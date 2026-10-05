-- Many categories per POI; keep navme_pois.category_type as primary for AR clients.
CREATE TABLE IF NOT EXISTS public.navme_poi_categories (
  poi_id uuid NOT NULL REFERENCES public.navme_pois(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.navme_categories(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poi_id, category_id)
);

CREATE INDEX IF NOT EXISTS navme_poi_categories_category_id_idx
  ON public.navme_poi_categories (category_id);

CREATE INDEX IF NOT EXISTS navme_poi_categories_poi_id_idx
  ON public.navme_poi_categories (poi_id);

INSERT INTO public.navme_poi_categories (poi_id, category_id, sort_order)
SELECT p.id, p.category_type, 0
FROM public.navme_pois p
WHERE p.category_type IS NOT NULL
ON CONFLICT (poi_id, category_id) DO NOTHING;

COMMENT ON TABLE public.navme_poi_categories IS
  'Many-to-many POI categories. navme_pois.category_type remains the primary category for AR clients.';

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.navme_poi_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.navme_poi_categories TO authenticated;
GRANT ALL ON TABLE public.navme_poi_categories TO service_role;
