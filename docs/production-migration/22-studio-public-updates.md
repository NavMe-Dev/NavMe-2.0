# UNC Charlotte Studio updates — 16 November 2026

Live Spatial Studio (`navme-dashboard-24e5.onrender.com`) writes to Supabase
project `znfwcohrpkiccibqcfpn`. The production viewer uses the copied
`kzpvhzyefdtrtidrbuxb` database. Copying records did not connect later edits.
Studio also left POI update timestamps unchanged, so timestamps cannot decide
which public metadata is current.

The reviewed three-way repair updates 19 canonical UNC POIs: 16 names, 18
translation maps and three floor assignments. It refreshes the 47 published
mirrors and the changed public project URL. Six mirror records retain private
source baselines for previously corrected coordinates and expected positions.
Rounding within one millimetre does not undo these corrections.

`scripts/production_migration/reconcile_uncc_studio.py` rehearses and rolls back
by default; `--apply` commits after private backups and preservation checks.
It checks the exact tenant, building, publication and source identity sets,
refuses conflicting edits, and verifies unrelated rows and GMap state.
Reports and input snapshots remain under ignored `platform/var/data/` paths.

The optional server settings are `STUDIO_SUPABASE_URL`,
`STUDIO_SUPABASE_ANON_KEY` and `STUDIO_LIVE_BUILDINGS`. Production enables
only `uncc-main-campus`. Database, Auth and Storage retain their existing
destination settings and read-only production permissions.

Public requests read current Studio metadata for already published POI IDs,
with a five-second cache. Explicit projections retain public names,
translations, descriptions, categories, positions and floor assignments;
private source fields and calibration metadata are never returned. Source
failure falls back to the saved publication. A page refresh after saving in
Studio loads these edits without a deployment or database write. New POI IDs
still need publication. Published navigation assets and stair chains retain
their existing release lifecycle.

Viewer loading now carries descriptions and translated details, and optional
translation responses cannot overwrite fresher bootstrap text. The existing
category directory and removal of floor labels and the dropdown are preserved.

Validation: 91 backend/planner checks and 59 viewer checks passed, including
publication scope, privacy, connection release, cache refresh without timestamp
changes, coordinate calibration, optional metadata and localization.
