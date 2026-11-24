import base64, json, math, multiprocessing as mp, os, pathlib, subprocess, sys
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).parent
BUILD = ROOT / "build"
FONTS = pathlib.Path.home() / ".cache/maze-video/fonts"
DATA = pathlib.Path(os.environ.get("MAZE", ROOT.parent.parent / "data/practice-sandbox"))
FPS, SW, SH = 30, 1920, 1080
S, MX, MY = 100, 2000, 1400

def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)

BOARD, INK, YELLOW, BEIGE = hexrgb("#EFEBE3"), hexrgb("#1D1C20"), hexrgb("#EDBD2E"), hexrgb("#F1EDE4")
EDGE = hexrgb("#FBFAF7")

def font(name, size, var=None):
    f = ImageFont.truetype(str(FONTS / name), size)
    if var:
        f.set_variation_by_name(var)
    return f

CASLON = lambda s, v="Regular": font("LibreCaslonText.ttf", s, v)
CASLON_I = lambda s: font("LibreCaslonText-Italic.ttf", s)
MARKER = lambda s: font("PermanentMarker-Regular.ttf", s)
ELITE = lambda s: font("SpecialElite-Regular.ttf", s)
ANTON = lambda s: font("Anton-Regular.ttf", s)

def wpt(tx, ty):
    return (MX + (tx + 0.5) * S, MY + (ty + 0.5) * S)

def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)

def rng(*key):
    return np.random.default_rng(abs(hash(key)) % (2 ** 32))

# ---------- map ----------

