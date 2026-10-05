-- Fix ambiguous poi_type in delete RPC (RETURNS TABLE column vs table column).

CREATE OR REPLACE FUNCTION public.project_admin_delete_sub_admin(
  p_email text,
  p_password text,
  p_sub_email text,
  p_poi_type text DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  poi_type text,
  deleted boolean
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
  removed int := 0;
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

  SELECT a.id INTO aid
  FROM public.navme_accounts a
  WHERE lower(trim(a.email)) = clean_sub
  LIMIT 1;

  IF aid IS NULL THEN
    RAISE EXCEPTION 'Sub-admin not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.navme_project_members m
    WHERE m.account_id = aid
      AND m.role = 'sub_admin'
      AND lower(trim(m.poi_type)) = lower(trim(target_poi))
  ) THEN
    RAISE EXCEPTION 'Account is not a sub-admin for this project';
  END IF;

  UPDATE public.navme_pois p SET assigned_to = NULL
  WHERE p.assigned_to = aid AND lower(trim(p.poi_type)) = lower(trim(target_poi));
  UPDATE public.navme_media md SET assigned_to = NULL
  WHERE md.assigned_to = aid AND lower(trim(md.poi_type)) = lower(trim(target_poi));
  UPDATE public.navme_facilities f SET assigned_to = NULL
  WHERE f.assigned_to = aid AND lower(trim(f.poi_type)) = lower(trim(target_poi));
  UPDATE public.navme_categories c SET assigned_to = NULL
  WHERE c.assigned_to = aid AND lower(trim(c.poi_type)) = lower(trim(target_poi));
  UPDATE public.navme_blocks b SET assigned_to = NULL
  WHERE b.assigned_to = aid AND lower(trim(b.poi_type)) = lower(trim(target_poi));

  DELETE FROM public.navme_project_members m
  WHERE m.account_id = aid
    AND m.role = 'sub_admin'
    AND lower(trim(m.poi_type)) = lower(trim(target_poi));

  GET DIAGNOSTICS removed = ROW_COUNT;

  IF NOT EXISTS (
    SELECT 1 FROM public.navme_project_members m WHERE m.account_id = aid
  ) THEN
    DELETE FROM public.navme_accounts WHERE id = aid;
  END IF;

  account_id := aid;
  poi_type := target_poi;
  deleted := removed > 0;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.project_admin_delete_sub_admin(text, text, text, text)
  TO anon, authenticated, PUBLIC;
