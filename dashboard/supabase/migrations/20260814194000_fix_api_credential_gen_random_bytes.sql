-- gen_random_bytes lives in extensions; RPC search_path is public only.
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
  base_url text;
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

  SELECT nullif(trim(COALESCE(f.whitelabeled_url, f.project_url, '')), '')
  INTO base_url
  FROM public.navme_project_features f
  WHERE lower(trim(f.poi_type)) = lower(trim(ctx.target_poi))
  LIMIT 1;
  IF base_url IS NULL THEN
    base_url := 'https://navme.space';
  END IF;
  base_url := rtrim(base_url, '/');

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

GRANT EXECUTE ON FUNCTION public.project_create_api_credential(text, text, text, text) TO anon, authenticated, service_role;