def build_map():
    cache = BUILD / "map.npz"
    layout = json.loads((DATA / "layout.json").read_text())
    if cache.exists():
        z = np.load(cache)
        return [z[f"l{i}"] for i in range(4)], layout
    W, H = layout["w"], layout["h"]
    tiles = np.frombuffer(base64.b64decode(layout["tiles"]), np.uint8).reshape(H, W)
    WW, WH = W * S + 2 * MX, H * S + 2 * MY
    floor_t = np.zeros((WH // S + 1, WW // S + 1), np.uint8)
    floor_t[MY // S:MY // S + H, MX // S:MX // S + W] = (tiles > 0) * 255
    floor = cv2.resize(floor_t, None, fx=S, fy=S, interpolation=cv2.INTER_NEAREST)[:WH, :WW]
    floor = (cv2.GaussianBlur(floor, (0, 0), 9) > 127).astype(np.uint8)
    d_out = cv2.distanceTransform(1 - floor, cv2.DIST_L2, 5)
    feat = np.zeros_like(floor)
    for r in layout["regions"]:
        if r["name"] in ("Atrium", "Open Office B7", "Meeting Room Annapurna"):
            x0, y0 = MX + r["x"] * S, MY + r["y"] * S
            feat[y0:y0 + r["h"] * S, x0:x0 + r["w"] * S] = 1
    ink = np.zeros((WH, WW), np.uint8)
    band = 1024
    for y0 in range(0, WH, band):
        y1 = min(WH, y0 + band)
        yy, xx = np.mgrid[y0:y1, 0:WW].astype(np.float32)
        d = d_out[y0:y1]
        fl = floor[y0:y1] > 0
        a = np.zeros(d.shape, np.float32)
        a[(~fl) & (d < 6)] = 1.0
        for off in (8, 19, 32, 48):
            a = np.maximum(a, np.clip(1.3 - np.abs(d - off), 0, 1) * 0.8)
        wav = np.mod(yy + 7 * np.sin(xx / 95.0) + 3 * np.sin(xx / 31.0 + yy / 400.0), 22.0)
        a = np.maximum(a, ((d > 60) & (wav < 1.8)).astype(np.float32) * 0.55)
        hatch = (np.mod(xx + yy, 22.0) < 1.6) & fl
        a = np.maximum(a, hatch * 0.32)
        fe = feat[y0:y1] > 0
        cross = ((np.mod(xx - yy, 13.0) < 1.4) | (np.mod(xx + yy, 13.0) < 1.4)) & fl & fe
        a = np.maximum(a, cross * 0.36)
        grat = ((np.mod(xx - MX, 1000) < 3) & (np.mod(yy, 16) < 4)) | ((np.mod(yy - MY, 1000) < 3) & (np.mod(xx, 16) < 4))
        a = np.maximum(a, grat * 0.45)
        ink[y0:y1] = (a * 255).astype(np.uint8)
    img = Image.fromarray(ink)
    dr = ImageDraw.Draw(img)
    for dd in layout["doors"]:
        x, y = dd["idx"] % W, dd["idx"] // W
        cx, cy = wpt(x, y)
        horiz = 0 < x < W - 1 and tiles[y, x - 1] > 0 and tiles[y, x + 1] > 0
        for s0 in range(-50, 50, 40):
            s1 = min(50, s0 + 22)
            if horiz:
                dr.line([(cx, cy + s0), (cx, cy + s1)], fill=230, width=4)
            else:
                dr.line([(cx + s0, cy), (cx + s1, cy)], fill=230, width=4)
    lab = CASLON(30, "Medium")
    for r in layout["regions"]:
        words = r["name"].upper().split(" ")
        lines = [" ".join(words[:2]), " ".join(words[2:])] if r["name"].startswith("Meeting Room") else [" ".join(words)]
        lines = [l for l in lines if l]
        cx = MX + (r["x"] + r["w"] / 2) * S
        y = MY + r["y"] * S + 34
        for ln in lines:
            widths = [lab.getlength(c) + 5 for c in ln]
            x = cx - sum(widths) / 2
            for c, wdt in zip(ln, widths):
                dr.text((x, y), c, font=lab, fill=255)
                x += wdt
            y += 40
    rose_c = (MX + W * S + 900, MY + H * S - 700)
    draw_rose(dr, rose_c, 300)
    ocean = CASLON_I(72)
    for text, (px, py) in (("The Corridor Sea", (MX + 1800, MY - 700)), ("Outer Waters", (MX - 1500, MY + 2600))):
        x = px
        for c in text:
            dr.text((x, py), c, font=ocean, fill=210)
            x += ocean.getlength(c) + 12
    ink = np.asarray(img)
    lv = [ink]
    for _ in range(3):
        lv.append(cv2.resize(lv[-1], None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA))
    BUILD.mkdir(exist_ok=True)
    np.savez(cache, **{f"l{i}": v for i, v in enumerate(lv)})
    return lv, layout

def draw_rose(dr, c, r):
    x, y = c
    dr.ellipse([x - r, y - r, x + r, y + r], outline=230, width=5)
    dr.ellipse([x - r * 0.82, y - r * 0.82, x + r * 0.82, y + r * 0.82], outline=200, width=3)
    for k in range(32):
        a = k * math.pi / 16
        r0 = r * (0.86 if k % 2 else 0.78)
        dr.line([(x + math.cos(a) * r0, y + math.sin(a) * r0), (x + math.cos(a) * r, y + math.sin(a) * r)], fill=220, width=3)
    for k in range(8):
        a = k * math.pi / 4 - math.pi / 2
        L = r * (0.95 if k % 2 == 0 else 0.55)
        tip = (x + math.cos(a) * L, y + math.sin(a) * L)
        l = (x + math.cos(a - math.pi / 2) * r * 0.11, y + math.sin(a - math.pi / 2) * r * 0.11)
        rr = (x + math.cos(a + math.pi / 2) * r * 0.11, y + math.sin(a + math.pi / 2) * r * 0.11)
        dr.polygon([tip, l, (x, y)], fill=235)
        dr.polygon([tip, rr, (x, y)], outline=235, width=3)
    f = CASLON(64, "Bold")
    dr.text((x - f.getlength("N") / 2, y - r - 90), "N", font=f, fill=240)

# ---------- paper pieces ----------

def halftone(g):
    h, w = g.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = (xx + yy) / math.sqrt(2), (xx - yy) / math.sqrt(2)
    cell = 5.0
    du, dv = np.mod(u, cell) - cell / 2, np.mod(v, cell) - cell / 2
    rad = np.sqrt(np.clip(1 - g, 0, 1)) * cell * 0.72
    dots = 1 - (np.sqrt(du * du + dv * dv) < rad)
    out = g * 0.66 + dots * 0.34
    out = np.clip((out - 0.5) * 1.25 + 0.5, 0, 1)
    return np.clip(out + np.random.default_rng(3).normal(0, 0.035, g.shape), 0, 1).astype(np.float32)

def with_shadow(rgb, a, pad=26):
    h, w = a.shape
    A = np.zeros((h + 2 * pad, w + 2 * pad), np.float32)
    A[pad:pad + h, pad:pad + w] = a
    C = np.zeros((h + 2 * pad, w + 2 * pad, 3), np.float32)
    C[pad:pad + h, pad:pad + w] = rgb
    sh = np.roll(np.roll(cv2.GaussianBlur(A, (0, 0), 4), 7, 0), 5, 1) * 0.32
    out_a = A + sh * (1 - A)
    prem = C * A[..., None] + INK * (sh * (1 - A))[..., None]
    return np.dstack([prem / np.maximum(out_a, 1e-4)[..., None], out_a]).astype(np.float32)

def cutout(g, a, ht=True, seed=0):
    g = halftone(g) if ht else g
    pad = 14
    a = np.pad(a, pad)
    g = np.pad(g, pad, constant_values=1)
    rgb = INK + (EDGE - INK) * g[..., None]
    rgb = rgb * 0.0 + (INK + (BEIGE - INK) * g[..., None])
    d = cv2.distanceTransform((a < 0.5).astype(np.uint8), cv2.DIST_L2, 5)
    noise = cv2.GaussianBlur(np.random.default_rng(seed).normal(0, 1, a.shape).astype(np.float32), (0, 0), 6)
    noise /= noise.std() + 1e-6
    edge = (d < 7 + noise * 1.8).astype(np.float32)
    edge = cv2.GaussianBlur(edge, (0, 0), 0.7)
    aa = np.clip(cv2.GaussianBlur(a, (0, 0), 0.6), 0, 1)
    rgb = EDGE * (1 - aa[..., None]) + rgb * aa[..., None]
    return with_shadow(rgb, np.maximum(edge, aa))

def canvas(w, h):
    return np.ones((h, w), np.float32), np.zeros((h, w), np.float32)

def shade_ellipse(g, a, cx, cy, rx, ry, tone, light=(-0.4, -0.5), strength=0.35):
    h, w = g.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = (xx - cx) / rx, (yy - cy) / ry
    m = nx * nx + ny * ny <= 1
    sh = np.clip(tone + strength * (0.5 - 0.5 * (nx * light[0] + ny * light[1]) - 0.35 * (nx * nx + ny * ny)), 0, 1)
    g[m] = sh[m]
    a[m] = 1

def shade_poly(g, a, pts, tone, grad=0.25):
    h, w = g.shape
    m = np.zeros((h, w), np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 1)
    xx = np.tile(np.linspace(0, 1, w, dtype=np.float32), (h, 1))
    sh = np.clip(tone + grad * (0.5 - xx), 0, 1)
    g[m > 0] = sh[m > 0]
    a[m > 0] = 1

def student(sad=False, seed=0):
    w, h = 150, 230
    g, a = canvas(w, h)
    hy = 70 if sad else 52
    hx = 80 if sad else 75
    lean = 10 if sad else 0
    shade_poly(g, a, [(46, 222), (50, 160), (60, 160), (66, 222)], 0.22)
    shade_poly(g, a, [(84, 222), (90, 160), (100, 160), (104, 222)], 0.22)
    sh = 108 if sad else 96
    body = [(30, 170), (34, sh + 6), (52 + lean, sh - 6), (98 + lean, sh - 6), (116, sh + 8), (120, 170)]
    shade_poly(g, a, body, 0.42)
    shade_poly(g, a, [(30, sh + 10), (22, 196 if sad else 176), (32, 198 if sad else 178), (40, sh + 14)], 0.36)
    shade_poly(g, a, [(118, sh + 10), (128, 196 if sad else 176), (118, 198 if sad else 178), (110, sh + 14)], 0.36)
    shade_ellipse(g, a, hx, hy, 28, 32, 0.72)
    shade_ellipse(g, a, hx, hy - 16, 29, 18, 0.18, strength=0.2)
    if seed % 2:
        shade_poly(g, a, [(56 + lean, sh - 4), (64 + lean, sh - 4), (58, 168), (50, 168)], 0.15, 0)
    return cutout(g, a, seed=seed + 11)

def vault():
    w = h = 230
    g, a = canvas(w, h)
    c = w / 2
    shade_ellipse(g, a, c, c, 105, 105, 0.38)
    shade_ellipse(g, a, c, c, 82, 82, 0.62, strength=0.3)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    for k in range(14):
        ang = k * 2 * math.pi / 14
        bx, by = c + math.cos(ang) * 94, c + math.sin(ang) * 94
        m = (xx - bx) ** 2 + (yy - by) ** 2 < 36
        g[m] = 0.15
    for k in range(3):
        ang = k * 2 * math.pi / 3 + 0.3
        p0 = (int(c), int(c))
        p1 = (int(c + math.cos(ang) * 66), int(c + math.sin(ang) * 66))
        cv2.line(g, p0, p1, 0.12, 10, cv2.LINE_AA)
        m = (xx - p1[0]) ** 2 + (yy - p1[1]) ** 2 < 120
        g[m] = 0.2
    shade_ellipse(g, a, c, c, 22, 22, 0.25)
    return cutout(g, a, seed=5)

def text_img(text, f, color, pad=(0, 0), spacing=0):
    widths = [f.getlength(ch) + spacing for ch in text]
    asc, desc = f.getmetrics()
    w = int(sum(widths) + pad[0] * 2 + 2)
    h = int(asc + desc + pad[1] * 2)
    img = Image.new("L", (max(w, 1), max(h, 1)), 0)
    d = ImageDraw.Draw(img)
    x = pad[0]
    for ch, wd in zip(text, widths):
        d.text((x, pad[1]), ch, font=f, fill=255)
        x += wd
    return np.asarray(img, np.float32) / 255

def tag(text, size=24):
    m = text_img(text.upper(), ELITE(size), None, pad=(18, 9), spacing=3)
    h, w = m.shape
    a = np.ones((h, w), np.float32)
    jag = np.random.default_rng(len(text)).uniform(0, 3, w).astype(np.int32)
    for x in range(w):
        a[:jag[x], x] = 0
        a[h - jag[(x * 7) % w]:, x] = 0
    rgb = YELLOW + (INK - YELLOW) * m[..., None]
    return with_shadow(rgb, a)

RANSOM_FONTS = [lambda s: CASLON(s, "Bold"), ANTON, ELITE]
RANSOM_BG = [(INK, BEIGE), (BEIGE, INK), (YELLOW, INK)]

def ransom_letter(ch, size, k):
    f = RANSOM_FONTS[k % 3](int(size * (0.92 if k % 3 == 1 else 0.8)))
    bg, fg = RANSOM_BG[(k * 2 + 1) % 3]
    m = text_img(ch, f, None, pad=(int(size * 0.16), int(size * 0.06)))
    side = max(m.shape[1], int(size * 0.78))
    box = np.zeros((int(size * 1.12), side), np.float32)
    oy, ox = (box.shape[0] - m.shape[0]) // 2, (side - m.shape[1]) // 2
    sy0, sx0 = max(0, -oy), max(0, -ox)
    hh, ww = min(m.shape[0] - sy0, box.shape[0] - max(0, oy)), min(m.shape[1] - sx0, side - max(0, ox))
    box[max(0, oy):max(0, oy) + hh, max(0, ox):max(0, ox) + ww] = m[sy0:sy0 + hh, sx0:sx0 + ww]
    rgb = bg + (fg - bg) * box[..., None]
    return with_shadow(rgb, np.ones(box.shape, np.float32))

def sheet_img(w, h):
    a = np.ones((h, w), np.float32)
    n = cv2.GaussianBlur(np.random.default_rng(9).normal(0, 1, (h, w)).astype(np.float32), (0, 0), 20)
    rgb = BEIGE * (1 + 0.02 * n / (n.std() + 1e-6))[..., None]
    return rgb, a

# ---------- drawing helpers ----------

def blit(frame, spr, x, y, scale=1.0, ang=0.0, alpha=1.0):
    h, w = spr.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, scale)
    M[0, 2] += x - w / 2
    M[1, 2] += y - h / 2
    pts = np.array([[0, 0, 1], [w, 0, 1], [0, h, 1], [w, h, 1]], np.float32) @ M.T
    x0, y0 = max(0, int(pts[:, 0].min()) - 1), max(0, int(pts[:, 1].min()) - 1)
    x1, y1 = min(SW, int(pts[:, 0].max()) + 2), min(SH, int(pts[:, 1].max()) + 2)
    if x1 <= x0 or y1 <= y0:
        return
    M2 = M.copy()
    M2[0, 2] -= x0
    M2[1, 2] -= y0
    prem = np.dstack([spr[..., :3] * spr[..., 3:], spr[..., 3:]])
    out = cv2.warpAffine(prem, M2, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderValue=0)
    a = out[..., 3:] * alpha
    region = frame[y0:y1, x0:x1]
    region[:] = region * (1 - a) + out[..., :3] * alpha

def ink_over(frame, alpha, color=INK):
    a = alpha[..., None]
    frame[:] = frame * (1 - a) + color * a

def multiply(frame, alpha, color=YELLOW, k=0.9):
    a = (alpha * k)[..., None]
    frame[:] = frame * (1 - a + a * color)

def catmull(pts, n=10):
    if len(pts) < 3:
        return np.array(pts, np.float32)
    p = np.array([pts[0]] + list(pts) + [pts[-1]], np.float32)
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for t in np.linspace(0, 1, n, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(p[-2])
    return np.array(out, np.float32)

def resample(poly, step):
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    L = cum[-1]
    if L < 1:
        return poly[:1], np.zeros(1), 0.0
    s = np.arange(0, L, step)
    x = np.interp(s, cum, poly[:, 0])
    y = np.interp(s, cum, poly[:, 1])
    return np.stack([x, y], 1), s, L

def stroke(alpha, pts, width, frac=1.0, dashed=False, seed=0, taper=True):
    poly = catmull(pts)
    P, s, L = resample(poly, 1.6)
    if L == 0:
        return
    n = max(1, int(len(P) * frac))
    r = np.random.default_rng(seed)
    wob = 1 + 0.15 * np.sin(s / 23.0 + seed) * np.sin(s / 7.3 + seed * 2)
    tap = np.minimum(1, np.minimum(s / 14 + 0.35, (L - s) / 14 + 0.35)) if taper else np.ones_like(s)
    if dashed:
        on = np.mod(s, 46) < 27
    else:
        on = np.ones_like(s, bool)
    m = np.zeros_like(alpha)
    for i in range(n):
        if on[i]:
            cv2.circle(m, (int(P[i, 0] * 4), int(P[i, 1] * 4)), max(1, int(width / 2 * wob[i] * tap[i] * 4)), 0.92, -1, cv2.LINE_AA, 2)
    d = np.gradient(P[:, 0]), np.gradient(P[:, 1])
    nrm = np.stack([-d[1], d[0]], 1)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-6
    drop = r.random(len(P)) > 0.35
    side = r.uniform(-0.62, 0.62, len(P)) * width
    c = np.zeros_like(alpha)
    for i in range(n):
        if on[i] and drop[i]:
            q = P[i] + nrm[i] * side[i]
            cv2.circle(c, (int(q[0] * 4), int(q[1] * 4)), max(1, int(width * 0.32 / 2 * 4)), 0.75, -1, cv2.LINE_AA, 2)
    np.maximum(alpha, np.maximum(m, c), out=alpha)

# ---------- scene ----------

class Cam:
    def __init__(self, moves):
        self.moves = moves

    def at(self, f):
        cx, cy, z = self.moves[0][2:]
        last_end = 0
        for (st, dur, tx, ty, tz) in self.moves[1:]:
            if f < st:
                break
            t = smooth((f - st) / dur)
            nx, ny = wpt(tx, ty)
            cx, cy = cx + (nx - cx) * t, cy + (ny - cy) * t
            z = math.exp(math.log(z) + (math.log(tz) - math.log(z)) * t)
            last_end = st + dur
        z *= 1 + 0.0009 * max(0, f - last_end)
        ww, wh = MAPLV[0].shape[1], MAPLV[0].shape[0]
        cx = min(max(cx, SW / 2 / z), ww - SW / 2 / z)
        cy = min(max(cy, SH / 2 / z), wh - SH / 2 / z)
        return cx, cy, z

def to_screen(cam, p, off=(0, 0)):
    cx, cy, z = cam
    return 960 + (p[0] - cx) * z + off[0], 540 + (p[1] - cy) * z + off[1]

def boil(key, f):
    r = rng(key, (f // 8) % 3)
    return r.uniform(-1.5, 1.5), r.uniform(-1.5, 1.5), r.uniform(-0.4, 0.4)

def slap(f, st):
    d = f - st
    return 1.1 if d < 2 else 0.98 if d < 4 else 1.0

class El:
    z = 0

    def __init__(self, start, end, **kw):
        self.start, self.end = start, end
        self.__dict__.update(kw)

    def live(self, f):
        return self.start <= f < self.end

class Piece(El):
    z = 2

    def draw(self, fr, f, cam, ctx):
        p = self.anchor(f) if callable(self.anchor) else self.anchor
        x, y = (p if getattr(self, "fixed", False) else to_screen(cam, p, self.off))
        dx, dy, da = boil(id(self), f)
        wob = 0
        if hasattr(self, "path"):
            wob = 4 * math.sin(f * 0.7)
        blit(fr, self.spr, x + dx, y + dy, slap(f, self.start), getattr(self, "rot", 0) + da + wob)

class Ink(El):
    z = 3

    def draw(self, fr, f, cam, ctx):
        frac = min(1.0, (f - self.start + 2) / self.reveal)
        dxs = [boil((id(self), i), f)[:2] for i in range(len(self.pts))]
        pts = []
        for (p, off), d in zip(self.pts, dxs):
            x, y = to_screen(cam, p, off) if p is not None else off
            pts.append((x + d[0], y + d[1]))
        a = ctx["ink"]
        a[:] = 0
        big = np.zeros((SH * 1, SW * 1), np.float32)
        stroke(big, pts, getattr(self, "width", 6), frac, getattr(self, "dashed", False), seed=self.seed)
        if getattr(self, "arrow", False) and frac >= 1:
            (x1, y1), (x0, y0) = pts[-1], pts[-2]
            ang = math.atan2(y1 - y0, x1 - x0)
            for s in (-0.48, 0.48):
                stroke(big, [(x1, y1), (x1 - 26 * math.cos(ang + s), y1 - 26 * math.sin(ang + s))], getattr(self, "width", 6), seed=self.seed + 3)
        ink_over(fr, big)

class Note(El):
    z = 3

    def draw(self, fr, f, cam, ctx):
        n = int((f - self.start) * 1.3) + 1
        txt = self.text[:n]
        if not txt.strip():
            return
        m = text_img(txt, MARKER(self.size), None, pad=(10, 10))
        dx, dy, da = boil(id(self), f)
        x, y = to_screen(cam, self.anchor, self.off)
        spr = np.dstack([np.broadcast_to(INK, m.shape + (3,)), m * 0.94]).astype(np.float32)
        full = text_img(self.text, MARKER(self.size), None, pad=(10, 10))
        blit(fr, spr, x - (full.shape[1] - m.shape[1]) / 2 + dx, y + dy, 1, self.rot + da)

class Paint(El):
    z = 1

    def draw(self, fr, f, cam, ctx):
        frac = smooth((f - self.start) / 16)
        x0, y0, x1, y1 = self.rect
        a = self.mask
        if frac < 1:
            h, w = a.shape
            jag = (np.sin(np.arange(w) / 9.0) * 10 + np.sin(np.arange(w) / 3.1) * 4).astype(np.float32)
            line = h * (1 - frac) + jag
            yy = np.arange(h, dtype=np.float32)[:, None]
            a = a * (yy > line[None, :])
        cx, cy, z = cam
        sc = z * self.scale
        M = np.array([[sc, 0, 960 + (x0 - cx) * z], [0, sc, 540 + (y0 - cy) * z]], np.float32)
        out = cv2.warpAffine(a, M, (SW, SH), flags=cv2.INTER_LINEAR, borderValue=0)
        multiply(fr, out)

class Fixed(El):
    z = 4

    def draw(self, fr, f, cam, ctx):
        dx, dy, da = boil(id(self), f)
        spr = self.render(f) if hasattr(self, "render") else self.spr
        blit(fr, spr, self.pos[0] + dx, self.pos[1] + dy, slap(f, self.start), self.rot + da)

class Highlight(El):
    z = 4.5

    def draw(self, fr, f, cam, ctx):
        frac = smooth((f - self.start) / 10)
        a = np.zeros((SH, SW), np.float32)
        x0, x1, y = self.x0, self.x0 + (self.x1 - self.x0) * frac, self.y
        stroke(a, [(x0, y), ((x0 + x1) / 2, y - 3), (x1, y + 2)], 30, 1.0, seed=4, taper=False)
        multiply(fr, np.minimum(1, a * 1.1), k=0.95)

def paint_mask(rect, seed):
    x0, y0, x1, y1 = rect
    sc = 0.25
    w, h = int((x1 - x0) * sc), int((y1 - y0) * sc)
    r = np.random.default_rng(seed)
    pts = []
    for t in np.linspace(0, 1, 40, endpoint=False):
        pts.append((t * w, r.uniform(-3, 5)))
    for t in np.linspace(0, 1, 30, endpoint=False):
        pts.append((w + r.uniform(-5, 3), t * h))
    for t in np.linspace(1, 0, 40, endpoint=False):
        pts.append((t * w, h + r.uniform(-5, 3)))
    for t in np.linspace(1, 0, 30, endpoint=False):
        pts.append((r.uniform(-3, 5), t * h))
    m = np.zeros((h + 20, w + 20), np.float32)
    cv2.fillPoly(m, [(np.array(pts) + 10).astype(np.int32)], 1.0)
    streak = cv2.GaussianBlur(r.normal(0, 1, m.shape).astype(np.float32), (0, 0), sigmaX=14, sigmaY=1.5)
    streak = 0.88 + 0.12 * np.tanh(streak / (streak.std() + 1e-6))
    return cv2.GaussianBlur(m, (0, 0), 1.2) * streak, sc

def paper_texture():
    r = np.random.default_rng(1)
    acc = np.zeros((SH, SW), np.float32)
    for k, amp in ((8, 0.022), (32, 0.014), (128, 0.01)):
        n = r.normal(0, 1, (SH // k + 2, SW // k + 2)).astype(np.float32)
        acc += cv2.resize(n, (SW, SH), interpolation=cv2.INTER_CUBIC) * amp
    fib = np.zeros((SH, SW), np.float32)
    for _ in range(900):
        x, y = r.uniform(0, SW), r.uniform(0, SH)
        a = r.uniform(0, math.pi)
        L = r.uniform(8, 30)
        cv2.line(fib, (int(x), int(y)), (int(x + math.cos(a) * L), int(y + math.sin(a) * L)), 1.0, 1, cv2.LINE_AA)
    acc -= fib * 0.025
    cr = np.zeros((SH, SW), np.float32)
    for (p0, p1) in (((0, 360), (SW, 300)), ((1240, 0), (1330, SH))):
        cv2.line(cr, p0, p1, 1.0, 2, cv2.LINE_AA)
    acc -= cv2.GaussianBlur(cr, (0, 0), 1.5) * 0.06
    acc += np.roll(cv2.GaussianBlur(cr, (0, 0), 3), 3, 0) * 0.03
    acc += r.normal(0, 0.012, (SH, SW)).astype(np.float32)
    yy, xx = np.mgrid[0:SH, 0:SW].astype(np.float32)
    rr = ((xx - SW / 2) / (SW / 2)) ** 2 + ((yy - SH / 2) / (SH / 2)) ** 2
    vig = 1 - 0.1 * rr
    return np.clip((1 + acc) * vig, 0.6, 1.1)[..., None].astype(np.float32)

def dust(seed):
    r = np.random.default_rng(seed)
    a = np.zeros((SH, SW), np.float32)
    for _ in range(55):
        x, y = int(r.uniform(0, SW)), int(r.uniform(0, SH))
        if r.random() < 0.7:
            cv2.circle(a, (x, y), int(r.uniform(1, 2.5)), 0.5, -1, cv2.LINE_AA)
        else:
            ang = r.uniform(0, math.pi)
            L = r.uniform(6, 18)
            cv2.line(a, (x, y), (int(x + math.cos(ang) * L), int(y + math.sin(ang) * L)), 0.35, 1, cv2.LINE_AA)
    return a

# ---------- timeline ----------

def timeline():
    T = json.loads((BUILD / "timing.json").read_text())
    beats = {b["id"]: b for b in T["beats"]}

    def w(b, word, occ=1, off=0):
        n = 0
        for x in beats[b]["words"]:
            if x["w"] == word:
                n += 1
                if n == occ:
                    return int(round(x["t"] * FPS)) + off
        raise KeyError((b, word, occ))

    def bs(b):
        return int(round(beats[b]["words"][0]["t"] * FPS)) - 6

    def be(b):
        return bs(next_beat[b]) if b in next_beat else total

    order = [b["id"] for b in T["beats"]]
    next_beat = {a: b for a, b in zip(order, order[1:])}
    total = int(round((T["voice_end"] + 1.3) * FPS))
    sfx = []
    E = []

    regions = {r["name"]: r for r in LAYOUT["regions"]}

    def rect(name):
        r = regions[name]
        return (MX + r["x"] * S, MY + r["y"] * S, MX + (r["x"] + r["w"]) * S, MY + (r["y"] + r["h"]) * S)

    def paint(name, st, seed):
        m, sc = paint_mask(rect(name), seed)
        x0, y0, x1, y1 = rect(name)
        E.append(Paint(st, total, mask=m, rect=(x0 - 10 / sc, y0 - 10 / sc, x1, y1), scale=1 / sc))
        sfx.append((st, "scribble"))

    def piece(spr, anchor, off, st, en, rot=0.0, **kw):
        E.append(Piece(st, en, spr=spr, anchor=anchor, off=off, rot=rot, **kw))
        sfx.append((st, "slap"))

    def ransom(text, anchor, off, st, en, size, fixed=False):
        f = st
        widths = []
        sprs = []
        for k, ch in enumerate(text):
            if ch == " ":
                sprs.append(None)
                widths.append(size * 0.35)
                continue
            s = ransom_letter(ch, size, k + len(text))
            sprs.append(s)
            widths.append(s.shape[1] - 52 + size * 0.06)
        x = -sum(widths) / 2
        r = np.random.default_rng(len(text) + size)
        for k, (s, wd) in enumerate(zip(sprs, widths)):
            if s is not None:
                o = (off[0] + x + wd / 2, off[1] + r.uniform(-7, 7))
                if fixed:
                    E.append(Fixed(f, en, spr=s, pos=(anchor[0] + o[0], anchor[1] + o[1]), rot=r.uniform(-6, 6), z=4.6))
                else:
                    E.append(Piece(f, en, spr=s, anchor=anchor, off=o, rot=r.uniform(-6, 6), z=4))
                sfx.append((f, "slap"))
                f += 3 if k % 2 else 4
            x += wd
        return f

    def ink(pts, st, en, reveal=10, seed=0, **kw):
        E.append(Ink(st, en, pts=pts, reveal=reveal, seed=seed, **kw))
        sfx.append((st, "scratch"))

    def circle_pts(anchor, rx, ry, seed, off=(0, 0)):
        r = np.random.default_rng(seed)
        a0 = r.uniform(0, 2 * math.pi)
        out = []
        for t in np.linspace(0, 2 * math.pi * 1.12, 16):
            k = 1 + 0.06 * math.sin(t * 2 + seed) + t * 0.012
            out.append((anchor, (off[0] + math.cos(a0 + t) * rx * k, off[1] + math.sin(a0 + t) * ry * k)))
        return out

    def tag_at(text, anchor, off, st, en, rot=-2.0):
        piece(tag(text), anchor, off, st, en, rot=rot, z=4)

    atrium = wpt(35, 26)
    vdoor = wpt(8, 50)
    pads = [wpt(9, 50), wpt(9, 49), wpt(10, 50)]
    b7 = wpt(13.5, 48)
    vroom = wpt(4, 48.5)

    moves = [(0, 0) + wpt(35, 26.5) + (0.56,)]
    moves = [(0, 0, *wpt(35, 26.5), 0.56)]
    mv = []

    def move(st, dur, tx, ty, z):
        mv.append((st, dur, tx, ty, z))
        sfx.append((st, "whoosh"))

    # 1 home
    paint("Atrium", w("home", "atrium", off=-2), 1)
    ransom("92", atrium, (0, 40), w("home", "ninety-two"), be("far") - 10, 150)
    tag_at("92 players · 23 nov 2026", atrium, (0, 175), w("home", "students"), be("home") + 20)

    # 2 far
    move(w("far", "top", off=-4), 24, 36, 27.5, 0.195)
    arc = [(atrium, (0, 0)), (wpt(28, 36), (0, 0)), (wpt(17, 44), (0, 0)), (vdoor, (0, 0))]
    ink(arc, w("far", "all"), be("far"), reveal=15, seed=2, dashed=True, arrow=True, width=6)
    t0, t1 = w("far", "came"), w("far", "door") + 2
    sx = catmull([p for p, _ in arc], 12)
    P, s, L = resample(sx, 4.0)

    def along(f, P=P, t0=t0, t1=t1):
        k = smooth((f - t0) / (t1 - t0))
        i = min(len(P) - 1, int(k * (len(P) - 1)))
        return tuple(P[i])

    E.append(Piece(t0, be("far"), spr=student(seed=4), anchor=along, off=(0, -70), rot=0, path=True, z=2.5))
    piece(vault(), vdoor, (-150, -60), w("far", "door"), be("tried"), rot=-4)
    ink(circle_pts(vdoor, 130, 120, 3, off=(-150, -60)), w("far", "door", off=4), be("far"), reveal=12, seed=3)
    tag_at("53 steps, shortest path", wpt(24, 39), (0, 0), w("far", "fifty-three"), be("far"), rot=3)

    # 3 pads
    move(bs("pads"), 24, 9.3, 49.0, 1.35)
    title = ["The vault door", "23 Nov 2026"]

    def card_render(f, st=bs("pads") + 18):
        n = max(0, f - st)
        img = Image.new("RGB", (560, 230), tuple(int(v * 255) for v in BEIGE))
        d = ImageDraw.Draw(img)
        d.text((34, 52), title[0][:n], font=CASLON(68), fill=tuple(int(v * 255) for v in INK))
        d.text((36, 140), title[1][:max(0, n - len(title[0]))], font=CASLON(44, "Medium"), fill=tuple(int(v * 255) for v in INK))
        tg = tag("fig. 01", 22)
        rgb = np.asarray(img, np.float32) / 255
        spr = with_shadow(rgb, np.ones((230, 560), np.float32))
        h, wd = tg.shape[:2]
        sub = spr[0:h, 0:wd]
        a = tg[..., 3:]
        sub[..., :3] = sub[..., :3] * (1 - a) + tg[..., :3] * a
        sub[..., 3:] = np.maximum(sub[..., 3:], a)
        return spr

    E.append(Fixed(bs("pads") + 8, be("tried"), render=card_render, pos=(350, 170), rot=-1.2))
    sfx.append((bs("pads") + 8, "slap"))
    for k in range(len(title[0]) + len(title[1])):
        sfx.append((bs("pads") + 18 + k, "tick"))
    for k, p in enumerate(pads):
        st = w("pads", "students") + k * 5
        piece(student(seed=k), p, ((-40, 10, 40)[k], -86 + (0, -30, 0)[k]), st, be("opens"), rot=(-3, 2, 4)[k])
        spl = []
        r = np.random.default_rng(k + 20)
        for j in range(6):
            a = r.uniform(0, 2 * math.pi)
            rr = r.uniform(70, 95)
            spl.append([(p, ((-40, 10, 40)[k] + math.cos(a) * rr * 0.6, 20 + math.sin(a) * rr * 0.3)),
                        (p, ((-40, 10, 40)[k] + math.cos(a) * rr * 0.8, 20 + math.sin(a) * rr * 0.4))])
        for j, sp in enumerate(spl):
            ink(sp, st + 1, be("opens"), reveal=3, seed=30 + k * 10 + j, width=5)
    for k, p in enumerate(pads):
        ink(circle_pts(p, 62, 30, 40 + k, off=((-40, 10, 40)[k], 24)), w("pads", "pads") + k * 3, be("opens"), reveal=9, seed=40 + k)
    for k, p in enumerate(pads):
        o = ((-40, 10, 40)[k], -60 + (0, -30, 0)[k])
        ink([(p, (o[0] - 60, o[1])), (p, (o[0] - 120, o[1] - 4))], w("pads", "pushed") + k * 2, be("tried"), reveal=8, seed=50 + k, arrow=True)

    # 4 tried
    ransom("46", wpt(13, 48), (0, -20), w("tried", "forty-six"), be("tried") + 4, 140)
    tag_at("pressed a pad", wpt(13, 48), (0, 95), w("tried", "tried") - 2, be("tried") + 4, rot=2)

    # 5 opens
    move(bs("opens"), 18, 11.6, 49, 1.08)
    tag_at("open 19 hours", wpt(15.5, 45.6), (0, 0), w("opens", "nineteen"), be("opens"), rot=-2)
    times = ["12:07 pm", "12:15 pm", "12:47 pm", "9:30 pm"]
    for k, t in enumerate(times):
        st = w("opens", "opened") + k * 6
        tag_at(f"opened {t}", wpt(15.5, 45.6), (30, 70 + k * 62), st, be("opens"), rot=(1.5, -1, 2, -1.5)[k])
        ink([(wpt(15.5, 45.6), (-150, 62 + k * 62)), (wpt(15.5, 45.6), (-128, 82 + k * 62)), (wpt(15.5, 45.6), (-96, 46 + k * 62))], st + 2, be("opens"), reveal=6, seed=60 + k)

    # 6 outside
    move(bs("outside"), 22, 13.6, 48.2, 0.8)
    paint("Open Office B7", w("outside", "outside", off=-2), 7)
    piece(student(sad=True, seed=8), b7, (-40, -30), w("outside", "players"), be("chat"), rot=3)
    tag_at("most time spent here", b7, (0, 200), w("outside", "most"), be("chat"), rot=-1.5)

    # 7 chat
    E.append(Note(w("chat", "chat") - 4, be("chat"), text="we need 1 more person", anchor=b7, off=(0, -260), size=72, rot=-3))
    for k in range(int(len("we need 1 more person") / 1.3)):
        if k % 2 == 0:
            sfx.append((w("chat", "chat") - 4 + k, "scratch"))
    ink(circle_pts(b7, 120, 150, 9, off=(-40, -30)), w("chat", "more"), be("chat"), reveal=12, seed=9)
    tag_at("47 messages in this room", b7, (0, -150), w("chat", "says"), be("chat"), rot=2)

    # 8 through
    move(bs("through"), 20, 6.3, 48.4, 0.9)
    paint("Meeting Room Annapurna", w("through", "through", off=-2), 12)
    ink([(vdoor, (90, 0)), (vdoor, (20, -10)), (vdoor, (-90, -20))], w("through", "through"), be("through"), reveal=10, seed=13, arrow=True)
    ransom("10", vroom, (0, -40), w("through", "ten"), be("through"), 150)
    tag_at("all scored 24+ of 27 max", vroom, (0, 90), w("through", "twenty-four"), be("through"), rot=-2)

    # 9 payoff
    move(bs("payoff"), 26, 36, 32.5, 0.19)
    sh_w, sh_h = 1000, 230
    line = "To reach the top, you needed"

    def sheet_render(f, st=w("payoff", "reach")):
        rgb, a = sheet_img(sh_w, sh_h)
        img = Image.fromarray((rgb * 255).astype(np.uint8))
        d = ImageDraw.Draw(img)
        n = max(0, f - st)
        fnt = CASLON(54, "Bold")
        d.text(((sh_w - fnt.getlength(line)) / 2, 26), line[:n], font=fnt, fill=tuple(int(v * 255) for v in INK))
        return with_shadow(np.asarray(img, np.float32) / 255, a)

    sheet_st = w("payoff", "to") - 2
    E.append(Fixed(sheet_st, total, render=sheet_render, pos=(960, 935), rot=0.6, z=4.2))
    sfx.append((sheet_st, "slap"))
    for k in range(len(line)):
        sfx.append((w("payoff", "reach") + k, "tick"))
    rst = w("payoff", "two")
    end_ransom = ransom("TWO OTHERS", (960, 978), (0, 0), rst, total, 92, fixed=True)
    E.append(Highlight(w("payoff", "time") - 4, total, x0=600, x1=1320, y=1016))
    sfx.append((w("payoff", "time") - 4, "scratch"))
    for k in range(3):
        piece(student(seed=k + 1), vroom, (-120 + k * 120, -90 - (k % 2) * 20), w("payoff", "other") + k * 4, total, rot=(-4, 1, 5)[k])
    ink(circle_pts(vroom, 220, 140, 21, off=(0, -90)), w("payoff", "same"), total, reveal=12, seed=21)

    E.sort(key=lambda e: e.z)
    return E, Cam(moves + mv), total, sfx

# ---------- render ----------

MAPLV, LAYOUT = None, None
G = {}

def render_frame(f):
    f2 = f - f % 2
    cam = G["cam"].at(f2)
    cx, cy, z = cam
    lvl = int(min(3, max(0, math.floor(math.log2(1 / z) + 0.15))))
    src = MAPLV[lvl]
    sc = z * (2 ** lvl)
    M = np.array([[sc, 0, 960 - cx * z], [0, sc, 540 - cy * z]], np.float32)
    ink = cv2.warpAffine(src, M, (SW, SH), flags=cv2.INTER_LINEAR, borderValue=0).astype(np.float32) / 255
    fr = np.empty((SH, SW, 3), np.float32)
    fr[:] = BOARD
    ink_over(fr, ink * 0.92)
    ctx = {"ink": np.zeros((SH, SW), np.float32)}
    for e in G["els"]:
        if e.live(f2):
            e.draw(fr, f2, cam, ctx)
    fr *= G["paper"]
    d = G["dust"][(f2 // 8) % 3]
    ink_over(fr, d)
    return (np.clip(fr, 0, 1) * 255).astype(np.uint8)

def setup():
    global MAPLV, LAYOUT
    MAPLV, LAYOUT = build_map()
    els, cam, total, sfx = timeline()
    G.update(els=els, cam=cam, total=total, sfx=sfx, paper=paper_texture(), dust=[dust(s) for s in range(3)])

def worker(args):
    a, b, out = args
    cv2.setNumThreads(1)
    p = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{SW}x{SH}", "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    last = None
    for f in range(a, b):
        if last is None or f % 2 == 0:
            last = render_frame(f).tobytes()
        p.stdin.write(last)
    p.stdin.close()
    p.wait()
    return out

def contact_sheet(frames, out):
    tiles = [cv2.resize(render_frame(f), (480, 270), interpolation=cv2.INTER_AREA) for f in frames]
    for t, f in zip(tiles, frames):
        cv2.putText(t, f"{f} ({f / FPS:.1f}s)", (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 0, 0), 2)
    while len(tiles) % 4:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]
    cv2.imwrite(str(out), cv2.cvtColor(np.vstack(rows), cv2.COLOR_RGB2BGR))

# ---------- sound ----------

def synth(kind, sr, r):
    def env(n, a, d):
        t = np.arange(n) / sr
        return np.minimum(1, t / a) * np.exp(-t / d)
    if kind == "slap":
        n = int(sr * 0.16)
        x = r.normal(0, 1, n) * env(n, 0.001, 0.025)
        x = np.convolve(x, np.ones(6) / 6, "same")
        t = np.arange(n) / sr
        x += 0.8 * np.sin(2 * np.pi * 110 * t) * env(n, 0.001, 0.04)
    elif kind == "tick":
        n = int(sr * 0.03)
        x = r.normal(0, 1, n) * env(n, 0.0005, 0.004)
        x = np.diff(np.concatenate([[0], x]))
    elif kind in ("scratch", "scribble"):
        n = int(sr * (0.28 if kind == "scratch" else 0.55))
        x = r.normal(0, 1, n)
        x = np.diff(np.concatenate([[0], x]))
        t = np.arange(n) / sr
        am = 0.55 + 0.45 * np.sin(2 * np.pi * (14 if kind == "scratch" else 9) * t + r.uniform(0, 6)) ** 2
        x *= am * np.minimum(1, t / 0.02) * np.minimum(1, (n / sr - t) / 0.06) * 0.5
    else:
        n = int(sr * 0.5)
        t = np.arange(n) / sr
        x = r.normal(0, 1, n)
        k = np.exp(-((t - 0.22) / 0.12) ** 2)
        lp = np.zeros(n)
        acc = 0.0
        for i in range(n):
            a = 0.02 + 0.2 * k[i]
            acc += a * (x[i] - acc)
            lp[i] = acc
        x = lp * k
    return x / (np.abs(x).max() + 1e-9)

def mix(sfx, total, out_wav):
    import soundfile as sf
    sr = 48000
    v, vsr = sf.read(BUILD / "voice.wav")
    v = np.interp(np.arange(int(len(v) * sr / vsr)) / sr, np.arange(len(v)) / vsr, v)
    N = int(total / FPS * sr) + sr
    track = np.zeros(N)
    track[:len(v)] += v
    peak = np.abs(v).max()
    gains = {"slap": 0.32, "tick": 0.16, "scratch": 0.22, "scribble": 0.26, "whoosh": 0.3}
    r = np.random.default_rng(7)
    last = {}
    for f, kind in sorted(sfx):
        if f - last.get(kind, -99) < 3:
            continue
        last[kind] = f
        x = synth(kind, sr, r) * peak * gains[kind]
        i = int(f / FPS * sr)
        j = min(N, i + len(x))
        track[i:j] += x[:j - i]
    track = track[:int(total / FPS * sr)]
    track *= 10 ** (-0.3 / 20) / (np.abs(track).max() + 1e-9)
    sf.write(out_wav, np.stack([track, track], 1).astype(np.float32), sr)

if __name__ == "__main__":
    mp.set_start_method("fork")
    setup()
    total = G["total"]
    if "--sheet" in sys.argv:
        n = 12
        frames = [int(x) for x in sys.argv[sys.argv.index("--sheet") + 1].split(",")] if len(sys.argv) > sys.argv.index("--sheet") + 1 else [int(i * (total - 1) / (n - 1)) for i in range(n)]
        contact_sheet(frames, BUILD / "sheet.png")
        print("sheet", BUILD / "sheet.png", total, "frames")
        sys.exit()
    if "--frame" in sys.argv:
        f = int(sys.argv[sys.argv.index("--frame") + 1])
        cv2.imwrite(str(BUILD / f"frame-{f}.png"), cv2.cvtColor(render_frame(f), cv2.COLOR_RGB2BGR))
        sys.exit()
    workers = os.cpu_count() or 4
    step = math.ceil(total / workers / 2) * 2
    jobs = [(a, min(total, a + step), str(BUILD / f"seg{i:02d}.mp4")) for i, a in enumerate(range(0, total, step))]
    with mp.Pool(len(jobs)) as pool:
        segs = pool.map(worker, jobs)
    (BUILD / "segs.txt").write_text("".join(f"file '{s}'\n" for s in segs))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(BUILD / "segs.txt"), "-c", "copy", str(BUILD / "silent.mp4")], check=True)
    mix(G["sfx"], total, BUILD / "mix.wav")
    out = ROOT.parent / "maze-vault-vox.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(BUILD / "silent.mp4"), "-i", str(BUILD / "mix.wav"), "-map", "0:v", "-map", "1:a",
                    "-c:v", "libx264", "-crf", "22", "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(out)], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", "9", "-i", str(out), "-frames:v", "1", "-q:v", "3", str(out.with_suffix(".jpg"))], check=True)
    print("wrote", out, total, "frames")
