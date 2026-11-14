# UNCC public recovery — 14 November 2026

The live database had GCU only. The UNCC deep link silently selected the first
manifest building (GCU), even though authentic UNCC v2 publication objects existed.
Local development had a separate UNCC building record and therefore worked.

Recovery registers the existing `uncc-main-campus` v2 / `kQBN52JqFE9` publication,
seven published pipeline floors, and a viewer mirror of the destination project's
20 active `Uncc_Navme` POIs and six categories. The two authored dashboard floors
are read through the existing API. No local integer IDs, GCU changes, account data,
permissions, migrations, or unrelated draft records are transferred. The existing
application/database read-only mode remains enabled.

The exact registration is recorded in
`scripts/production_migration/recover_uncc_v2.sql`. A transaction rehearsal passed
and rolled back; activation then passed the same assertions preserving every
pre-existing row of all four affected application tables. Re-execution aborts
when UNCC already exists. Published config and georef checksums are in the SQL.
The existing UNCC bundle files are unchanged, including its previously missing
optional walkgrid; the Matterport viewer uses the independent Recast mesh.

The working local Recast mesh was uploaded to the previously absent public
`wayfinding-bundles/navmesh/uncc-main-campus.navmesh` object and read back byte for
byte (2,294,432 bytes; SHA256
`8e091b58cb586d2e729d39f9576f5a172bc47308b262c02510c156aaf2427638`).
The existing navmesh resolver restores this object after deployments/restarts.

Viewer boot now rejects an unavailable requested campus instead of opening a
different building. Links without an explicit building retain their default.
The boot asset version is bumped. Validation: 39 viewer regression checks pass;
`platform/tools/uncc_acceptance.cjs` verifies actual desktop/mobile UNCC identity,
SDK startup, curated categories/camera focus, and durable-mesh routing.

## Verified production release

- Repository: `NavMe-Dev/NavMe-2.0`, main; functional fix `2e4c7d7`.
- Deployed commit: `6d45b611a9d4d9d8abbe6bcf117d2269875c23a0`.
- Render deployment: `dep-dbs1qfdg1s2s73dutl20`, LIVE at
  08:35:50 UTC / 14:05:50 IST on 14 November 2026.
- Actual public `wf-boot.js` and `index.html` match the Git source byte for byte.
- Post-deploy desktop: **5/5 PASS**, including actual UNCC Matterport render,
  eight Student Union category entries, acknowledged SDK camera focus, and a
  complete route on the recovered Recast mesh. See
  [desktop evidence](evidence/uncc-live/desktop.json).
- Public privacy/read-only preflight: **18/18 PASS**; UNCC-specific public payload
  privacy: **6/6 PASS**. GCU retains 99 viewer-visible curated places.
- No Render error-level logs were returned between activation and the final check.

The mobile test confirms UNCC identity and metadata but its Matterport iframe is
blocked by the upstream Cloudflare human-verification screen in automated Chrome.
This is not claimed as a mobile scene-render pass. No verification challenge was
bypassed. Desktop rendering was checked again after deploy and passed.
Optional pre-existing `/ar_webxr/launch.js` and `/data/sdk_config.json` 404s remain;
these did not block the tested desktop map, camera, category, or navmesh flows.

Live link: <https://wayfinding.navme.space/?b=uncc-main-campus&mp=1>.
