# VPS prototype – evaluation results (Matterport Hn36TwktGgz, 2400 Greenland Ave)

Run: 2026-09-28, box CPU (8 cores, no GPU). Code + how to re-run: [README.md](README.md). Raw per-image results: `results/<config>.json`.

## Method (short)
MegaLoc global retrieval (top-10 of 1,760 reference crops rendered from the 80 Matterport 2k skyboxes) → SuperPoint + LightGlue matching →
2D-3D correspondences via raycasting the MatterPak mesh → pycolmap LO-RANSAC PnP + refinement (focal fixed if HFOV known, else HFOV grid search + focal refinement).
Floor = floor of the nearest sweep to the estimate; heading = compass bearing of the optical axis via the georef rotation.

## Test set and ground truth
* 29 of the 30 public Matterport photos (7680×4320, downscaled to 1024×576); 1 excluded (`zyUrXQmgxSw`, camera_mode 2 = dollhouse/floor-plan view).
* GT position: each photo's `scan_position` equals its source sweep's camera centre exactly (verified 0.0000 m for all 29).
* GT orientation: `camera_quaternion` yaw is consistent (±0.9°) but its pitch is not reproduced in the JPGs, so GT rotation + intrinsics were refined by
  matching each photo to its own skybox (pure-rotation homography, median residual 1.0 px): HFOV 109.8 ± 1.4°, pitch −0.7 ± 0.6°, principal point ~4 % above centre.
