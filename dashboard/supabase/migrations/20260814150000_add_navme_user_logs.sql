-- Dashboard activity audit. Written by the SPA after successful mutations
-- (custom email/password auth, so DB triggers cannot identify the actor).
CREATE TABLE IF NOT EXISTS public.navme_user_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  poi_type text,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  actor_account_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  entity_label text,
  created_email text,
  summary text NOT NULL,
  details jsonb
);

CREATE INDEX IF NOT EXISTS navme_user_logs_created_at_idx
  ON public.navme_user_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS navme_user_logs_poi_type_created_at_idx
  ON public.navme_user_logs (poi_type, created_at DESC);

COMMENT ON TABLE public.navme_user_logs IS
  'Editor and access-control activity. Inserted by the dashboard after successful writes.';

ALTER TABLE public.navme_user_logs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON TABLE public.navme_user_logs TO anon;
GRANT SELECT, INSERT ON TABLE public.navme_user_logs TO authenticated;
GRANT ALL ON TABLE public.navme_user_logs TO service_role;

DROP POLICY IF EXISTS navme_user_logs_select_anon ON public.navme_user_logs;
CREATE POLICY navme_user_logs_select_anon
  ON public.navme_user_logs
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS navme_user_logs_insert_anon ON public.navme_user_logs;
CREATE POLICY navme_user_logs_insert_anon
  ON public.navme_user_logs
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
