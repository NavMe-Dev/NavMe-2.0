# Student Union scan-derived review plans

The public runtime bundle is `student-union/`. It contains five SVG/PNG/GeoJSON
plans, the five-page PDF and their metadata. These are **partial scan-derived
review plans**, not complete architectural layouts. Four floor elevations are
supported by source doorway thresholds and sweep positions. The mezzanine is
provisional. Individually verified room/corridor polygons are unavailable.

Source model: `kQBN52JqFE9`, UNC Charlotte Main Campus. Coordinates retain its
local metric frame; true north/global placement is not surveyed. The drawings
preserve measured source walls and leave unscanned spaces unknown.

The API serves only explicitly allowed filenames for cataloged levels and the
matching campus. Raw DOCX/EMF references, occupancy information, audit files and
local filesystem inventories are excluded. No database records are changed.

The API Docker image copies this bundle to `/app/floorplans/student-union` and
sets `FLOORPLAN_DIR` to that path. The existing viewer opens it with
`/unc-charlotte?plan=student-union`; ordinary campus/POI/Matterport flows remain
available. GCU does not receive these building-specific controls.

Regenerate locally from the recorded MatterPak workspace, then package:

```sh
platform/.venv/bin/python scripts/floorplans/generate_student_union.py
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/floorplans/render_previews.cjs
platform/.venv/bin/python scripts/floorplans/validate_outputs.py
platform/.venv/bin/python scripts/floorplans/package_runtime.py
```

The generator requires the local read-only POI snapshot and source scan files;
raw source material is not copied into the runtime bundle. `runtime-manifest.json`
records the hashes and sizes of every public artifact. Re-generation is an
explicit review step; a deployment serves the checked-in files without invoking
the geometry pipeline or changing production data.

Browser verification uses `scripts/floorplans/verify_viewer.cjs`. Set
`PLAYWRIGHT_MODULE`, optionally `BASE_URL`, `EVIDENCE_DIR` and `REPORT_PATH`.
The checks use real POIs and navigation-mesh routing, and explicitly exclude
claims about successful external Matterport rendering.
