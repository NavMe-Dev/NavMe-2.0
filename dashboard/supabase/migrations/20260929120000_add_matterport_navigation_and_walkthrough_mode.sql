-- Wire matterport_navigation + walkthrough_mode into admin_upsert_project_features.
--
-- The dashboard sends p_matterport_navigation and p_walkthrough_mode, but the
-- deployed function accepts neither, so every admin save fails with PGRST202
-- ("Could not find the function ... in the schema cache").
--
-- The live function had also drifted ahead of this folder: it already carries
-- p_companion_model, which no migration here adds. Because that drifted
-- signature cannot be named reliably, existing overloads are dropped by OID
-- rather than by a written-out argument list.

-- 1. Columns ------------------------------------------------------------------

ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS matterport_navigation boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS companion_model text DEFAULT 'guidebot',
  ADD COLUMN IF NOT EXISTS walkthrough_mode text NOT NULL DEFAULT 'walkthrough_first';

-- Allowed values are normalised in the function rather than enforced by a table
-- CHECK, so this migration cannot fail on pre-existing rows.

-- 2. Drop every existing overload ---------------------------------------------

DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'admin_upsert_project_features'
  LOOP
    EXECUTE format('DROP FUNCTION %s', fn);
  END LOOP;
END
$$;

-- 3. Recreate with the full parameter list ------------------------------------

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
  p_treasure boolean DEFAULT false,
  p_guided_tours boolean DEFAULT false,
  p_matterport_navigation boolean DEFAULT false,
  p_companion_model text DEFAULT NULL::text,
  p_walkthrough_mode text DEFAULT NULL::text
)
RETURNS public.navme_project_features
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result public.navme_project_features;
  clean_poi_type text := trim(p_poi_type);
  -- NULL for these two means "caller did not say" — the dashboard only sends a
  -- value when the admin actually picked one.
  clean_model text := lower(NULLIF(trim(COALESCE(p_companion_model, '')), ''));
  clean_walkthrough text := lower(NULLIF(trim(COALESCE(p_walkthrough_mode, '')), ''));
BEGIN
  IF NOT public.verify_navme_superadmin(p_email, p_password) THEN
    RAISE EXCEPTION 'Unauthorized superadmin credentials';
  END IF;

  IF clean_poi_type IS NULL OR clean_poi_type = '' THEN
    RAISE EXCEPTION 'poi_type is required';
  END IF;

  -- Anything unrecognised falls back to the droid rather than erroring: a bad
  -- value must never leave a project with no companion at all.
  IF clean_model IS NOT NULL AND clean_model NOT IN ('guidebot', 'ramanujan') THEN
    clean_model := 'guidebot';
  END IF;

  -- Same rule for the start mode — a bad value must not block the admin save.
  IF clean_walkthrough IS NOT NULL
     AND clean_walkthrough NOT IN ('walkthrough_first', 'ar_first', 'hybrid') THEN
    clean_walkthrough := 'walkthrough_first';
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
    guided_tours,
    matterport_navigation,
    companion_model,
    walkthrough_mode,
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
    p_guided_tours,
    p_matterport_navigation,
    COALESCE(clean_model, 'guidebot'),
    COALESCE(clean_walkthrough, 'walkthrough_first'),
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
    guided_tours = EXCLUDED.guided_tours,
    matterport_navigation = EXCLUDED.matterport_navigation,
    -- NULL means "caller did not say", so keep whatever is already stored.
    companion_model =
      COALESCE(clean_model, navme_project_features.companion_model),
    walkthrough_mode =
      COALESCE(clean_walkthrough, navme_project_features.walkthrough_mode),
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  boolean,
  text, text
) TO anon, authenticated, PUBLIC;

-- PGRST202 is a schema-cache miss, so make PostgREST pick the new signature up
-- immediately instead of waiting for its next reload.
NOTIFY pgrst, 'reload schema';
