# UNC production60 local preflight

Recorded: 2026-11-16T12:36:38.246551+00:00. No application changes, production traffic, deployment or database-pool increase.

**PASS for the two local finite60-user trials only.** Production/Matterport/device acceptance is separate.

Settings: one worker,40AnyIO tokens, admission128/backlog128, pool3+2, checkout wait15seconds. The wait matches the previously reviewed hosted configuration; effective deployment values must still be verified.

| Repeat | Requests / failures | All HTTP P50/P95/P99 ms | Route P95 ms | Floor P95 ms | Peak RSS MiB | CPU % of one core | Max DB checkout ms |
|---|---:|---|---:|---:|---:|---:|---:|
| a | 300 / 0 | 640.72/3617.93/5694.7 | 4714.2 | 322.69 | 252.67 | 94.2 | 4766.82 |
| b | 300 / 0 | 647.65/3281.73/4668.17 | 3335.49 | 308.19 | 263.81 | 95.6 | 4062.72 |

Both trials returned every connection (peak5, checked-out0 afterward), preserved all route hashes, and had zero database-timeout/admission/transport errors or liveness failures. All six recovery readiness probes returned200. Each cold Floor2 cohort used one origin download; both prepared graphs were warmed by four reference routes before timed traffic.

These results support the bounded existing pool with the reviewed wait. They do not prove the wait alone corrected all prior behavior, and they do not certify60physical browsers, post-load WebGL stability or Render capacity. Use the parent production benchmark and browser capture for those claims.

Evidence: [summary](evidence/unc-demo-prod60-local-preflight.json), [repeat A](evidence/unc-demo-prod60-wait15-repeat-a.json), [repeat B](evidence/unc-demo-prod60-wait15-repeat-b.json).
