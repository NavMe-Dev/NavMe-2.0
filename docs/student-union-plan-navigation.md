# Student Union: draft 2D ↔ Matterport navigation

This change extends the existing Student Union panel. It does not redraw the
published plans, create another viewer, write POI records, change floor
assignments, modify Matterport tags, or automatically publish/deploy anything. Deployment is a separate authorized step.

## Current result and remaining evidence

Desktop double-click and mobile tap → Enter 3D are implemented, with floor-aware
matching, serialized SDK camera commands, return to the same 2D viewport,
throttled reverse position updates, and an authenticated floor-calibration UI.
The normal failure message is “3D view is not available for this location.”
A failed match leaves the 2D map open and does not fly to a default viewpoint.

**No Student Union location has been verified through real SDK navigation.**
The official diagrams are independent pixel drawings, not registered model
geometry. Source scan floor metadata also includes stairs and mixed elevation
bands. A room label's center is not a surveyed correspondence. Automatic
alignment cannot be accepted from the available common evidence: no paired
physical control points or verified named model-room polygons exist.

The local source snapshot has 594 placed, Showcase-tagged scans in the Student
Union crop: LL 132; L1 248; M 39; L2 87; L3 88. These are **source candidates**,
not proof that a runtime sweep remains enabled or that any named destination
is correctly aligned. `navigation-context.json` starts with zero approved
calibrations. Source-authored walls/doorway gaps and scan-derived floor-surface
coverage are retained; no room polygons or entrances are fabricated.

Two real browser attempts found (1) Matterport's unsupported-WebGL screen and
(2) a security-verification screen after a software-WebGL attempt. Neither
attempt connected the SDK. No verification screen was bypassed. Evidence is
under `outputs/unc-charlotte/student-union/navigation-evidence/`.

Union Square, Wendy’s, Bojangles, Union Theater, corridors and stairs/elevator
areas on every level therefore remain **unverified / alignment required**.
It would be inaccurate to call a particular label unscanned until its transform
has been verified. Runtime disabled, unplaced, wrong-floor, disconnected,
wall-separated, unscanned and low-confidence matches are rejected independently.

## Local use

Generate the read-only evidence bundle from existing local MatterPak metadata:

```sh
platform/.venv/bin/python scripts/floorplans/build_navigation_context.py
```

Run the existing API from `platform/` with `FLOORPLAN_DIR` pointing to the
absolute `outputs/unc-charlotte/student-union` directory, plus the usual
`VIEWER_DIR=viewer ADMIN_DIR=admin` settings. No database migration is needed.

Open:

- `/unc-charlotte?plan=student-union` — ordinary visitor interactions.
- `/unc-charlotte?plan=student-union&planCalibration=1` — optional calibration
  controls; sign in through the existing `/admin` first on this same origin.

The calibration query parameter grants no access by itself. JWT/admin checks
protect draft reads and writes. Read-only deployments refuse draft writes.
Calibration drafts are stored atomically under
`DATA_DIR/floorplan-calibration-drafts/{slug}/{floor}.json`; the public evidence
endpoint never reads or automatically activates them.

## One calibration per floor, not per room

1. Confirm the selected physical level and SDK floor identity. Do not equate a
   displayed floor name with a native SDK floor sequence.
2. In **Floor calibration · draft**, select a 2D reference at the physical floor
   position of a known placed scan. Use independently verified reference
   coordinates; a shop/room label anchor is not sufficient evidence.
3. Use **Inspect existing 3D view**, stand at that exact scan in Inside View,
   return to 2D, describe the evidence and capture its current reference.
   The runtime puck must agree with the source snapshot within 0.3 m.
4. Spread at least four fit references across the floor in both dimensions.
   Add two **independent check points** that are not used to fit the transform.
5. Record how the floor identity was verified, then **Save draft**. The backend
   recomputes the affine transform from source sweep coordinates. Submitted
   matrices or approval flags are not accepted. Collinear points, changed source
   versions, mixed levels and implausible scale/distortion are rejected.
6. A fit needs maximum error ≤ 0.5 m and RMS error ≤ 0.35 m. A mathematically
   validated draft is still unpublished and does not prove a correct landing.
7. **Preview draft locally** explicitly enables it on that signed-in device.
   A new session must load and explicitly preview the saved draft again.
8. Test real SDK landings against the physical destinations and record evidence
   before requesting a separately authorized release. This change contains no
   publish action or automatic promotion to the public calibration bundle.

Matches are restricted to the control points' convex hull; there is no automatic
extrapolation into unsupported wings. If the schematic cannot fit these checks,
use an accurately registered/surveyed plan or additional verified floor evidence;
do not relax the checks or map individual rooms by guesswork.

## Coordinate and matching behavior

The existing SVG's live screen CTM supplies the inverse viewport transform,
including pan, zoom and CSS rotation. Native pointer coordinates are normalized
to plain numeric points before being passed to the matcher. Two-pointer pinch
and panning suppress navigation gestures. Floor drawings and their downloaded
PDF/SVG/GeoJSON assets are unchanged.

