"""Download player JSON + the Matterport photos (7680x4320) and store 1024x576 copies in data/photos/."""
import json, urllib.request, io, os, concurrent.futures as cf
from PIL import Image
MODEL = 'Hn36TwktGgz'
os.makedirs('data/photos', exist_ok=True)
r = urllib.request.Request(f'https://my.matterport.com/api/v1/player/models/{MODEL}/', headers={'User-Agent': 'Mozilla/5.0'})
d = json.load(urllib.request.urlopen(r, timeout=60)); json.dump(d, open('data/player.json', 'w'))
def get(im):
    b = urllib.request.urlopen(urllib.request.Request(im['download_url'], headers={'User-Agent': 'Mozilla/5.0'}), timeout=120).read()
    open(f"data/photos/{im['sid']}_full.jpg", 'wb').write(b)
    Image.open(io.BytesIO(b)).convert('RGB').resize((1024, 576), Image.LANCZOS).save(f"data/photos/{im['sid']}.jpg", quality=95)
with cf.ThreadPoolExecutor(8) as ex: list(ex.map(get, d['images']))
print(len(d['images']), 'photos')
