"""Validate generated geometry, source wall alignment, scale, labels and artifacts."""
import json, re
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
from shapely.geometry import shape,LineString
from generate_student_union import SOURCE,OUTPUT,LEVELS


def run():
    inventory=json.loads((OUTPUT/'floor-inventory.json').read_text())
    model=json.loads((SOURCE/'work/mp_model.json').read_text())['data']['model']
    report={'schema':'navme.floorplan-qa/v1','floors':[],'complete_floor_count':0,
            'comparison_note':'Official reference vs scan-derived drawing is a qualitative comparison, not a registered survey overlay.'}
    thumbnails=[]
    for level in LEVELS:
        fid,label,index,elevation=level;root=OUTPUT/'floors'/fid
        required=['floorplan.svg','floorplan.png','floorplan.geojson','rooms.geojson','corridors.geojson','walls.geojson','metadata.json']
        assert all((root/name).is_file() for name in required),fid
        meta=json.loads((root/'metadata.json').read_text())
        plan=json.loads((root/'floorplan.geojson').read_text());walls=json.loads((root/'walls.geojson').read_text())['features']
        invalid=[f['properties'].get('id') for f in plan['features'] if not shape(f['geometry']).is_valid or shape(f['geometry']).is_empty]
        assert not invalid,(fid,invalid)
        floor=model['floors'][index];verts={v['id']:(v['position']['x'],v['position']['y']) for v in floor['vertices']}
        original={e['id']:LineString([verts[v['id']] for v in e['vertices']]) for e in floor['edges']}
        aligned=0
        for wall in walls:
            p=wall['properties']
            if p['kind']=='wall':
                assert shape(wall['geometry']).difference(original[p['source_edge_id']].buffer(.00001)).is_empty
                aligned+=1
        assert meta['vectorization_iou']>.94
        assert all(p['alignment_distance_to_scanned_surface_m']<=1 for p in meta['pois'])
        assert meta['model_to_svg'][0]==-meta['model_to_svg'][3]==10
        im=Image.open(root/'floorplan.png');assert im.size==(3200,2640)
        assert meta['verified_room_count']==len(json.loads((root/'rooms.geojson').read_text())['features'])==0
        assert meta['verified_corridor_count']==len(json.loads((root/'corridors.geojson').read_text())['features'])==0
        report['floors'].append({'floor_id':fid,'label':label,'status':meta['status'],
            'source_wall_segments_aligned_within_10_micrometres':aligned,
            'invalid_geometries':0,'vectorization_iou':meta['vectorization_iou'],
            'poi_count':meta['poi_count'],'poi_alignment_pass':True,'png_size':list(im.size),
            'verified_rooms':0,'verified_corridors':0,'complete_scan':False,
            'manual_review_required':True})
        thumb=ImageOps.contain(im.convert('RGB'),(780,645));tile=Image.new('RGB',(800,700),'#edf1f3');tile.paste(thumb,((800-thumb.width)//2,35));ImageDraw.Draw(tile).text((20,12),label+(' / PROVISIONAL' if fid=='M' else ' / partial coverage'),fill='#263238');thumbnails.append(tile)
        reference={'LL':'lower','L1':'first','M':'mezzanine','L2':'second','L3':'third'}[fid]
        before=Image.open(OUTPUT/'audit'/('official-'+reference+'.webp')).convert('RGB')
        comparison=Image.new('RGB',(2000,1100),'white')
        for x,img in [(0,before),(1000,im.convert('RGB'))]:
            thumb=ImageOps.contain(img,(960,1000));comparison.paste(thumb,(x+(1000-thumb.width)//2,60))
        draw=ImageDraw.Draw(comparison);draw.text((30,20),'UNIVERSITY REFERENCE / complete schematic',fill='#263238');draw.text((1030,20),'GENERATED / measured partial scan only',fill='#263238')
        dest=OUTPUT/'comparisons';dest.mkdir(exist_ok=True);comparison.save(dest/(fid+'-before-after.png'))
    preview=Image.new('RGB',(2400,1400),'#dfe6e9')
    for i,tile in enumerate(thumbnails):preview.paste(tile,((i%3)*800,(i//3)*700))
    preview.save(OUTPUT/'all-floor-previews.png')
    pdf=(OUTPUT/'student-union-floorplans.pdf').read_bytes()
    pages=len(re.findall(rb'/Type\s*/Page\b',pdf));assert pages==5
    report.update({'pdf_pages':pages,'generated_plans':5,'validated_floor_elevations':4,'provisional_levels':1,
                   'all_geometry_checks_pass':True,'full_architectural_room_validation_pass':False,
                   'reason':'Scan coverage and room/corridor/lift/stair identities are incomplete; no missing geometry was fabricated.'})
    (OUTPUT/'geometry-validation.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__':run()
