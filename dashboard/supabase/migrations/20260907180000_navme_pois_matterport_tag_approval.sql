-- Link accepted NavMe POIs to Matterport Mattertags; pending tags are API-only until accept.
ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS matterport_tag_id text,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'accepted';

COMMENT ON COLUMN public.navme_pois.matterport_tag_id IS
  'Matterport Mattertag id when POI was accepted from a space tag';
COMMENT ON COLUMN public.navme_pois.approval_status IS
  'accepted | rejected. Pending Matterport tags are not rows until accept.';

CREATE UNIQUE INDEX IF NOT EXISTS navme_pois_matterport_tag_id_uidx
  ON public.navme_pois (matterport_tag_id)
  WHERE matterport_tag_id IS NOT NULL;
