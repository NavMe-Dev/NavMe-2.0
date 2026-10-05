-- POI floors per project (poi_type): Y-slice height + display name.
-- Super admin creates floors; POIs reference floor_id.

CREATE TABLE IF NOT EXISTS public.navme_floors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  poi_type text NOT NULL,
  name text NOT NULL,
  slice_y double precision NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_floors_poi_type_name_key UNIQUE (poi_type, name)
);

CREATE INDEX IF NOT EXISTS navme_floors_poi_type_idx
  ON public.navme_floors (poi_type);

ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS floor_id uuid REFERENCES public.navme_floors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS navme_pois_floor_id_idx
  ON public.navme_pois (floor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_floors TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_floors TO authenticated;
