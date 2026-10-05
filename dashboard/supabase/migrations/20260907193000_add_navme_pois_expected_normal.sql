-- Surface normal at the exact click (for Matterport pin stem tilt on walls).
ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS expected_normal_x numeric,
  ADD COLUMN IF NOT EXISTS expected_normal_y numeric,
  ADD COLUMN IF NOT EXISTS expected_normal_z numeric;

COMMENT ON COLUMN public.navme_pois.expected_normal_x IS
  'Unit normal X at expected click (wall/floor tilt for Showcase stem).';
COMMENT ON COLUMN public.navme_pois.expected_normal_y IS
  'Unit normal Y at expected click (wall/floor tilt for Showcase stem).';
COMMENT ON COLUMN public.navme_pois.expected_normal_z IS
  'Unit normal Z at expected click (wall/floor tilt for Showcase stem).';

UPDATE public.navme_pois
SET
  expected_normal_x = 0,
  expected_normal_y = 1,
  expected_normal_z = 0
WHERE expected_normal_x IS NULL
   OR expected_normal_y IS NULL
   OR expected_normal_z IS NULL;
