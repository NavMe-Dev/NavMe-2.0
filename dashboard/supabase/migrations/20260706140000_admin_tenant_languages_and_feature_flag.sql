-- Extend project feature upsert to persist the languages master toggle.
CREATE OR REPLACE FUNCTION public.admin_upsert_project_features(
  p_email text,
  p_password text,
  p_poi_type text,
  p_login_id uuid DEFAULT NULL::uuid,
  p_people_search boolean DEFAULT true,
  p_save_location boolean DEFAULT true,
  p_block_enabled boolean DEFAULT true,
  p_mini3d_gta_embed boolean DEFAULT false,
  p_custom_media boolean DEFAULT true,
  p_assistant boolean DEFAULT false,
  p_snapshot boolean DEFAULT false,
  p_whatsapp boolean DEFAULT false,
  p_feedback boolean DEFAULT false,
  p_languages boolean DEFAULT false
)
RETURNS navme_project_features
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
    login_id,
    poi_type,
    people_search,
    save_location,
    block_enabled,
    mini3d_gta_embed,
    custom_media,
    assistant,
    snapshot,
    whatsapp,
    feedback,
    languages,
    updated_at
  )
  VALUES (
    p_login_id,
    clean_poi_type,
    p_people_search,
    p_save_location,
    p_block_enabled,
    p_mini3d_gta_embed,
    p_custom_media,
    p_assistant,
    p_snapshot,
    p_whatsapp,
    p_feedback,
    p_languages,
    now()
  )
  ON CONFLICT (poi_type) DO UPDATE SET
    login_id = COALESCE(EXCLUDED.login_id, navme_project_features.login_id),
    people_search = EXCLUDED.people_search,
    save_location = EXCLUDED.save_location,
    block_enabled = EXCLUDED.block_enabled,
    mini3d_gta_embed = EXCLUDED.mini3d_gta_embed,
    custom_media = EXCLUDED.custom_media,
    assistant = EXCLUDED.assistant,
    snapshot = EXCLUDED.snapshot,
    whatsapp = EXCLUDED.whatsapp,
    feedback = EXCLUDED.feedback,
    languages = EXCLUDED.languages,
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$function$;

-- Seed the six supported language rows for a tenant (idempotent).
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

-- Toggle a single tenant language row.
CREATE OR REPLACE FUNCTION public.admin_upsert_tenant_language(
  p_email text,
  p_password text,
  p_poi_type text,
  p_lang_code text,
  p_is_enabled boolean
)
RETURNS navme_tenant_languages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result public.navme_tenant_languages;
  clean_poi_type text := trim(p_poi_type);
  clean_lang_code text := lower(trim(p_lang_code));
BEGIN
  IF NOT public.verify_navme_superadmin(p_email, p_password) THEN
    RAISE EXCEPTION 'Unauthorized superadmin credentials';
  END IF;

  IF clean_poi_type IS NULL OR clean_poi_type = '' THEN
    RAISE EXCEPTION 'poi_type is required';
  END IF;

  IF clean_lang_code IS NULL OR clean_lang_code = '' THEN
    RAISE EXCEPTION 'lang_code is required';
  END IF;

  PERFORM public.admin_init_tenant_languages(p_email, p_password, clean_poi_type);

  UPDATE public.navme_tenant_languages
  SET
    is_enabled = p_is_enabled,
    updated_at = now()
  WHERE lower(poi_type) = lower(clean_poi_type)
    AND lang_code = clean_lang_code
  RETURNING * INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Unknown language code % for tenant %', clean_lang_code, clean_poi_type;
  END IF;

  RETURN result;
END;
$function$;

-- Remove tenant language rows when a project is deleted.
CREATE OR REPLACE FUNCTION public.admin_delete_tenant_languages(
  p_email text,
  p_password text,
  p_poi_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.verify_navme_superadmin(p_email, p_password) THEN
    RAISE EXCEPTION 'Unauthorized superadmin credentials';
  END IF;

  DELETE FROM public.navme_tenant_languages
  WHERE lower(poi_type) = lower(trim(p_poi_type));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_project_features(p_email text, p_password text, p_poi_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.verify_navme_superadmin(p_email, p_password) THEN
    RAISE EXCEPTION 'Unauthorized superadmin credentials';
  END IF;

  DELETE FROM public.navme_tenant_languages
  WHERE lower(poi_type) = lower(trim(p_poi_type));

  DELETE FROM public.navme_project_features
  WHERE lower(poi_type) = lower(trim(p_poi_type));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_init_tenant_languages(text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_upsert_tenant_language(text, text, text, text, boolean) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_tenant_languages(text, text, text) TO anon, authenticated, PUBLIC;
