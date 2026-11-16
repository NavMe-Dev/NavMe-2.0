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

## Read-only production: pending approval

Production's general application connection remains read-only. A separate
execute-only writer is prepared in
[`20261116063201_capture_camera_viewpoint_writer.sql`](../deploy/pending-migrations/20261116063201_capture_camera_viewpoint_writer.sql).
This file is deliberately outside automatic Alembic and Studio migration paths.
It has **not been applied** and must be reviewed and explicitly approved before
use against the platform database. It must not be applied to the Studio source
database by mistake.

The migration creates only a private schema, narrowly scoped function and
`NOLOGIN` role. It changes no application records or table definitions. Its
function can update only the selected POI's camera-viewpoint JSON for the active
model; it grants no direct table writes and revokes public function access.
Provisioning a login/password is a separate approved operational step. The
private schema must stay outside the exposed Data API schemas.

After approval and credential provisioning, server-only configuration is:

- `CAMERA_VIEWPOINT_DATABASE_URL`: the dedicated role at the same application
  database host, port and database, with TLS required.
- `CAMERA_VIEWPOINT_BUILDINGS`: explicitly permitted building slugs, or `*` if
  all registered buildings have been approved for this capability.

The application fails closed when this capability is absent. The old
`POI_VIEWPOINT_DATABASE_URL` is not reused or broadened. No deployment is
performed by this implementation.

## Verification

Targeted tests cover capture, cancellation, refresh, replacement, source/model
compatibility, disabled scans, public fallback, authentication and row
preservation. Database tests use the isolated local `wayfinding_test` database,
private temporary schemas, and rollback all fixture DDL/data. Capability tests
exercise a temporary execute-only role without applying the pending migration.
The final combined run passed 137 Python checks and 95 JavaScript checks.

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