* "Heading error" = absolute yaw difference of the optical axis (what a wayfinding UI uses); "rot err" = full 3-D rotation angle (includes a systematic
  ~3° pitch bias caused by assuming a centred principal point, which the Matterport photos don't have).
* Position error is 3-D Euclidean (m). Failures count as misses in the "<0.5 m / <1 m / <5°" columns. No configuration had a hard failure (all returned a pose),
  but some poses are wrong – see confidence gating below.

## Results
| Test | Localized | Median pos err (m) | p90 (m) | Max (m) | <0.5 m | <1 m | Median heading err (°) | p90 heading (°) | Max heading (°) | Median rot err (°) | <5° heading | Floor correct | Mean time (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Standard, HFOV known (110°) | 29/29 | 0.04 | 0.10 | 0.16 | 100% | 100% | 0.6 | 1.6 | 2.7 | 3.7 | 100% | 100% | 2.6 |
| Standard, focal estimated | 29/29 | 0.08 | 0.21 | 0.30 | 100% | 100% | 0.8 | 1.7 | 2.4 | 3.7 | 100% | 100% | 2.9 |
| Leave-one-sweep-out, HFOV known | 29/29 | 0.11 | 0.27 | 0.63 | 97% | 100% | 0.8 | 1.6 | 3.0 | 3.6 | 100% | 100% | 2.7 |
| Phone-like augmentation, HFOV known | 29/29 | 0.04 | 0.14 | 0.22 | 100% | 100% | 1.6 | 3.2 | 4.2 | 4.2 | 100% | 100% | 2.4 |
| Augmented + leave-one-sweep-out, HFOV known | 29/29 | 0.12 | 0.87 | 21.61 | 86% | 93% | 1.4 | 5.3 | 42.6 | 4.2 | 90% | 100% | 2.5 |
| Augmented + LOSO, focal estimated | 29/29 | 0.41 | 9.27 | 76.05 | 59% | 79% | 1.9 | 25.8 | 98.4 | 4.2 | 86% | 90% | 2.9 |

Tests: *Standard* = full database (the photo's own sweep is in the DB). *Leave-one-sweep-out (LOSO)* = all 22 crops of the photo's source sweep removed, so the
photo must be localized from other sweeps (nearest remaining sweep: median 2.1 m, min 0.5 m, max 8.1 m away) – simulates standing between scan points.
*Phone-like augmentation* = centred 60–80° FOV crop with ±4 % principal-point offset, 320×240 capture upsampled to 640×480, Gaussian + motion blur,
gamma/exposure/white-balance jitter, noise, JPEG q55 (examples `results/aug_*.jpg`); "HFOV known" means the crop's true FOV is passed (as if from EXIF).

### With confidence gating (reject `confidence < 0.3`)
| Test | Accepted | Median pos (m) | p90 (m) | Max (m) | Median heading (°) | p90 (°) | Max (°) |
|---|---|---|---|---|---|---|---|
| LOSO, HFOV known | 29/29 | 0.11 | 0.27 | 0.63 | 0.8 | 1.6 | 3.0 |
| Augmented, HFOV known | 29/29 | 0.04 | 0.14 | 0.22 | 1.6 | 3.2 | 4.2 |
| Augmented + LOSO, HFOV known | 25/29 | 0.11 | 0.22 | 0.87 | 1.3 | 3.4 | 4.9 |
| Augmented + LOSO, focal estimated | 24/29 | 0.33 | 0.68 | 6.79 | 1.7 | 3.1 | 4.2 |

The confidence score separates the bad poses well: every error > 1 m in the known-FOV runs had confidence ≤ 0.14. With unknown focal, one accepted
estimate was still 6.8 m off (focal estimation on a narrow, degraded crop is the weakest link: HFOV abs error median 2.8°, p90 21°).

### Runtime (CPU, 8 threads, 1024-px query, 10 retrieved crops)
Mean 2.6 s per query: retrieval 0.28 s, SuperPoint 0.60 s, LightGlue ×10 1.71 s, PnP 0.03 s (+0.3 s for the unknown-focal grid). Model load ~5 s, ~2.5 GB RAM.
DB build: 29.5 min for 80 sweeps (1,760 crops, 843 MB).

## Failure cases
* **wVAYLkSbRGP (S72, west end of the upper hall/porch, looking at a mostly uniform wall/corner)** – with the source sweep removed and phone-like degradation
  it snaps to a wrong place 21.6 m away (18 inliers, conf 0.13); with unknown focal 53 m. Without augmentation it's fine (0.28 m). Cause: few distinctive
  structures in a 60–80° crop; the neighbours of S72 are far (S70 is 14 m away).
* **abo6bdLuvzx (S69, outdoor south lawn/path)** – LOSO: 0.63 m with only 44 inliers; augmented+LOSO 0.89 m (24 inliers); unknown focal 76 m. Outdoor
  vegetation/sky, sparse sweeps (nearest other sweep 8.1 m) and the mesh is poor for trees.
* **x8khoJ7nzxw (S26, small podcast room)** – augmented+LOSO 1.7 m / 14° (10 inliers). Close-range furniture seen from a different sweep changes appearance a lot.
* **954q3vR35w9 / 6wu1ho93yXt (S69 outdoor)** – correct in known-FOV runs but low confidence; wrong (2–14 m) with unknown focal.
* Floor classification was 100 % correct in all known-FOV runs; 90 % with unknown focal (the 3 gross outliers).
* Systematic ~3–4° full-rotation error even when position is ~5 cm: pitch bias from assuming a centred principal point (photos have cy ≈ 0.46·H).
  Heading (yaw) is unaffected (median 0.6–1.6°).

## Caveat – these numbers are optimistic for real phone photos
The Matterport photos are **rendered from the very same panoramas** used to build the database (same exposure, same moment in time, same people/furniture,
same camera centre as a sweep, perfect pinhole). The standard test is therefore close to an upper bound. LOSO and the augmentations remove part of this
advantage (new viewpoint, lower resolution, blur, exposure changes, narrow FOV) but not all of it: real phone photos will additionally have different
lighting/time of day, moved furniture and people, lens distortion and rolling shutter, HDR/tone mapping, arbitrary heights (not tripod height 1.1–1.5 m),
portrait orientation and tilt, and positions up to several metres from any sweep. Expect noticeably lower recall and larger errors in the field;
see `../FIELD_TEST_PLAN.md` and use `../app/localize.html` to measure it.

## Visualizations
* `results/viz_std_vs_loso.jpg` – floor plans, green = GT position + heading, red = standard, blue = leave-one-sweep-out.
* `results/viz_aug_loso.jpg` – red = augmented + LOSO (known FOV), blue = augmented + LOSO (focal estimated).

## Per-image tables
**Per image – Leave-one-sweep-out, HFOV known**

| Photo | Sweep | Pos err (m) | Heading err (°) | Floor ok | Inliers | Conf | Time (s) |
|---|---|---|---|---|---|---|---|
| abo6bdLuvzx | S69 | 0.63 | 3.0 | ✓ | 44 | 0.36 | 2.0 |
| 9ov7P8PnQTA | S72 | 0.29 | 0.8 | ✓ | 580 | 1.00 | 2.7 |
| wVAYLkSbRGP | S72 | 0.28 | 0.7 | ✓ | 47 | 0.41 | 2.8 |
| x8khoJ7nzxw | S26 | 0.27 | 1.6 | ✓ | 79 | 0.73 | 2.2 |
| 6wu1ho93yXt | S69 | 0.23 | 0.4 | ✓ | 531 | 1.00 | 2.8 |
| ACvjzzKJern | S4 | 0.21 | 1.6 | ✓ | 1176 | 1.00 | 3.0 |
| yLFtwrDtbFq | S76 | 0.16 | 0.7 | ✓ | 1662 | 1.00 | 2.6 |
| JfYaRyrXURC | S78 | 0.16 | 0.2 | ✓ | 1079 | 1.00 | 2.3 |
| g8fKdVqS9ry | S44 | 0.16 | 2.3 | ✓ | 978 | 1.00 | 3.4 |
| 954q3vR35w9 | S69 | 0.15 | 1.3 | ✓ | 574 | 1.00 | 2.6 |
| DbAdYUQ1N2h | S35 | 0.14 | 0.8 | ✓ | 740 | 1.00 | 5.2 |
| UMnBooqTigU | S0 | 0.13 | 1.0 | ✓ | 1185 | 1.00 | 2.7 |
| fBNpVMLFWKR | S53 | 0.11 | 0.1 | ✓ | 881 | 1.00 | 1.8 |
| ZASr2LbY1vj | S72 | 0.11 | 0.5 | ✓ | 61 | 0.59 | 2.0 |
| SxtD1FKTT49 | S16 | 0.11 | 0.2 | ✓ | 1876 | 1.00 | 2.5 |
| iEwFt9TY1wx | S58 | 0.10 | 0.6 | ✓ | 785 | 1.00 | 1.7 |
| 6MyL9ec9GJL | S56 | 0.09 | 0.2 | ✓ | 879 | 1.00 | 2.0 |
| Ty4Ym7nore5 | S2 | 0.09 | 0.8 | ✓ | 1375 | 1.00 | 4.0 |
| n57tVSBQ4eW | S43 | 0.09 | 0.0 | ✓ | 881 | 1.00 | 3.4 |
| h8Dyf9QmeF1 | S9 | 0.08 | 0.9 | ✓ | 401 | 1.00 | 1.8 |
| zxVJRS1tMwH | S64 | 0.08 | 0.9 | ✓ | 1527 | 1.00 | 2.5 |
| ojtntbrp1kf | S65 | 0.07 | 0.0 | ✓ | 1886 | 1.00 | 2.8 |
| h31pJG2eFhr | S53 | 0.07 | 0.9 | ✓ | 715 | 1.00 | 2.0 |
| S5iUpzEmDrS | S25 | 0.06 | 0.0 | ✓ | 1141 | 1.00 | 3.6 |
| UzzXj8fao2q | S46 | 0.05 | 0.3 | ✓ | 951 | 1.00 | 3.7 |
| P3eVRiGhqaY | S4 | 0.05 | 0.4 | ✓ | 637 | 1.00 | 2.4 |
| PA6BPze28gs | S0 | 0.05 | 1.2 | ✓ | 537 | 1.00 | 2.8 |
| oQWyBwgqJB7 | S4 | 0.04 | 1.4 | ✓ | 357 | 1.00 | 2.5 |
| qubjLgeyMqt | S31 | 0.04 | 0.8 | ✓ | 1469 | 1.00 | 2.6 |


**Per image – Augmented + leave-one-sweep-out, HFOV known**

| Photo | Sweep | Pos err (m) | Heading err (°) | Floor ok | Inliers | Conf | Time (s) |
|---|---|---|---|---|---|---|---|
| wVAYLkSbRGP | S72 | 21.61 | 42.6 | ✓ | 18 | 0.13 | 2.4 |
| x8khoJ7nzxw | S26 | 1.67 | 14.4 | ✓ | 10 | 0.03 | 1.9 |
| abo6bdLuvzx | S69 | 0.89 | 6.8 | ✓ | 24 | 0.14 | 3.0 |
| ZASr2LbY1vj | S72 | 0.87 | 4.9 | ✓ | 37 | 0.42 | 2.5 |
| Ty4Ym7nore5 | S2 | 0.27 | 0.7 | ✓ | 180 | 0.99 | 2.2 |
| JfYaRyrXURC | S78 | 0.22 | 1.1 | ✓ | 446 | 1.00 | 2.3 |
| h31pJG2eFhr | S53 | 0.22 | 0.1 | ✓ | 265 | 1.00 | 2.2 |
| yLFtwrDtbFq | S76 | 0.19 | 3.4 | ✓ | 404 | 1.00 | 2.3 |
| PA6BPze28gs | S0 | 0.17 | 3.5 | ✓ | 217 | 1.00 | 2.7 |
| h8Dyf9QmeF1 | S9 | 0.16 | 0.9 | ✓ | 88 | 0.83 | 2.0 |
| UMnBooqTigU | S0 | 0.15 | 1.6 | ✓ | 705 | 1.00 | 3.2 |
| 6MyL9ec9GJL | S56 | 0.14 | 0.5 | ✓ | 105 | 0.66 | 2.2 |
| ACvjzzKJern | S4 | 0.14 | 3.7 | ✓ | 160 | 0.98 | 2.0 |
| fBNpVMLFWKR | S53 | 0.12 | 1.4 | ✓ | 238 | 1.00 | 2.0 |
| 9ov7P8PnQTA | S72 | 0.12 | 0.1 | ✓ | 108 | 0.93 | 2.8 |
| 6wu1ho93yXt | S69 | 0.11 | 1.0 | ✓ | 63 | 0.39 | 2.4 |
| g8fKdVqS9ry | S44 | 0.10 | 2.3 | ✓ | 440 | 1.00 | 3.2 |
| iEwFt9TY1wx | S58 | 0.10 | 1.0 | ✓ | 216 | 0.99 | 2.0 |
| 954q3vR35w9 | S69 | 0.08 | 1.0 | ✓ | 36 | 0.21 | 3.5 |
| oQWyBwgqJB7 | S4 | 0.06 | 3.1 | ✓ | 164 | 0.98 | 2.1 |
| S5iUpzEmDrS | S25 | 0.06 | 0.6 | ✓ | 304 | 1.00 | 2.8 |
| ojtntbrp1kf | S65 | 0.05 | 1.7 | ✓ | 613 | 1.00 | 2.2 |
| SxtD1FKTT49 | S16 | 0.05 | 0.7 | ✓ | 885 | 1.00 | 2.5 |
| zxVJRS1tMwH | S64 | 0.05 | 3.0 | ✓ | 627 | 1.00 | 1.9 |
| P3eVRiGhqaY | S4 | 0.05 | 2.1 | ✓ | 196 | 0.99 | 2.3 |
| UzzXj8fao2q | S46 | 0.05 | 1.0 | ✓ | 582 | 1.00 | 2.8 |
| n57tVSBQ4eW | S43 | 0.04 | 1.3 | ✓ | 380 | 1.00 | 3.3 |
| DbAdYUQ1N2h | S35 | 0.04 | 0.8 | ✓ | 77 | 0.69 | 3.4 |
| qubjLgeyMqt | S31 | 0.01 | 3.2 | ✓ | 590 | 1.00 | 2.6 |
