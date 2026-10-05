# Data formats

All files live in a building workspace `DATA_DIR/buildings/<slug>/out/` (draft) and are frozen into
`DATA_DIR/published/<slug>/v<N>/` on publish. Public URL: `/api/v1/public/buildings/<slug>/data/<file>`;
static export: `api/v1/public/buildings/<slug>/data/<file>` (same layout). Coordinates: see ARCHITECTURE.md.

## venues/<venue>/manifest.json (`wayfinding.venue/v1`)
```json
{"schema":"wayfinding.venue/v1","slug":"greenland-campus","name":"…","branding":{},
 "buildings":[{"slug":"greenland","name":"Shiloh Institutional Baptist Church","address":"…","center":{"lon":-80.8796,"lat":35.2260},
   "bounds":[w,s,e,n],"floors":[{"id":"F1","label":"Floor 1","short":"1"}],"version":3,"data":"buildings/greenland/data/"}]}
```
`venue = all` lists every published building.

## config.json (`wayfinding.building/v1`)
Per-building manifest. Keys: `slug, name, address, matterport_model_id, center{lon,lat}, bounds[w,s,e,n]`,
`floors[] {id, label, short, ordinal, elevation (model z), height, overlay, glb}`, `default_floor`,
`model_bbox [xmin,ymin,xmax,ymax]` (model m), `grade_z`, `rotation_deg`, `files{georef, floors, nav_graph, walkgrid, pois, mp_graph_raw, indoor{F1:…}, buildings_osm, site_shell, model_glb, thumbs}`,
`stats{pois, nav_nodes, nav_edges, entrances, step_free_entrance}`, `branding{title, primary_color, icon, logo_url}`, `arrival_poi`, `venue`, `sdk_key_configured`, `vps_enabled`.

## georef.json
```json
{"mode":"auto|control_points|fixed","model_to_epsg3857_affine":[[a,b,tx],[c,d,ty]],
 "rotation_deg":-4.75,"scale":1.0,"model_origin_wgs84":{"lat":35.226002,"lon":-80.879506},
 "rms_m":null,"max_err_m":null,"control_points":[{"id":1,"model_xy":[x,y],"wgs84":[lat,lon],"residual_m":0.4}],
 "auto":{"ncc":0.36,"match_rotation_deg":-4.75,"match_scale":1.0}}
```
Pipeline config for georef (`building.json` → `georef`): `{"mode":"auto","search_radius_m":130}`,
`{"mode":"control_points","control_points":[{"model_xy":[x,y],"wgs84":[lat,lon]}, … ≥2]}`, or
`{"mode":"fixed","affine":[[…],[…]]}` / `{"mode":"fixed","lat":…,"lon":…,"rotation_deg":…}`.

## floors.json
`{"floors":[{"id":"F1","image":"floor_F1.webp","colorplan":"colorplan_000.jpg","corners_model":[[x,y]×4],"corners_lonlat":[[lon,lat]×4]}]}` — corners TL, TR, BR, BL of the overlay image.

## indoor_<F>.geojson (IMDF-inspired)
FeatureCollection, WGS84. `properties.feature_type` ∈ `level | unit | wall | opening | fixture | anchor`, plus
`level_id, ordinal, name, category, style, floor_z, mp_room_id, poi_id, display_category`. Units come from Matterport room
polygons; openings are doors detected on the nav graph; anchors are POI points (added at publish). `site_shell.geojson`
= building outline (union of rooms), `buildings_osm.geojson` = neighbouring OSM footprints.

## nav_graph.json
```json
{"frame":"model metres (Z up); lonlat WGS84","floors":{"F1":{"mp_floor_id":"…","label":"Floor 1"}},
 "stairs":[{"id":"stair_north","name":"North stair tower","bbox_model":[x0,y0,x1,y1],"floors":["F1","F2"],"source":"config|auto"}],
 "elevators":[{"id":"elev_main","name":"Main elevator","floors":["F1","F2"],"doors":{"F1":{"x":0,"y":0},"F2":{"x":0,"y":0}},"door_nodes":{"F1":"…","F2":"…"},"source":"config"}],
 "cost_model":{"weight":"3D length (m)","stair_penalty_m":15,"walk_speed_mps":1.2,"stair_extra_s_per_m_rise":2.0,
   "elevator_wait_m":15,"elevator_per_floor_m":8,"elevator_wait_s":20,"elevator_per_floor_s":4},
 "stats":{…pruning diagnostics…},
 "nodes":[{"id":"…","kind":"sweep|door|osm|elevator","label":"S67","floor":"F2","x":-6.57,"y":-2.86,"z":1.37,"indoor":false,"lonlat":[lon,lat]}],
 "edges":[{"u":"…","v":"…","length":7.1,"dz":0.3,"stairs":null,"cross_floor":false,"step_free":true,"doors":[],"source":"elevator","elevator":"elev_main"}]}
```
Edges are undirected. Routing weight = length + `stair_penalty_m` for stair edges (elevator edges already embed wait+climb in `length`; no stair penalty). Step-free routing drops edges with `step_free=false` (elevators stay). Empty `elevators` config → no elevator edges.
Sweep node ids are Matterport sweep ids (stable per model); OSM node ids are `osm_<id>`.

