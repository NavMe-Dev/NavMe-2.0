-- Treasure hunt feature flag for NavMe dashboard / app gating
ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS treasure boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.navme_project_features.treasure IS
  'Treasure hunt — when true, show Treasure panel and map treasures; when false hide them.';

DROP FUNCTION IF EXISTS public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
);

DROP FUNCTION IF EXISTS public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
);

CREATE FUNCTION public.admin_upsert_project_features(
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
  p_languages boolean DEFAULT false,
  p_fps_display boolean DEFAULT false,
  p_localization_display boolean DEFAULT false,
  p_navme_robo_companion boolean DEFAULT false,
  p_facilities boolean DEFAULT false,
  p_treasure boolean DEFAULT false
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
    fps_display,
    localization_display,
    navme_robo_companion,
    facilities,
    treasure,
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
    p_fps_display,
    p_localization_display,
    p_navme_robo_companion,
    p_facilities,
    p_treasure,
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
    fps_display = EXCLUDED.fps_display,
    localization_display = EXCLUDED.localization_display,
    navme_robo_companion = EXCLUDED.navme_robo_companion,
    facilities = EXCLUDED.facilities,
    treasure = EXCLUDED.treasure,
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
) TO anon, authenticated, PUBLIC;

UPDATE public.navme_project_features f
SET treasure = true,
    updated_at = now()
WHERE f.treasure = false
AND (
  EXISTS (SELECT 1 FROM public.treasure_levels tl WHERE lower(tl.poi_type) = lower(f.poi_type))
  OR EXISTS (SELECT 1 FROM public.treasure_project_features tpf WHERE lower(tpf.poi_type) = lower(f.poi_type) AND tpf.game_enabled = true)
);
