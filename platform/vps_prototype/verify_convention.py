"""NOTE: this wide-baseline reprojection test turned out INCONCLUSIVE (SIFT on 3-13 m baselines gives mostly wrong matches);
the decisive checks are verify_depth_overlay.py and verify_relpose.py. Original intent: empirically determine the skybox face convention: for each hypothesis of the pano-local
direction of face 1, render crops at neighbouring sweeps, match SIFT, lift sweep-A keypoints to 3D by
raycasting the MatterPak mesh, project into sweep B and measure reprojection error."""
import numpy as np,cv2,json,sys
from vpslib import *
S=load_sweeps()['sweeps']; byid={s['id']:s for s in S}
sift=cv2.SIFT_create(4000)
w,h=640,480; K=K_from_fov(w,h,90)
rng=np.random.default_rng(0)
pairs=[]
for s in S:
    for n in s['neighbors']:
        t=byid[n]; d=np.linalg.norm([s['cam'][k]-t['cam'][k] for k in 'xyz'])
        if 1.0<d<3.5 and s['floor']==t['floor']: pairs.append((s['id'],n))
rng.shuffle(pairs); pairs=pairs[:8]
def C(s): return np.array([s['cam'][k] for k in 'xyz'])
for pitch_test in [0,-40,40]:
  for f1 in [(1,0,0),(-1,0,0),(0,1,0),(0,-1,0)]:
    conv=dict(f1=f1,cw=True); errs=[]
    for a,b in pairs:
        A,B=byid[a],byid[b]; skyA=Sky(a,conv); skyB=Sky(b,conv)
        v=C(B)-C(A); yaw=np.degrees(np.arctan2(v[1],v[0]))
        for dy in [-60,0,60]:
            R=look_R(yaw+dy,pitch_test)
            ia=render_persp(skyA,quat_R(A['rot']),R,K,w,h); ib=render_persp(skyB,quat_R(B['rot']),R,K,w,h)
            ka,da=sift.detectAndCompute(cv2.cvtColor(ia,cv2.COLOR_BGR2GRAY),None); kb,db=sift.detectAndCompute(cv2.cvtColor(ib,cv2.COLOR_BGR2GRAY),None)
            if da is None or db is None: continue
            mt=[m for m,n in cv2.BFMatcher().knnMatch(da,db,k=2) if m.distance<0.75*n.distance]
            if len(mt)<10: continue
            pa=np.float32([ka[m.queryIdx].pt for m in mt]); pb=np.float32([kb[m.trainIdx].pt for m in mt])
            ray=np.c_[pa,np.ones(len(pa))]@np.linalg.inv(K).T
            D=(ray/np.linalg.norm(ray,axis=1,keepdims=True))@R.T
            loc,ir,_=mesh().ray.intersects_location(np.repeat(C(A)[None],len(D),0),D,multiple_hits=False)
            Xc=(loc-C(B))@R; ok=Xc[:,2]>0.1
            pr=Xc[ok,:2]/Xc[ok,2:]*K[0,0]+K[:2,2]
            e=np.linalg.norm(pr-pb[ir[ok]],axis=1); errs.append(np.median(e))
    print('pitch',pitch_test,'f1',f1,'median reproj err px: %.1f'%np.median(errs),'n',len(errs),flush=True)
