-- POI categories per project (poi_type) with SVG icon keys for the dashboard UI.

CREATE TABLE IF NOT EXISTS public.navme_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  poi_type text NOT NULL,
  name text NOT NULL,
  icon_key text NOT NULL DEFAULT 'map-pin',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_categories_poi_type_name_key UNIQUE (poi_type, name)
);

CREATE INDEX IF NOT EXISTS navme_categories_poi_type_idx
  ON public.navme_categories (poi_type);

ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS category_type uuid REFERENCES public.navme_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS navme_pois_category_type_idx
  ON public.navme_pois (category_type);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_categories TO authenticated;