## walkgrid.json
Raster (model frame) used for line-of-sight path smoothing: `x0, y0, res` (m), `nx, ny, row_major`, `floors{F1:{walk: base64 uint8 (1 = walkable: floor surface in band and no mesh 0.5–1.8 m above; Matterport walls burned in, doorways open), z_cm: base64 int16 LE floor height in cm (−32768 = none), walkable_cells}}`.

## pois.json (`wayfinding.pois/v1`)
```json
{"schema":"wayfinding.pois/v1","building":"…","arrival_poi":"poi_parking",
 "pois":[{"id":"poi_b4qtykzcaz","name":"Pastor's Office","code":"Room F1-01","category":"room","floor":"F1",
   "model":{"x":-3.5,"y":19.62,"z":0.01},"lonlat":[-80.879526,35.226180],"nearest_node":"s72m…","nearest_sweep_label":"S34",
   "room_id":"b4qt…","step_free":null,"step_free_from_parking":false,"hours":"Mon–Fri 9:00–15:00","description":null,"photo_url":null,"source":"admin"}]}
```
Categories: `room, hall, corridor, entrance, stairs, elevator, restroom, parking, outdoor, info, office, worship, kitchen, other` (see `/api/v1/admin/categories`).

### Curated seed POIs (pipeline config `pois_seed`)
```json
[{"id":"poi_parking","name":"Parking lot","category":"parking","node":"osm_123"},          // attach to a graph node
 {"id":"poi_stage","name":"Raised platform","category":"room","sweep_label":"S12"},          // or a sweep label
 {"id":"poi_x","name":"Info desk","category":"info","model_xy":[3.2,-1.5],"floor":"F2"},     // or a model position
 {"id":"poi_xy2x8mpaaq","name":"Lower Hall","category":"hall"}]                              // or rename an auto POI
```
Example: `platform/fixtures/greenland_pipeline.json` (reproduces the prototype's curated POIs).

## POI CSV (admin import/export)
Header: `key,name,category,floor,lon,lat,code,step_free,hours,description,photo_url,published,nearest_node`.
Import upserts by `key` (new key → new POI, snapped to the nearest sweep); `step_free` empty = auto; imported rows are locked.

## Pipeline config (`building.json`, stored in `buildings.pipeline_config` + identity fields)
```json
{"name":"…","slug":"…","matterport_model_id":"Hn36TwktGgz","matterpak":"/path/or.zip","address":"…","lat":35.22,"lon":-80.88,
 "georef":{"mode":"auto"},"floors":[{"id":"F2","label":"Main floor","short":"M","elevation":2.75,"height":3.1}],
 "stairs":null,                        // null = auto-detect, or list of {id,name,bbox_model,floors}
 "elevators":[],                        // config only (no auto-detect): [{id,name,floors,doors|{bbox_model}}]
 "tour_modes":{"embed_showcase":true,"mesh_tour":false,"bundle_scene":false,"bundle_url":"","bundle_camera":"dollhouse"},
 "media_panels":[],                     // Option 4: [{id,name,kind:image|video|text,src?,body?,buttons:[{label,url}]?,model:{x,y,z},normal?,floor?,poster?,style:glass_v1,published}]
 "osm":{"enabled":true,"footways_file":null,"buildings_file":null},
 "glb":{"target_reduction":0.72},"thumbs":{"enabled":true},
 "graph":{"max_edge_m":15,"step_free_max_step_m":0.16,"osm_link_max_m":12},
 "pois_seed":[],"arrival_poi":null,"branding":{}}
```
Relative file paths resolve against the process working directory (use absolute paths in production).
Admin Spatial Studio **Elevators** tab (`/admin/#/b/<slug>/elevators`) edits `elevators`; **Tour** tab (`/admin/#/b/<slug>/tour`) edits `tour_modes`; **Media** tab edits `media_panels`. Overview pipeline JSON is the same field. Publish freezes `tour_modes` + `has_glb` into `config.json`.

## MatterPak / E57 input (`config.matterpak`)
Path to a MatterPak **folder**, **.zip**, ASTM **.e57**, or Matterport **E57-export zip** (`mp_e57_*.zip` with `cloud_0.e57`, no `.obj`).
Zip/folder must include `model.obj` (or any `*.obj`) and ideally `colorplan_*.jpg`. An `.e57` is converted at
**ingest** into `work/matterpak/model.obj` + synthetic `colorplan_*.jpg`; manifest gets `source_format: "e57"`
and a `conversion` block (voxel size, mesh method, floor bands). Matterport model ID is still required for
sweeps/nav. Georef from synthetic colour plans is weaker — plan on control points or fine-tune.
Optional pipeline knobs: `"e57": {"voxel_m": 0.08, "colorplan_res_m": 0.05, "max_points": 8000000}`.

## Media panels (`media_panels.json` + `config.json.media_panels`)

Authored in Spatial Studio **Media** tab → `buildings.pipeline_config.media_panels`. Kinds: `image` | `video` | `text`. Optional `buttons: [{label, url}]` (CTA). Text panels use `body` (markdown/plain); `src` optional. On publish: copy `buildings/<slug>/media/` → `published/<slug>/vN/media/`, rewrite local admin URLs to `media/<file>`, write `media_panels.json` (`schema: wayfinding.media_panels/v1`). Viewer Tour injects session Tags; playback is CSS **glass_v1** HUD (image/video well, text body, CTA buttons — not Matterport billboard chrome). See `docs/MEDIA_IN_TWIN_OPTIONS.md`.
