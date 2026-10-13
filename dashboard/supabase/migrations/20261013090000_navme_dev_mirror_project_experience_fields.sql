-- Targets navme_dev (wpyodawmrawcyriklvji), NOT the main NavMe Dashboard project.
--
-- platform/api was reading navme_project_features (experience_ref, walkthrough_url) from
-- the OTHER Supabase project (znfwcohrpkiccibqcfpn) via hardcoded constants, even though
-- every other table platform/api reads lives in navme_dev. navme_dev already had its own
-- navme_project_features table (a near-complete mirror, same GCU row) but was missing
-- these two columns. Adding them here and backfilling GCU's values to match production
-- lets platform/api read everything from navme_dev exclusively, per explicit instruction:
-- the "metadigilabs"/production project is left untouched, this is purely additive here.

ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS experience_ref text;

ALTER TABLE public.navme_project_features
  ADD COLUMN IF NOT EXISTS walkthrough_url text;

COMMENT ON COLUMN public.navme_project_features.experience_ref IS
  'Compact Zappar "host.spaceId" ref used to build share.navme.space/<slug>?p=<poiId>&x=<ref> AR deep links.';

COMMENT ON COLUMN public.navme_project_features.walkthrough_url IS
  'The wayfinding viewer URL to open for this project (e.g. https://wayfinding.navme.space/?b=gcu&mp=1) when walkthrough_mode is walkthrough_first, or hybrid on a non-iOS device.';

UPDATE public.navme_project_features
SET experience_ref = 'r77z2.7069996602396526792',
    walkthrough_url = 'https://wayfinding.navme.space/?b=gcu&mp=1'
WHERE poi_type = 'GCU';

-- Note: the 136 navme_pois rows that existed in production but not in navme_dev for
-- poi_type=GCU (235 total vs 99) were synced separately via a one-off script (full row
-- copy, no schema change), not tracked as a SQL migration here since it's a data sync,
-- not a schema change. Both projects now report 235 GCU POIs.
