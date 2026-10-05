-- Export returns full api_key for download; UI list still omits the secret.
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
  base_url text;
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

  SELECT nullif(trim(COALESCE(f.whitelabeled_url, f.project_url, '')), '')
  INTO base_url
  FROM public.navme_project_features f
  WHERE lower(trim(f.poi_type)) = lower(trim(ctx.target_poi))
  LIMIT 1;
  IF base_url IS NULL THEN
    base_url := 'https://navme.space';
  END IF;
  base_url := rtrim(base_url, '/');

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

GRANT EXECUTE ON FUNCTION public.project_export_api_credential(text, text, uuid, text) TO anon, authenticated, PUBLIC;
