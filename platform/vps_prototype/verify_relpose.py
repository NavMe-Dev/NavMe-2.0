"""Decisive face-convention check: relative rotation/translation between neighbouring sweeps from essential matrices
(computed in pano-local frames) vs. GraphQL pano poses. Expect rel_yaw_obs == PB^T PA and dir B in A-local == PA^T dir."""
import numpy as np,cv2,json
from vpslib import *
from scipy.spatial.transform import Rotation as Rot
S=load_sweeps()['sweeps']; byid={s['id']:s for s in S}
sift=cv2.SIFT_create(4000)
w,h=800,800; K=K_from_fov(w,h,100)
conv=dict(f1=(1,0,0),cw=True)
def C(s): return np.array([s['cam'][k] for k in 'xyz'])
rng=np.random.default_rng(1); pairs=[]
for s in S:
    for n in s['neighbors']:
        t=byid[n]; d=np.linalg.norm(C(s)-C(t))
        if 1.0<d<4 and s['floor']==t['floor']: pairs.append((s['id'],n))
rng.shuffle(pairs)
for a,b in pairs[:8]:
    A,B=byid[a],byid[b]; sa=Sky(a,conv); sb=Sky(b,conv); best=None
    for ya in range(0,360,45):
        Ra=look_R(ya,0); ia=render_persp(sa,np.eye(3),Ra,K,w,h)
        ka,da=sift.detectAndCompute(cv2.cvtColor(ia,cv2.COLOR_BGR2GRAY),None)
        for yb in range(0,360,45):
            Rb=look_R(yb,0); ib=render_persp(sb,np.eye(3),Rb,K,w,h)
            kb,db=sift.detectAndCompute(cv2.cvtColor(ib,cv2.COLOR_BGR2GRAY),None)
            mt=[m for m,n in cv2.BFMatcher().knnMatch(da,db,k=2) if m.distance<0.75*n.distance]
            if len(mt)<30: continue
            pa=np.float32([ka[m.queryIdx].pt for m in mt]); pb=np.float32([kb[m.trainIdx].pt for m in mt])
            E,msk=cv2.findEssentialMat(pa,pb,K,cv2.RANSAC,0.999,1.0)
            if E is None or E.shape!=(3,3): continue
            n,R,t,_=cv2.recoverPose(E,pa,pb,K,mask=msk)
            if best is None or n>best[0]: best=(n,Ra,Rb,R,t)
    n,Ra,Rb,R,t=best
    # cam a -> cam b: Xb = R Xa + t. local frames: Xla = Ra Xa, Xlb = Rb Xb
    R_la_to_lb = Rb@R@Ra.T
    # B centre in A-local: Xa of B centre = -R^T t
    cB_la = Ra@(-R.T@t).ravel()
    PA=quat_R(A['rot']); PB=quat_R(B['rot'])
    def yawof(M): return np.degrees(np.arctan2(M[1,0],M[0,0]))
    dw=C(B)-C(A); 
    print(f"inl {n} rel_yaw_obs {yawof(R_la_to_lb):7.1f}  PB^T PA {yawof(PB.T@PA):7.1f}  PB PA^T {yawof(PB@PA.T):7.1f} | dir B in A-local {np.degrees(np.arctan2(cB_la[1],cB_la[0])):7.1f} ; world dir {np.degrees(np.arctan2(dw[1],dw[0])):7.1f}, PA^T dir {np.degrees(np.arctan2(*(PA.T@dw)[[1,0]])):7.1f} PA dir {np.degrees(np.arctan2(*(PA@dw)[[1,0]])):7.1f}")