An approved transform maps **diagram pixels → model X/Y metres**. Model Z is the
calibrated floor elevation. The existing NavMe convention is preserved:
`SDK = {x: model.x, y: model.z, z: -model.y}`. The inverse uses the same matrix.

`Matcher.findBestMatterportSweep(target2D, floorId, modelId)` uses a per-floor
KD-tree. Runtime `Sweep.data` is authoritative for enabled/placed/aligned status.
`Model.getData()` verifies model identity; legacy results never invent an
`enabled` flag. SDK ID conversion is used when runtime and source IDs differ.
`Floor.data`, `Sweep.current` and `Camera.pose` are observed and unsubscribed on
disposal. No second SDK script, iframe or camera owner is created.

Source/runtime XY positions and puck elevations must agree; all calibration
references must still exist on the validated runtime floor. The search radius is
based on measured scan spacing and capped at 3 m. Candidates need same-floor
SDK/source connectivity, a surface-covered approach, and no source wall crossing.
Verified model-room boundaries and verified doorway approaches are supported
when supplied; the current source contains neither, so neither is invented.
An unscanned room can use only an explicitly verified entrance/approach polygon,
with the UI identifying that entrance fallback.

Confidence is a conservative geometric score, not a probability. It includes
alignment error and target distance; the default minimum is 0.75. A confirmed
`Sweep.moveTo` plus observable target-sweep/Inside-mode evidence is required
before closing 2D. Stale requests cannot commit their UI result. SDK movement
itself is not cancellable: commands are serialized, and a stalled native command
can delay a later one while the caller gets a bounded error.

While exploring 3D, verified positions update at most every 200 ms. Returning
shows the last verified position without recentering the viewport. Directions
reuse authoritative existing POIs; the Navigate button is unavailable for
arbitrary diagram annotations without an existing routing destination.

Source and drawing hashes invalidate stale drafts. The rendered SVG hash is
checked against its evidence version, a lightweight version endpoint is checked
before movement, and live sweep collections rebuild the per-floor index after
changes. Draft preview never changes the published geometry or public data.

## Tests and evidence

Final local checks: 118 JavaScript tests passed; 251 backend tests passed with
2 existing skips. All requested browser sizes and the existing 104-label
regression checks passed. See `navigation-evidence/implementation-report.json`.

```sh
node --test platform/tests/*.test.cjs
platform/.venv/bin/python -m pytest platform/tests -q
BASE_URL=http://localhost:8780 PLAYWRIGHT_MODULE=/path/to/playwright \
  node scripts/floorplans/verify_plan_navigation.cjs
BASE_URL=http://localhost:8780 PLAYWRIGHT_MODULE=/path/to/playwright \
  node scripts/floorplans/verify_plan_sdk_fixture.cjs
```

- Geometry/SDK unit tests cover transforms/inverse, KD-tree lookup, floor/model
  restrictions, walls, disconnected coverage, verified entrance fallback,
  missing/disabled/unplaced sweeps, stale versions, identifier conversion,
  serialized repeated requests, reverse sync and observer disposal.
- Backend tests cover affine fitting, independent holdouts, unsafe references,
  authentication, read-only mode, extra-field rejection and draft-only storage.
- Browser checks use the actual plans at 1440×1000, 375×812, 390×844 and 430×932,
  covering all five floors, gestures, selection and safe failures.
- `verify_plan_sdk_fixture.cjs` tests successful command/landing-observable logic,
  viewer reuse, return viewport, reverse markers and failures using a **mock SDK
  and synthetic alignment**. Its screenshots/results are explicitly fixture
  evidence. They cannot establish real spatial alignment.
- A 594-source-point KD-tree benchmark is recorded separately. Mock movement
  timings are not live click-to-navigation or viewer-readiness measurements.

Reviewed interfaces: the installed bootstrap remains
`showcase-sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.js`. Official SDK declarations
reviewed were `26.5.4_webgl-708-g332adb66f5`; no SDK upgrade was made.
References: [Sweep](https://matterport.github.io/showcase-sdk/docs/reference/current/modules/sweep.html),
[Camera](https://matterport.github.io/showcase-sdk/docs/reference/current/modules/camera.html),
[declarations](https://api.matterport.com/sdk/types/sdk.d.ts?v=26.5.4_webgl-708-g332adb66f5).

## Reuse for another building

The matcher and SDK adapter are building-independent. Supply a context with an
explicit model identity, a source/diagram revision, canonical-to-source floor
bindings, placed source scans, coverage, authored walls and optional verified
room/entrance polygons. Preserve that building's own SDK connection lifecycle.
Generate and independently validate floor transforms as drafts before activating
them. The current source-evidence builder intentionally targets Student Union;
it must not silently assume its crop, floor IDs or model for another building.

## Authorized production release

The requested production release includes the source matching context with zero
approved registrations. Drafts, synthetic fixtures, private source references
and screenshots are not packaged in the runtime image. Existing production
read-only settings remain unchanged, so draft writes remain disabled there.
Publishing code does not validate floor alignment or establish real SDK landings.
