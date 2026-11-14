"""Floor-level draft calibration. Never infers control points from room names."""
import json
import hashlib
from functools import lru_cache
from pathlib import Path
import numpy as np
from shapely.geometry import MultiPoint


@lru_cache(maxsize=4)
def _read_context(path: str, modified: int, size: int):
    return json.loads(Path(path).read_text())


def load_context(root: Path, slug: str):
    path = (root / 'navigation-context.json').resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Invalid matching context')
    stat = path.stat()
    context = _read_context(str(path), stat.st_mtime_ns, stat.st_size)
    if context.get('building_slug') != slug:
        raise ValueError('No matching context for this building')
    # Source/diagram changes invalidate every draft; never silently reuse a
    # transformation made for another rendering or mesh revision.
    for asset, expected in context['plan_versions'].items():
        file = (root / asset).resolve()
        if not file.is_relative_to(root.resolve()) or hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise ValueError('Spatial evidence is stale; regenerate the matching context')
    return context


def fit_draft(context, floor_id, payload):
    floor = context['floors'].get(floor_id)
    if not floor:
        raise ValueError('Unknown floor')
    if payload['source_version'] != context['source_version']:
        raise ValueError('Spatial evidence version changed')
    if not payload['floor_verified']:
        raise ValueError('Verify the physical floor and SDK floor identity first')
    anchors = payload['anchors']
    if len({a['sweep_id'] for a in anchors}) != len(anchors):
        raise ValueError('Use distinct physical reference points')
    source = {s['id']: s for s in context['sweeps'] if s['floor_id'] == floor_id}
    if any(not a['verified'] or a['sweep_id'] not in source for a in anchors):
        raise ValueError('Every anchor must be verified on this source floor')
    fit = [a for a in anchors if not a['holdout']]
    holdout = [a for a in anchors if a['holdout']]
    if len(fit) < 4 or len(holdout) < 2:
        raise ValueError('Use at least four fit references and two independent holdout references')
    diagram = np.array([a['diagram'] for a in fit], dtype=float)
    origin = diagram.mean(axis=0)
    centered = diagram - origin
    spread = np.linalg.svd(centered, compute_uv=False)
    if spread[-1] < 10 or spread[0] / spread[-1] > 30:
        raise ValueError('Reference points must span the floor in two dimensions')
    target = np.array([[source[a['sweep_id']]['position'][key] for key in ['x','y']] for a in fit])
    coefficients, _, rank, _ = np.linalg.lstsq(np.column_stack([centered, np.ones(len(fit))]), target, rcond=None)
    if rank != 3:
        raise ValueError('Degenerate floor alignment')
    coefficients[2] -= origin @ coefficients[:2]
    scales = np.linalg.svd(coefficients[:2], compute_uv=False)
    if scales[-1] < .005 or scales[0] > 1 or scales[0] / scales[-1] > 4:
        raise ValueError('Unreliable scale or excessive diagram distortion')
    matrix = [float(coefficients[0,0]),float(coefficients[0,1]),float(coefficients[1,0]),
              float(coefficients[1,1]),float(coefficients[2,0]),float(coefficients[2,1])]
    errors = []
    for anchor in anchors:
        predicted = np.array([*anchor['diagram'],1]) @ coefficients
        expected = np.array([source[anchor['sweep_id']]['position'][key] for key in ['x','y']])
        errors.append(float(np.linalg.norm(predicted-expected)))
    elevation = float(np.median([source[a['sweep_id']]['position']['z'] for a in anchors]))
    if any(abs(source[a['sweep_id']]['position']['z']-elevation) > .65 for a in anchors):
        raise ValueError('Reference points include stairs or different physical levels')
    hull = MultiPoint([a['diagram'] for a in anchors]).convex_hull
    rms = float(np.sqrt(np.mean(np.array(errors)**2)))
    passed = max(errors) <= .5 and rms <= .35
    return {'schema':'navme.floor-calibration/v1','floor_id':floor_id,'model_id':context['model_id'],
            'source_version':context['source_version'],'sdk_floor_id':payload['sdk_floor_id'],
            'source_floor_id':floor['source_floor_id'],'status':'validated_draft' if passed else 'draft',
            'diagram_to_model':matrix,'elevation_model_m':elevation,'valid_region':list(map(list,hull.exterior.coords)),
            'anchors':anchors,'floor_evidence':payload['floor_evidence'],
            'validation':{'passed':passed,'rms_error_m':rms,'max_error_m':max(errors),
                          'holdout_count':len(holdout),'fit_count':len(fit),'errors_m':errors,
                          'verification':'Control-point fit only; live SDK landing validation still required'},
            'published':False}
