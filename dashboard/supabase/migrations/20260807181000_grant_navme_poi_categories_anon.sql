-- Match navme_pois grants so dashboard (anon key) can manage multi-category links.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.navme_poi_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.navme_poi_categories TO authenticated;
GRANT ALL ON TABLE public.navme_poi_categories TO service_role;
