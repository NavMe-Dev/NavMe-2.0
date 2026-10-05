-- NavMe RBAC: accounts + project memberships (one project_admin per poi_type)

CREATE TABLE IF NOT EXISTS public.navme_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password text NOT NULL,
  display_name text,
  is_superadmin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_accounts_email_unique UNIQUE (email)
);

CREATE UNIQUE INDEX IF NOT EXISTS navme_accounts_email_ci_idx
  ON public.navme_accounts (lower(trim(email)));

CREATE TABLE IF NOT EXISTS public.navme_project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.navme_accounts(id) ON DELETE CASCADE,
  poi_type text NOT NULL,
  role text NOT NULL CHECK (role IN ('project_admin', 'sub_admin')),
  created_by uuid REFERENCES public.navme_accounts(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One active membership per account
CREATE UNIQUE INDEX IF NOT EXISTS navme_project_members_one_active_account
  ON public.navme_project_members (account_id)
  WHERE is_active;

-- One active project_admin per poi_type
CREATE UNIQUE INDEX IF NOT EXISTS navme_project_members_one_project_admin
  ON public.navme_project_members (lower(trim(poi_type)))
  WHERE is_active AND role = 'project_admin';

CREATE INDEX IF NOT EXISTS navme_project_members_poi_type_idx
  ON public.navme_project_members (poi_type);

COMMENT ON TABLE public.navme_accounts IS
  'Dashboard login identities for NavMe RBAC (superadmin / project admin / sub-admin).';
COMMENT ON TABLE public.navme_project_members IS
  'Binds an account to exactly one poi_type with role project_admin or sub_admin.';

-- Seed superadmin account from existing login email if present
INSERT INTO public.navme_accounts (email, password, display_name, is_superadmin)
SELECT lower(trim(l.email)), l.password, 'Superadmin', true
FROM public.navme_logins l
WHERE lower(trim(l.email)) = 'superadmin@navme.space'
ON CONFLICT (email) DO UPDATE
SET is_superadmin = true,
    password = EXCLUDED.password,
    updated_at = now();

-- One account per distinct email (latest login row wins on conflict password)
INSERT INTO public.navme_accounts (email, password, display_name, is_superadmin)
SELECT DISTINCT ON (lower(trim(l.email)))
  lower(trim(l.email)),
  l.password,
  split_part(l.email, '@', 1),
  false
FROM public.navme_logins l
WHERE lower(trim(l.email)) <> 'superadmin@navme.space'
  AND nullif(trim(l.poi_type), '') IS NOT NULL
ORDER BY lower(trim(l.email)), l.created_at DESC NULLS LAST
ON CONFLICT (email) DO NOTHING;

-- One project_admin per poi_type from that project's primary login email.
-- If an email is primary for multiple poi_types, seed only one membership
-- (other projects get an admin via superadmin assign later).
WITH primary_per_poi AS (
  SELECT DISTINCT ON (lower(trim(l.poi_type)))
    lower(trim(l.email)) AS email_key,
    trim(l.poi_type) AS poi_type
  FROM public.navme_logins l
  WHERE lower(trim(l.email)) <> 'superadmin@navme.space'
    AND nullif(trim(l.poi_type), '') IS NOT NULL
  ORDER BY lower(trim(l.poi_type)), l.created_at DESC NULLS LAST
),
seed_rows AS (
  SELECT DISTINCT ON (email_key)
    email_key,
    poi_type
  FROM primary_per_poi
  ORDER BY email_key, poi_type
)
INSERT INTO public.navme_project_members (account_id, poi_type, role, is_active)
SELECT a.id, s.poi_type, 'project_admin', true
FROM seed_rows s
JOIN public.navme_accounts a ON lower(trim(a.email)) = s.email_key
WHERE NOT EXISTS (
  SELECT 1 FROM public.navme_project_members m
  WHERE m.account_id = a.id AND m.is_active
)
AND NOT EXISTS (
  SELECT 1 FROM public.navme_project_members m2
  WHERE lower(trim(m2.poi_type)) = lower(trim(s.poi_type))
    AND m2.role = 'project_admin'
    AND m2.is_active
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.navme_accounts TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.navme_project_members TO anon, authenticated;
