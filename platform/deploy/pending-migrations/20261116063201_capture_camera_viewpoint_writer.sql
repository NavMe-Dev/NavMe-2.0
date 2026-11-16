-- PENDING APPROVAL: run only against the platform application database.
-- This is intentionally outside automatic Alembic/Studio migration paths.
-- No application table/column is added. No POI or marker is changed by install.
-- The role starts NOLOGIN: credential provisioning is a separate approved step.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $setup$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navme_camera_viewpoint_writer')
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'navme_camera_viewpoint_private') THEN
        RAISE EXCEPTION 'Camera viewpoint capability already exists; review its ownership and grants before upgrading';
    END IF;
    CREATE ROLE navme_camera_viewpoint_writer NOLOGIN NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2;
END;
$setup$;

CREATE SCHEMA navme_camera_viewpoint_private AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA navme_camera_viewpoint_private FROM PUBLIC;
GRANT USAGE ON SCHEMA navme_camera_viewpoint_private TO navme_camera_viewpoint_writer;

CREATE OR REPLACE FUNCTION navme_camera_viewpoint_private.set_viewpoint(
    p_slug text, p_id integer, p_model_id text, p_viewpoint jsonb, p_revision text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_building_id integer;
    active_model text;
    existing jsonb;
    records jsonb;
    current_record jsonb;
    next_record jsonb;
    current_revision text;
    axis text;
    stamp timestamptz;
BEGIN
    IF p_model_id IS NULL OR p_model_id !~ '^[A-Za-z0-9_-]{1,40}$'
       OR p_revision IS NULL
       OR (p_revision <> 'default' AND p_revision !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
    END IF;

    IF p_viewpoint IS NOT NULL THEN
        IF jsonb_typeof(p_viewpoint) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
        END IF;
        IF (SELECT count(*) FROM jsonb_object_keys(p_viewpoint)) <> 6
           OR NOT (p_viewpoint ?& ARRAY['model_id','sweep_id','camera_position','camera_rotation','floor_id','captured_at'])
           OR jsonb_typeof(p_viewpoint->'model_id') IS DISTINCT FROM 'string'
           OR p_viewpoint->>'model_id' IS DISTINCT FROM p_model_id
           OR jsonb_typeof(p_viewpoint->'sweep_id') IS DISTINCT FROM 'string'
           OR (p_viewpoint->>'sweep_id') !~ '^[A-Za-z0-9_-]{1,128}$'
           OR jsonb_typeof(p_viewpoint->'camera_position') IS DISTINCT FROM 'object'
           OR jsonb_typeof(p_viewpoint->'camera_rotation') IS DISTINCT FROM 'object'
           OR jsonb_typeof(p_viewpoint->'captured_at') IS DISTINCT FROM 'string'
           OR (p_viewpoint->>'captured_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
            RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
        END IF;
        IF (SELECT count(*) FROM jsonb_object_keys(p_viewpoint->'camera_position')) <> 3
           OR NOT ((p_viewpoint->'camera_position') ?& ARRAY['x','y','z'])
           OR (SELECT count(*) FROM jsonb_object_keys(p_viewpoint->'camera_rotation')) <> 2
           OR NOT ((p_viewpoint->'camera_rotation') ?& ARRAY['pitch','yaw']) THEN
            RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
        END IF;
        FOREACH axis IN ARRAY ARRAY['x','y','z'] LOOP
            IF jsonb_typeof(p_viewpoint->'camera_position'->axis) IS DISTINCT FROM 'number' THEN
                RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
            END IF;
            IF abs((p_viewpoint->'camera_position'->>axis)::numeric) > 100000 THEN
                RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
            END IF;
        END LOOP;
        IF jsonb_typeof(p_viewpoint->'camera_rotation'->'pitch') IS DISTINCT FROM 'number'
           OR jsonb_typeof(p_viewpoint->'camera_rotation'->'yaw') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
        END IF;
        IF (p_viewpoint->'camera_rotation'->>'pitch')::numeric NOT BETWEEN -90 AND 90
           OR (p_viewpoint->'camera_rotation'->>'yaw')::numeric NOT BETWEEN -180 AND 180
           OR (p_viewpoint->'floor_id' <> 'null'::jsonb AND (
               jsonb_typeof(p_viewpoint->'floor_id') IS DISTINCT FROM 'string'
               OR length(p_viewpoint->>'floor_id') NOT BETWEEN 1 AND 80
               OR btrim(p_viewpoint->>'floor_id') = ''
               OR btrim(p_viewpoint->>'floor_id') <> p_viewpoint->>'floor_id')) THEN
            RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
        END IF;
        BEGIN
            stamp := (p_viewpoint->>'captured_at')::timestamptz;
            IF NOT isfinite(stamp) THEN
                RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
            END IF;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
            RAISE EXCEPTION 'Invalid captured viewpoint' USING ERRCODE = '22023';
        END;
    END IF;

    -- Hold the model binding stable while locking only the selected POI for update.
    SELECT b.id, b.matterport_model_id INTO v_building_id, active_model
      FROM public.buildings b WHERE b.slug = p_slug FOR SHARE OF b;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Location not found' USING ERRCODE = 'P0002';
    END IF;
    IF active_model IS DISTINCT FROM p_model_id THEN
        RAISE EXCEPTION 'Matterport model changed' USING ERRCODE = '40001';
    END IF;
    SELECT coalesce(p.extra, '{}'::jsonb) INTO existing
      FROM public.pois p WHERE p.id = p_id AND p.building_id = v_building_id
      FOR UPDATE OF p;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Location not found' USING ERRCODE = 'P0002';
    END IF;
    IF jsonb_typeof(existing) IS DISTINCT FROM 'object'
       OR (existing ? 'camera_viewpoints' AND jsonb_typeof(existing->'camera_viewpoints') IS DISTINCT FROM 'object') THEN
        RAISE EXCEPTION 'Invalid stored viewpoint' USING ERRCODE = '22023';
    END IF;
    records := coalesce(existing->'camera_viewpoints', '{}'::jsonb);
    current_record := records->p_model_id;
    current_revision := current_record->>'revision';
    IF current_revision IS NULL OR current_revision !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        current_revision := 'default';
    END IF;
    IF p_revision IS DISTINCT FROM current_revision THEN
        RAISE EXCEPTION 'Viewpoint changed' USING ERRCODE = '40001';
    END IF;

    IF p_viewpoint IS NULL THEN
        next_record := NULL;
    ELSIF current_revision <> 'default' AND current_record->'viewpoint' = p_viewpoint THEN
        next_record := current_record;
    ELSE
        next_record := jsonb_build_object('viewpoint', p_viewpoint, 'revision', gen_random_uuid()::text);
    END IF;
    IF next_record IS DISTINCT FROM current_record THEN
        IF next_record IS NULL THEN
            records := records - p_model_id;
        ELSE
            records := jsonb_set(records, ARRAY[p_model_id], next_record, true);
        END IF;
        UPDATE public.pois p SET extra = CASE WHEN records = '{}'::jsonb
            THEN existing - 'camera_viewpoints'
            ELSE jsonb_set(existing, '{camera_viewpoints}', records, true) END
          WHERE p.id = p_id AND p.building_id = v_building_id;
    END IF;
    RETURN jsonb_build_object('id', p_id, 'model_id', p_model_id,
        'viewpoint', next_record->'viewpoint',
        'revision', coalesce(next_record->>'revision', 'default'),
        'status', CASE WHEN next_record IS NOT NULL THEN 'saved'
                       WHEN records <> '{}'::jsonb THEN 'incompatible' ELSE 'none' END);
END;
$function$;

REVOKE ALL ON FUNCTION navme_camera_viewpoint_private.set_viewpoint(text,integer,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION navme_camera_viewpoint_private.set_viewpoint(text,integer,text,jsonb,text)
    TO navme_camera_viewpoint_writer;
COMMENT ON FUNCTION navme_camera_viewpoint_private.set_viewpoint(text,integer,text,jsonb,text)
    IS 'Private camera-viewpoint-only capability; never exposed through the public Data API. Administrator authentication is enforced by the platform API.';
COMMIT;
