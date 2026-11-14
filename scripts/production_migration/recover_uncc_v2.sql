-- Authorized UNCC public recovery, 2026-11-14. Data registration, not a schema migration.
-- Source: existing published UNCC v2 config/georef in this project's public bucket,
-- and this project's existing canonical Uncc_Navme dashboard records.
-- No local integer IDs, draft pipeline records, users, grants, or GCU data are copied.
-- Execute this block in one transaction. An existing UNCC identity causes an abort.
-- Config SHA256: 546050d8de34067aac77a377324c3ec758085cfb86e276ccf3f4e5e795d11ba6
-- Georef SHA256: a3bf7ecd5aac635e3881616382228d2b87a2995c9e0600a3a26665fc7b5ffd28
DO $recover$
DECLARE
    cfg jsonb := $config${"schema":"wayfinding.building/v1","slug":"uncc-main-campus","name":"UNCC Main Campus","address":"9201 University City Blvd, Charlotte, NC 28223, United States","matterport_model_id":"kQBN52JqFE9","center":{"lon":-80.74108564,"lat":35.3080082},"bounds":[-80.74517712,35.30484249,-80.73699416,35.31117379],"floors":[{"id":"F1","label":"Floor 1","short":"1","ordinal":0,"elevation":-14.86,"height":7.51,"overlay":"floor_F1.webp","glb":"model_F1.glb"},{"id":"F2","label":"Floor 2","short":"2","ordinal":1,"elevation":-7.35,"height":5.33,"overlay":"floor_F2.webp","glb":"model_F2.glb"},{"id":"F3","label":"Floor 3","short":"3","ordinal":2,"elevation":-2.02,"height":2.42,"overlay":"floor_F3.webp","glb":"model_F3.glb"},{"id":"F4","label":"Floor 4","short":"4","ordinal":3,"elevation":0.4,"height":14.19,"overlay":"floor_F4.webp","glb":"model_F4.glb"},{"id":"F5","label":"Floor 5","short":"5","ordinal":4,"elevation":14.59,"height":-7.47,"overlay":"floor_F5.webp","glb":"model_F5.glb"},{"id":"F6","label":"Floor 6","short":"6","ordinal":5,"elevation":7.12,"height":5.51,"overlay":"floor_F6.webp","glb":"model_F6.glb"},{"id":"F7","label":"Floor 7","short":"7","ordinal":6,"elevation":12.63,"height":3.1,"overlay":"floor_F7.webp","glb":"model_full.glb"}],"default_floor":"F1","model_bbox":[-73.47,-259.96,512.03,206.56],"grade_z":-1.38,"grade_note":"model z of outdoor grade near model origin (3D terrain anchoring)","rotation_deg":-31.748687596912497,"files":{"georef":"georef.json","floors":"floors.json","nav_graph":"nav_graph.json","walkgrid":"walkgrid.json","navmesh":"navmesh.json","pois":"pois.json","mp_graph_raw":"mp_graph_raw.json","indoor":{"F1":"indoor_F1.geojson","F2":"indoor_F2.geojson","F3":"indoor_F3.geojson","F4":"indoor_F4.geojson","F5":"indoor_F5.geojson","F6":"indoor_F6.geojson","F7":"indoor_F7.geojson"},"buildings_osm":"buildings_osm.geojson","site_shell":"site_shell.geojson","model_glb":"model_glb.json","thumbs":"thumbs/index.json","media_panels":"media_panels.json"},"stats":{"pois":170,"nav_nodes":4900,"nav_edges":15783,"entrances":5,"step_free_entrance":false,"media_panels":0,"has_glb":true},"branding":{},"arrival_poi":null,"venue":null,"sdk_key_configured":true,"vps_enabled":true,"media_panels":[],"tour_modes":{"embed_showcase":true,"mesh_tour":false,"bundle_scene":false,"bundle_camera":"dollhouse","bundle_configured":false,"has_glb":true},"has_glb":true,"access":{"twin":"public","tour_public":true,"routing":{"mode":"all_public","excluded_edge_ids":[]},"pin_required":false},"debug":false,"debug_scope":"published_hint"}$config$::jsonb;
    geo jsonb := $georef${"building":"9201 University City Blvd, Charlotte, NC 28223, United States","matterport_model_id":"kQBN52JqFE9","mode":"fixed","method":"fixed transform from configuration / admin fine-tune","model_units":"meters, right-handed, Z up","model_to_epsg3857_affine":[[1.0420375797176398,0.6447994120018576,-8987567.038852977],[-0.6447994120018576,1.0420375797176398,4205659.182716779]],"note_affine":"[X,Y]_3857 = A[:, :2] @ [x,y]_model + A[:, 2]. Includes the Mercator factor 1/cos(lat).","rotation_deg":-31.748687596912497,"scale":1.0000115043816138,"model_origin_wgs84":{"lat":35.306848286789865,"lon":-80.73668838050457},"rms_m":null,"max_err_m":null,"residual_note":"Residuals relative to control points (imagery-derived unless surveyed).","auto":null,"fit":null,"control_points":[]}$georef$::jsonb;
    bid integer;
    n integer;
    categories jsonb;
    before_rows jsonb;
    after_rows jsonb;
