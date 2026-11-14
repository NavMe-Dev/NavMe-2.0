"""Prepare local-only matching evidence. Does not edit plans, DBs or publish.

Diagram labels are not surveyed anchors. All floor registrations start absent.
The Model API's puck and panorama positions are Z-up; the runtime SDK is Y-up.
"""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import numpy as np
from shapely.geometry import shape, LineString
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = ROOT / 'outputs/unc-charlotte/student-union'
WORK = ROOT / 'platform/var/data/buildings/uncc-main-campus/work'

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def build(output=DEFAULT, work=WORK):
    catalog = json.loads((output/'floor-inventory.json').read_text())
    model = json.loads((work/'mp_model.json').read_text())['data']['model']
    files = [output/'floor-inventory.json', work/'mp_model.json']
    context = {'schema':'navme.plan-navigation/v1','model_id':catalog['model_id'],
               'building_slug':catalog['parent_building_slug'],'building_id':catalog['building_id'],
               'coordinate_convention':'Model X/Y horizontal Z up; SDK X/Y up/Z depth=(X,Z,-Y)',
               'approved_calibrations':{},'floors':{},'sweeps':[], 'plan_versions':{},
               'automatic_alignment':{'status':'unverified','reason':'Official diagram pixels have no surveyed correspondences. Named POI/label centers are not control points.'}}
    locations = model['locations']
    for floor in catalog['floors']:
        fid=floor['floor_id'];directory=output/'floors'/fid
        meta=json.loads((directory/'metadata.json').read_text())
        a,b,c,d=meta['bounds_model_xy']
        selected=[s for s in locations if s.get('floor',{}).get('id')==meta['source_floor_id']
                  and a<=s['position']['x']<=c and b<=s['position']['y']<=d
                  and s.get('pano',{}).get('placement') in {'auto','manual'} and 'showcase' in s.get('tags',[])]
        spacing=[]
        xy=np.array([[s['position']['x'],s['position']['y']] for s in selected])
        if len(xy)>1:
            distances=np.linalg.norm(xy[:,None,:]-xy[None,:,:],axis=-1)
            np.fill_diagonal(distances,np.inf);spacing=distances.min(axis=1).tolist()
        geo=json.loads((directory/'floorplan.geojson').read_text())
        coverage=[f['geometry']['coordinates'] for f in geo['features'] if f['properties']['kind']=='scan_coverage']
        assert len(coverage)==1
        # Cut only source-authored doorway openings from source-authored walls.
        # No guessed room partition or diagram wall is promoted into this model.
        doors=[shape(f['geometry']).buffer(.12) for f in geo['features'] if f['properties']['kind']=='doorway']
        holes=unary_union(doors)
        source_walls=json.loads((directory/'walls.geojson').read_text())
        wall_lines=[]
        for feature in source_walls['features']:
            geom=shape(feature['geometry']).difference(holes)
            for line in getattr(geom,'geoms',[geom]):
                if isinstance(line,LineString) and line.length>.08:wall_lines.append(list(map(list,line.coords)))
        ground=[s['position']['z'] for s in selected]
        context['floors'][fid]={'label':floor['label'],'source_floor_id':meta['source_floor_id'],
            'source_floor_sequence':meta['source_floor_sequence'],'suggested_elevation_m':meta['elevation_model_m'],
            'floor_binding_status':'requires_verified_calibration','scan_spacing_m':round(statistics.median(spacing),3) if spacing else None,
            'source_sweep_count':len(selected),'source_puck_z_range_m':[min(ground),max(ground)] if ground else None,
            'coverage':coverage[0], 'walls':wall_lines,'rooms':[], 'verified_entrances':[],
            'limitations':['Room identities not verified in model geometry','Floor elevation and SDK floor identity require independent reference points']}
        for s in selected:
            context['sweeps'].append({'id':s['id'],'floor_id':fid,'source_floor_id':meta['source_floor_id'],
                'position':s['position'],'camera_model':s['pano']['position'],'neighbors':s.get('neighbors',[])})
        for name in ['label-plan.svg','label-plan.json','metadata.json','floorplan.geojson','walls.geojson']:
            path=directory/name;files.append(path)
            context['plan_versions'][f'floors/{fid}/{name}']=digest(path)
    context['source_version']=hashlib.sha256(''.join(digest(p) for p in files).encode()).hexdigest()
    path=output/'navigation-context.json';path.write_text(json.dumps(context,separators=(',',':'))+'\n')
    report={ 'source_version':context['source_version'],'source_sweeps':len(context['sweeps']),
             'approved_floor_registrations':0,'automatic_alignment':context['automatic_alignment'],
             'floors':{k:{p:v[p] for p in ['source_sweep_count','source_puck_z_range_m','scan_spacing_m','floor_binding_status']} for k,v in context['floors'].items()}}
    (output/'navigation-evidence').mkdir(exist_ok=True)
    (output/'navigation-evidence/source-audit.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=DEFAULT);parser.add_argument('--work',type=Path,default=WORK)
    args=parser.parse_args();build(args.output,args.work)
