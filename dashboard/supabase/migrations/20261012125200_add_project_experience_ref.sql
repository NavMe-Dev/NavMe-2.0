-- Adds a third experience field alongside project_url / whitelabeled_url: the compact
-- Zappar experience ref ("host.spaceId", e.g. "r77z2.7069996602396526792") used to build
-- AR share links (share.navme.space/<poi-name>?p=<poiId>&x=<experience_ref>) from the
-- NavMe-2.0 wayfinding viewer's "View in AR" buttons.
--
-- The new 6-arg admin_upsert_project_experience_urls (adds p_experience_ref) is a strict
-- superset of the old 5-arg one (p_experience_ref defaults to NULL and is COALESCEd
-- against the existing stored value), so the old overload is dropped rather than left
-- sitting side by side with the new one.

ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS experience_ref text;

COMMENT ON COLUMN public.navme_project_features.experience_ref IS
  'Compact Zappar experience ref ("host.spaceId") for this poi_type, used as the `x` param in share.navme.space AR deep links.';

DROP FUNCTION IF EXISTS public.admin_upsert_project_experience_urls(
  text, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.admin_upsert_project_experience_urls(
  p_email text,
  p_password text,
  p_poi_type text,
  p_project_url text DEFAULT NULL,
  p_whitelabeled_url text DEFAULT NULL,
  p_experience_ref text DEFAULT NULL
)
RETURNS public.navme_project_features
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result public.navme_project_features;
  clean_poi_type text := trim(p_poi_type);
BEGIN
  IF NOT public.verify_navme_superadmin(p_email, p_password) THEN
    RAISE EXCEPTION 'Unauthorized superadmin credentials';
  END IF;

  IF clean_poi_type IS NULL OR clean_poi_type = '' THEN
    RAISE EXCEPTION 'poi_type is required';
  END IF;

  INSERT INTO public.navme_project_features (
    poi_type,
    project_url,
    whitelabeled_url,
    experience_ref,
    updated_at
  )
  VALUES (
    clean_poi_type,
    nullif(trim(p_project_url), ''),
    nullif(trim(p_whitelabeled_url), ''),
    nullif(trim(p_experience_ref), ''),
    now()
  )
  ON CONFLICT (poi_type) DO UPDATE SET
    project_url = EXCLUDED.project_url,
    whitelabeled_url = EXCLUDED.whitelabeled_url,
    experience_ref = COALESCE(EXCLUDED.experience_ref, public.navme_project_features.experience_ref),
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_project_experience_urls(
  text, text, text, text, text, text
) TO anon, authenticated, PUBLIC;

UPDATE public.navme_project_features
SET experience_ref = 'r77z2.7069996602396526792'
WHERE poi_type = 'GCU';
