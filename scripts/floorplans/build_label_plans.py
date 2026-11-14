"""Build clean, diagram-coordinate vectors from reviewed university plan traces.

No source download, image assets, production database or model alignment needed.
The reviewed source URLs, checksums, contours and label transcriptions live in
student_union_labels.json. Never project navigation routes into these pixels.
"""
import argparse
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).with_name('student_union_labels.json')
DEFAULT_OUTPUT = ROOT / 'outputs/unc-charlotte/student-union'


def write(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def build(output=DEFAULT_OUTPUT):
    reference = json.loads(DATA.read_text())
    catalog = json.loads((output / 'floor-inventory.json').read_text())
    total = 0
    for floor in catalog['floors']:
        fid = floor['floor_id']
        data = reference['floors'][fid]
        labels = data['labels']
        assert len({label['id'] for label in labels}) == len(labels)
        directory = output / 'floors' / fid
        directory.mkdir(parents=True, exist_ok=True)
        elements = []
        elements.append(f'<path class="outline" d="{data["outline"]}"/>')
        for region in data['regions'] + data.get('extra_regions', []):
            attrs = f'id="{region["id"]}" class="division"'
            if 'points' in region:
                points = ' '.join(f'{x},{y}' for x, y in region['points'])
                elements.append(f'<polygon {attrs} points="{points}"/>')
            else:
                elements.append(f'<path {attrs} d="{region["path"]}"/>')
        for line in data['divisions']:
            points = ' '.join(f'{x},{y}' for x, y in line['points'])
            dash = ' stroke-dasharray="5 5"' if line['dashed'] else ''
            elements.append(f'<polyline class="partition" points="{points}"{dash}/>')
        for label in labels:
            x, y = label['position']
            size = label['size']
            lines = label['lines']
            height = size * 1.25
            top = -height * (len(lines)-1)/2
            # Separate transparent hit areas let every transcribed label be
            # selected by pointer or keyboard without pretending it is a POI.
            width = max(len(s) for s in lines) * size * .57 + 12
            safe_id, name = html.escape(label['id']), html.escape(label['text'])
            elements.append(f'<g class="plan-label" data-label-id="{safe_id}" tabindex="0" '
                            f'role="button" aria-label="{name}" '
                            f'transform="translate({x} {y}) rotate({label["rotation"]})">')
            elements.append(f'<rect class="label-hit" x="{-width/2:.1f}" y="{top-size*.75:.1f}" '
                            f'width="{width:.1f}" height="{height*len(lines):.1f}" rx="4"/>')
            elements.append(f'<text font-size="{size}">')
            for i, line in enumerate(lines):
                elements.append(f'<tspan x="0" y="{top+i*height:.1f}">{html.escape(line)}</tspan>')
            elements.append('</text></g>')
        title = html.escape(data['label'])
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1824 1368" role="img" aria-labelledby="plan-title">
<title id="plan-title">Student Union — {title} — labels and divisions</title>
<style>
.outline,.division{{fill:#fff;stroke:#667a72;stroke-width:2;stroke-linejoin:round}}
.partition{{fill:none;stroke:#667a72;stroke-width:2}}
.plan-label{{cursor:pointer;outline:none}}
.plan-label text{{fill:#193f33;font-family:Arial,sans-serif;text-anchor:middle;dominant-baseline:central;paint-order:stroke;stroke:#fff;stroke-width:3;stroke-linejoin:round}}
.label-hit{{fill:transparent;stroke:none}}
.plan-label:hover .label-hit,.plan-label:focus .label-hit,.plan-label.fp-selected .label-hit{{fill:#d9efe4;stroke:#24785c;stroke-width:1.5}}
.division.fp-region-selected{{fill:#edf7f1;stroke:#24785c;stroke-width:3}}
</style>
<rect width="1824" height="1368" fill="white"/>
<text x="50" y="55" fill="#193f33" font-family="Arial,sans-serif" font-size="23">Student Union</text>
<text x="50" y="85" fill="#53695f" font-family="Arial,sans-serif" font-size="19">{title}</text>
<g id="plan-geometry">{''.join(elements)}</g>
<text x="50" y="1330" fill="#64756d" font-family="Arial,sans-serif" font-size="15">Labels and divisions redrawn from UNC Charlotte’s published floor plans · Diagram, not to scale</text>
</svg>
'''
        (directory / 'label-plan.svg').write_text(svg)
        metadata = {'floor_id': fid, 'label': data['label'], 'presentation': 'official_labels_divisions',
                    'source_url': data['source_url'], 'source_sha256': data['source_sha256'],
                    'reference_page': reference['reference_page'],
                    'coordinate_space': 'official diagram pixels', 'model_registered': False,
                    'view_box': [180, 0, 1530, 1280] if fid == 'L1' else [120, 80, 1590, 1170],
                    'labels': labels, 'region_count': len(data['regions']) + len(data.get('extra_regions', [])),
                    'partition_count': len(data['divisions']),
                    'note': 'Labels and divisions from the university diagram. Diagram not to scale.'}
        write(directory / 'label-plan.json', metadata)
        floor.update(label=data['label'], label_plan='label-plan.svg', label_metadata='label-plan.json',
                     official_label_count=len(labels))
        total += len(labels)
    catalog.update(presentation='official_labels_divisions', official_label_count=total,
                   official_reference=reference['reference_page'])
    write(output / 'floor-inventory.json', catalog)
    print(f'Built {len(catalog["floors"])} label/division plans with {total} labels')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    build(parser.parse_args().output)
