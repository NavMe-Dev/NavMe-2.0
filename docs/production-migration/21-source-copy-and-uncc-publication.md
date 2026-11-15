# Source copy and UNC Charlotte publication — 16 November 2026

The requested additive copy ran from Supabase project
`znfwcohrpkiccibqcfpn` to `kzpvhzyefdtrtidrbuxb`. The user selected only
tables already present in the destination: 50 shared public tables out of
82 destination public tables. All source columns were already present with
matching types, so no persistent schema changes were needed.

The copy inserted **289,866 missing rows**, including two API-credential
records after explicit user approval. It retained destination values for
252 conflicting source records. A private complete destination archive was
captured before the copy; every exported table's count and canonical SQL
content digest were verified before insertion. Locked transactions checked
that all pre-existing public-table rows remained intact.

The export and merge helpers are `export_znfw_shared.py` and
`sync_znfw_shared.py` under `scripts/production_migration/`. Merge defaults
to a rollback-only plan; `--apply` requires a fresh completed backup manifest.
Credentials, exports, archives, configuration and detailed reports remain
under ignored private paths and are not committed.

## UNC Charlotte viewer publication

The destination contained all 47 canonical `Uncc_Navme` POI identities, but
the public `uncc-main-campus` viewer still used its earlier 20-row
`public.pois` mirror. The user requested publication of the remaining POIs.

`scripts/production_migration/publish_uncc_missing_pois.sql` inserted only
the 27 missing mirrors, preserving all 250 original rows across buildings,
including the existing 20 corrected UNC Charlotte POIs. The script retains
SDK coordinates and expected positions and computes geographic positions
with the existing SDK X/−Z transform. Building and publication metadata
remain intact; the current UNC Charlotte publication remains version 2.

A transaction rehearsal inserted 27 and rolled back. The original 250-row
digest remained `050c870f3ee69378c72131da1036aa64`. Activation then inserted
27 and verified 47 unique published source identities. Both actual-domain
`navme-pois` and `viewer-data` endpoints returned HTTP 200 and 47 POIs.
The operation needs no navigation rebuild or application restart because
public requests read the published mirror directly.

The production viewer assets already match local HEAD and the existing
production commit `bc78d3a`. The focused viewer suite passed 105 checks;
the merge planner suite passed 11 tests. The live acceptance helper now
expects 47 POIs. Actual-domain desktop acceptance passed 5/5 checks: all
47 places, the real Matterport scene, category selection and camera focus,
a complete campus route, and zero unhandled errors or application writes.
Six categories and two display floors remain available. The report is
`evidence/uncc-47-live.json`; screenshots remain in the ignored private
evidence directory.

Live page: <https://wayfinding.navme.space/unc-charlotte>.
