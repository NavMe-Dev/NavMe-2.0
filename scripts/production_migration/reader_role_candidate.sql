-- REVIEW-ONLY STAGING CANDIDATE: SELECT-only role for an unchanged public viewer.
-- No production application data is inserted, updated, deleted, or reconciled.
-- No login password, legacy ACL change, or browser role membership is created.
BEGIN;

DO $guard$
BEGIN
    IF current_database() NOT IN ('navme_security_test', 'navme_reader_test', 'navme_destination_restore_test')
       OR current_setting('navme.reader_role_staging', true) IS DISTINCT FROM 'enabled' THEN
        RAISE EXCEPTION 'Reader candidate is restricted to explicitly enabled isolated staging';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navme_wayfinding_public_reader_v1') THEN
        RAISE EXCEPTION 'Reader role already exists; review before proceeding';
    END IF;
END
$guard$;

CREATE ROLE navme_wayfinding_public_reader_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA public TO navme_wayfinding_public_reader_v1;

DO $reader$
DECLARE
    target text;
BEGIN
    IF has_schema_privilege('navme_wayfinding_public_reader_v1', 'public', 'CREATE')
       OR has_database_privilege('navme_wayfinding_public_reader_v1', current_database(), 'CREATE') THEN
        RAISE EXCEPTION 'Inherited schema/database creation privilege makes the reader unsafe';
    END IF;
    FOREACH target IN ARRAY ARRAY[
        'users', 'venues', 'buildings', 'floors', 'pois', 'control_points',
        'nav_graphs', 'map_versions', 'jobs', 'alembic_version'
    ] LOOP
        IF to_regclass(format('public.%I', target)) IS NULL THEN
            RAISE EXCEPTION 'Required backend table is absent: %', target;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                   AND tablename=target AND policyname='wayfinding_public_reader_select') THEN
            RAISE EXCEPTION 'Reader policy already exists on %; review before proceeding', target;
        END IF;
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
        EXECUTE format('GRANT SELECT ON TABLE public.%I TO navme_wayfinding_public_reader_v1', target);
        EXECUTE format('CREATE POLICY wayfinding_public_reader_select ON public.%I FOR SELECT '
                       'TO navme_wayfinding_public_reader_v1 USING (true)', target);
        IF has_table_privilege('navme_wayfinding_public_reader_v1', format('public.%I', target),
                               'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
            RAISE EXCEPTION 'Inherited table mutation privilege makes the reader unsafe: %', target;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relkind IN ('r','p','v','m','f')
           AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
           AND has_schema_privilege('navme_wayfinding_public_reader_v1', n.oid, 'USAGE')
           AND has_table_privilege('navme_wayfinding_public_reader_v1', c.oid,
                                   'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           AND NOT (n.nspname='public' AND c.relname IN (
               'users','venues','buildings','floors','pois','control_points',
               'nav_graphs','map_versions','jobs','alembic_version'))
           AND NOT (n.nspname='public' AND c.relname IN ('spatial_ref_sys','geometry_columns','geography_columns')
                    AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
                                 WHERE d.classid='pg_class'::regclass AND d.objid=c.oid
                                   AND d.deptype='e' AND e.extname='postgis'))
    ) THEN
        RAISE EXCEPTION 'Inherited access to unrelated application objects makes the reader unsafe';
    END IF;

    -- PostgreSQL has no per-role DENY over PUBLIC grants. Abort if any reachable
    -- SECURITY DEFINER function would extend the role beyond read-only access.
    -- Only the three audited PostGIS statistics-helper overloads are permitted;
    -- extension membership is checked so a same-name application RPC cannot pass.
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE p.prosecdef
           AND has_schema_privilege('navme_wayfinding_public_reader_v1', n.oid, 'USAGE')
           AND has_function_privilege('navme_wayfinding_public_reader_v1', p.oid, 'EXECUTE')
           AND NOT (
               n.nspname='public' AND p.proname='st_estimatedextent'
               AND oidvectortypes(p.proargtypes) IN ('text, text', 'text, text, text', 'text, text, text, boolean')
               AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
                            WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
                              AND d.deptype='e' AND e.extname='postgis')
           )
    ) THEN
        RAISE EXCEPTION 'An unaudited SECURITY DEFINER function is reachable by the reader';
    END IF;
END
$reader$;

-- Future approved login provisioning must use a unique private credential, no
-- ownership/BYPASSRLS, and membership only in this group. Settings on a NOLOGIN
-- group do not become login defaults: enforce readonly on the concrete login
-- and through the application's verified session initializer + WF_READ_ONLY.
COMMIT;
