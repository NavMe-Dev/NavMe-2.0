-- Fourth experience field alongside project_url (AR app entry) / whitelabeled_url /
-- experience_ref: the wayfinding viewer's own end URL for this project, e.g.
-- https://wayfinding.navme.space/?b=gcu&mp=1 — the "Walkthrough First" destination
-- for the smart start-mode redirect in wf-boot.js.

ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS walkthrough_url text;

COMMENT ON COLUMN public.navme_project_features.walkthrough_url IS
  'The wayfinding viewer URL to open for this project (e.g. https://wayfinding.navme.space/?b=gcu&mp=1) when walkthrough_mode is walkthrough_first, or hybrid on a non-iOS device.';

DROP FUNCTION IF EXISTS public.admin_upsert_project_experience_urls(
  text, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.admin_upsert_project_experience_urls(
  p_email text,
  p_password text,
  p_poi_type text,
  p_project_url text DEFAULT NULL,
  p_whitelabeled_url text DEFAULT NULL,
  p_experience_ref text DEFAULT NULL,
  p_walkthrough_url text DEFAULT NULL
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
    walkthrough_url,
    updated_at
  )
  VALUES (
    clean_poi_type,
    nullif(trim(p_project_url), ''),
    nullif(trim(p_whitelabeled_url), ''),
    nullif(trim(p_experience_ref), ''),
    nullif(trim(p_walkthrough_url), ''),
    now()
  )
  ON CONFLICT (poi_type) DO UPDATE SET
    project_url = EXCLUDED.project_url,
    whitelabeled_url = EXCLUDED.whitelabeled_url,
    experience_ref = COALESCE(EXCLUDED.experience_ref, public.navme_project_features.experience_ref),
    walkthrough_url = COALESCE(EXCLUDED.walkthrough_url, public.navme_project_features.walkthrough_url),
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_project_experience_urls(
  text, text, text, text, text, text, text
) TO anon, authenticated, PUBLIC;

UPDATE public.navme_project_features
SET walkthrough_url = 'https://wayfinding.navme.space/?b=gcu&mp=1'
WHERE poi_type = 'GCU';
