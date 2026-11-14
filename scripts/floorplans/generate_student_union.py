"""Generate evidence-preserving Student Union plans from the local MatterPak.

No database writes, network access, synthetic rooms, convex-hull infill or publishing.
Model coordinates are X/Y horizontal, Z up; SDK coordinates are X/Y-up/Z-depth.
"""
from __future__ import annotations
import argparse, collections, hashlib, html, json, math, zipfile
from pathlib import Path
import cv2
import numpy as np
from shapely import make_valid
from shapely.geometry import LineString, Point, Polygon, MultiPolygon, box, mapping, shape
from shapely.ops import unary_union, polygonize
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'platform/var/data/buildings/uncc-main-campus'
OUTPUT = ROOT / 'outputs/unc-charlotte/student-union'
# Manually reviewed against the source tags, all seven color plans and official
# diagrams. This is a crop window, NEVER an invented building boundary.
BOUNDS = [140., -20., 240., 80.]
RES = .05
W, H = 1600, 1320
SCALE = 10.
LEVELS = [('LL','Lower Level',2,-4.544),('L1','First Floor',3,.37),
          ('M','Mezzanine',4,3.4),('L2','Second Floor',5,7.06),('L3','Third Floor',6,12.55)]
CRS = {'type':'name','properties':{'name':'LOCAL:MATTERPORT:kQBN52JqFE9:XY_METRES'}}
OFFICIAL = 'https://studentunion.charlotte.edu/about/floor-plans/'


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, allow_nan=False)+'\n')


def feature(geom, **props):
    return {'type':'Feature','geometry':mapping(geom),'properties':props}


def collection(features):
    return {'type':'FeatureCollection','crs':CRS,'coordinate_reference_note':
            'Local model metres, not RFC 7946 longitude/latitude. No surveyed global georeference is claimed.',
            'features':features}


def xy(x,y):
    return 80+(x-BOUNDS[0])*SCALE, 220+(BOUNDS[3]-y)*SCALE


def paths(geom):
    if geom.geom_type=='Polygon':
        return [list(geom.exterior.coords)]+[list(r.coords) for r in geom.interiors]
    if geom.geom_type in ('MultiPolygon','MultiLineString','GeometryCollection'):
        return [p for g in geom.geoms for p in paths(g)]
    if geom.geom_type=='LineString': return [list(geom.coords)]
    return []


def svg_path(geom):
    parts=[]
    for ring in paths(geom):
        if not ring: continue
        pts=[xy(*p[:2]) for p in ring]
        parts.append('M'+' L'.join(f'{x:.3f},{y:.3f}' for x,y in pts)+(' Z' if ring[0]==ring[-1] else ''))
    return ' '.join(parts)


def source_walls(floor):
    verts={v['id']:(v['position']['x'],v['position']['y']) for v in floor['vertices']}
    walls, openings=[],[]
    roi=box(*BOUNDS)
    for edge in floor['edges']:
        line=LineString([verts[v['id']] for v in edge['vertices']])
        if not line.intersects(roi) or line.length<.02: continue
        # Keep the source centerline and explicit opening dimensions. The stored
        # geometry does not stretch walls or bridge gaps between disconnected scans.
        clipped=line.intersection(roi)
        if clipped.geom_type!='LineString' or clipped.length<.02: continue
        doors=[]
        for op in edge.get('openings',[]):
            center=line.interpolate(op['relativeCenter'],normalized=True)
            if not roi.covers(center): continue
            dist=line.length*op['relativeCenter']; half=op['width']/2
            a=line.interpolate(max(0,dist-half));b=line.interpolate(min(line.length,dist+half))
            opening=LineString([a,b]);doors.append((max(0,dist-half),min(line.length,dist+half)))
            openings.append(feature(opening,id=op['id'],kind=op['type'],label=op.get('label'),
                width_m=op['width'],elevation_m=op.get('lowerElevation'),source='Matterport authored opening',
                confidence='source_geometry',source_edge_id=edge['id']))
        # Cut explicit door/window gaps in the drawn wall. Preserve separate
        # centerline segments in the vector deliverable, with their provenance.
        intervals=[];cursor=0.
        for start,end in sorted(doors):
            if start>cursor: intervals.append((cursor,start))
            cursor=max(cursor,end)
        if cursor<line.length: intervals.append((cursor,line.length))
        for j,(start,end) in enumerate(intervals):
            piece=LineString([line.interpolate(start),line.interpolate(end)]).intersection(roi)
            if piece.geom_type=='LineString' and piece.length>=.02:
                walls.append(feature(piece,id=f"{edge['id']}-{j}",source_edge_id=edge['id'],
                    kind='wall',thickness_m=edge.get('thickness',.16),source='Matterport authored wall',confidence='source_geometry'))
    return walls, openings


