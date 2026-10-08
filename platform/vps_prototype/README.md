# VPS / "Localize" prototype – Matterport model Hn36TwktGgz (2400 Greenland Ave, Charlotte NC)

Single-image visual positioning against a Matterport scan, fully open source, CPU only.
Given one photo it returns position (MatterPak model metres), floor, compass heading, WGS84 lat/lon, confidence and inlier count.
**Results: see [RESULTS.md](RESULTS.md).** Floor-plan visualization: `results/viz_*.jpg`.

## Method (hloc-style, all local)
1. **Reference database from skyboxes** (`fetch_sky.py`, `build_db.py`): 80 sweeps × 6 cube faces at 2k (public GraphQL, signed URLs fetched fresh;
   4k not used). Each sweep is rendered into 22 perspective crops (640×480, HFOV 75°): 12 yaws at pitch 0°, 6 at −30°, 4 at +25° → 1,760 reference images with exact pose
   (camera centre = `pano.position`, orientation = `pano.rotation` ∘ crop rotation).
2. **3D for every keypoint**: SuperPoint keypoints (≤1024/crop) are lifted to 3D by raycasting the MatterPak mesh
   (`../matterpak/model.obj`, cached as `data/mesh.npz`, trimesh + Embree) from the sweep centre. ~95 % of keypoints get a 3D point (misses = sky / windows).
3. **Retrieval**: MegaLoc global descriptor (DINOv2-based, `torch.hub gmberton/MegaLoc`) for each crop; query top-10 crops by cosine similarity.
4. **Matching**: SuperPoint (≤2048 kp on the query, max side 1024 px) + LightGlue (cvg/LightGlue) against each retrieved crop → 2D-3D correspondences.
5. **Pose**: pycolmap `estimate_and_refine_absolute_pose` (LO-RANSAC P3P + nonlinear refinement, 8 px threshold @1024 px).
   If the FOV is unknown: grid-search HFOV 50–120° by inlier count, then P4Pf-style focal estimation + refinement (`estimate_focal_length`).
6. **Outputs**: floor = floor of the nearest sweep to the estimated 3D centre; heading = compass bearing of the optical axis
   (model yaw converted with the georef rotation −4.955°); lat/lon via `../app/data/georef.json` affine (model XY → EPSG:3857 → WGS84);
   confidence = (1−exp(−inliers/40))·min(1, inlier_ratio/0.25).

### Conventions (verified empirically – important if you touch the geometry)
* World = MatterPak frame (metres, right-handed, Z up). GraphQL `pano.position/rotation` are in this frame; `world = R(pano.rotation) · local`.
* Skybox faces (2k, `children[0..5]`): 0 = up, 1–4 = horizontal faces, 5 = down. In the pano-local frame face 1 looks along **+X**, face 2 along −Y, 3 along −X, 4 along +Y
  (each next face is to the right, i.e. clockwise seen from above); image x = right, y = down. Up-face bottom edge / down-face top edge touch face 1.
  Verified by (a) seam continuity of an equirect render, (b) mesh-depth edges overlaid on renders at pitch 0 and ±75° (pixel-aligned),
  (c) essential-matrix relative rotation / translation direction between neighbouring sweeps matching `R_B^T R_A` and `R_A^T (C_B−C_A)`.
  See `vpslib.py` (`CONV`, `face_axes`, `render_persp`), `verify_depth_overlay.py` and `verify_relpose.py` (`verify_convention.py` is an inconclusive earlier attempt).
