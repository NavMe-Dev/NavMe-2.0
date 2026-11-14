"""Package only reviewed, public floor-plan assets into the Docker build context."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'outputs/unc-charlotte/student-union'
TARGET = ROOT / 'platform/floorplans/student-union'
ROOT_ASSETS = {'floor-inventory.json', 'building-metadata.json', 'student-union-floorplans.pdf'}
FLOOR_ASSETS = {'floorplan.svg', 'floorplan.png', 'floorplan.geojson', 'rooms.geojson', 'corridors.geojson',
                'walls.geojson', 'source-spaces.geojson', 'circulation-evidence.geojson', 'metadata.json',
                'label-plan.svg', 'label-plan.json'}


def package(source=SOURCE, target=TARGET):
    catalog = json.loads((source / 'floor-inventory.json').read_text())
    assert catalog['parent_building_slug'] == 'uncc-main-campus'
    assert catalog['model_id'] == 'kQBN52JqFE9'
    assert catalog['complete_floor_count'] == 0
    assert {f['floor_id'] for f in catalog['floors']} == {'LL', 'L1', 'M', 'L2', 'L3'}
    assets = sorted(ROOT_ASSETS) + [f"floors/{f['floor_id']}/{name}"
        for f in catalog['floors'] for name in sorted(FLOOR_ASSETS)]
    # Source evidence is public; unpublished calibration files are never bundled.
    navigation = source / 'navigation-context.json'
    if navigation.is_file():
        context = json.loads(navigation.read_text())
        assert context['model_id'] == catalog['model_id']
        assert context.get('approved_calibrations') == {}, 'Calibration release needs explicit independent review'
        for asset, sha in context['plan_versions'].items():
            candidate = (source / asset).resolve()
            assert candidate.is_relative_to(source.resolve())
            assert hashlib.sha256(candidate.read_bytes()).hexdigest() == sha
        assets.append('navigation-context.json')
    manifest, supporting = [], []
    for asset in assets:
        src, dest = source / asset, target / asset
        assert src.is_file(), asset
        assert src.resolve().is_relative_to(source.resolve())
        dest.parent.mkdir(parents=True, exist_ok=True)
        if asset == 'building-metadata.json':
            metadata = json.loads(src.read_text())
            metadata = {k: v for k, v in metadata.items() if not k.startswith('reference_docx_')}
            metadata.update(published=True, release_kind='official diagram labels/divisions with separate scan-derived assets',
                            default_presentation='official_labels_divisions',
                            official_reference=catalog['official_reference'],
                            complete_architectural_plans=False, provisional_levels=['M'])
            dest.write_text(json.dumps(metadata, indent=2) + '\n')
        else:
            shutil.copyfile(src, dest)
        (supporting if asset == 'navigation-context.json' else manifest).append({'path': asset, 'bytes': dest.stat().st_size,
                         'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
    (target / 'runtime-manifest.json').write_text(json.dumps({'assets': manifest, 'supporting_files': supporting,
        'excluded': ['audit/', 'raw DOCX/EMF', 'local source inventory', 'reference comparisons', 'navigation-evidence/', 'floorplan-calibration-drafts/'],
        'complete_floor_count': 0, 'provisional_levels': ['M']}, indent=2) + '\n')
    print(f'Packaged {len(assets)} public assets ({sum(f["bytes"] for f in manifest + supporting):,} bytes)')
    return manifest + supporting


if __name__ == '__main__':
    package()
