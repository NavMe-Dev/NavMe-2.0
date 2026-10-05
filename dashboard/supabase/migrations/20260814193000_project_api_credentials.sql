-- Named API credentials per project (generate many; key shown once on create).

CREATE TABLE IF NOT EXISTS public.navme_project_api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_type text NOT NULL,
  name text NOT NULL,
  public_id text NOT NULL,
  api_key text NOT NULL,
  key_prefix text NOT NULL,
  created_by uuid REFERENCES public.navme_accounts(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_project_api_credentials_public_id_key UNIQUE (public_id),
  CONSTRAINT navme_project_api_credentials_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS navme_project_api_credentials_poi_idx
  ON public.navme_project_api_credentials (lower(trim(poi_type)), created_at DESC);

COMMENT ON TABLE public.navme_project_api_credentials IS
  'Project-scoped API credentials. Full api_key is returned only from the create RPC.';

ALTER TABLE public.navme_project_api_credentials ENABLE ROW LEVEL SECURITY;

-- No direct anon/authenticated table access; manage via SECURITY DEFINER RPCs.
REVOKE ALL ON TABLE public.navme_project_api_credentials FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._navme_cred_caller_poi(
  p_email text,
  p_password text,
  p_poi_type text DEFAULT NULL
)
RETURNS TABLE (
  caller_id uuid,
  target_poi text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  aid uuid;
  mem public.navme_project_members%ROWTYPE;
  poi text;
BEGIN
  IF public.verify_navme_superadmin(p_email, p_password) THEN
    aid := (
      SELECT id FROM public.navme_accounts
      WHERE lower(trim(email)) = lower(trim(p_email))
      LIMIT 1
    );
    poi := nullif(trim(p_poi_type), '');
    IF poi IS NULL THEN
      RAISE EXCEPTION 'poi_type is required';
    END IF;
  ELSE
    aid := public.verify_navme_account(p_email, p_password);
    IF aid IS NULL THEN
      RAISE EXCEPTION 'Invalid credentials';
    END IF;
    SELECT * INTO mem
    FROM public.navme_project_members m
    WHERE m.account_id = aid AND m.is_active AND m.role = 'project_admin'
    LIMIT 1;
    IF mem.id IS NULL THEN
      RAISE EXCEPTION 'Only project admins or superadmin can manage credentials';
    END IF;
    poi := mem.poi_type;
  END IF;

  caller_id := aid;
  target_poi := poi;
  RETURN NEXT;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.project_delete_api_credential(
  p_email text,
  p_password text,
  p_credential_id uuid,
  p_poi_type text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ctx record;
  removed int := 0;
BEGIN
  SELECT * INTO ctx FROM public._navme_cred_caller_poi(p_email, p_password, p_poi_type);
  IF ctx.target_poi IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  DELETE FROM public.navme_project_api_credentials c
  WHERE c.id = p_credential_id
    AND lower(trim(c.poi_type)) = lower(trim(ctx.target_poi));

  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed = 0 THEN
    RAISE EXCEPTION 'Credential not found';
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public._navme_cred_caller_poi(text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_list_api_credentials(text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_create_api_credential(text, text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_delete_api_credential(text, text, uuid, text) TO anon, authenticated, PUBLIC;
