-- NavMe RBAC auth + membership RPCs

CREATE OR REPLACE FUNCTION public.verify_navme_account(p_email text, p_password text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  aid uuid;
BEGIN
  SELECT id INTO aid
  FROM public.navme_accounts
  WHERE lower(trim(email)) = lower(trim(p_email))
    AND password = p_password
    AND is_active
  LIMIT 1;
  RETURN aid;
END;
$$;

CREATE OR REPLACE FUNCTION public.authenticate_navme_account(p_email text, p_password text)
RETURNS TABLE (
  account_id uuid,
  email text,
  is_superadmin boolean,
  role text,
  poi_type text,
  map_code text,
  client_id text,
  client_secret text,
  member_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  aid uuid;
  acc public.navme_accounts%ROWTYPE;
  mem public.navme_project_members%ROWTYPE;
  login_row public.navme_logins%ROWTYPE;
BEGIN
  aid := public.verify_navme_account(p_email, p_password);
  IF aid IS NULL THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  SELECT * INTO acc FROM public.navme_accounts WHERE id = aid;

  IF acc.is_superadmin THEN
    account_id := acc.id;
    email := acc.email;
    is_superadmin := true;
    role := 'superadmin';
    poi_type := NULL;
    map_code := NULL;
    client_id := NULL;
    client_secret := NULL;
    member_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO mem
  FROM public.navme_project_members m
  WHERE m.account_id = aid AND m.is_active
  LIMIT 1;

  IF mem.id IS NULL THEN
    RAISE EXCEPTION 'Account has no active project membership';
  END IF;

  SELECT * INTO login_row
  FROM public.navme_logins l
  WHERE lower(trim(l.poi_type)) = lower(trim(mem.poi_type))
  ORDER BY l.created_at DESC NULLS LAST
  LIMIT 1;

  account_id := acc.id;
  email := acc.email;
  is_superadmin := false;
  role := mem.role;
  poi_type := mem.poi_type;
  map_code := login_row.map_code;
  client_id := login_row.client_id;
  client_secret := login_row.client_secret;
  member_id := mem.id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_assign_project_admin(
  p_email text,
  p_password text,
  p_poi_type text,
  p_admin_email text,
  p_admin_password text,
  p_display_name text DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  member_id uuid,
  poi_type text,
  role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  clean_poi text := trim(p_poi_type);
  clean_admin_email text := lower(trim(p_admin_email));
  aid uuid;
  mid uuid;
BEGIN
  IF NOT public.verify_navme_superadmin(p_email, p_password) THEN
    RAISE EXCEPTION 'Unauthorized superadmin credentials';
  END IF;
  IF clean_poi IS NULL OR clean_poi = '' THEN
    RAISE EXCEPTION 'poi_type is required';
  END IF;
  IF clean_admin_email IS NULL OR clean_admin_email = '' OR nullif(p_admin_password, '') IS NULL THEN
    RAISE EXCEPTION 'admin email and password are required';
  END IF;

  INSERT INTO public.navme_accounts (email, password, display_name, is_superadmin, is_active)
  VALUES (
    clean_admin_email,
    p_admin_password,
    COALESCE(nullif(trim(p_display_name), ''), split_part(clean_admin_email, '@', 1)),
    false,
    true
  )
  ON CONFLICT (email) DO UPDATE
  SET password = EXCLUDED.password,
      display_name = COALESCE(EXCLUDED.display_name, public.navme_accounts.display_name),
      is_active = true,
      is_superadmin = false,
      updated_at = now()
  RETURNING id INTO aid;

  -- Deactivate existing project_admin for this poi_type
  UPDATE public.navme_project_members m
  SET is_active = false
  WHERE lower(trim(m.poi_type)) = lower(clean_poi)
    AND m.role = 'project_admin'
    AND m.is_active;

  -- Deactivate any other active membership for this account
  UPDATE public.navme_project_members m
  SET is_active = false
  WHERE m.account_id = aid AND m.is_active;

  INSERT INTO public.navme_project_members (account_id, poi_type, role, created_by, is_active)
  VALUES (
    aid,
    clean_poi,
    'project_admin',
    (SELECT id FROM public.navme_accounts WHERE lower(trim(email)) = lower(trim(p_email)) LIMIT 1),
    true
  )
  RETURNING id INTO mid;

  account_id := aid;
  member_id := mid;
  poi_type := clean_poi;
  role := 'project_admin';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_admin_upsert_sub_admin(
  p_email text,
  p_password text,
  p_sub_email text,
  p_sub_password text,
  p_display_name text DEFAULT NULL,
  p_active boolean DEFAULT true,
  p_poi_type text DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  member_id uuid,
  poi_type text,
  role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  caller_id uuid;
  caller_mem public.navme_project_members%ROWTYPE;
  clean_sub text := lower(trim(p_sub_email));
  target_poi text;
  aid uuid;
  mid uuid;
BEGIN
  IF public.verify_navme_superadmin(p_email, p_password) THEN
    caller_id := (
      SELECT id FROM public.navme_accounts
      WHERE lower(trim(email)) = lower(trim(p_email))
      LIMIT 1
    );
    target_poi := nullif(trim(p_poi_type), '');
    IF target_poi IS NULL THEN
      RAISE EXCEPTION 'poi_type is required for superadmin sub-admin management';
    END IF;
  ELSE
    caller_id := public.verify_navme_account(p_email, p_password);
    IF caller_id IS NULL THEN
      RAISE EXCEPTION 'Invalid credentials';
    END IF;

    SELECT * INTO caller_mem
    FROM public.navme_project_members m
    WHERE m.account_id = caller_id AND m.is_active AND m.role = 'project_admin'
    LIMIT 1;

    IF caller_mem.id IS NULL THEN
      RAISE EXCEPTION 'Only project admins or superadmin can manage sub-admins';
    END IF;
    target_poi := caller_mem.poi_type;
  END IF;

  IF clean_sub IS NULL OR clean_sub = '' THEN
    RAISE EXCEPTION 'sub-admin email is required';
  END IF;

  IF nullif(p_sub_password, '') IS NULL THEN
    SELECT id INTO aid
    FROM public.navme_accounts
    WHERE lower(trim(email)) = clean_sub
    LIMIT 1;
    IF aid IS NULL THEN
      RAISE EXCEPTION 'sub-admin email and password are required';
    END IF;
    UPDATE public.navme_accounts
    SET display_name = COALESCE(nullif(trim(p_display_name), ''), display_name),
        is_active = true,
        is_superadmin = false,
        updated_at = now()
    WHERE id = aid;
  ELSE
    INSERT INTO public.navme_accounts (email, password, display_name, is_superadmin, is_active)
    VALUES (
      clean_sub,
      p_sub_password,
      COALESCE(nullif(trim(p_display_name), ''), split_part(clean_sub, '@', 1)),
      false,
      true
    )
    ON CONFLICT (email) DO UPDATE
    SET password = EXCLUDED.password,
        display_name = COALESCE(EXCLUDED.display_name, public.navme_accounts.display_name),
        is_active = true,
        is_superadmin = false,
        updated_at = now()
    RETURNING id INTO aid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.navme_project_members m
    WHERE m.account_id = aid
      AND m.role = 'project_admin'
      AND m.is_active
      AND lower(trim(m.poi_type)) <> lower(trim(target_poi))
  ) THEN
    RAISE EXCEPTION 'Account is already a project admin for another poi_type';
  END IF;

  UPDATE public.navme_project_members m
  SET is_active = false
  WHERE m.account_id = aid AND m.is_active;

  IF p_active THEN
    INSERT INTO public.navme_project_members (account_id, poi_type, role, created_by, is_active)
    VALUES (aid, target_poi, 'sub_admin', caller_id, true)
    RETURNING id INTO mid;
  ELSE
    mid := NULL;
  END IF;

  account_id := aid;
  member_id := mid;
  poi_type := target_poi;
  role := 'sub_admin';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_project_members(
  p_email text,
  p_password text,
  p_poi_type text
)
RETURNS TABLE (
  member_id uuid,
  account_id uuid,
  email text,
  display_name text,
  role text,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  clean_poi text := trim(p_poi_type);
  caller_id uuid;
  is_sa boolean := false;
  caller_poi text;
BEGIN
  IF public.verify_navme_superadmin(p_email, p_password) THEN
    is_sa := true;
  ELSE
    caller_id := public.verify_navme_account(p_email, p_password);
    IF caller_id IS NULL THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;
    SELECT m.poi_type INTO caller_poi
    FROM public.navme_project_members m
    WHERE m.account_id = caller_id AND m.is_active AND m.role = 'project_admin'
    LIMIT 1;
    IF caller_poi IS NULL OR lower(trim(caller_poi)) <> lower(clean_poi) THEN
      RAISE EXCEPTION 'Unauthorized for this poi_type';
    END IF;
  END IF;

  IF clean_poi IS NULL OR clean_poi = '' THEN
    RAISE EXCEPTION 'poi_type is required';
  END IF;

  RETURN QUERY
  SELECT m.id, a.id, a.email, a.display_name, m.role, m.is_active
  FROM public.navme_project_members m
  JOIN public.navme_accounts a ON a.id = m.account_id
  WHERE lower(trim(m.poi_type)) = lower(clean_poi)
  ORDER BY m.role ASC, a.email ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_admin_assign_entity(
  p_email text,
  p_password text,
  p_table text,
  p_row_id uuid,
  p_assignee_account_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  caller_id uuid;
  caller_mem public.navme_project_members%ROWTYPE;
  row_poi text;
  allowed text[] := ARRAY['navme_pois','navme_media','navme_facilities','navme_categories','navme_blocks'];
BEGIN
  IF NOT (p_table = ANY (allowed)) THEN
    RAISE EXCEPTION 'Unsupported table';
  END IF;

  caller_id := public.verify_navme_account(p_email, p_password);
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  SELECT * INTO caller_mem
  FROM public.navme_project_members m
  WHERE m.account_id = caller_id AND m.is_active AND m.role = 'project_admin'
  LIMIT 1;

  IF caller_mem.id IS NULL THEN
    RAISE EXCEPTION 'Only project admins can assign entities';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.navme_project_members m
    WHERE m.account_id = p_assignee_account_id
      AND m.is_active
      AND m.role = 'sub_admin'
      AND lower(trim(m.poi_type)) = lower(trim(caller_mem.poi_type))
  ) THEN
    RAISE EXCEPTION 'Assignee must be an active sub-admin on this project';
  END IF;

  EXECUTE format('SELECT poi_type::text FROM public.%I WHERE id = $1', p_table)
    INTO row_poi
    USING p_row_id;

  IF row_poi IS NULL OR lower(trim(row_poi)) <> lower(trim(caller_mem.poi_type)) THEN
    RAISE EXCEPTION 'Row not found in this project';
  END IF;

  EXECUTE format(
    'UPDATE public.%I SET assigned_to = $1 WHERE id = $2',
    p_table
  ) USING p_assignee_account_id, p_row_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_navme_account(text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.authenticate_navme_account(text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_assign_project_admin(text, text, text, text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_admin_upsert_sub_admin(text, text, text, text, text, boolean, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_project_members(text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_admin_assign_entity(text, text, text, uuid, uuid) TO anon, authenticated, PUBLIC;
