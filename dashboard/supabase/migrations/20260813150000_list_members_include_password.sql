-- Superadmin / project-admin may view stored login passwords for team members
-- so they can copy credentials for onboarding (navme_accounts.password is plaintext).
DROP FUNCTION IF EXISTS public.admin_list_project_members(text, text, text);

CREATE FUNCTION public.admin_list_project_members(
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
  SELECT m.id, a.id, a.email, a.display_name, m.role, m.is_active, a.password
  FROM public.navme_project_members m
  JOIN public.navme_accounts a ON a.id = m.account_id
  WHERE lower(trim(m.poi_type)) = lower(clean_poi)
  ORDER BY m.role ASC, a.email ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_project_members(text, text, text) TO anon, authenticated, PUBLIC;
