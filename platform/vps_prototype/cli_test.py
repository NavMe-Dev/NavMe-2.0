#!/usr/bin/env python3
"""CLI test.  Direct:   python3 cli_test.py photo.jpg [--hfov 70]
          Via HTTP: python3 cli_test.py photo.jpg --url http://localhost:8770"""
import argparse, json, sys, os, time
ap = argparse.ArgumentParser(); ap.add_argument('images', nargs='+'); ap.add_argument('--hfov', type=float)
ap.add_argument('--url'); a = ap.parse_args()
if a.url:
    import urllib.request, uuid
    for p in a.images:
        bnd = uuid.uuid4().hex; body = b''
        body += f'--{bnd}\r\nContent-Disposition: form-data; name="image"; filename="{os.path.basename(p)}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode() + open(p, 'rb').read() + b'\r\n'
        if a.hfov: body += f'--{bnd}\r\nContent-Disposition: form-data; name="hfov"\r\n\r\n{a.hfov}\r\n'.encode()
        body += f'--{bnd}--\r\n'.encode()
        t = time.time()
        r = urllib.request.Request(a.url.rstrip('/') + '/localize', data=body, headers={'Content-Type': f'multipart/form-data; boundary={bnd}'})
        print(p, json.dumps(json.load(urllib.request.urlopen(r, timeout=300)), indent=1), f'(round trip {time.time()-t:.1f}s)')
else:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import cv2
    from localize import Localizer
    L = Localizer()
    for p in a.images:
        r = L.localize(cv2.imread(p), hfov=a.hfov); r.pop('R_wc', None)
        print(p, json.dumps(r, indent=1, default=float))
