-- Full key for Export only; list UI still returns key_prefix only.
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
  base_url text;
BEGIN
  SELECT * INTO ctx FROM public._navme_cred_caller_poi(p_email, p_password, p_poi_type);
  IF ctx.target_poi IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT nullif(trim(COALESCE(f.whitelabeled_url, f.project_url, '')), '')
  INTO base_url
  FROM public.navme_project_features f
  WHERE lower(trim(f.poi_type)) = lower(trim(ctx.target_poi))
  LIMIT 1;
  IF base_url IS NULL THEN
    base_url := 'https://navme.space';
  END IF;
  base_url := rtrim(base_url, '/');

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

GRANT EXECUTE ON FUNCTION public.project_get_api_credential(text, text, uuid, text) TO anon, authenticated, PUBLIC;
