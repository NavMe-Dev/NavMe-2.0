-- NavMe GMap Structure
-- Adds navme_gmap_enabled feature flag + navme_gmap_ tables.
-- GLBs stay on the wayfinding server filesystem; only metadata lives here.

-- 1. Feature flag

ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS navme_gmap_enabled boolean NOT NULL DEFAULT false;

-- 2. Core tables

CREATE TABLE IF NOT EXISTS public.navme_gmap_buildings (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_type       text        NOT NULL UNIQUE,
  account_email  text        NOT NULL,
  slug           text        NOT NULL UNIQUE,
  matterport_sid text,
  provisioned    boolean     NOT NULL DEFAULT false,
  provisioned_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.navme_gmap_floors (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid        NOT NULL REFERENCES public.navme_gmap_buildings(id) ON DELETE CASCADE,
  floor_id    text        NOT NULL,
  label       text        NOT NULL,
  ordinal     integer     NOT NULL DEFAULT 0,
  elevation   float8      NOT NULL DEFAULT 0,
  glb_filename text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (building_id, floor_id)
);

CREATE TABLE IF NOT EXISTS public.navme_gmap_pois (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid        NOT NULL REFERENCES public.navme_gmap_buildings(id) ON DELETE CASCADE,
  floor_id    text        NOT NULL,
  label       text        NOT NULL,
  category    text,
  x           float8      NOT NULL,
  y           float8      NOT NULL,
  z           float8      NOT NULL DEFAULT 0,
  metadata    jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.navme_gmap_georef (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id      uuid        NOT NULL REFERENCES public.navme_gmap_buildings(id) ON DELETE CASCADE UNIQUE,
  model_origin_lon float8      NOT NULL,
  model_origin_lat float8      NOT NULL,
  affine_a         float8      NOT NULL DEFAULT 1,
  affine_b         float8      NOT NULL DEFAULT 0,
  affine_tx        float8      NOT NULL DEFAULT 0,
  affine_c         float8      NOT NULL DEFAULT 0,
  affine_d         float8      NOT NULL DEFAULT 1,
  affine_ty        float8      NOT NULL DEFAULT 0,
  grade_z          float8      NOT NULL DEFAULT 0.5,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.navme_gmap_navmesh (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id  uuid        NOT NULL REFERENCES public.navme_gmap_buildings(id) ON DELETE CASCADE UNIQUE,
  navmesh_json jsonb       NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 3. RLS

ALTER TABLE public.navme_gmap_buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.navme_gmap_floors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.navme_gmap_pois      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.navme_gmap_georef    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.navme_gmap_navmesh   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "navme_gmap_buildings_deny" ON public.navme_gmap_buildings FOR ALL USING (false);
CREATE POLICY "navme_gmap_floors_deny"    ON public.navme_gmap_floors    FOR ALL USING (false);
CREATE POLICY "navme_gmap_pois_deny"      ON public.navme_gmap_pois      FOR ALL USING (false);
CREATE POLICY "navme_gmap_georef_deny"    ON public.navme_gmap_georef    FOR ALL USING (false);
CREATE POLICY "navme_gmap_navmesh_deny"   ON public.navme_gmap_navmesh   FOR ALL USING (false);

-- 4. Drop old admin_upsert_project_features before redefining with new param

DROP FUNCTION IF EXISTS public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  boolean,
  text, text
);

CREATE FUNCTION public.admin_upsert_project_features(
  p_email                text,
  p_password             text,
  p_poi_type             text,
  p_login_id             uuid,
  p_people_search        boolean,
  p_save_location        boolean,
  p_block_enabled        boolean,
  p_mini3d_gta_embed     boolean,
  p_custom_media         boolean,
  p_assistant            boolean,
  p_snapshot             boolean,
  p_whatsapp             boolean,
  p_feedback             boolean,
  p_languages            boolean,
  p_fps_display          boolean,
  p_localization_display boolean,
  p_navme_robo_companion boolean,
  p_facilities           boolean,
  p_treasure             boolean,
  p_guided_tours         boolean,
  p_matterport_navigation boolean,
  p_navme_gmap_enabled   boolean,
  p_companion_model      text DEFAULT NULL,
  p_walkthrough_mode     text DEFAULT NULL
)
RETURNS public.navme_project_features
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  authed        public.navme_accounts%ROWTYPE;
  clean_model   text;
  clean_walk    text;
  result        public.navme_project_features%ROWTYPE;
BEGIN
  SELECT * INTO authed FROM public.navme_accounts
  WHERE email = lower(trim(p_email))
    AND password = p_password
    AND is_active = true
    AND is_superadmin = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  clean_model := CASE
    WHEN p_companion_model IN ('guidebot','ramanujan') THEN p_companion_model
    ELSE NULL
  END;

  clean_walk := CASE
    WHEN p_walkthrough_mode IN ('walkthrough_first','ar_first','hybrid') THEN p_walkthrough_mode
    ELSE NULL
  END;

  INSERT INTO public.navme_project_features (
    poi_type, login_id,
    people_search, save_location, block_enabled, mini3d_gta_embed,
    custom_media, assistant, snapshot, whatsapp, feedback, languages,
    fps_display, localization_display, navme_robo_companion, facilities,
    treasure, guided_tours, matterport_navigation, navme_gmap_enabled,
    companion_model, walkthrough_mode
  ) VALUES (
    p_poi_type, p_login_id,
    p_people_search, p_save_location, p_block_enabled, p_mini3d_gta_embed,
    p_custom_media, p_assistant, p_snapshot, p_whatsapp, p_feedback, p_languages,
    p_fps_display, p_localization_display, p_navme_robo_companion, p_facilities,
    p_treasure, p_guided_tours, p_matterport_navigation, p_navme_gmap_enabled,
    COALESCE(clean_model, 'guidebot'), COALESCE(clean_walk, 'walkthrough_first')
  )
  ON CONFLICT (poi_type) DO UPDATE SET
    login_id              = EXCLUDED.login_id,
    people_search         = EXCLUDED.people_search,
    save_location         = EXCLUDED.save_location,
    block_enabled         = EXCLUDED.block_enabled,
    mini3d_gta_embed      = EXCLUDED.mini3d_gta_embed,
    custom_media          = EXCLUDED.custom_media,
    assistant             = EXCLUDED.assistant,
    snapshot              = EXCLUDED.snapshot,
    whatsapp              = EXCLUDED.whatsapp,
    feedback              = EXCLUDED.feedback,
    languages             = EXCLUDED.languages,
    fps_display           = EXCLUDED.fps_display,
    localization_display  = EXCLUDED.localization_display,
    navme_robo_companion  = EXCLUDED.navme_robo_companion,
    facilities            = EXCLUDED.facilities,
    treasure              = EXCLUDED.treasure,
    guided_tours          = EXCLUDED.guided_tours,
    matterport_navigation = EXCLUDED.matterport_navigation,
    navme_gmap_enabled    = EXCLUDED.navme_gmap_enabled,
    companion_model       = COALESCE(clean_model, navme_project_features.companion_model),
    walkthrough_mode      = COALESCE(clean_walk, navme_project_features.walkthrough_mode),
    updated_at            = now();

  SELECT * INTO result FROM public.navme_project_features WHERE poi_type = p_poi_type;
  RETURN result;
END;
$$;

-- 5. GMap RPCs

CREATE OR REPLACE FUNCTION public.admin_gmap_upsert_building(
  p_email          text,
  p_password       text,
  p_poi_type       text,
  p_account_email  text,
  p_slug           text,
  p_matterport_sid text DEFAULT NULL
)
RETURNS public.navme_gmap_buildings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  authed public.navme_accounts%ROWTYPE;
  result public.navme_gmap_buildings%ROWTYPE;
BEGIN
  SELECT * INTO authed FROM public.navme_accounts
  WHERE email = lower(trim(p_email)) AND password = p_password
    AND is_active = true AND is_superadmin = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  INSERT INTO public.navme_gmap_buildings (poi_type, account_email, slug, matterport_sid)
  VALUES (p_poi_type, p_account_email, p_slug, p_matterport_sid)
  ON CONFLICT (poi_type) DO UPDATE SET
    account_email  = EXCLUDED.account_email,
    slug           = EXCLUDED.slug,
    matterport_sid = COALESCE(EXCLUDED.matterport_sid, navme_gmap_buildings.matterport_sid),
    updated_at     = now();

  SELECT * INTO result FROM public.navme_gmap_buildings WHERE poi_type = p_poi_type;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_gmap_get_building(
  p_email    text,
  p_password text,
  p_poi_type text
)
RETURNS public.navme_gmap_buildings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  authed public.navme_accounts%ROWTYPE;
  result public.navme_gmap_buildings%ROWTYPE;
BEGIN
  SELECT * INTO authed FROM public.navme_accounts
  WHERE email = lower(trim(p_email)) AND password = p_password
    AND is_active = true AND is_superadmin = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  SELECT * INTO result FROM public.navme_gmap_buildings WHERE poi_type = p_poi_type;
  RETURN result;
END;
$$;

-- 6. Grants

GRANT EXECUTE ON FUNCTION public.admin_upsert_project_features(
  text, text, text, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  boolean, boolean,
  text, text
) TO anon, authenticated, PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_gmap_upsert_building(text, text, text, text, text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_gmap_get_building(text, text, text) TO anon, authenticated, PUBLIC;

NOTIFY pgrst, 'reload schema';
