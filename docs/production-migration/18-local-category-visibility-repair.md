# Local category visibility repair

Recorded 2026-11-13, Asia/Kolkata. **Local repair and browser acceptance PASS.** The backed-up repair is committed and the restarted API/viewer both expose **235 POIs**, including **Basketball Court 8** and **BHM Block 28**. Existing cards, camera focus, floor filtering, search and a real route work. This is not a public production deployment claim.

## Confirmed cause

The local GCU database contains **235 existing CMS-mirrored POIs**. Only 108 were returned publicly because 127 had `published=false` and `extra.stale=true`. All eight Basketball Court and 28 BHM Block POIs were in that hidden group. Their records, categories and source IDs still exist.

The publication filter added during recovery hid those records. An older pipeline-import rule had incorrectly treated unlocked CMS-owned records missing from generated pipeline output as stale; subsequent CMS sync updated their content but never cleared that incorrect retirement. This was not a selected-floor or category-name matching issue.

Read-only comparison confirms the same 235 source IDs exist in the active canonical GCU CMS set. The independent GCU v5 reader preview already shows Basketball Court 8 and BHM Block 28; it is a separate dataset and was not substituted for local GCU v1.

## Permanent code fix

- Pipeline imports preserve CMS-owned POIs when absent from generated output. A matching generated key also cannot replace CMS-authored content; only existing derived routing updates remain allowed.
- Sync can restore an existing mirror only after fetching a valid active canonical row and checking `source=supabase`, `published=false`, `stale=true` and unlocked status. It clears the stale marker and restores visibility. Explicit non-stale drafts and locked, invalid, inactive or absent hidden records are not restored.
- The public `published=true` and current-publication checks remain in place. No draft visibility guard was removed.

Full platform regression: **200 passed, 2 skipped**. These include the new ownership/recovery cases. See [test output](evidence/platform-pytest.txt).

## Bounded local data repair

The authorized repair is restricted to the existing 127 local GCU records after fresh backup verification, complete canonical-ID equality and a no-active-job check. Only `published` and the incorrect `extra.stale` marker may change. Names, coordinates, categories, source IDs, primary keys, other metadata and timestamps must remain unchanged. The repair inserts or deletes no record and performs no Supabase application-data write.

The fresh full local backup is **2,311,581 bytes**, SHA-256 **`4616d6acc6189ee4fa3f0703443240a219ce14c8de23f6ba8e1b1d22d298ab4e`**, retained privately with mode 0600. It was fully decoded and restored into a new isolated local database; **all 11 table counts and fingerprints match**. This is a local PostgreSQL 18 backup, separate from the earlier Supabase PG17 archive. The canonical and local 235-ID sets match exactly.

The bounded transaction changed **exactly 127 existing records**, only `published=false` to `true` and removal of `extra.stale`. All **536 original POI records** match the exact expected two-field transformation; all other **ten tables' full rows and fingerprints are unchanged**. All 235 mirror source IDs equal the active canonical GCU set and no GCU job was active. Primary keys, names, categories, coordinates, timestamps and all other metadata remain intact. Record insertion/deletion count is zero; no full sync, workspace import or publish ran against the working database.

The local API was restarted with the permanent fix and independently returns health 200 and the restored counts. Evidence: [fresh backup/restore](evidence/local-category-visibility-backup.json), [bounded repair and preservation](evidence/local-category-visibility-repair.json). Raw backups, original records and private before/after snapshots remain ignored and private.

## Browser verification

The after-repair browser verification passed **7/7 checks** on the existing local GCU v1 publication. All 235 POIs are unique, and every API category count matches the runtime and visible All list. Basketball Court shows eight and BHM Block 28. An actual POI card opens in each category; SDK focus completes and the camera moves to the restored locations. BHM floor filtering shows six F3 entries. Search finds a restored POI, and a genuine route between restored Basketball/BHM POIs succeeds: **147.3 m, 45 nodes, 34 instructions**. No page errors or browser mutation attempts occurred.

Evidence: [7/7 browser verification](evidence/local-category-visibility/verification.json), [Basketball Court list](evidence/local-category-visibility/basketball-court-list.png), [Basketball Court card](evidence/local-category-visibility/basketball-court-selected.png), [BHM Block list](evidence/local-category-visibility/bhm-block-list.png), [BHM Block card](evidence/local-category-visibility/bhm-block-selected.png). A fresh `http://localhost:8780/gcu-omr` tab was opened for the user; previously open tabs need refresh to replace the old 108-POI in-memory set.

The previous before-state had 108 visible records and empty lists for these categories; it is retained privately and was not reclassified as success. No local GCU/UNCC content was merged into Supabase, and the independent destination GCU v5 reader data remains separate.
