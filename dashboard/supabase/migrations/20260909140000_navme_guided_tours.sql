ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS guided_tours boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.navme_guided_tours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  poi_type text NOT NULL,
  name text NOT NULL,
  pace text NOT NULL DEFAULT 'standard'
    CHECK (pace IN ('relaxed', 'standard', 'express')),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  approx_distance_m double precision,
  expected_duration_min integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_guided_tours_poi_type_name_key UNIQUE (poi_type, name)
);

CREATE INDEX IF NOT EXISTS navme_guided_tours_poi_type_idx
  ON public.navme_guided_tours (poi_type);

CREATE TABLE IF NOT EXISTS public.navme_guided_tour_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id uuid NOT NULL REFERENCES public.navme_guided_tours(id) ON DELETE CASCADE,
  poi_id uuid NOT NULL REFERENCES public.navme_pois(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_guided_tour_stops_tour_poi_key UNIQUE (tour_id, poi_id)
);

CREATE INDEX IF NOT EXISTS navme_guided_tour_stops_tour_order_idx
  ON public.navme_guided_tour_stops (tour_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_guided_tours TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_guided_tour_stops TO anon, authenticated;
