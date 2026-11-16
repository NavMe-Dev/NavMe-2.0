# Production 60-user test monitoring

The root agent controls deployment and load. This monitor performs read-only
Render/DB checks and can signal the root-owned stop file; it does not restart,
resize, deploy, mutate data, or run load itself.

## Window and baseline

- Resource: `srv-db32v3bncjis73e9l2cg`; confirmed workspace
  `tea-d9dsalurnols73d3t4cg`.
- Root supplies the new live deploy ID, test start UTC and test end UTC.
- Query only the test window for failure/restart events. A normal deployment
  instance replacement before test start is not a test crash.
- Save allowlisted series and event metadata under this directory, plus a
  summary. Do not save credentials, raw query text, full private log messages,
  request tokens or user details.

## Sampling

- Fetch CPU usage/limit, memory usage/limit, instance count, HTTP counts by
  status and request latency using explicit RFC3339 start/end timestamps.
- Use 30-second resolution for short test windows. The current official CPU
  API documents a 30-second minimum; MCP defaults to 60 seconds. This is sampled
  platform evidence, not proof that a shorter memory spike did not occur.
- CPU values use `cpu` units (cores); report usage / limit, not raw values as
  percentages. Memory uses bytes; report MiB and percentage of reported limit.
- Query event types `server_failed`, `server_restarted`,
  `server_hardware_failure`, and `service_suspended`, with a bounded limit and
  the same window. Failure event reasons can establish OOM/nonzero exit even
  if application logs do not contain a traceback.
- Read startup log lines matching `API runtime limits` after the new deploy
  starts. Only the safe pool size/overflow/wait/token/read-only values are
  needed; no environment credential listing is required.
- Error logs are summarized by type/count/timestamp. A healthy process plus
  HTTP errors is distinct from a crash or restart.
- Root's load harness owns regular health probes. The monitor may issue one
  separate health request at the boundary; do not add a second high-rate loop.

## Stop signals

Write a brief JSON reason to `/private/tmp/navme-prod60-stop` and notify the
root immediately if any of these occur during the test window:

- Sampled memory exceeds 460 MiB (about 90% of the current 512 MiB limit);
  any observation above 480 MiB is critical immediately.
- Unexpected restart, OOM/server failure or hardware failure event.
- Repeated health failures reported by the root's harness, or the instance
  disappears from service while load is active.

High CPU is a saturation finding to report with latency, not by itself proof of
a crash. A missing series or event page is unavailable evidence, not a zero.

## Network interpretation

Render's outbound bandwidth graph has one point per hour and each point appears
approximately 60 minutes after that hour ends. It cannot immediately isolate a
two-minute test. Client-measured encoded response-body bytes are the immediate
test-window measure; decoded bytes and protocol/header overhead must be labeled
separately. Browser traffic to Matterport/Supabase/external CDNs is distinct from
Render API egress. A 60-VU API test is not 60 simultaneous mobile 3D renderers.

Official references checked on 2026-11-16:

- [CPU metrics API](https://api-docs.render.com/reference/get-cpu)
- [Service event API](https://api-docs.render.com/reference/list-events)
- [Service metrics and bandwidth timing](https://render.com/docs/service-metrics.md)
- [Health checks](https://render.com/docs/health-checks.md)
