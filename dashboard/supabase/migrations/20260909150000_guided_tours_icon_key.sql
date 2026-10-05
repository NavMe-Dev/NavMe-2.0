-- Per-tour Lucide icon (same catalog as navme_categories.icon_key).
ALTER TABLE public.navme_guided_tours
  ADD COLUMN IF NOT EXISTS icon_key text NOT NULL DEFAULT 'route';

COMMENT ON COLUMN public.navme_guided_tours.icon_key IS
  'Lucide icon key for the tour card (same catalog as navme_categories.icon_key).';