BEGIN
    LOCK TABLE public.buildings, public.floors, public.pois, public.map_versions IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.buildings WHERE slug='uncc-main-campus' OR matterport_model_id='kQBN52JqFE9') THEN
        RAISE EXCEPTION 'UNCC identity already exists; inspect rather than overwrite';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.buildings b JOIN public.map_versions m ON m.building_id=b.id
                   WHERE b.slug='gcu' AND m.version=5 AND m.is_current) THEN
        RAISE EXCEPTION 'Expected existing GCU v5 is unavailable';
    END IF;
    IF (SELECT count(*) FROM public.navme_pois WHERE poi_type='Uncc_Navme' AND is_active) <> 20
       OR (SELECT count(*) FROM public.navme_categories WHERE poi_type='Uncc_Navme') <> 6
       OR NOT EXISTS (SELECT 1 FROM public.navme_media WHERE poi_type='Uncc_Navme'
                      AND media_type='model' AND is_active AND media_url='https://my.matterport.com/show/?m=kQBN52JqFE9') THEN
        RAISE EXCEPTION 'Verified UNCC dashboard scope has changed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='wayfinding-bundles'
                   AND name='published/uncc-main-campus/v2/config.json')
       OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='wayfinding-bundles'
                      AND name='published/uncc-main-campus/v2/georef.json') THEN
        RAISE EXCEPTION 'Authentic UNCC v2 publication is missing';
    END IF;
    SELECT jsonb_build_object(
      'buildings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.buildings t),
      'floors',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.floors t),
      'pois',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.pois t),
      'versions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.map_versions t)
    ) INTO before_rows;
    SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'icon_key',icon_key,'sort_order',sort_order)
                     ORDER BY sort_order,name)
      INTO categories FROM public.navme_categories WHERE poi_type='Uncc_Navme';
    INSERT INTO public.buildings
      (slug,name,address,lat,lon,location,matterport_model_id,sdk_key_ref,georef,
       pipeline_config,model_info,status,branding,created_at,updated_at)
    VALUES
      (cfg->>'slug',cfg->>'name',cfg->>'address',(cfg#>>'{center,lat}')::double precision,
       (cfg#>>'{center,lon}')::double precision,
       public.ST_SetSRID(public.ST_MakePoint((cfg#>>'{center,lon}')::double precision,
                                           (cfg#>>'{center,lat}')::double precision),4326),
       cfg->>'matterport_model_id','MATTERPORT_SDK_KEY',geo,
       jsonb_build_object('navme_poi_type','Uncc_Navme','navme_categories',categories,
                          'navme_stair_chains','[]'::jsonb,'access',cfg->'access'),
       '{}'::jsonb,'published',cfg->'branding',now(),now()) RETURNING id INTO bid;
    INSERT INTO public.floors (building_id,fid,label,short_label,ordinal,elevation_m,height_m)
      SELECT bid,f->>'id',f->>'label',f->>'short',(f->>'ordinal')::integer,
             (f->>'elevation')::double precision,(f->>'height')::double precision
        FROM jsonb_array_elements(cfg->'floors') f;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 7 THEN RAISE EXCEPTION 'Expected seven published pipeline floors'; END IF;
    -- Preserve SDK Y-up positions and stable CMS source UUIDs, as navme_sync does.
    -- Geometry converts SDK X,-Z to the published Z-up affine plane.
    INSERT INTO public.pois
      (building_id,key,name,category,floor,geom,model_x,model_y,model_z,published,source,locked,extra,updated_at)
      SELECT bid,'gmap_'||replace(p.id::text,'-','_'),trim(p.poi_name),
             lower(trim(coalesce(c.name,'General'))),coalesce(f.name,'F1'),
             public.ST_Transform(public.ST_SetSRID(public.ST_MakePoint(
               (geo#>>'{model_to_epsg3857_affine,0,0}')::double precision*p.pos_x
               -(geo#>>'{model_to_epsg3857_affine,0,1}')::double precision*p.pos_z
               +(geo#>>'{model_to_epsg3857_affine,0,2}')::double precision,
               (geo#>>'{model_to_epsg3857_affine,1,0}')::double precision*p.pos_x
               -(geo#>>'{model_to_epsg3857_affine,1,1}')::double precision*p.pos_z
               +(geo#>>'{model_to_epsg3857_affine,1,2}')::double precision),3857),4326),
             p.pos_x,p.pos_y,p.pos_z,true,'supabase',false,
             jsonb_build_object('gmap_poi_type','Uncc_Navme','gmap_src_id',p.id::text,
                 'gmap_metadata',jsonb_build_object('src_id',p.id::text),
                 'expected_pos_x',p.expected_pos_x,'expected_pos_y',p.expected_pos_y,'expected_pos_z',p.expected_pos_z),now()
        FROM public.navme_pois p
        LEFT JOIN public.navme_categories c ON c.id=p.category_type AND c.poi_type=p.poi_type
        LEFT JOIN public.navme_floors f ON f.id=p.floor_id AND f.poi_type=p.poi_type
       WHERE p.poi_type='Uncc_Navme' AND p.is_active
         AND nullif(trim(p.poi_name),'') IS NOT NULL
         AND p.pos_x IS NOT NULL AND p.pos_y IS NOT NULL AND p.pos_z IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 20 THEN RAISE EXCEPTION 'Expected twenty valid canonical active UNCC POIs'; END IF;
    INSERT INTO public.map_versions (building_id,version,notes,path,summary,is_current,created_at)
    VALUES (bid,2,'Recovered authentic published UNCC v2; canonical Uncc_Navme viewer mirror restored',
            'var/data/published/uncc-main-campus/v2',cfg->'stats',true,now());
    SELECT jsonb_build_object(
      'buildings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.buildings t WHERE id<>bid),
      'floors',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.floors t WHERE building_id<>bid),
      'pois',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.pois t WHERE building_id<>bid),
      'versions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.map_versions t WHERE building_id<>bid)
    ) INTO after_rows;
    IF before_rows IS DISTINCT FROM after_rows THEN
        RAISE EXCEPTION 'Existing application records changed; rollback required';
    END IF;
END
$recover$;
