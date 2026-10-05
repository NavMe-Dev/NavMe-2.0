-- Experience URLs on navme_project_features (superadmin-visible).
ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS project_url text,
  ADD COLUMN IF NOT EXISTS whitelabeled_url text;

COMMENT ON COLUMN public.navme_project_features.project_url IS
  'NavMe experience / project URL for this poi_type.';

COMMENT ON COLUMN public.navme_project_features.whitelabeled_url IS
  'White-labeled experience URL for this poi_type.';

CREATE OR REPLACE FUNCTION public.admin_upsert_project_experience_urls(
  p_email text,
  p_password text,
  p_poi_type text,
  p_project_url text DEFAULT NULL,
  p_whitelabeled_url text DEFAULT NULL
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
    updated_at
  )
  VALUES (
    clean_poi_type,
    nullif(trim(p_project_url), ''),
    nullif(trim(p_whitelabeled_url), ''),
    now()
  )
  ON CONFLICT (poi_type) DO UPDATE SET
    project_url = EXCLUDED.project_url,
    whitelabeled_url = EXCLUDED.whitelabeled_url,
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_project_experience_urls(
  text, text, text, text, text
) TO anon, authenticated, PUBLIC;
