-- Dashboard uses the Supabase anon key for facility CRUD (same as navme_pois / navme_categories).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_facilities TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_facilities TO authenticated;
