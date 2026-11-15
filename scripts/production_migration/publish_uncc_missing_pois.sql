-- Publish only the 27 missing UNC Charlotte viewer mirrors, 2026-11-16.
-- Canonical input: destination public.navme_pois, exact poi_type Uncc_Navme.
-- Existing corrected mirrors, publication, building and navigation stay intact.
-- Rehearsal: replace the final COMMIT with ROLLBACK. Sequence allocations are
-- not transactional, so a rehearsal can leave harmless gaps in pois_id_seq.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog, public, pg_temp;

LOCK TABLE public.pois IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.buildings, public.map_versions,
           public.navme_pois, public.navme_categories, public.navme_floors
    IN SHARE MODE;

CREATE TEMP TABLE uncc_publish_before ON COMMIT DROP AS
    SELECT to_jsonb(p) AS row_data FROM public.pois p;

CREATE TEMP TABLE uncc_publish_context_before ON COMMIT DROP AS
    SELECT 'buildings'::text AS relation_name, to_jsonb(b) AS row_data FROM public.buildings b
    UNION ALL
    SELECT 'map_versions', to_jsonb(v) FROM public.map_versions v;

CREATE TEMP TABLE uncc_publish_result (
    count_before bigint,
    inserted bigint,
    count_after bigint,
    canonical_count bigint,
    existing_rows_preserved boolean
) ON COMMIT DROP;

DO $publish_uncc$
DECLARE
    building_id_verified integer;
    geo jsonb;
    affine jsonb;
    coefficient jsonb;
    a00 double precision;
    a01 double precision;
    a02 double precision;
    a10 double precision;
    a11 double precision;
    a12 double precision;
    before_count bigint;
    after_count bigint;
    inserted_count bigint;
    expected_insert_count bigint;
