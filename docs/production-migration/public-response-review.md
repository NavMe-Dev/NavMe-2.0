# Independent read-only release privacy review

**Latest production review: 18/18 GET-only checks PASS**, after corrected deploy `dep-dbrjjlcipgvc73fq761g` / `6527ba8` went LIVE at 16:25:56 UTC on 13 November 2026. The actual public URL returned `read_only=true`, 99 allowlisted curated GCU v5 POIs, expected public configuration/metadata, anonymous and invalid-token admin/auth reads 401, and traversal 404. No scanned response exposed private user/login/password/hash fields, database URLs, service-role tokens, modern secret-key prefixes or explicit draft/unpublished objects. Bodies and credential values were not saved. **No production mutation probe was sent.** [Exact production privacy checks](evidence/browser/production-gcu-v5-corrected/privacy-preflight.json).

The real production browser run also passed 52 ArcGIS and 15 Matterport/admin-login-UI assertions without mutation attempts or unhandled page errors; the final 16-GET bounded burst returned all 200 with zero 503s. These are scoped observations for the existing read-only GCU v5/99 release, not administrator edit/publish validation or whole-project Supabase security clearance. Legacy RLS findings and live active-CMS metadata scope remain as described below. [Final scoped summary](evidence/browser/production-gcu-v5-corrected/summary.json).

The mode-label fix now updates the stored `data-i18n-aria-label` key when the active view changes and resynchronizes after boot translation, preserving the proper target label on later language passes. Three isolated source-driven regressions cover 2D, 3D, translation failure and a later French DOM pass; the unchanged live 52-check suite passed the visible mode control on every viewport. It changes no publication or access policy.

## Earlier destination-shadow review

Reviewed 13 November 2026 against the verified destination shadow on `127.0.0.1:8782`. **Scoped public-response/authorization checks: PASS, 24/24. This is not a full Supabase security clearance.** No production data or configuration was changed by this review.

## Actual response and authorization evidence

The final preflight inspected the real venue manifest, GCU published configuration and POIs, curated public POIs/categories, floors, translations, Matterport client metadata, AR references, shop profiles, and public runtime flags. No inspected response contained the scanner's private user/account/login fields, password/hash fields, database URI, privileged service-role JWT, modern secret-key prefix, or explicit `published=false`/`draft=true` object. Bodies and secret values were not written to evidence. The curated POI endpoint has a constrained field allowlist for identity/name/floor/category/positions.

Anonymous and invalid-bearer requests to protected admin/authentication reads returned HTTP 401. A published-file traversal attempt returned 404. The public runtime endpoint explicitly confirmed `read_only=true` before six loopback-only empty-body POST/PATCH/DELETE probes ran. Every probe was rejected with HTTP 503 and `application is read-only`, before mutation dependencies. No mutation probes were sent to production.

The preflight tool refuses mutation-method probes for non-loopback hosts, disables redirects, bounds response reads, and reports paths/issues without echoing sensitive values. Three targeted tests pass for nested secret detection/redaction, public-client metadata versus explicit draft objects, and refusal of production mutation probes. [Exact 24 checks](evidence/browser/shadow-gcu-v5/privacy-preflight-final.json).

## Publication boundary

An independent read-only destination query found 230 GCU platform POIs: 82 `auto`, 49 `matterport_room`, and 99 `supabase`; all currently have `published=true`. The immutable GCU v5 published POI file contains 131 pipeline POIs, while the public curated mirror exposes 99 records. Those are separate intentional datasets, not proof of lost records.

The review found a future-exposure gap: the curated public query originally omitted the POI publication flag and current-building-publication check. The backend fix now requires a current publication and `published=true`, preserving the existing 99 GCU rows. Its isolated database/API regression covers an explicitly unpublished mirrored POI and an entirely unpublished building; neither appears in the public response. This review did not create such test rows in production.

Live CMS metadata remains a distinct existing contract: all 235 canonical GCU CMS POIs inspected are `is_active=true`, and the translations endpoint exposes 235 name IDs, including 136 outside the current 99-record mirror. Existing Explore metadata intentionally reads active CMS records live. This is not evidence that those 136 records are inactive/draft, and this review did not silently remove them. It also means the whole application must not be described as an immutable snapshot of every metadata field. [Scope counts](evidence/browser/shadow-gcu-v5/publication-scope-review.json).

## Frontend change review

The `app.js` change emits a view-change event after a real 2D/3D switch. The `ui.js` listener and initial synchronization update the public target-mode label and the active view's default widgets. They do not alter database queries, route selection, POI identities, access policies, coordinates, or published content. The existing Matterport adapter implements the required no-op view/is3D methods and remains compatible. The listener binds once during UI initialization. The final four-viewport browser run directly verifies the corrected label, actual view switch, and subsequent map/search/route behavior.

## Limits and unresolved findings

The 24 checks are bounded endpoint and authorization observations. They do not establish genuine-administrator login, every role combination, every free-text field, or the security of the entire connected Supabase project. Public Matterport application keys are intentionally client metadata; no database/service-role credential is needed in the public viewer.

The pre-existing legacy RLS/advisor findings remain tracked in `07-security-review.md`. This application-layer read-only release does not repair direct Supabase Data API grants/RLS or authorize unrelated NavMe/ConnectLabs changes. The optional AR launch asset 404 and previously identified published geometry/accessibility limitations are also unchanged. A whole-project security PASS must not be inferred from this scoped review.
