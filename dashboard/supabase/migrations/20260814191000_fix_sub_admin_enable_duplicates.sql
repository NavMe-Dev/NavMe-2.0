-- Fix sub-admin enable/disable duplicating membership rows.
-- Reuse existing account+poi+role membership instead of INSERT on every enable.
-- Deduplicate list output and clean existing duplicate inactive rows.

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

  -- Keep at most one membership row for this account on this project as sub_admin.
  SELECT m.id INTO mid
  FROM public.navme_project_members m
  WHERE m.account_id = aid
    AND m.role = 'sub_admin'
    AND lower(trim(m.poi_type)) = lower(trim(target_poi))
  ORDER BY m.is_active DESC, m.created_at DESC NULLS LAST
  LIMIT 1;

  IF mid IS NULL THEN
    IF p_active THEN
      INSERT INTO public.navme_project_members (account_id, poi_type, role, created_by, is_active)
      VALUES (aid, target_poi, 'sub_admin', caller_id, true)
      RETURNING id INTO mid;
    END IF;
  ELSE
    UPDATE public.navme_project_members
    SET is_active = p_active,
        created_by = COALESCE(created_by, caller_id)
    WHERE id = mid;

    -- Remove leftover duplicate rows for the same account/project/role.
    DELETE FROM public.navme_project_members m
    WHERE m.account_id = aid
      AND m.role = 'sub_admin'
      AND lower(trim(m.poi_type)) = lower(trim(target_poi))
      AND m.id <> mid;
  END IF;

  -- Deactivate any other active memberships for this account outside this project.
  UPDATE public.navme_project_members m
  SET is_active = false
  WHERE m.account_id = aid
    AND m.is_active
    AND m.id IS DISTINCT FROM mid
    AND lower(trim(m.poi_type)) <> lower(trim(target_poi));

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
  is_active boolean,
  password text
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
  SELECT DISTINCT ON (m.account_id, m.role)
    m.id,
    a.id,
    a.email,
    a.display_name,
    m.role,
    m.is_active,
    a.password
  FROM public.navme_project_members m
  JOIN public.navme_accounts a ON a.id = m.account_id
  WHERE lower(trim(m.poi_type)) = lower(clean_poi)
  ORDER BY m.account_id, m.role, m.is_active DESC, m.created_at DESC NULLS LAST;
END;
$$;

-- One-time cleanup of duplicate inactive sub-admin memberships.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, role, lower(trim(poi_type))
      ORDER BY is_active DESC, created_at DESC NULLS LAST
    ) AS rn
  FROM public.navme_project_members
  WHERE role = 'sub_admin'
)
DELETE FROM public.navme_project_members m
USING ranked r
WHERE m.id = r.id
  AND r.rn > 1;

GRANT EXECUTE ON FUNCTION public.project_admin_upsert_sub_admin(text, text, text, text, text, boolean, text)
  TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_project_members(text, text, text)
  TO anon, authenticated, PUBLIC;