* Photo metadata: `scan_position` equals the sweep's `pano.position` exactly, `scan_quaternion` equals `pano.rotation` (so each photo was
  rendered from a sweep). `scan_position = (−cam.x, −cam.z, cam.y)` of the Showcase `camera_position`. The Showcase `camera_quaternion`
  gives yaw consistently (true yaw = yaw of `N·q⁻¹` + 180°, std 0.9°, N = [[1,0,0],[0,0,−1],[0,1,0]]) but its pitch is **not** reproduced in the
  delivered JPGs (photos are levelled, pitch ≈ −0.7 ± 0.6°, while the quaternion says ±6°). Therefore ground-truth orientation + intrinsics
  are **refined** in `fit_photo_gt.py` by matching each photo to a rendering of its own skybox (pure-rotation homography, median residual 1.0 px):
  HFOV = 109.8 ± 1.4°, principal point ≈ (511, 265) on 1024×576 (cy is ~4 % above centre → ~3° pitch bias when a centred principal point is assumed).
* One of the 30 photos (`zyUrXQmgxSw`, camera_mode 2 = dollhouse/floorplan) is excluded → 29 test photos.

## Setup
```bash
pip install --break-system-packages torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install --break-system-packages kornia fastapi uvicorn python-multipart embreex rtree pycolmap huggingface_hub safetensors \
    opencv-python-headless trimesh scipy "git+https://github.com/cvg/LightGlue.git"
```
Model weights download automatically on first use (SuperPoint/LightGlue from GitHub releases, MegaLoc via torch.hub + HF hub) into `~/.cache`.
Memory: the loaded localizer needs ~2.5 GB RAM (1,760 crops × ≤1024 fp16 descriptors).

## Rebuild data (only needed for a new model or if data/ is deleted)
```bash
cd /workspace/wayfinding/vps
python3 fetch_sky.py                  # data/sweeps.json + data/sky/<sweep>_<face>.jpg (480 files, ~290 MB), ~10 s
python3 fetch_photos.py               # data/player.json + data/photos/<sid>.jpg (1024x576) and <sid>_full.jpg (7680x4320)
python3 fit_photo_gt.py               # data/photo_gt.json (refined GT pose + intrinsics of the test photos), ~15 s
python3 build_db.py                   # data/db/: crops/, <sweep>.npz (kp, fp16 desc, xyz), global.npy, meta.json  (~30 min on 8 CPU cores, 843 MB)
```

## Run the service
```bash
cd /workspace/wayfinding/vps
uvicorn service:app --host 0.0.0.0 --port 8770      # loads models at startup (~5-15 s)
curl http://localhost:8770/health
curl -F image=@data/photos/6MyL9ec9GJL.jpg -F hfov=110 http://localhost:8770/localize
```
`POST /localize` (multipart): `image` (any JPG/PNG), optional `hfov` (horizontal FOV in degrees of the image as uploaded; omit → estimated),
optional `max_side` (default 1024). Response:
```json
{"success":true,"x":-11.23,"y":8.21,"z":3.82,"floor":"Floor 2","floor_id":"pd0i1c4yq9w0y2zsb07ed23sb","heading":70.5,"pitch":-4.2,
 "lat":35.2260846,"lon":-80.8796215,"confidence":1.0,"inliers":1774,"inlier_ratio":0.81,"hfov":110.0,"nearest_sweep":56,
 "n_matches":2200,"time":2.3,"yaw_model":24.4,"retrieved":["..."],"timing":{"retrieval":0.33,"extract":0.6,"match":1.33,"pnp":0.03}}
```
`heading` = compass bearing (° clockwise from true north); `yaw_model` = CCW from model +X. Treat `confidence < 0.3` (or inliers < 30) as "no fix".
CLI: `python3 cli_test.py photo.jpg [--hfov 69]` (in-process) or `python3 cli_test.py photo.jpg --url http://localhost:8770` (via HTTP).
Field-test web page: `../app/localize.html` (served by the app server on :8765) – takes a phone photo, POSTs to the service, draws the result on the floor plan,
lets you tap the true position, and keeps a downloadable JSON log. Plan: `../FIELD_TEST_PLAN.md`.