BEGIN
    IF (SELECT count(*) FROM public.buildings WHERE slug = 'uncc-main-campus') <> 1 THEN
        RAISE EXCEPTION 'Expected exactly one UNC Charlotte building';
    END IF;
    SELECT b.id, b.georef
      INTO building_id_verified, geo
      FROM public.buildings b
     WHERE b.slug = 'uncc-main-campus'
       AND b.id = 3
       AND b.matterport_model_id = 'kQBN52JqFE9'
       AND b.status = 'published'
       AND b.pipeline_config->>'navme_poi_type' = 'Uncc_Navme';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'UNC Charlotte building identity or dashboard mapping changed';
    END IF;
    IF (SELECT count(*) FROM public.map_versions
         WHERE building_id = building_id_verified AND is_current) <> 1
       OR NOT EXISTS (
           SELECT 1 FROM public.map_versions
            WHERE building_id = building_id_verified AND is_current AND version = 2
       ) THEN
        RAISE EXCEPTION 'Expected exactly one current authentic UNCC v2 publication';
    END IF;

    affine := geo->'model_to_epsg3857_affine';
    IF jsonb_typeof(affine) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'UNCC affine transform is missing';
    END IF;
    IF jsonb_array_length(affine) <> 2
       OR jsonb_typeof(affine->0) IS DISTINCT FROM 'array'
       OR jsonb_typeof(affine->1) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Expected a two-row UNCC affine transform';
    END IF;
    IF jsonb_array_length(affine->0) <> 3 OR jsonb_array_length(affine->1) <> 3 THEN
        RAISE EXCEPTION 'Expected three coefficients per UNCC affine row';
    END IF;
    FOR coefficient IN
        SELECT value FROM jsonb_array_elements(affine->0)
        UNION ALL
        SELECT value FROM jsonb_array_elements(affine->1)
    LOOP
        IF jsonb_typeof(coefficient) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'UNCC affine coefficients must be numeric';
        END IF;
    END LOOP;
    a00 := (affine#>>'{0,0}')::double precision;
    a01 := (affine#>>'{0,1}')::double precision;
    a02 := (affine#>>'{0,2}')::double precision;
    a10 := (affine#>>'{1,0}')::double precision;
    a11 := (affine#>>'{1,1}')::double precision;
    a12 := (affine#>>'{1,2}')::double precision;
    IF abs(a00 * a11 - a01 * a10) < 1e-12 THEN
        RAISE EXCEPTION 'UNCC affine transform is singular';
    END IF;

    IF (SELECT count(*) FROM public.navme_pois
         WHERE poi_type = 'Uncc_Navme' AND is_active) <> 47 THEN
        RAISE EXCEPTION 'Expected exactly 47 active canonical UNC Charlotte POIs';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.navme_pois p
         WHERE p.poi_type = 'Uncc_Navme' AND p.is_active
           AND (p.id IS NULL OR nullif(btrim(p.poi_name), '') IS NULL
                OR p.pos_x IS NULL OR p.pos_y IS NULL OR p.pos_z IS NULL
                OR p.pos_x::text IN ('NaN', 'Infinity', '-Infinity')
                OR p.pos_y::text IN ('NaN', 'Infinity', '-Infinity')
                OR p.pos_z::text IN ('NaN', 'Infinity', '-Infinity'))
    ) THEN
        RAISE EXCEPTION 'Canonical UNC Charlotte names or positions are invalid';
    END IF;
    IF (SELECT count(DISTINCT id) FROM public.navme_pois
         WHERE poi_type = 'Uncc_Navme' AND is_active) <> 47 THEN
        RAISE EXCEPTION 'Canonical UNC Charlotte source IDs are not unique';
    END IF;
    -- Null references retain the established General/F1 fallbacks. Non-null
    -- references must resolve exactly once within this dashboard project.
    IF EXISTS (
        SELECT 1 FROM public.navme_pois p
         WHERE p.poi_type = 'Uncc_Navme' AND p.is_active
           AND ((p.category_type IS NOT NULL AND
                 (SELECT count(*) FROM public.navme_categories c
                   WHERE c.id = p.category_type AND c.poi_type = p.poi_type) <> 1)
             OR (p.floor_id IS NOT NULL AND
                 (SELECT count(*) FROM public.navme_floors f
                   WHERE f.id = p.floor_id AND f.poi_type = p.poi_type) <> 1))
    ) THEN
        RAISE EXCEPTION 'Canonical UNC Charlotte category or floor reference is orphaned or ambiguous';
    END IF;

    CREATE TEMP TABLE uncc_publish_source ON COMMIT DROP AS
        SELECT p.id::text AS source_id,
               'gmap_' || replace(p.id::text, '-', '_') AS mirror_key,
               btrim(p.poi_name) AS name,
               lower(btrim(coalesce(c.name, 'General'))) AS category,
               coalesce(f.name, 'F1') AS floor,
               p.pos_x, p.pos_y, p.pos_z,
               p.expected_pos_x, p.expected_pos_y, p.expected_pos_z
          FROM public.navme_pois p
          LEFT JOIN public.navme_categories c
            ON c.id = p.category_type AND c.poi_type = p.poi_type
          LEFT JOIN public.navme_floors f
            ON f.id = p.floor_id AND f.poi_type = p.poi_type
         WHERE p.poi_type = 'Uncc_Navme' AND p.is_active;
    IF (SELECT count(*) FROM pg_temp.uncc_publish_source) <> 47 THEN
        RAISE EXCEPTION 'Canonical UNC Charlotte projection changed row multiplicity';
    END IF;

    -- Include historical sb_ keys and nested source metadata when recognizing
    -- existing mirrors; never insert a second identity beside a legacy key.
    CREATE TEMP TABLE uncc_publish_matches_before ON COMMIT DROP AS
        SELECT s.source_id, p.id AS mirror_id
          FROM pg_temp.uncc_publish_source s
          JOIN public.pois p ON p.building_id = building_id_verified
           AND (p.extra->>'gmap_src_id' = s.source_id
             OR p.extra#>>'{gmap_metadata,src_id}' = s.source_id
             OR p.key = s.mirror_key
             OR p.key = 'sb_' || s.source_id
             OR p.key = 'sb_' || replace(s.source_id, '-', '_'));
    IF EXISTS (SELECT 1 FROM pg_temp.uncc_publish_matches_before
                GROUP BY source_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM pg_temp.uncc_publish_matches_before
                   GROUP BY mirror_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Existing UNC Charlotte mirrors have ambiguous or duplicate source identities';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_temp.uncc_publish_matches_before m
        JOIN public.pois p ON p.id = m.mirror_id
         WHERE p.source IS DISTINCT FROM 'supabase' OR p.published IS DISTINCT FROM true
    ) THEN
        RAISE EXCEPTION 'A canonical UNC Charlotte identity already exists outside the published mirror';
    END IF;
    SELECT count(*) INTO before_count FROM public.pois
     WHERE building_id = building_id_verified AND source = 'supabase' AND published;
    IF before_count NOT IN (20, 47)
       OR (SELECT count(*) FROM pg_temp.uncc_publish_matches_before) <> before_count THEN
        RAISE EXCEPTION 'Expected exactly the reviewed 20 mirrors or the completed 47 mirrors';
    END IF;
    IF (SELECT count(*) FROM public.pois) <> 250 + (before_count - 20) THEN
        RAISE EXCEPTION 'The reviewed all-building POI count changed';
    END IF;
    expected_insert_count := 47 - before_count;

    INSERT INTO public.pois
        (building_id, key, name, category, floor, geom,
         model_x, model_y, model_z, published, source, locked, extra, updated_at)
    SELECT building_id_verified, s.mirror_key, s.name, s.category, s.floor,
           public.ST_Transform(public.ST_SetSRID(public.ST_MakePoint(
               a00 * s.pos_x - a01 * s.pos_z + a02,
               a10 * s.pos_x - a11 * s.pos_z + a12), 3857), 4326),
           s.pos_x, s.pos_y, s.pos_z, true, 'supabase', false,
           jsonb_build_object(
               'gmap_poi_type', 'Uncc_Navme', 'gmap_src_id', s.source_id,
               'gmap_metadata', jsonb_build_object('src_id', s.source_id),
               'expected_pos_x', s.expected_pos_x,
               'expected_pos_y', s.expected_pos_y,
               'expected_pos_z', s.expected_pos_z), now()
      FROM pg_temp.uncc_publish_source s
     WHERE NOT EXISTS (
         SELECT 1 FROM pg_temp.uncc_publish_matches_before m
          WHERE m.source_id = s.source_id
     )
     ORDER BY s.source_id;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count <> expected_insert_count THEN
        RAISE EXCEPTION 'Inserted UNC Charlotte mirror count differs from the reviewed missing set';
    END IF;

    CREATE TEMP TABLE uncc_publish_matches_after ON COMMIT DROP AS
        SELECT s.source_id, p.id AS mirror_id
          FROM pg_temp.uncc_publish_source s
          JOIN public.pois p ON p.building_id = building_id_verified
           AND p.source = 'supabase' AND p.published
           AND (p.extra->>'gmap_src_id' = s.source_id
             OR p.extra#>>'{gmap_metadata,src_id}' = s.source_id
             OR p.key = s.mirror_key
             OR p.key = 'sb_' || s.source_id
             OR p.key = 'sb_' || replace(s.source_id, '-', '_'));
    SELECT count(*) INTO after_count FROM public.pois
     WHERE building_id = building_id_verified AND source = 'supabase' AND published;
    IF after_count <> 47
       OR (SELECT count(*) FROM pg_temp.uncc_publish_matches_after) <> 47
       OR (SELECT count(DISTINCT source_id) FROM pg_temp.uncc_publish_matches_after) <> 47
       OR (SELECT count(DISTINCT mirror_id) FROM pg_temp.uncc_publish_matches_after) <> 47 THEN
        RAISE EXCEPTION 'The final UNC Charlotte mirror has missing, duplicate, or orphaned identities';
    END IF;
    IF EXISTS (
        SELECT row_data FROM pg_temp.uncc_publish_before
        EXCEPT ALL
        SELECT to_jsonb(p) FROM public.pois p
    ) THEN
        RAISE EXCEPTION 'A pre-existing POI row changed or disappeared';
    END IF;
    IF (SELECT count(*) FROM public.pois)
       <> (SELECT count(*) FROM pg_temp.uncc_publish_before) + inserted_count THEN
        RAISE EXCEPTION 'Unexpected POI rows were added or removed';
    END IF;
    IF EXISTS (
        (SELECT relation_name, row_data FROM pg_temp.uncc_publish_context_before
         EXCEPT ALL
         (SELECT 'buildings'::text, to_jsonb(b) FROM public.buildings b
          UNION ALL SELECT 'map_versions', to_jsonb(v) FROM public.map_versions v))
        UNION ALL
        ((SELECT 'buildings'::text, to_jsonb(b) FROM public.buildings b
          UNION ALL SELECT 'map_versions', to_jsonb(v) FROM public.map_versions v)
         EXCEPT ALL
         SELECT relation_name, row_data FROM pg_temp.uncc_publish_context_before)
    ) THEN
        RAISE EXCEPTION 'Building or publication metadata changed';
    END IF;
    INSERT INTO pg_temp.uncc_publish_result
        VALUES (before_count, inserted_count, after_count, 47, true);
END
$publish_uncc$;

SELECT jsonb_build_object(
    'building_slug', 'uncc-main-campus',
    'poi_type', 'Uncc_Navme',
    'count_before', count_before,
    'inserted', inserted,
    'count_after', count_after,
    'canonical_count', canonical_count,
    'existing_rows_preserved', existing_rows_preserved
) AS result
FROM pg_temp.uncc_publish_result;

COMMIT;
