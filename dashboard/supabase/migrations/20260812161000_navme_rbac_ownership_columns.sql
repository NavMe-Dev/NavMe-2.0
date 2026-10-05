-- Ownership for RBAC visibility (nullable = legacy project-owned)

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'navme_pois',
    'navme_media',
    'navme_facilities',
    'navme_categories',
    'navme_blocks'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.navme_accounts(id) ON DELETE SET NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.navme_accounts(id) ON DELETE SET NULL',
      t
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (created_by)',
      t || '_created_by_idx', t
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (assigned_to)',
      t || '_assigned_to_idx', t
    );
  END LOOP;
END $$;
