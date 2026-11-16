# Capture Current Viewpoint

The admin **Viewpoints** tab saves an actual Matterport panorama and camera
rotation for each registered POI. It works across buildings and POI sources;
it is separate from the older UNC directions look-at targets.

## Administrator workflow

1. Select a location, then **Set Viewpoint** or **Replace Viewpoint**.
2. Walk to the intended scan position and rotate the twin toward the location.
3. Choose **Capture Current Viewpoint**. The editor reads the supported SDK
   camera pose, verifies its enabled sweep and active model, saves it, and reads
   the committed record back before confirming success.
4. Use **View saved viewpoint** to return to that scan. Published locations also
   offer **Open visitor view**, which opens Matterport mode at that location.

**Cancel Viewpoint Setup** makes no write. A failed capture cannot reuse an older
unsaved attempt. A failed save retains the captured view for retry; a revision
conflict requires reloading locations. No coordinates need to be typed.

## Persistence and permissions

Existing `pois.extra.camera_viewpoints` JSONB stores one record per model ID:

```json
{
  "camera_viewpoints": {
    "existingModelId": {
      "revision": "generated-uuid",
      "viewpoint": {
        "model_id": "existingModelId",
        "sweep_id": "capturedEnabledScanId",
        "camera_position": {"x": 1, "y": 2, "z": 3},
        "camera_rotation": {"pitch": 5, "yaw": 90},
        "floor_id": null,
        "captured_at": "2026-11-16T00:00:00Z"
      }
    }
  }
}
```

The values above illustrate the shape; capture always uses actual SDK values.
The API binds each write to the selected POI, building and active model. A row
lock and revision check prevent duplicate records and stale overwrites. Only
the camera-viewpoint JSON key changes; marker coordinates, routing anchors,
legacy look targets, other metadata and other locations stay intact. Replacing
a model preserves its earlier record for administrator review. Removing a view
removes only the active model's record.

Admin routes use the existing `current_admin` dependency:

- `GET /api/v1/admin/buildings/{slug}/camera-viewpoints`
- `PUT /api/v1/admin/buildings/{slug}/pois/{id}/camera-viewpoint`

The write body is `{model_id, viewpoint, revision}`. A null `viewpoint` removes
the current model's saved view. Writable installations use the existing
application connection; no application table or column migration is needed.

## Visitor behavior

Selecting a location in Matterport mode performs a fresh, non-cached read from
`GET /api/v1/public/buildings/{slug}/camera-viewpoints/{public_location_id}`.
Only published locations in published buildings can be read. Public responses
contain the current model's validated viewpoint, never revisions, credentials
or historical records.

The viewer checks the active model and enabled sweep before calling the SDK's
`Sweep.moveTo` with the captured pitch/yaw. It reuses the current model
connection and does not navigate to arbitrary camera XYZ coordinates. Missing
or historical views use existing location navigation; an incompatible view is
never reused. Existing directions and route calculations are unchanged.

## Read-only production: approved deployment

On 2026-11-16, the approved
[`20261116063201_capture_camera_viewpoint_writer.sql`](../deploy/pending-migrations/20261116063201_capture_camera_viewpoint_writer.sql)
was applied to the verified platform database, Supabase project
`kzpvhzyefdtrtidrbuxb`. The file remains outside automatic Alembic and Studio
migration paths; it must not be applied to the Studio source database by mistake.

The general application connection remains read-only. The migration created a
private schema, narrowly scoped function and initially `NOLOGIN` role. Separate
approved provisioning enabled the dedicated login with a generated password.
Verification confirmed TLS, private function execution, no inherited roles,
no direct table writes and no public function execution. The private schema
must stay outside the exposed Data API schemas.

Render's server-only configuration now includes:

- `CAMERA_VIEWPOINT_DATABASE_URL`: the dedicated role at the same application
  database host, port and database, with TLS required.
- `CAMERA_VIEWPOINT_BUILDINGS=*`: the approved capability for all registered
  buildings.

The application fails closed when this capability is absent. The old
`POI_VIEWPOINT_DATABASE_URL` remains separate and unchanged.

The initial production rollout reached Render status `live` at commit
`e4742ada9686b4b0f286b0b1793458dc4a0b2122`
(deploy `dep-dbtb5pjm8hqs73adi5cg`). Deploying this code does not synchronize
the independent local and production datasets.

## Verification

Targeted tests cover capture, cancellation, refresh, replacement, source/model
compatibility, disabled scans, public fallback, authentication and row
preservation. Database tests use the isolated local `wayfinding_test` database,
private temporary schemas, and rollback all fixture DDL/data. Capability tests
exercise isolated temporary execute-only capability fixtures.
The final combined run passed 137 Python checks and 95 JavaScript checks.

The production writer also passed a transaction test using Starbucks POI 454
and a previously recorded actual Matterport camera pose. Saving returned the
exact payload; an identical save preserved its revision; resetting succeeded.
The entire transaction was rolled back. The original POI JSON and complete
before/after digests of all 277 POIs and both buildings were identical.
No test viewpoint or legacy override change persisted.

Live HTTP checks confirmed database readiness, deployed admin/viewer bytes,
the new API routes, unauthenticated access rejection, non-cached public lookup,
the general read-only mode, and the existing 47-POI UNCC publication. A fresh
authenticated browser capture remains unverified; the local signing key does
not authenticate to production.

The local browser fixture verifies the actual Vue controls and public restore
code with a simulated SDK, including 390px mobile layout. It does not claim a
fresh live Matterport save test. Earlier live SDK inspection confirmed the
documented camera pose/sweep APIs; repeated remote browser loading encountered
Matterport human verification.

Production builds for the dashboard, 2D editor and 3D viewer pass. The 3D
TypeScript check passes. The separately run 2D TypeScript check still reports
existing errors in unchanged `mini3d-2d/src` files, including floor-map types,
`lastPointerWorld`, `usZoneColorFromLabel`, PDF render parameters and typed-array
types. These are outside the viewpoint change.
