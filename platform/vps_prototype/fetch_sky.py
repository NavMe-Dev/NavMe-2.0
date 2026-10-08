import json,os,urllib.request,concurrent.futures as cf
from gql import q
Q='''{model(id:"Hn36TwktGgz"){floors{id label} locations{id index floor{id} neighbors position{x y z}
 pano{id position{x y z} rotation{x y z w} skyboxes{resolution url children}}}}}'''
d=q(Q); m=d['data']['model']
meta={'floors':m['floors'],'sweeps':[]}
jobs=[]
for l in m['locations']:
    p=l['pano']; sk=[s for s in p['skyboxes'] if s['resolution']=='2k'][0]
    meta['sweeps'].append({'id':l['id'],'index':l['index'],'floor':l['floor']['id'],'position':l['position'],
        'cam':p['position'],'rot':p['rotation'],'neighbors':l['neighbors']})
    for i,u in enumerate(sk['children']):
        jobs.append((u,f"data/sky/{l['id']}_{i}.jpg"))
json.dump(meta,open('data/sweeps.json','w'),indent=1)
def get(j):
    u,f=j
    if os.path.exists(f) and os.path.getsize(f)>1000: return
    r=urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'})
    open(f,'wb').write(urllib.request.urlopen(r,timeout=60).read())
with cf.ThreadPoolExecutor(16) as ex: list(ex.map(get,jobs))
print(len(jobs))
