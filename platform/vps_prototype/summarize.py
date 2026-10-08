"""Summarize results/*.json into a markdown table (results/summary.md)."""
import json, os, sys, numpy as np
from evaluate import CONFIGS
DESC = {'std_knownf': 'Standard, HFOV known (110°)', 'std_unknownf': 'Standard, focal estimated',
        'loso_knownf': 'Leave-one-sweep-out, HFOV known', 'aug_knownf': 'Phone-like augmentation, HFOV known',
        'aug_loso_knownf': 'Augmented + leave-one-sweep-out, HFOV known', 'aug_loso_unknownf': 'Augmented + LOSO, focal estimated'}
def pct(a, q): return float(np.percentile(a, q)) if len(a) else float('nan')
lines = ['| Test | Localized | Median pos err (m) | p90 (m) | Max (m) | <0.5 m | <1 m | Median heading err (°) | p90 heading (°) | Max heading (°) | Median rot err (°) | <5° heading | Floor correct | Mean time (s) |',
         '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
per = {}
for name in CONFIGS:
    f = f'results/{name}.json'
    if not os.path.exists(f): continue
    R = json.load(open(f)); n = len(R); ok = [r for r in R if r['success']]
    pe = np.array([r['pos_err'] for r in ok]); ye = np.array([r['yaw_err'] for r in ok]); re_ = np.array([r['rot_err'] for r in ok])
    # failures count as misses for the threshold rates
    w05 = sum(pe < 0.5) / n; w1 = sum(pe < 1) / n; h5 = sum(ye < 5) / n
    fl = sum(r['floor_ok'] for r in ok) / n
    t = np.mean([r['time'] for r in R])
    lines.append(f"| {DESC[name]} | {len(ok)}/{n} | {np.median(pe):.2f} | {pct(pe,90):.2f} | {pe.max():.2f} | {w05:.0%} | {w1:.0%} | {np.median(ye):.1f} | {pct(ye,90):.1f} | {ye.max():.1f} | {np.median(re_):.1f} | {h5:.0%} | {fl:.0%} | {t:.1f} |")
    per[name] = R
out = '\n'.join(lines)
# per-image table for the hardest two configs
for name in ['loso_knownf', 'aug_loso_knownf']:
    if name not in per: continue
    out += f"\n\n**Per image – {DESC[name]}**\n\n| Photo | Sweep | Pos err (m) | Heading err (°) | Floor ok | Inliers | Conf | Time (s) |\n|---|---|---|---|---|---|---|---|\n"
    for r in sorted(per[name], key=lambda r: -r.get('pos_err', 1e9)):
        if r['success']:
            out += f"| {r['photo']} | S{r['sweep']} | {r['pos_err']:.2f} | {r['yaw_err']:.1f} | {'✓' if r['floor_ok'] else '✗'} | {r['inliers']} | {r['confidence']:.2f} | {r['time']:.1f} |\n"
        else:
            out += f"| {r['photo']} | S{r['sweep']} | FAIL ({r['n_matches']} matches) | – | – | – | – | {r['time']:.1f} |\n"
open('results/summary.md', 'w').write(out); print(out)
