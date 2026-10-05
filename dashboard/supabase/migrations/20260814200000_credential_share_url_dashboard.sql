-- Fixed share host for all API credentials (dashboard SPA).
CREATE OR REPLACE FUNCTION public._navme_cred_share_base()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 'https://dashboard.navme.space'::text $$;

CREATE OR REPLACE FUNCTION public.project_list_api_credentials(
  p_email text,
  p_password text,
  p_poi_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  public_id text,
  share_url text,
  key_prefix text,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ctx record;
  base_url text := rtrim(public._navme_cred_share_base(), '/');
BEGIN
  SELECT * INTO ctx FROM public._navme_cred_caller_poi(p_email, p_password, p_poi_type);
  IF ctx.target_poi IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.public_id,
    (base_url || '/c/' || c.public_id)::text AS share_url,
    c.key_prefix,
    c.is_active,
    c.created_at
  FROM public.navme_project_api_credentials c
  WHERE lower(trim(c.poi_type)) = lower(trim(ctx.target_poi))
  ORDER BY c.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_create_api_credential(
  p_email text,
  p_password text,
  p_name text,
  p_poi_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  public_id text,
  share_url text,
  api_key text,
  key_prefix text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ctx record;
  clean_name text := nullif(trim(p_name), '');
  new_public_id text;
  new_key text;
  new_prefix text;
  base_url text := rtrim(public._navme_cred_share_base(), '/');
  row_id uuid;
  row_created timestamptz;
BEGIN
  SELECT * INTO ctx FROM public._navme_cred_caller_poi(p_email, p_password, p_poi_type);
  IF ctx.target_poi IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF clean_name IS NULL THEN
    RAISE EXCEPTION 'Name is required';
  END IF;

  new_public_id := lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  new_key := 'nm_' || encode(extensions.gen_random_bytes(24), 'hex');
  new_prefix := left(new_key, 10);

  INSERT INTO public.navme_project_api_credentials (
    poi_type, name, public_id, api_key, key_prefix, created_by, is_active
  )
  VALUES (
    ctx.target_poi, clean_name, new_public_id, new_key, new_prefix, ctx.caller_id, true
  )
  RETURNING navme_project_api_credentials.id, navme_project_api_credentials.created_at
  INTO row_id, row_created;

  id := row_id;
  name := clean_name;
  public_id := new_public_id;
  share_url := base_url || '/c/' || new_public_id;
  api_key := new_key;
  key_prefix := new_prefix;
  created_at := row_created;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_export_api_credential(
  p_email text,
  p_password text,
  p_credential_id uuid,
  p_poi_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  public_id text,
  share_url text,
  api_key text,
  key_prefix text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ctx record;
  base_url text := rtrim(public._navme_cred_share_base(), '/');
  c public.navme_project_api_credentials%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM public._navme_cred_caller_poi(p_email, p_password, p_poi_type);
  IF ctx.target_poi IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO c
  FROM public.navme_project_api_credentials row
  WHERE row.id = p_credential_id
    AND lower(trim(row.poi_type)) = lower(trim(ctx.target_poi))
  LIMIT 1;

  IF c.id IS NULL THEN
    RAISE EXCEPTION 'Credential not found';
  END IF;

  id := c.id;
  name := c.name;
  public_id := c.public_id;
  share_url := base_url || '/c/' || c.public_id;
  api_key := c.api_key;
  key_prefix := c.key_prefix;
  created_at := c.created_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_get_api_credential(
  p_email text,
  p_password text,
  p_credential_id uuid,
  p_poi_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  public_id text,
  share_url text,
  api_key text,
  key_prefix text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ctx record;
  base_url text := rtrim(public._navme_cred_share_base(), '/');
BEGIN
  SELECT * INTO ctx FROM public._navme_cred_caller_poi(p_email, p_password, p_poi_type);
  IF ctx.target_poi IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.public_id,
    (base_url || '/c/' || c.public_id)::text AS share_url,
    c.api_key,
    c.key_prefix,
    c.created_at
  FROM public.navme_project_api_credentials c
  WHERE c.id = p_credential_id
    AND lower(trim(c.poi_type)) = lower(trim(ctx.target_poi))
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credential not found';
  END IF;
END;
$$;

-- Public resolve for /c/:public_id landing page (no full key).
CREATE OR REPLACE FUNCTION public.resolve_project_api_credential(
  p_public_id text
)
RETURNS TABLE (
  name text,
  public_id text,
  poi_type text,
  share_url text,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  clean_id text := lower(nullif(trim(p_public_id), ''));
  base_url text := rtrim(public._navme_cred_share_base(), '/');
BEGIN
  IF clean_id IS NULL OR clean_id !~ '^[a-f0-9]{8,32}$' THEN
    RAISE EXCEPTION 'Credential not found';
  END IF;

  RETURN QUERY
  SELECT
    c.name,
    c.public_id,
    c.poi_type,
    (base_url || '/c/' || c.public_id)::text AS share_url,
    c.is_active,
    c.created_at
  FROM public.navme_project_api_credentials c
  WHERE c.public_id = clean_id
    AND c.is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credential not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public._navme_cred_share_base() TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_list_api_credentials(text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_create_api_credential(text, text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_export_api_credential(text, text, uuid, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_get_api_credential(text, text, uuid, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_project_api_credential(text) TO anon, authenticated, PUBLIC;
