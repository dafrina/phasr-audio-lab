# Cuts the Arp-Ape-ator gorilla illustration into the layers in src/ui/arp/ape/
# (body, head, rail, hands, sparks). Usage: python slice_ape.py <picture.png> <out-dir>
# then export each layer at 0.3x as .webp (needs pillow, numpy, scipy).
import sys, json
from PIL import Image
import numpy as np
from scipy import ndimage as nd

SRC = sys.argv[1]; OUT = sys.argv[2]
a = np.array(Image.open(SRC).convert('RGBA')).astype(np.float32)
H, W = a.shape[:2]
rgb, al = a[..., :3], a[..., 3]
lum = rgb.mean(-1)
yy, xx = np.mgrid[0:H, 0:W]

BAR_TOP, BAR_BOT = 880, 932     # rail rows
CUT = BAR_BOT                   # legs below the rail are dropped

# --- sparks: the 4 small blue blobs outside the body
lab, n = nd.label(al > 40)
sizes = nd.sum(np.ones_like(al), lab, range(1, n + 1))
body_lab = int(np.argmax(sizes)) + 1
spark_mask = (lab > 0) & (lab != body_lab)
# grow a little so their anti-aliased fringe goes with them
spark_mask = nd.binary_dilation(spark_mask, iterations=3) & (al > 0)

# --- hands: light palm + blue wristband, plus their dark outline
def hand_mask(x0, x1, y0, y1):
    box = (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1)
    light = box & (lum > 80) & (al > 200) & (np.abs(rgb[..., 2] - rgb[..., 0]) < 40)
    light &= (yy < BAR_TOP + 40)
    # keep only the biggest light blob (the palm with fingers)
    l, k = nd.label(light)
    if k:
        s = nd.sum(light, l, range(1, k + 1)); light = l == (int(np.argmax(s)) + 1)
    blue = box & (rgb[..., 2] > 180) & (rgb[..., 2] - rgb[..., 0] > 90) & (al > 120)
    core = light | blue
    grown = nd.binary_dilation(core, iterations=13)
    dark = grown & box & (lum < 24) & (al > 120)
    m = core | dark
    m = nd.binary_fill_holes(nd.binary_closing(m, iterations=3))
    m &= box
    # include antialiased edge pixels touching the hand
    edge = nd.binary_dilation(m, iterations=2) & (al > 0) & (lum < 60) & ~((yy >= BAR_TOP) & (lum > 30))
    return m | edge

hands = [hand_mask(285, 535, 730, 915), hand_mask(755, 975, 760, 925)]

def save_layer(name, mask_alpha, src=None):
    src = a if src is None else src
    lay = src.copy()
    lay[..., 3] = src[..., 3] * mask_alpha
    ys, xs = np.nonzero(lay[..., 3] > 1)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    Image.fromarray(lay[y0:y1, x0:x1].clip(0, 255).astype(np.uint8)).save(f'{OUT}/{name}.png')
    return dict(x=int(x0), y=int(y0), w=int(x1 - x0), h=int(y1 - y0))

layout = {}
# soft hand alpha (1px feather)
for i, m in enumerate(hands):
    soft = nd.gaussian_filter(m.astype(np.float32), 0.7)
    soft = np.where(m, np.maximum(soft, 0.9), soft * 0.6)
    layout[f'hand{i}'] = save_layer(f'hand{i}', soft)

for i, side in enumerate([xx < W / 2, xx >= W / 2]):
    layout[f'spark{i}'] = save_layer(f'spark{i}', (spark_mask & side).astype(np.float32))

# --- rail: rebuilt from a clean column so it has no hands baked in
bar = np.zeros_like(a)
clean_l, clean_r = 205, 1050
prof = a[:, clean_l].copy()
for x in range(W):
    if x < clean_l or x > clean_r:
        bar[BAR_TOP:BAR_BOT, x] = a[BAR_TOP:BAR_BOT, x]
    else:
        bar[BAR_TOP:BAR_BOT, x] = prof[BAR_TOP:BAR_BOT]
# the original rail where it is visible beside the body keeps its ends
layout['rail'] = save_layer('rail', np.ones((H, W), np.float32), bar)

# --- body: no sparks, no legs, hands painted over with forearm fur
body = a.copy()
FUR = np.array([36, 34, 49], np.float32)
for m in hands:
    fill = nd.binary_dilation(m, iterations=2) & (yy < BAR_TOP + 4)
    # only where it sits on the body or the arm (not where the hand sticks out past it)
    reach = nd.binary_dilation((al > 200) & ~m, iterations=1)
    body[fill, :3] = FUR
    body[fill, 3] = 253
body[spark_mask] = 0
body[yy >= CUT] = 0

# --- head: everything above a curve under the chin, its bottom edge feathered into the neck fur
pts = [(150, 520), (390, 550), (470, 640), (630, 690), (790, 640), (860, 560), (1100, 540)]
cut = np.interp(np.arange(W), [p[0] for p in pts], [p[1] for p in pts])[None, :]
FEATHER = 26.0
ha = np.clip((cut - yy) / FEATHER, 0, 1) * ((xx > 180) & (xx < 1080))
head = body.copy()
layout['head'] = save_layer('head', ha.astype(np.float32), head)
# under the head: only a shrunken dark patch low down (fills the neck gap when he leans);
# above it the body is empty, so a moving head just reveals what is behind it
above = (cut - yy) > FEATHER
patch = nd.binary_erosion(above & (body[..., 3] > 200), iterations=22) & (yy > 470)
body[above & ~patch] = 0
body[patch, :3] = np.array([16, 15, 21], np.float32)
layout['body'] = save_layer('body', np.ones((H, W), np.float32), body)

# eyes (for blinking lids): dark blobs inside the face
face = (yy > 380) & (yy < 520) & (xx > 450) & (xx < 800)
eye = face & (lum < 30) & (al > 200)
l, k = nd.label(eye)
blobs = sorted([(nd.sum(eye, l, j), j) for j in range(1, k + 1)], reverse=True)[:6]
eyes = []
for s, j in blobs:
    ys, xs = np.nonzero(l == j)
    eyes.append(dict(size=int(s), x0=int(xs.min()), x1=int(xs.max()), y0=int(ys.min()), y1=int(ys.max())))
layout['eyeBlobs'] = eyes
layout['image'] = dict(w=W, h=H, barTop=BAR_TOP, barBot=BAR_BOT)
json.dump(layout, open(f'{OUT}/layout.json', 'w'), indent=1)
print(json.dumps(layout, indent=1))