def mask_polygons(mask):
    contours,hierarchy=cv2.findContours(mask,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    result=[]
    if hierarchy is None:return Polygon()
    def coords(c):return [(BOUNDS[0]+float(p[0][0])*RES,BOUNDS[3]-float(p[0][1])*RES) for p in c]
    for i,c in enumerate(contours):
        if hierarchy[0][i][3]!=-1 or len(c)<3:continue
        holes=[];child=hierarchy[0][i][2]
        while child!=-1:
            if len(contours[child])>=3:holes.append(coords(contours[child]))
            child=hierarchy[0][child][0]
        p=make_valid(Polygon(coords(c),holes))
        if p.area>.35:result.append(p.simplify(.04,preserve_topology=True))
    def only_polygons(g):
        if g.geom_type=='Polygon':return [g]
        return [p for part in getattr(g,'geoms',[]) for p in only_polygons(part)]
    return unary_union([p for g in result for p in only_polygons(g)]) if result else Polygon()


def mesh_coverage(triangles,elevation):
    a,b,c=triangles[:,0],triangles[:,1],triangles[:,2]
    normals=np.cross(b-a,c-a);norm=np.linalg.norm(normals,axis=1)
    flat=np.abs(normals[:,2])/np.maximum(norm,1e-12)>.7
    near=(np.abs(triangles[:,:,2].mean(axis=1)-elevation)<.28)&flat
    mask=np.zeros((2001,2001),np.uint8)
    for tri in triangles[near]:
        px=np.column_stack(((tri[:,0]-BOUNDS[0])/RES,(BOUNDS[3]-tri[:,1])/RES))
        cv2.fillConvexPoly(mask,np.rint(px).astype(np.int32),255)
    # Only sub-15 cm scan gaps are regularized. Large holes/unscanned wings remain.
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    return mask, int(near.sum())


def colorplan_coverage(source,index):
    im=cv2.imread(str(source/f'work/matterpak/colorplan_{index:03}.jpg'))
    a=np.array(json.loads((source/'work/colorplan_map.json').read_text())['model_to_cp_px'])
    # Remap the existing aligned color-plan foreground onto the shared metric grid.
    ys,xs=np.indices((2001,2001),dtype=np.float32)
    mx=BOUNDS[0]+xs*RES;my=BOUNDS[3]-ys*RES
    u=a[0,0]*mx+a[0,1]*my+a[0,2];v=a[1,0]*mx+a[1,1]*my+a[1,2]
    sampled=cv2.remap(im,u.astype(np.float32),v.astype(np.float32),cv2.INTER_NEAREST,borderValue=(51,55,59))
    bg=im[20,20].astype(np.int16)
    mask=(np.abs(sampled.astype(np.int16)-bg).sum(2)>35).astype(np.uint8)*255
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    return mask


def mesh_section(triangles,z):
    selected=triangles[(triangles[:,:,2].min(axis=1)<z)&(triangles[:,:,2].max(axis=1)>z)]
    lines=[]
    for t in selected:
        pts=[]
        for i,j in [(0,1),(1,2),(2,0)]:
            if (t[i,2]-z)*(t[j,2]-z)<0:
                ratio=(z-t[i,2])/(t[j,2]-t[i,2]);pts.append(t[i,:2]+ratio*(t[j,:2]-t[i,:2]))
        if len(pts)==2 and np.linalg.norm(pts[0]-pts[1])>.02:lines.append(LineString(pts))
    if not lines:return []
    from shapely.ops import linemerge
    merged=linemerge(unary_union(lines))
    gs=list(merged.geoms) if hasattr(merged,'geoms') else [merged]
    return [feature(g.simplify(.035),id=f'mesh-section-{i}',kind='wall_candidate',
                    source='MatterPak mesh section',cut_height_model_m=z,confidence='manual_review',
                    warning='May include railings or tall furniture; not a confirmed architectural wall')
            for i,g in enumerate(gs) if g.length>.6]


def svg_plan(level,coverage,walls,openings,pois,metadata):
    esc=html.escape
    fid,label,*_=level
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
      f'<title id="title">Student Union — {esc(label)} scan-derived plan</title>',
      '<desc id="desc">Measured scan coverage and source walls. Unscanned rooms are not reconstructed. Local model coordinates, metres.</desc>',
      '<rect width="1600" height="1320" fill="#fff"/>',
      '<rect x="64" y="52" width="48" height="6" rx="3" fill="#087f8c"/>',
      '<text x="64" y="100" font-family="Arial,sans-serif" font-size="18" letter-spacing="3" fill="#56636c">NAVME / UNC CHARLOTTE</text>',
      f'<text x="64" y="153" font-family="Arial,sans-serif" font-size="42" font-weight="700" fill="#263238">Student Union · {esc(label)}</text>',
      f'<text x="64" y="190" font-family="Arial,sans-serif" font-size="18" fill="#59656d">{esc(metadata["status_label"])} · model kQBN52JqFE9 · geometry in metres</text>',
      '<rect x="64" y="212" width="1032" height="1024" rx="12" fill="#fafbfc" stroke="#e4e8eb"/>',
      f'<g id="plan-geometry"><path data-kind="scan-coverage" d="{svg_path(coverage)}" fill="#e9edef" stroke="#c5ced2" stroke-width=".7" fill-rule="evenodd"/>']
    for i,f in enumerate(walls):
        p=f['properties'];candidate=p['kind']=='wall_candidate'
        parts.append(f'<path data-feature-id="{esc(p["id"])}" data-kind="{p["kind"]}" d="{svg_path(shape(f["geometry"]))}" fill="none" stroke="{"#b5792b" if candidate else "#303b42"}" stroke-width="{1.5 if candidate else max(1.7,p.get("thickness_m",.16)*SCALE):.2f}" stroke-linecap="round"'+(' stroke-dasharray="4 3"' if candidate else '')+'/>')
    for f in openings:
        p=f['properties'];g=shape(f['geometry'])
        parts.append(f'<path data-feature-id="{esc(p["id"])}" data-kind="{p["kind"]}" d="{svg_path(g)}" fill="none" stroke="{"#6d9eac" if p["kind"]=="window" else "#95a5ad"}" stroke-width="1"/>')
    for i,p in enumerate(pois,1):
        x,y=xy(p['model_x'],p['model_y'])
        parts.append(f'<g data-poi-id="{esc(p["id"])}" tabindex="0" role="button" aria-label="{esc(p["name"])}"><title>{esc(p["name"])}</title><circle cx="{x:.2f}" cy="{y:.2f}" r="12" fill="#087f8c" stroke="white" stroke-width="3"/><text x="{x:.2f}" y="{y+4:.2f}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="white">{i}</text></g>')
    parts.append('</g>')
    def text(x,y,value,size=16,color='#52616a',weight='normal'):
        parts.append(f'<text x="{x}" y="{y}" font-family="Arial,sans-serif" font-size="{size}" font-weight="{weight}" fill="{color}">{esc(value)}</text>')
    text(1150,250,'READ THIS PLAN',15,weight='700')
    for i,line in enumerate(['Solid charcoal: source walls','Light gray: scanned floor surface','Blue-gray: source openings','White: no reconstructed geometry','Amber dashed: mesh candidates']):text(1150,290+i*28,line,15)
    text(1150,465,'VERIFIED POI RECORDS',15,weight='700')
    for i,p in enumerate(pois,1):
        text(1150,505+(i-1)*37,f'{i:02d}  {p["name"]}',16)
    if not pois:text(1150,505,'No mapped POIs on this level.',15)
    y=790
    for line in ['Partial scan coverage','Not a construction / life-safety plan',f'Source scans: {metadata["source_scan_count"]}',f'Doorway candidates: {metadata["doorway_count"]}','Room identities: not verified','Stair / lift identity: not verified']:
        text(1150,y,line,15);y+=28
    text(1150,1030,'MODEL +Y',13,weight='700')
    parts.append('<path d="M1205 1110 V1050 M1198 1062 L1205 1050 L1212 1062" fill="none" stroke="#53626b" stroke-width="2"/>')
    text(1150,1140,'True north not surveyed',13)
    parts.append('<path d="M80 1270 H180 M80 1264 V1276 M180 1264 V1276" stroke="#303b42" stroke-width="2"/>')
    text(80,1300,'10 m · model scale',14)
    text(340,1300,'Source geometry preserved · unscanned spaces remain unknown',15)
    parts.append('</svg>')
    return '\n'.join(parts)


