# Published asset recovery and integrity

Read-only investigation on 13 November 2026 of the exact destination project's public `wayfinding-bundles` bucket. **These assets provide authentic published data candidates; they do not provide a verified database backup, establish source completeness, or authorize a production merge.** No production record was created or changed.

## Recoverable published identities

Four configuration files were retrieved successfully from `published/{slug}/v{version}/config.json`: GCU v4 (2,367 bytes), GCU v5 (3,249 bytes), UNCC Main Campus v1 and v2 (3,174 bytes each).

| Published bundle | Model ID | Floors | Published pipeline POIs | Graph nodes | Graph edges |
|---|---|---:|---:|---:|---:|
| `gcu/v5` | `jdjvM17BPEh` | 5 | 131 | 1,073 | 3,842 |
| `uncc-main-campus/v2` | `kQBN52JqFE9` | 7 | 170 | 4,900 | 15,783 |

GCU v5's slug, Matterport identity, and version agree with the destination building/current-publication inventory reported by the infrastructure audit. Its 131 pipeline POIs are a different dataset from the destination's 230 curated `pois` rows; differing counts do not justify replacing either dataset. UNCC published objects exist independently of a destination `buildings` row: the destination inventory found no UNCC building. Recovering those objects is not sufficient to invent missing relational metadata or assume integer IDs match.

## Bounded verification

The investigation made four configuration reads, eight bounded core-JSON read attempts, 60 HEAD requests for all unique latest-config asset references, and two bounded missing-object probes. Each core JSON read was limited to 6,000,001 bytes, with oversized responses rejected. Raw JSON is stored only under ignored `platform/var/production-migration/storage/`; no large models, walkgrids, or complete thumbnail collections were downloaded. Schema/config checksums and safe aggregates appear in the [integrity evidence](evidence/storage/published-bundle-integrity.json).

GCU v5: all 27 unique config-referenced assets returned HTTP 200. Readable POI and graph counts match config statistics. Node and POI IDs are unique; all edges reference existing nodes; all POIs reference an existing nearest node; floor references exist; sampled complete POI/node coordinate sets contain finite, in-range longitude/latitude pairs. The graph is connected when considering unpruned edges. Georeferencing identifies the same Matterport model. The 3,002,196-byte floors JSON has matching floor IDs and valid corner coordinate ranges.

UNCC v2: 32 of 33 config-referenced assets returned HTTP 200. The missing reference is `walkgrid.json`. Bounded GET probes for both v1 and v2 returned HTTP 400 with a structured `statusCode: 404`, `Object not found`, `NoSuchKey` body. The 38,566,047-byte floors JSON was confirmed present by HEAD but was not parsed because it exceeds the read budget. The 4,766,733-byte graph and 96,858-byte POI file are readable and match config counts. IDs are unique, edges have valid endpoints, floor references and longitude/latitude ranges are valid, and the unpruned graph is connected. Twenty POIs on F1 have a null nearest node; no non-null nearest-node value points to a missing node. All non-null nearest-node floor assignments match their POI floors.

HEAD availability verifies only the enumerated object names. It does not verify complete binary readability, every thumbnail, every nested GLB texture/reference, upload-generation consistency, or rollback restoration. Geometric placement on a rendered map still requires visual acceptance.

## Unresolved authentic-data defects

| Bundle | Finding | Applicable release impact |
|---|---|---|
| GCU v5 | F2 height `-0.39`; elevation decreases from F2 `3.43` to F3 `3.04` despite increasing ordinal | Review before accepting affected floor geometry or multi-floor navigation |
| UNCC v2 | F5 height `-7.47`; elevation decreases from F5 `14.59` to F6 `7.12` | Review before accepting affected floor geometry or multi-floor navigation |
| UNCC v1/v2 | Missing `walkgrid.json` | Blocks the regular ArcGIS startup path, which requires it; canonical UNCC `mp=1` mode intentionally skips it |
| UNCC v2 | 20 POIs have no snapped node | Server-side published routing for these POIs cannot be accepted without an explicit resolution |
| Both tested bundles | Selected step-free routes unavailable | Accessibility acceptance remains unresolved for those actual start/end pairs |

The investigation did not reorder floors, adjust elevations, regenerate walkgrids, choose replacement nodes, or republish data. Those operations need a reviewed source/data policy and isolated validation.

## Offline real-data route probes

The existing Python route engine was run against actual published POI/node pairs, without Supabase database access or a fabricated venue. Two ordinary routes per building (same-floor and cross-floor) were found; four matching step-free requests returned no route. Route endpoints matched the selected real graph nodes and returned nonempty geometry. GCU ordinary calculations took approximately 7–10 ms in the initial diagnostic; UNCC took 35–40 ms. Reproduction logs contain individual timings; these are local computation measurements, not live API latency, browser render times, or a service-level estimate.

These eight diagnostics are recorded as observed route/no-route outcomes, outside the browser assertion totals. Their success does not establish correct visual path alignment, route safety, accessibility, or full graph acceptance. Source data's `step_free_entrance` flag is false in both configs. [Exact route probes](evidence/storage/authentic-route-probes.json) record the actual identities, measurements, and limitations.

## Read-only local API smoke

The confirmed development API on `127.0.0.1:8780` returned HTTP 200 for `/api/health` and `/api/v1/public/venues/all/manifest.json`. Its manifest is `wayfinding.venue/v1`, listing GCU **v1** with five floors and UNCC **v2** with seven floors. The local GCU version differs from destination GCU v5, and local relational provenance remains unresolved. These results are local-only checks and cannot establish production readiness or destination completeness. [Local API evidence](evidence/storage/local-api-smoke.json).

Reproduce cached integrity checks with `python3 platform/tools/published_bundle_audit.py`; add `--check-remote-assets` for the bounded public HEAD checks. Run `PYTHONPATH=platform/api:platform/pipeline platform/.venv/bin/python platform/tools/published_route_probe.py` for the offline route diagnostics. The tools require the authentic cached JSON files; they do not generate replacement records or silently fetch an unbounded archive.
