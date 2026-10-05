-- Wire facilities feature flag into admin_upsert_project_features RPC.
-- Column navme_project_features.facilities already exists (boolean NOT NULL DEFAULT false).

COMMENT ON COLUMN public.navme_project_features.facilities IS
  'Facilities — when true, show amenities from navme_facilities in the NavMe app / editor; when false hide them.';

-- Drop prior overloads so PostgREST resolves one RPC.
DROP FUNCTION IF EXISTS public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
);

DROP FUNCTION IF EXISTS public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
);

DROP FUNCTION IF EXISTS public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
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
  p_facilities boolean DEFAULT false
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
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean
) TO anon, authenticated, PUBLIC;

-- Projects that already have facility rows: turn the flag on by default.
UPDATE public.navme_project_features f
SET facilities = true,
    updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM public.navme_facilities nf
  WHERE lower(nf.poi_type) = lower(f.poi_type)
)
AND f.facilities = false;