def pdf_path(c,g,fill=None,stroke=None,width=1):
    p=c.beginPath()
    for ring in paths(g):
        if not ring:continue
        a,b=xy(*ring[0][:2]);p.moveTo(a,H-b)
        for pt in ring[1:]:a,b=xy(*pt[:2]);p.lineTo(a,H-b)
        if ring[0]==ring[-1]:p.close()
    if fill:c.setFillColor(HexColor(fill))
    if stroke:c.setStrokeColor(HexColor(stroke))
    c.setLineWidth(width);c.drawPath(p,fill=int(bool(fill)),stroke=int(bool(stroke)),fillMode=0)


def pdf_page(c,level,coverage,walls,openings,pois,metadata):
    c.setFillColor(HexColor('#263238'));c.setFont('Helvetica-Bold',34);c.drawString(64,H-95,'UNC Charlotte / Student Union')
    c.setFont('Helvetica',27);c.drawString(64,H-145,level[1])
    c.setFont('Helvetica',16);c.drawString(64,H-185,metadata['status_label']+' — source model kQBN52JqFE9')
    pdf_path(c,coverage,fill='#e9edef',stroke='#c5ced2',width=.7)
    for f in walls:pdf_path(c,shape(f['geometry']),stroke='#b5792b' if f['properties']['kind']=='wall_candidate' else '#303b42',width=1.7)
    for f in openings:pdf_path(c,shape(f['geometry']),stroke='#95a5ad',width=1)
    c.setFont('Helvetica',15)
    for i,p in enumerate(pois,1):
        x,y=xy(p['model_x'],p['model_y']);c.setFillColor(HexColor('#087f8c'));c.circle(x,H-y,11,fill=1,stroke=0)
        c.setFillColor(HexColor('#ffffff'));c.drawCentredString(x,H-y-5,str(i));c.setFillColor(HexColor('#263238'));c.drawString(1140,H-310-i*32,f'{i}. {p["name"]}')
    c.setFillColor(HexColor('#52616a'));c.setFont('Helvetica',14)
    for i,line in enumerate(['Scan-derived geometry','White = not reconstructed','Doorways are source candidates','Room/route semantics need review','Not a life-safety plan','True north not surveyed']):c.drawString(1140,H-700-i*30,line)
    c.setStrokeColor(HexColor('#303b42'));c.line(80,50,180,50);c.drawString(80,24,'10 m / local model scale')
    c.showPage()