## Re-run the evaluation
```bash
python3 evaluate.py                    # all configs → results/<config>.json   (~15 min)
python3 evaluate.py loso_knownf        # a single config
python3 summarize.py                   # → results/summary.md (tables used in RESULTS.md)
python3 visualize.py results/viz_std_loso.jpg std_knownf loso_knownf
```
Configs (`evaluate.py: CONFIGS`): `std_knownf`, `std_unknownf`, `loso_knownf` (source sweep removed from the DB – simulates standing between
scan points), `aug_knownf` / `aug_loso_knownf` / `aug_loso_unknownf` (phone-like degradation: centred 60–80° FOV crop with ±4 % principal-point
offset, 320×240 capture upsampled to 640×480, Gaussian+motion blur, gamma/exposure/white-balance jitter, noise, JPEG q55; examples in `results/aug_*.jpg`).

## Onboarding another Matterport model
1. Set the model id in `fetch_sky.py` (GraphQL query) and download the MatterPak (`model.obj`) for that model; convert to `data/mesh.npz`
   (`V`, `F` arrays: `trimesh.load(obj, force='mesh')`). Check that sweep positions land inside the mesh (the MatterPak and GraphQL frames matched here).
2. `python3 fetch_sky.py && python3 build_db.py` (≈20 s per sweep on 8 CPU cores; 2k skyboxes suffice).
3. Provide a georeference (`app/data/georef.json`-style affine model XY → EPSG:3857) and floor labels (from GraphQL `floors`).
4. Sanity checks: run `verify_depth_overlay.py` for 2–3 sweeps (face convention should be identical across Matterport models, but verify);
   if the model has Matterport photos, run `fit_photo_gt.py` + `evaluate.py` for a quick benchmark.
5. Multiple buildings: build one DB per model; either run one service per model or add a first-stage model selector (GPS/Wi-Fi or global-descriptor vote).

## Files
`vpslib.py` geometry (cube convention, rendering, raycasting) · `fetch_sky.py` · `fetch_photos.py` · `fit_photo_gt.py` · `verify_depth_overlay.py` · `verify_relpose.py` · `build_db.py` ·
`localize.py` (Localizer) · `service.py` (FastAPI) · `cli_test.py` · `evaluate.py` · `summarize.py` · `visualize.py` · `field_spots.jpg` (reference photos per spot) ·
`data/` (sky, photos, db, sweeps.json, photo_gt.json, mesh.npz) · `results/`.

## Status / next steps (for whoever continues)
* Done: DB (data/db), evaluation (RESULTS.md), service, CLI, field-test page `../app/localize.html`, `../FIELD_TEST_PLAN.md`.
* Not done: real phone photo evaluation (needs a site visit – follow FIELD_TEST_PLAN.md, drop logs in `vps/field_logs/`).
* Likely improvements for real phones: (1) add denser reference views (synthetic viewpoints between sweeps rendered from the textured mesh, or
  lower/higher camera heights); (2) use EXIF focal (35 mm equiv → HFOV) instead of focal estimation; (3) undistort + use gravity (phone IMU) to fix
  pitch/roll → 2-DoF-rotation PnP, which makes RANSAC much more robust; (4) increase top-k / use sweep-level clustering; (5) temporal fusion of several
  frames + PDR/IMU in the app; (6) on-device: run retrieval/features on the phone (CoreML/TFLite SuperPoint, MegaLoc is heavy – consider a
  distilled/ResNet descriptor) or keep server-side and send 1024-px JPEGs (~150 KB, 2–3 s).
* Mobile integration: `POST /localize` returns model x/y/z + floor + lat/lon + heading; the app should (a) send `hfov` from EXIF or the camera API
  (iOS `AVCaptureDevice.activeFormat.videoFieldOfView`, Android `CameraCharacteristics` focal length/sensor size), (b) ignore fixes with confidence < 0.3,
  (c) map x/y to the floor-plan with `app/data/floors.json` corners (as `localize.html` does). HTTPS is needed for camera access from a web page on
  most phones when not using `<input type=file capture>`.
