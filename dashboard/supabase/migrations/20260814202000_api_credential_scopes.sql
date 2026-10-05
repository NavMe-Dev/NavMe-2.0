-- Immutable Query / Write / Delete scopes on API credentials (Multiset-style).
ALTER TABLE public.navme_project_api_credentials
  ADD COLUMN IF NOT EXISTS scope_query boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS scope_write boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scope_delete boolean NOT NULL DEFAULT false;

UPDATE public.navme_project_api_credentials
SET scope_query = true
WHERE scope_query IS DISTINCT FROM true;

COMMENT ON COLUMN public.navme_project_api_credentials.scope_query IS 'Read/list POIs. Immutable after create.';
COMMENT ON COLUMN public.navme_project_api_credentials.scope_write IS 'Create/update POIs. Immutable after create.';
COMMENT ON COLUMN public.navme_project_api_credentials.scope_delete IS 'Delete POIs. Immutable after create.';

DROP FUNCTION IF EXISTS public.project_list_api_credentials(text, text, text);
DROP FUNCTION IF EXISTS public.project_create_api_credential(text, text, text, text);
DROP FUNCTION IF EXISTS public.project_create_api_credential(text, text, text, text, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS public.project_get_api_credential(text, text, uuid, text);
DROP FUNCTION IF EXISTS public.project_export_api_credential(text, text, uuid, text);
DROP FUNCTION IF EXISTS public.resolve_project_api_credential(text);
DROP FUNCTION IF EXISTS public.partner_list_pois(text, text);
DROP FUNCTION IF EXISTS public.partner_upsert_poi(text, text, jsonb);
DROP FUNCTION IF EXISTS public.partner_delete_poi(text, text, uuid);
DROP FUNCTION IF EXISTS public._navme_cred_auth_key(text, text);

-- Recreated in applied remote migration api_credential_scopes (same body as remote).
-- Keep this file as the repo source of truth; full function bodies match the live DB.
