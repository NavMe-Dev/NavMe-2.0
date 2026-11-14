# Student Union 2D plans

The default viewer shows **labels and divisions from the university's public
floor diagrams**, redrawn as clean SVGs. All five levels are available: Lower
Level, First Floor, Mezzanine Level, Second Floor and Third Floor. The drawings
contain 104 transcribed labels, including service symbols rendered as words,
meeting rooms, offices, shops and the nine lettered divisions of Room 340.
Furniture, logos and decorative artwork are omitted.

Reference: https://studentunion.charlotte.edu/about/floor-plans

`label-plan.svg` / `label-plan.json` use **diagram pixels**. They are not surveyed
plans and are not registered to Matterport/model coordinates. The viewer never
projects a model-space route into these drawings. Label selection highlights
its source region and supports keyboard navigation, zoom, pan and fit.
Existing mapped places can select matching labels by name.

The original `floorplan.svg`, GeoJSONs and `metadata.json` retain the earlier
**partial scan-derived review geometry** as separate assets. Their coverage
limits and provisional mezzanine elevation still apply to those scan assets;
they do not describe the official diagram's published floor names. No database,
POI floor assignment, Matterport camera or campus georeference is changed.

The Docker image copies this bundle to `/app/floorplans/student-union` and sets
`FLOORPLAN_DIR` to that path. Open `/unc-charlotte?plan=student-union` or the `2D`
button above the location control. GCU does not receive these controls.

The reviewed source checksums, contour coordinates and label transcriptions
are in `scripts/floorplans/student_union_labels.json`. Rebuild without network:

```sh
platform/.venv/bin/python scripts/floorplans/build_label_plans.py
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/floorplans/render_label_plans.cjs
platform/.venv/bin/python scripts/floorplans/package_runtime.py
```

Rebuilding the separate scan geometry with `generate_student_union.py` requires
the original local MatterPak workspace; run the label builder again afterward.
Raw DOCX/EMF references, occupancy information and private audit files are never
packaged. `runtime-manifest.json` records the hashes of all public assets.

Browser verification: `scripts/floorplans/verify_viewer.cjs`, with optional
`BASE_URL`, `PLAYWRIGHT_MODULE`, `EVIDENCE_DIR` and `REPORT_PATH`. It verifies all
104 labels on desktop/mobile, source partitions, keyboard selection, zoom/pan,
absence of unregistered route overlays and the unrelated-campus behavior.

The navigation release additionally packages `navigation-context.json`: placed
source candidates, coverage and authored walls, with zero approved registrations.
The dedicated navigation API validates drawing hashes before serving it.
Calibration drafts and navigation audit/screenshots are excluded. Production
read-only mode remains in effect; floor calibration must be validated separately.
