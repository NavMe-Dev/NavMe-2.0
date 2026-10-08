"""Refine ground-truth orientation + intrinsics of the Matterport photos.
The photo camera centre equals the sweep camera centre exactly (scan_position == pano position),
so photo <-> skybox rendering is related by a pure-rotation homography
    x_photo ~ K_p R_p^T R_r K_r^-1 x_render.
We match SIFT features between the photo and a wide rendering of its source skybox, fit H with
RANSAC, then solve for K_p (f, cx, cy) and R_p by nonlinear least squares on the inliers."""
import numpy as np,cv2,json
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot
from vpslib import *
S=load_sweeps()['sweeps']; byu={s['uuid']:s for s in S}
P=json.load(open('data/player.json'))
N=np.array([[1,0,0],[0,0,-1],[0,1,0.]])
sift=cv2.SIFT_create(8000)
def feats(img):
    k,d=sift.detectAndCompute(cv2.cvtColor(img,cv2.COLOR_BGR2GRAY),None); return np.float32([p.pt for p in k]),d
out={}
for im in P['images']:
    m=json.loads(im['metadata'])
    if m['camera_mode']!=0: continue
    s=byu[m['scan_id']]; Rp=quat_R(s['rot']); sky=Sky(s['id'])
    photo=cv2.imread(f"data/photos/{im['sid']}.jpg"); h,w=photo.shape[:2]
    Rq=N@quat_R(m['camera_quaternion']).T@np.diag([1,-1,-1.])
    f=Rq[:,2]; yaw0=np.degrees(np.arctan2(f[1],f[0]))
    Wr,Hr=1400,1000; Kr=K_from_fov(Wr,Hr,140); Rr=look_R(yaw0+90,0)
    ren=render_persp(sky,Rp,Rr,Kr,Wr,Hr)
    k1,d1=feats(photo); k2,d2=feats(ren)
    mt=cv2.BFMatcher().knnMatch(d1,d2,k=2)
    g=[a for a,b in mt if a.distance<0.8*b.distance]
    p1=k1[[a.queryIdx for a in g]]; p2=k2[[a.trainIdx for a in g]]
    H,inl=cv2.findHomography(p2,p1,cv2.USAC_MAGSAC,3.0,maxIters=20000)
    inl=inl.ravel().astype(bool); p1=p1[inl]; p2=p2[inl]
    # world directions of render inliers
    rays=np.c_[p2,np.ones(len(p2))]@np.linalg.inv(Kr).T; rays/=np.linalg.norm(rays,axis=1,keepdims=True)
    dw=rays@Rr.T
    def proj(x):
        R=Rot.from_rotvec(x[:3]).as_matrix(); f_,cx,cy=x[3:]
        c=dw@R  # world->cam: R^T d  => (d @ R)
        return np.c_[f_*c[:,0]/c[:,2]+cx, f_*c[:,1]/c[:,2]+cy]
    f0=(w/2)/np.tan(np.radians(55))
    x0=np.r_[Rot.from_matrix(Rq).as_rotvec(),f0,w/2,h/2]
    # init rotation from Rr and H with K0
    K0=K_from_fov(w,h,110); A=np.linalg.inv(K0)@H@Kr; U,_,Vt=np.linalg.svd(A); Rrel=U@Vt
    if np.linalg.det(Rrel)<0: Rrel=-Rrel
    x0[:3]=Rot.from_matrix(Rr@Rrel.T).as_rotvec()
    r=least_squares(lambda x:(proj(x)-p1).ravel(),x0,loss='huber',f_scale=1.0)
    res=np.linalg.norm((proj(r.x)-p1),axis=1)
    R=Rot.from_rotvec(r.x[:3]).as_matrix(); fw=R[:,2]
    hfov=2*np.degrees(np.arctan(w/2/r.x[3]))
    out[im['sid']]=dict(sweep=s['id'],sweep_index=s['index'],R_wc=R.tolist(),f=r.x[3],cx=r.x[4],cy=r.x[5],w=w,h=h,hfov=hfov,
        inliers=int(inl.sum()),rms_px=float(np.sqrt(np.median(res**2))),
        yaw=float(np.degrees(np.arctan2(fw[1],fw[0]))),pitch=float(np.degrees(np.arcsin(fw[2]))),q_yaw=yaw0,q_pitch=float(np.degrees(np.arcsin(f[2]))))
    o=out[im['sid']]; print(im['sid'],s['index'],'inl',o['inliers'],'medres %.2f'%o['rms_px'],'hfov %.2f cx %.1f cy %.1f'%(hfov,o['cx'],o['cy']),'yaw %.1f pitch %.1f | q %.1f %.1f roll %.2f'%(o['yaw'],o['pitch'],yaw0,o['q_pitch'],np.degrees(np.arcsin(R[2,0]))),flush=True)
json.dump(out,open('data/photo_gt.json','w'),indent=1)