def run(source,output):
    output.mkdir(parents=True,exist_ok=True)
    model=json.loads((source/'work/mp_model.json').read_text())['data']['model']
    mesh=np.load(source/'work/mesh.npz');v=mesh['V'];faces=mesh['F']
    in_roi=(v[:,0]>=BOUNDS[0])&(v[:,0]<=BOUNDS[2])&(v[:,1]>=BOUNDS[1])&(v[:,1]<=BOUNDS[3])
    selected=faces[np.any(in_roi[faces],axis=1)];tri=v[selected]
    print('Loaded source mesh; crop faces',len(tri),flush=True)
    poi_records=json.loads((output/'audit/student-union-pois.json').read_text())
    all_floors=[];pdf=canvas.Canvas(str(output/'student-union-floorplans.pdf'),pagesize=(W,H))
    pdf.setTitle('UNC Charlotte Student Union — scan-derived review plans')
    cpmap=json.loads((source/'work/colorplan_map.json').read_text())
    for level in LEVELS:
        fid,label,index,elevation=level;floor=model['floors'][index];provisional=fid=='M'
        loc=[s for s in model['locations'] if s.get('floor',{}).get('id')==floor['id'] and BOUNDS[0]<s['position']['x']<BOUNDS[2] and BOUNDS[1]<s['position']['y']<BOUNDS[3]]
        mask,ntri=mesh_coverage(tri,elevation)
        if provisional:mask=colorplan_coverage(source,index)
        coverage=mask_polygons(mask)
        walls,openings=source_walls(floor)
        if provisional:
            walls=[]
            for candidate in mesh_section(tri,elevation+1.2):
                clipped=shape(candidate['geometry']).intersection(coverage.buffer(.5))
                for part in (list(clipped.geoms) if hasattr(clipped,'geoms') else [clipped]):
                    if part.geom_type=='LineString' and part.length>.6:
                        walls.append(feature(part,**candidate['properties']))
        # Only labels already present in the current Student Union CMS mirror.
        # Assign by actual model height, never its stale generic floor string.
        floorpois=[]
        for p in poi_records:
            target=min(LEVELS,key=lambda f:abs(f[3]-float(p.get('expected_pos_y',p['y']))))
            if target[0]!=fid:continue
            point=Point(p['x'],-p['z'])
            floorpois.append({**p,'model_x':p['x'],'model_y':-p['z'],'floor_id':fid,
                'source_record_floor':p['floor'],'assignment':'nearest validated physical model elevation',
                'alignment_distance_to_scanned_surface_m':round(coverage.distance(point),3)})
        # Preserve actual source space polygons, but do not pretend the scan's
        # coarse "Other" spaces are individually identified rooms or corridors.
        spaces=[]
        for r in model['rooms']:
            if r.get('floor',{}).get('id')!=floor['id'] or any(c.get('label')=='Void' for c in r.get('classifications',[])):continue
            edges=[LineString([(p['position']['x'],p['position']['y']) for p in e['vertices']]) for e in r.get('boundary',{}).get('edges',[])]
            for j,g in enumerate(polygonize(unary_union(edges))):
                g=make_valid(g).intersection(box(*BOUNDS))
                if g.area>4:spaces.append(feature(g,id=r['id']+f'-{j}',kind='unclassified_source_space',source='Matterport room boundary',classification='Other',room_identity_verified=False))
        # Neighbour links are movement evidence, not claimed corridor outlines.
        byid={s['id']:s for s in loc};links=[];seen=set()
        for s in loc:
            for nid in s.get('neighbors',[]):
                key=tuple(sorted([s['id'],nid]));t=byid.get(nid)
                if not t or key in seen:continue
                seen.add(key);a=s['position'];b=t['position']
                if abs(a['z']-elevation)>.8 or abs(b['z']-elevation)>.8:continue
                g=LineString([(a['x'],a['y']),(b['x'],b['y'])])
                if g.length<=4 and coverage.buffer(.5).covers(g):links.append(feature(g,id='link-'+str(len(links)),kind='scan_neighbor_link',source='Matterport sweep graph',corridor_identity_verified=False))
        # Raster/vector round-trip quantifies vectorization, not scan completeness.
        reconstructed=np.zeros_like(mask)
        polygons=list(coverage.geoms) if coverage.geom_type=='MultiPolygon' else [coverage]
        for poly in polygons:
            if poly.geom_type!='Polygon':continue
            def pixels(coords):return np.rint([((x-BOUNDS[0])/RES,(BOUNDS[3]-y)/RES) for x,y in coords]).astype(np.int32)
            cv2.fillPoly(reconstructed,[pixels(poly.exterior.coords)],255)
            for hole in poly.interiors:cv2.fillPoly(reconstructed,[pixels(hole.coords)],0)
        union=np.count_nonzero((mask>0)|(reconstructed>0));iou=np.count_nonzero((mask>0)&(reconstructed>0))/max(union,1)
        meta={'floor_id':fid,'label':label,'source_floor_sequence':index,'source_floor_id':floor['id'],
            'source_floor_label':floor['label'],'elevation_model_m':elevation,'elevation_status':'provisional variable-height scan' if provisional else 'validated by authored doorway threshold heights and sweep positions',
            'status':'provisional_partial' if provisional else 'validated_level_partial_coverage',
            'status_label':'PROVISIONAL / PARTIAL SCAN' if provisional else 'VALIDATED LEVEL / PARTIAL SCAN',
            'complete_building_geometry':False,'source_scan_count':len(loc),'source_floor_triangles':ntri,
            'scanned_surface_area_m2':round(coverage.area,2),'wall_segment_count':len(walls),
            'doorway_count':sum(f['properties']['kind']=='doorway' for f in openings),'window_count':sum(f['properties']['kind']=='window' for f in openings),
            'verified_room_count':0,'verified_corridor_count':0,'unclassified_source_space_count':len(spaces),
            'scan_neighbor_link_count':len(links),'poi_count':len(floorpois),'staircase_count':0,'elevator_count':0,
            'coordinate_reference':CRS,'bounds_model_xy':BOUNDS,'model_to_svg':[SCALE,0,0,-SCALE,80-BOUNDS[0]*SCALE,220+BOUNDS[3]*SCALE],
            'svg_size':[W,H],'true_north_verified':False,'global_georeference_verified':False,
            'vectorization_iou':round(iou,5),'raster_resolution_m':RES,'maximum_contour_simplification_m':.04,
            'source_mesh_section_z':elevation+1.2 if provisional else None,
            'source_colorplan':f'colorplan_{index:03}.jpg','source_alignment_ecc':cpmap['ecc_corr'],
            'manual_review':['Unscanned rooms/wings are not reconstructed','No room number, restroom, elevator or staircase identity is inferred from appearance','Surveyed global control points required before world-map placement']+(['Mezzanine elevation and mesh wall candidates require manual validation'] if provisional else []),
            'pois':floorpois}
        dest=output/'floors'/fid
        geometry=[feature(coverage,id=f'{fid}-coverage',kind='scan_coverage',confidence='scan_derived',not_building_boundary=True)]+walls+openings
        write(dest/'floorplan.geojson',collection(geometry));write(dest/'walls.geojson',collection(walls))
        write(dest/'rooms.geojson',collection([]));write(dest/'corridors.geojson',collection([]))
        write(dest/'source-spaces.geojson',collection(spaces));write(dest/'circulation-evidence.geojson',collection(links))
        write(dest/'metadata.json',meta)
        (dest/'floorplan.svg').write_text(svg_plan(level,coverage,walls,openings,floorpois,meta))
        pdf_page(pdf,level,coverage,walls,openings,floorpois,meta)
        # Save the exact observed mask for reproducible QA; never expose raw CAD occupants.
        cv2.imwrite(str(output/'audit'/f'{fid}-coverage.png'),mask)
        all_floors.append(meta)
        print(fid,label,'wall segments',len(walls),'coverage m2',round(coverage.area),'IoU',round(iou,3),flush=True)
    pdf.save()
    write(output/'floor-inventory.json',{'schema':'navme.floorplans/v1','parent_building_slug':'uncc-main-campus','building_id':'student-union','building_name':'Student Union','model_id':'kQBN52JqFE9','official_reference':OFFICIAL,'validated_level_count':4,'provisional_level_count':1,'complete_floor_count':0,'generated_plan_count':len(all_floors),'floors':[{k:f[k] for k in ['floor_id','label','status','elevation_model_m','source_floor_id','source_floor_sequence','poi_count','scanned_surface_area_m2','wall_segment_count','doorway_count','verified_room_count','verified_corridor_count']} for f in all_floors]})
    write(output/'building-metadata.json',{'building_id':'student-union','name':'Popp Martin Student Union','campus':'UNC Charlotte','model_id':'kQBN52JqFE9','source':'Existing extracted campus MatterPak and cached Matterport model metadata','source_mesh_vertices':int(len(v)),'source_mesh_triangles':int(len(faces)),'student_union_crop_xy_m':BOUNDS,'crop_is_building_boundary':False,'coordinate_reference':CRS,'scale_units':'metres','source_colorplan_pixels_per_metre':cpmap['px_per_m'],'source_colorplan_alignment_ecc':cpmap['ecc_corr'],'global_georeference_status':'unverified: existing OSM Student Union footprint transforms outside the source mesh bounds','reference_docx_local':'z-ab-sp-hl-occ-plan-prnt-2026-10-24100917.531.docx: empty document','reference_docx_drive':'Student_union_z-ab-sp-hl-occ-plan-prnt-2026-10-24094500.735.docx: 3 valid EMF drawings; used for qualitative review only','official_floor_names_source':OFFICIAL,'production_database_changed':False,'published':False})
    return all_floors

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,default=SOURCE);p.add_argument('--output',type=Path,default=OUTPUT)
    a=p.parse_args();run(a.source,a.output)
