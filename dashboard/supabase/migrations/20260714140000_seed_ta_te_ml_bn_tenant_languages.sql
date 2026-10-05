-- Seed Tamil, Telugu, Malayalam, and Bengali into admin_init_tenant_languages.
CREATE OR REPLACE FUNCTION public.admin_init_tenant_languages(
  p_email text,
  p_password text,
  p_poi_type text
)
RETURNS SETOF navme_tenant_languages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  clean_poi_type text := trim(p_poi_type);
BEGIN
  IF NOT public.verify_navme_superadmin(p_email, p_password) THEN
    RAISE EXCEPTION 'Unauthorized superadmin credentials';
  END IF;

  IF clean_poi_type IS NULL OR clean_poi_type = '' THEN
    RAISE EXCEPTION 'poi_type is required';
  END IF;

  INSERT INTO public.navme_tenant_languages (poi_type, lang_code, native_label, is_enabled, sort_order)
  VALUES
    (clean_poi_type, 'en', 'English', true, 1),
    (clean_poi_type, 'es', 'Español', false, 2),
    (clean_poi_type, 'fr', 'Français', false, 3),
    (clean_poi_type, 'ar', 'العربية', false, 4),
    (clean_poi_type, 'zh', '中文', false, 5),
    (clean_poi_type, 'ja', '日本語', false, 6),
    (clean_poi_type, 'hi', 'हिन्दी', false, 7),
    (clean_poi_type, 'kn', 'ಕನ್ನಡ', false, 8),
    (clean_poi_type, 'pt', 'Português', false, 9),
    (clean_poi_type, 'ta', 'தமிழ்', false, 10),
    (clean_poi_type, 'te', 'తెలుగు', false, 11),
    (clean_poi_type, 'ml', 'മലയാളം', false, 12),
    (clean_poi_type, 'bn', 'বাংলা', false, 13)
  ON CONFLICT (poi_type, lang_code) DO NOTHING;

  RETURN QUERY
  SELECT *
  FROM public.navme_tenant_languages
  WHERE lower(poi_type) = lower(clean_poi_type)
  ORDER BY sort_order ASC, lang_code ASC;
END;
$function$;
