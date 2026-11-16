# UNC Charlotte directions viewpoints — 16 November 2026

The UNC admin building page has an **Adjust POI viewpoints** entry and a
**POI viewpoints** tab. The editor lists all published UNC POIs independently
of floor filters. An admin can point at a door/surface in the digital twin,
or enter a Matterport X/Y/Z look target, preview from the POI, save it, and
reset to the current Studio default. These operations preserve the route
destination, source identity, geometry and calibrated POI position.

The saved override is `pois.extra.directions_viewpoint`, with a typed target
and an opaque revision. Save uses an optimistic revision check; stale edits
return 409. Public responses apply the validated target as the existing
`expected_pos_x/y/z` triple after Studio metadata is read. The internal
override and revision are not returned publicly. Reset removes only this
override and resumes the current Studio target and calibration behavior.

The Matterport viewer now maps expected targets from SDK Y-up to the model
coordinates used by the UI. Directions re-aim once on arrival; POI preview
and tour final views use the target without moving the route endpoint or
changing sweep selection. Existing fallback views remain available.

Production `WF_READ_ONLY` and `DB_READ_ONLY` remain enabled. The only new
mutation exception is authenticated `PUT` for a numeric published POI ID
under `uncc-main-campus`. A separate `POI_VIEWPOINT_DATABASE_URL` uses an
execute-only login. It has no direct table writes or role memberships and
can invoke only the new private capability granted to it. The private
function checks the exact UNC building/model, tenant, publication and POI
source, and updates only the override JSON key. Public/anon execution is
revoked; the schema is outside the Data API. Other edits, sync, jobs and
publishing retain the existing read-only block.

`install_poi_viewpoint_writer.py` rehearses and rolls back by default.
`--apply` installs the private function/login after checking application
data digests. Credentials remain in an ignored 0600 file. The deployed
allowlist is `POI_VIEWPOINT_BUILDINGS=uncc-main-campus`. Disabling either
new setting disables saving; removing both disables the capability while
retaining existing saved targets. Revoke function execution and remove
the dedicated login/schema when retiring the feature, after checking no
active sessions depend on it.

Verification covers validation, authentication and read-only boundaries,
SQL scope, exact row preservation, save/no-op/conflict/reset, source override
precedence, axis conversion, arrival aiming and SDK lifecycle. A real
dedicated-login save/reset rehearsal rolled back and verified all 277 POI
rows unchanged. Private reports remain under ignored
`platform/var/data/production_migration/2026-11-16-poi-viewpoints/`.
