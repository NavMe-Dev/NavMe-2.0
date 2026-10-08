import json,sys,urllib.request
def q(query,variables=None):
    r=urllib.request.Request('https://my.matterport.com/api/mp/models/graph',data=json.dumps({'query':query,'variables':variables or {}}).encode(),headers={'Content-Type':'application/json','User-Agent':'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(r,timeout=60))
if __name__=='__main__':
    print(json.dumps(q(sys.argv[1]),indent=1)[:int(sys.argv[2]) if len(sys.argv)>2 else 6000])
