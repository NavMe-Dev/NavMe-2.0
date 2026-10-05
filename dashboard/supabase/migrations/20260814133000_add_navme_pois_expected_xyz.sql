-- Original click XYZ vs snapped/placed XYZ on navme_pois.
ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS expected_pos_x numeric,
  ADD COLUMN IF NOT EXISTS expected_pos_y numeric,
  ADD COLUMN IF NOT EXISTS expected_pos_z numeric;

COMMENT ON COLUMN public.navme_pois.expected_pos_x IS
  'Original click X. Same as pos_x when placed on the navmesh; the raw off-mesh click when pos was snapped onto the mesh.';
COMMENT ON COLUMN public.navme_pois.expected_pos_y IS
  'Original click Y. Same as pos_y when placed on the navmesh; the raw off-mesh click when pos was snapped onto the mesh.';
COMMENT ON COLUMN public.navme_pois.expected_pos_z IS
  'Original click Z. Same as pos_z when placed on the navmesh; the raw off-mesh click when pos was snapped onto the mesh.';

UPDATE public.navme_pois
SET
  expected_pos_x = pos_x,
  expected_pos_y = pos_y,
  expected_pos_z = pos_z
WHERE expected_pos_x IS NULL
   OR expected_pos_y IS NULL
   OR expected_pos_z IS NULL;
