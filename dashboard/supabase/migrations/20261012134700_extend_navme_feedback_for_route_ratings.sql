-- Extends the existing navme_feedback table (already used for a general free-text
-- feedback form) to also capture thumbs up/down route ratings from the wayfinding
-- viewer's "Destination reached" card — reusing the same table the user already has
-- for feedback, rather than a new one. All new columns nullable so the existing
-- free-text-feedback usage is completely unaffected.
ALTER TABLE public.navme_feedback
  ADD COLUMN IF NOT EXISTS rating text,          -- 'up' | 'down'
  ADD COLUMN IF NOT EXISTS context text,         -- 'walkthrough_wayfinding' | 'tour_interior' | 'start_preview'
  ADD COLUMN IF NOT EXISTS route_from text,      -- origin POI name
  ADD COLUMN IF NOT EXISTS route_to text,        -- destination POI name
  ADD COLUMN IF NOT EXISTS poi_type text,        -- tenant key, matches navme_pois.poi_type
  ADD COLUMN IF NOT EXISTS building_slug text;   -- wayfinding slug, for direct filtering

COMMENT ON COLUMN public.navme_feedback.rating IS 'Thumbs up/down on a completed route ("up"/"down"); null for the older free-text feedback form.';
COMMENT ON COLUMN public.navme_feedback.context IS 'Which viewer feature the rating came from: walkthrough_wayfinding, tour_interior, or start_preview.';
