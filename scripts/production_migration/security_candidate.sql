-- REVIEW-ONLY STAGING CANDIDATE. NOT A PRODUCTION MIGRATION.
-- This intentionally refuses any database other than navme_security_test.
-- The approval-ready production migration must be generated from the reviewed
-- destination backup/copy and reviewed RPC, grant, role, and policy inventory.
-- No credentials, production role membership, or application sessions are created.
-- No legacy navme_*, spatial_*, ConnectLabs, auth, or storage objects are changed.

BEGIN;

DO $preconditions$
DECLARE
    target text;
BEGIN
    IF current_database() <> 'navme_security_test'
       OR current_setting('navme.security_candidate_staging', true) IS DISTINCT FROM 'enabled' THEN
        RAISE EXCEPTION 'Security candidate is restricted to explicitly enabled isolated staging';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navme_wayfinding_backend') THEN
        RAISE EXCEPTION 'Backend group role already exists; review its privileges before proceeding';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        RAISE EXCEPTION 'Staging must contain the browser roles used by the destination';
    END IF;
    FOREACH target IN ARRAY ARRAY[
        'users', 'venues', 'buildings', 'floors', 'pois',
        'control_points', 'nav_graphs', 'map_versions', 'jobs', 'alembic_version'
    ] LOOP
        IF to_regclass(format('public.%I', target)) IS NULL THEN
            RAISE EXCEPTION 'Missing audited staging application table: %', target;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = target) THEN
            RAISE EXCEPTION 'Unexpected existing policy on %; manual reconciliation required', target;
        END IF;
    END LOOP;
END
$preconditions$;

CREATE ROLE navme_wayfinding_backend NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA public TO navme_wayfinding_backend;

DO $scoped_security$
DECLARE
    target text;
    columns_sql text;
    owned_sequence text;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'users', 'venues', 'buildings', 'floors', 'pois',
        'control_points', 'nav_graphs', 'map_versions', 'jobs', 'alembic_version'
    ] LOOP
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated', target);

        -- Table-level REVOKE alone does not remove independent column grants.
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
          INTO columns_sql
          FROM pg_attribute
         WHERE attrelid = to_regclass(format('public.%I', target))
           AND attnum > 0 AND NOT attisdropped;
        EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
                       columns_sql, target);

        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
        IF target = 'alembic_version' THEN
            EXECUTE format('GRANT SELECT ON TABLE public.%I TO navme_wayfinding_backend', target);
            EXECUTE format('CREATE POLICY wayfinding_backend_access ON public.%I FOR SELECT '
                           'TO navme_wayfinding_backend USING (true)', target);
        ELSE
            -- This service principal is confined to the wayfinding backend's
            -- application tables. Public/admin user authorization stays in the
            -- FastAPI backend; this role is never issued in a browser JWT.
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I '
                           'TO navme_wayfinding_backend', target);
            EXECUTE format('CREATE POLICY wayfinding_backend_access ON public.%I FOR ALL '
                           'TO navme_wayfinding_backend USING (true) WITH CHECK (true)', target);
            SELECT pg_get_serial_sequence(format('public.%I', target), 'id') INTO owned_sequence;
            IF owned_sequence IS NOT NULL THEN
                EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC, anon, authenticated', owned_sequence);
                EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO navme_wayfinding_backend', owned_sequence);
            END IF;
        END IF;
    END LOOP;
END
$scoped_security$;

-- Deliberately no GRANT of this role to existing postgres/service_role/browser
-- principals. A future dedicated server login, membership, and TLS credential
-- provision require a separate approved production change and connection test.
COMMIT;
