#!/usr/bin/env python3
"""详情长图多版式引擎（1:9 母版，可切 1:3 上传页）。

同一份 spec、同一批已确认素材，只换排版语言，用于横向对比：

  editorial  米白杂志：左对齐、金色强调、留白大（现行版）
  oscuro     暗黑高奢：黑底金字、通栏满幅、居中轴线
  bloque     电商色块：白底黑条、编号大字、卡片描边
  collage    拼贴杂志：宝丽来斜贴、竖排标签、错位叠图

用法：
  python3 tools/pod/listing/make-detail-variants.py --spec spec.json \
      --variant oscuro --out x.png [--split-1x3 <dir>]

只使用 spec 内已确认素材，不生成新图。
"""
import argparse, json, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, BAND = 1080, 1080
H19 = 9720
FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def font(size):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def wrap(d, text, f, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def tracked_w(d, text, f, tracking):
    return sum(d.textlength(c, font=f) for c in text) + tracking * max(0, len(text) - 1)


def tracked(d, xy, text, f, fill, tracking=0, center=None):
    """按字距逐字绘制；center 给定时以该 x 为居中轴。"""
    x, y = xy
    if center is not None:
        x = center - tracked_w(d, text, f, tracking) / 2
    for c in text:
        d.text((x, y), c, font=f, fill=fill)
        x += d.textlength(c, font=f) + tracking
    return x


def load(path):
    return Image.open(path).convert("RGB")


def cover(im, bw, bh):
    s = max(bw / im.width, bh / im.height)
    im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    l, t = (im.width - bw) // 2, (im.height - bh) // 2
    return im.crop((l, t, l + bw, t + bh))


def fit(im, bw, bh):
    s = min(bw / im.width, bh / im.height)
    return im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)


def paste_cover(canvas, path, box):
    x0, y0, x1, y1 = box
    canvas.paste(cover(load(path), x1 - x0, y1 - y0), (x0, y0))


def paste_fit(canvas, path, box):
    x0, y0, x1, y1 = box
    im = fit(load(path), x1 - x0, y1 - y0)
    canvas.paste(im, (x0 + (x1 - x0 - im.width) // 2, y0 + (y1 - y0 - im.height) // 2))


def shade_bottom(canvas, box, top_frac=0.45, strength=225, power=0.9):
    """在 box 内自 top_frac 起向下压暗。"""
    x0, y0, x1, y1 = box
    h = y1 - y0
    mask = Image.new("L", (1, h))
    for i in range(h):
        t = (i - h * top_frac) / max(1, h * (1 - top_frac))
        mask.putpixel((0, i), int(strength * max(0.0, t) ** power))
    mask = mask.resize((x1 - x0, h))
    region = canvas.crop(box)
    canvas.paste(Image.composite(Image.new("RGB", region.size, (6, 6, 6)), region, mask), (x0, y0))


def shade_side(canvas, box, frac=0.5, strength=210):
    x0, y0, x1, y1 = box
    w = x1 - x0
    mask = Image.new("L", (w, 1))
    for i in range(w):
        t = (i - w * (1 - frac)) / max(1, w * frac)
        mask.putpixel((i, 0), int(strength * max(0.0, t) ** 0.85))
    mask = mask.resize((w, y1 - y0))
    region = canvas.crop(box)
    canvas.paste(Image.composite(Image.new("RGB", region.size, (8, 8, 8)), region, mask), (x0, y0))


# ---------------------------------------------------------------- editorial
def v_editorial(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))

    def head(y, kicker, title, sub, size=84):
        d.text((80, y), kicker.upper(), font=font(32), fill=accent)
        y += 58
        f = font(size)
        for line in wrap(d, title, f, W - 160):
            d.text((80, y), line, font=f, fill=ink)
            y += size + 10
        if sub:
            fs = font(36)
            for line in wrap(d, sub, fs, W - 160):
                d.text((80, y), line, font=fs, fill=muted)
                y += 50
        d.line([(80, y + 22), (240, y + 22)], fill=accent, width=6)
        return y + 60

    # hero
    paste_cover(canvas, s["images"]["hero"], (0, 0, W, 2160))
    shade_bottom(canvas, (0, 0, W, 2160), 0.42, 248, 0.85)
    y = 1620
    d.text((80, y), s["product"]["kicker"].upper(), font=font(32), fill=(224, 206, 176))
    y += 62
    f1 = font(78)
    for line in wrap(d, s["product"]["title"], f1, W - 160):
        d.text((80, y), line, font=f1, fill=(255, 255, 255))
        y += 88
    y += 18
    d.text((80, y), s["product"]["tagline"], font=font(34), fill=(226, 218, 206))

    # claim
    y0 = 2160
    y = head(y0 + 100, s["claim"]["kicker"], s["claim"]["title"], "", 72)
    f = font(40)
    for line in wrap(d, s["claim"]["body"], f, W - 160):
        d.text((80, y), line, font=f, fill=muted)
        y += 54
    top = max(y + 40, y0 + 560)
    paste_cover(canvas, s["claim"]["image"], (80, top, W - 80, y0 + 1020))

    # front / back
    y0 = 3240
    head(y0 + 90, "Vista del producto", "Frontal y posterior", "", 76)
    cw = (W - 160 - 24) // 2
    paste_cover(canvas, s["images"]["front"], (80, y0 + 330, 80 + cw, y0 + 970))
    paste_cover(canvas, s["images"]["back"], (80 + cw + 24, y0 + 330, W - 80, y0 + 970))
    d.text((80, y0 + 990), "FRONTAL", font=font(26), fill=accent)
    d.text((80 + cw + 24, y0 + 990), "POSTERIOR", font=font(26), fill=accent)

    # print
    y0 = 4320
    d.rectangle([0, y0, W, y0 + BAND], fill=(12, 12, 12))
    head(y0 + 90, "Detalle", "El diseño de cerca", "", 76)
    paste_fit(canvas, s["images"]["print"], (80, y0 + 250, W - 80, y0 + 1010))

    # fabric
    y0 = 5400
    head(y0 + 90, "La prenda", "Tejido y composición", "", 76)
    paste_cover(canvas, s["images"]["fabric"], (80, y0 + 330, 560, y0 + 990))
    yy = y0 + 340
    for row in s["spec_rows"]:
        d.text((620, yy), row["label"].upper(), font=font(24), fill=accent)
        yy += 34
        for line in wrap(d, row["value"], font(32), W - 700):
            d.text((620, yy), line, font=font(32), fill=ink)
            yy += 42
        yy += 22

    # finishes
    y0 = 6480
    head(y0 + 90, "Acabados", "Detalles de confección", "", 76)
    cw = (W - 160 - 48) // 3
    for i, it in enumerate(s["details"][:3]):
        x = 80 + i * (cw + 24)
        paste_cover(canvas, it["image"], (x, y0 + 330, x + cw, y0 + 890))
        d.text((x, y0 + 908), it["label"].upper(), font=font(24), fill=accent)

    # colors
    y0 = 7560
    head(y0 + 90, "Opciones", "Colores disponibles", "Seis colores en el mismo diseño", 76)
    gw, gh = (W - 160 - 48) // 3, 300
    for i, c in enumerate(s["colors"][:6]):
        col, row = i % 3, i // 3
        x, yy = 80 + col * (gw + 24), y0 + 340 + row * (gh + 60)
        color_tile(canvas, c, (x, yy, x + gw, yy + gh), (255, 255, 255), (222, 218, 210))
        d.text((x, yy + gh + 10), c["name"].upper(), font=font(24), fill=accent)

    # sizes
    v_table(canvas, d, s, t, 8640, left=True)


def v_table(canvas, d, s, t, y0, left=True, dark=False):
    accent, ink, muted = t["accent"], t["ink"], t["muted"]
    d.text((80, y0 + 80), "MEDIDAS", font=font(32), fill=accent)
    f = font(76)
    d.text((80, y0 + 138), "Guía de tallas", font=f, fill=ink)
    d.text((80, y0 + 236), "Medidas en centímetros", font=font(36), fill=muted)
    rows = s.get("size_table", [])
    cols = [("Talla", 200), ("Hombro", 180), ("Pecho", 180), ("Largo", 180), ("Manga", 180)]
    x0, ty = 80, y0 + 330
    d.line([(x0, ty), (W - 80, ty)], fill=ink, width=3)
    cx = x0
    for name, cwid in cols:
        d.text((cx + 10, ty + 26), name.upper(), font=font(26), fill=accent)
        cx += cwid
    ty += 84
    d.line([(x0, ty), (W - 80, ty)], fill=ink, width=1)
    zebra = (238, 233, 224) if not dark else (26, 26, 26)
    for i, r in enumerate(rows):
        if i % 2 == 0:
            d.rectangle([x0, ty, W - 80, ty + 104], fill=zebra)
        vals = [r["size"], r["shoulder"], r["chest"], r["length"], r["sleeve"]]
        cx = x0
        for (name, cwid), val in zip(cols, vals):
            d.text((cx + 10, ty + 28), str(val), font=font(40 if name == "Talla" else 38), fill=ink)
            cx += cwid
        ty += 104
        d.line([(x0, ty), (W - 80, ty)], fill=ink, width=1)
    yy = ty + 36
    for line in wrap(d, s["care"], font(24), W - 160):
        d.text((80, yy), line, font=font(24), fill=muted)
        yy += 34


# ------------------------------------------------------------------- oscuro
def v_oscuro(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))

    def head(y, kicker, title, sub="", size=80, rule=True):
        if rule:
            d.line([(80, y), (W - 80, y)], fill=accent, width=2)
        y += 34
        tracked(d, (0, y), kicker.upper(), font(26), accent, 8, center=W / 2)
        y += 62
        f = font(size)
        for line in wrap(d, title, f, W - 200):
            d.text((W / 2, y), line, font=f, fill=ink, anchor="ma")
            y += size + 12
        if sub:
            for line in wrap(d, sub, font(32), W - 240):
                d.text((W / 2, y), line, font=font(32), fill=muted, anchor="ma")
                y += 44
        return y + 24

    # hero 满幅
    paste_cover(canvas, s["images"]["hero"], (0, 0, W, 2160))
    shade_bottom(canvas, (0, 0, W, 2160), 0.30, 250, 0.75)
    d.line([(80, 1478), (W - 80, 1478)], fill=accent, width=2)
    tracked(d, (0, 1512), s["product"]["kicker"].upper(), font(28), accent, 10, center=W / 2)
    y = 1584
    for line in wrap(d, s["product"]["title"], font(66), W - 200):
        d.text((W / 2, y), line, font=font(66), fill=ink, anchor="ma")
        y += 78
    d.line([(440, y + 26), (W - 440, y + 26)], fill=accent, width=2)
    d.text((W / 2, y + 56), s["product"]["tagline"], font=font(28), fill=muted, anchor="ma")

    # claim：满幅图 + 居中大字压在图上
    y0 = 2160
    paste_cover(canvas, s["claim"]["image"], (0, y0, W, y0 + BAND))
    shade_bottom(canvas, (0, y0, W, y0 + BAND), 0.05, 235, 1.0)
    tracked(d, (0, y0 + 190), s["claim"]["kicker"].upper(), font(26), accent, 9, center=W / 2)
    yy = y0 + 250
    for line in wrap(d, s["claim"]["title"], font(72), W - 200):
        d.text((W / 2, yy), line, font=font(72), fill=ink, anchor="ma")
        yy += 84
    yy += 20
    for line in wrap(d, s["claim"]["body"], font(32), W - 260):
        d.text((W / 2, yy), line, font=font(32), fill=muted, anchor="ma")
        yy += 46

    # 正反：通栏，中间 2px 金线
    y0 = 3240
    yy = head(y0 + 70, "Vista del producto", "Frontal y posterior", "", 68)
    top = max(yy + 10, y0 + 280)
    cw = (W - 80 - 4) // 2
    paste_cover(canvas, s["images"]["front"], (0, top, cw, y0 + BAND))
    paste_cover(canvas, s["images"]["back"], (cw + 4, top, W, y0 + BAND))
    d.rectangle([cw, top, cw + 4, y0 + BAND], fill=accent)
    d.text((24, y0 + BAND - 54), "FRONTAL", font=font(24), fill=ink)
    d.text((cw + 30, y0 + BAND - 54), "POSTERIOR", font=font(24), fill=ink)

    # 图案：居中留白式，非满幅
    y0 = 4320
    d.rectangle([0, y0, W, y0 + BAND], fill=(10, 10, 10))
    tracked(d, (0, y0 + 74), "DETALLE", font(26), accent, 10, center=W / 2)
    d.text((W / 2, y0 + 124), "El diseño de cerca", font=font(62), fill=ink, anchor="ma")
    paste_fit(canvas, s["images"]["print"], (150, y0 + 250, W - 150, y0 + 1000))

    # 面料 + 规格：左图满高，右侧居中轴
    y0 = 5400
    paste_cover(canvas, s["images"]["fabric"], (0, y0, 470, y0 + BAND))
    d.line([(470, y0), (470, y0 + BAND)], fill=accent, width=2)
    tracked(d, (0, y0 + 96), "LA PRENDA", font(24), accent, 8, center=(470 + W) / 2)
    d.text(((470 + W) / 2, y0 + 146), "Tejido y composición", font=font(48), fill=ink, anchor="ma")
    yy = y0 + 268
    for row in s["spec_rows"]:
        d.text((540, yy), row["label"].upper(), font=font(22), fill=accent)
        yy += 32
        for line in wrap(d, row["value"], font(28), W - 600):
            d.text((540, yy), line, font=font(28), fill=ink)
            yy += 38
        yy += 16
        d.line([(540, yy - 6), (W - 60, yy - 6)], fill=(46, 46, 46), width=1)

    # 工艺：三条竖幅满高
    y0 = 6480
    tracked(d, (0, y0 + 62), "ACABADOS", font(26), accent, 10, center=W / 2)
    d.text((W / 2, y0 + 112), "Detalles de confección", font=font(56), fill=ink, anchor="ma")
    cw = (W - 8) // 3
    for i, it in enumerate(s["details"][:3]):
        x = i * (cw + 4)
        box = (x, y0 + 230, x + cw, y0 + BAND)
        paste_cover(canvas, it["image"], box)
        shade_bottom(canvas, box, 0.72, 210, 1.0)
        tracked(d, (x + 26, y0 + BAND - 46), it["label"].upper(), font(22), (240, 232, 214), 5)

    # 颜色：暗底三列两行
    y0 = 7560
    tracked(d, (0, y0 + 62), "OPCIONES", font(26), accent, 10, center=W / 2)
    d.text((W / 2, y0 + 112), "Colores disponibles", font=font(58), fill=ink, anchor="ma")
    gw, gh = (W - 160 - 40) // 3, 296
    for i, c in enumerate(s["colors"][:6]):
        col, row = i % 3, i // 3
        x, yy = 80 + col * (gw + 20), y0 + 280 + row * (gh + 52)
        color_tile(canvas, c, (x, yy, x + gw, yy + gh), (255, 255, 255), (54, 54, 54))
        tracked(d, (x, yy + gh + 12), c["name"].upper(), font(22), accent, 4)

    # 尺码：暗底居中表
    y0 = 8640
    tracked(d, (0, y0 + 66), "MEDIDAS", font(26), accent, 10, center=W / 2)
    d.text((W / 2, y0 + 116), "Guía de tallas", font=font(64), fill=ink, anchor="ma")
    d.text((W / 2, y0 + 206), "Medidas en centímetros", font=font(30), fill=muted, anchor="ma")
    rows = s.get("size_table", [])
    cols = [("TALLA", 190), ("HOMBRO", 185), ("PECHO", 185), ("LARGO", 185), ("MANGA", 185)]
    x0, ty = 70, y0 + 290
    d.line([(x0, ty), (W - 70, ty)], fill=accent, width=2)
    cx = x0
    for name, cwid in cols:
        tracked(d, (cx + 12, ty + 26), name, font(22), accent, 2)
        cx += cwid
    ty += 78
    for i, r in enumerate(rows):
        if i % 2 == 0:
            d.rectangle([x0, ty, W - 70, ty + 100], fill=(22, 22, 22))
        vals = [r["size"], r["shoulder"], r["chest"], r["length"], r["sleeve"]]
        cx = x0
        for (name, cwid), val in zip(cols, vals):
            d.text((cx + 12, ty + 26), str(val), font=font(38 if name != "TALLA" else 40), fill=ink)
            cx += cwid
        ty += 100
        d.line([(x0, ty), (W - 70, ty)], fill=(46, 46, 46), width=1)
    yy = ty + 30
    for line in wrap(d, s["care"], font(22), W - 140):
        d.text((W / 2, yy), line, font=font(22), fill=muted, anchor="ma")
        yy += 30


# ------------------------------------------------------------------- bloque
def v_bloque(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))

    def bar(y, num, label, fill=None):
        fill = ink if fill is None else fill
        d.rectangle([0, y, W, y + 104], fill=fill)
        d.text((40, y + 24), num, font=font(54), fill=accent)
        tracked(d, (128, y + 36), label.upper(), font(26), (255, 255, 255), 6)

    def card(canvas, path, box, border=4):
        x0, y0, x1, y1 = box
        canvas.paste(Image.new("RGB", (x1 - x0 + 24, y1 - y0 + 24), (222, 216, 205)), (x0 - 12, y0 - 12))
        paste_cover(canvas, path, box)
        d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=ink, width=border)

    # hero
    paste_cover(canvas, s["images"]["hero"], (0, 0, W, 2160))
    shade_bottom(canvas, (0, 0, W, 2160), 0.50, 240, 0.8)
    d.rectangle([0, 1780, W, 2160], fill=ink)
    d.text((64, 1808), s["product"]["kicker"].upper(), font=font(28), fill=accent)
    y = 1862
    for line in wrap(d, s["product"]["title"], font(62), W - 128):
        d.text((64, y), line, font=font(62), fill=(255, 255, 255))
        y += 72
    d.text((64, y + 10), s["product"]["tagline"], font=font(28), fill=(196, 190, 178))

    # claim：左文字块 / 右出边框图
    y0 = 2160
    bar(y0, "01", "Por qué elegirla")
    yy = y0 + 160
    for line in wrap(d, s["claim"]["title"], font(66), 500):
        d.text((48, yy), line, font=font(66), fill=ink)
        yy += 78
    yy += 18
    for line in wrap(d, s["claim"]["body"], font(30), 480):
        d.text((48, yy), line, font=font(30), fill=muted)
        yy += 44
    im = cover(load(s["claim"]["image"]), 470, 760)
    canvas.paste(im, (600, y0 + 230))
    d.rectangle([600, y0 + 230, 600 + 469, y0 + 230 + 759], outline=ink, width=4)
    d.rectangle([600 - 14, y0 + 230 - 14, 600 - 1, y0 + 230 + 760], fill=accent)

    # 正反：上下两卡
    y0 = 3240
    bar(y0, "02", "Frontal y posterior")
    card(canvas, s["images"]["front"], (60, y0 + 170, 520, y0 + 830))
    card(canvas, s["images"]["back"], (560, y0 + 170, 1020, y0 + 830))
    d.text((60, y0 + 850), "FRONTAL", font=font(24), fill=accent)
    d.text((560, y0 + 850), "POSTERIOR", font=font(24), fill=accent)
    d.text((60, y0 + 900), "Impresión directa sobre tela", font=font(28), fill=ink)

    # 图案：深色满幅
    y0 = 4320
    d.rectangle([0, y0, W, y0 + BAND], fill=(16, 16, 16))
    bar(y0, "03", "El diseño", fill=(16, 16, 16))
    d.line([(0, y0 + 104), (W, y0 + 104)], fill=accent, width=3)
    paste_fit(canvas, s["images"]["print"], (90, y0 + 140, W - 90, y0 + 990))

    # 面料 + 规格：大卡 + 数据条
    y0 = 5400
    bar(y0, "04", "Tejido y composición")
    card(canvas, s["images"]["fabric"], (60, y0 + 170, 500, y0 + 700))
    d.text((60, y0 + 720), "MICRO TEJIDO", font=font(24), fill=accent)
    yy = y0 + 170
    for row in s["spec_rows"]:
        d.rectangle([540, yy, W - 60, yy + 76], fill=(240, 235, 226))
        d.text((558, yy + 10), row["label"].upper(), font=font(20), fill=accent)
        d.text((558, yy + 36), row["value"], font=font(28), fill=ink)
        yy += 86

    # 工艺：三竖卡
    y0 = 6480
    bar(y0, "05", "Detalles de confección")
    cw = (W - 120 - 32) // 3
    for i, it in enumerate(s["details"][:3]):
        x = 60 + i * (cw + 16)
        card(canvas, it["image"], (x, y0 + 170, x + cw, y0 + 810), border=3)
        d.text((x, y0 + 828), it["label"].upper(), font=font(24), fill=accent)

    # 颜色：3×2 色卡 + 色点
    y0 = 7560
    bar(y0, "06", "Seis colores")
    gw, gh = (W - 120 - 32) // 3, 280
    sw = {"NEGRO": (26, 26, 26), "BLANCO": (245, 243, 238), "AZUL": (34, 62, 160),
          "ROJO": (176, 26, 38), "VERDE": (38, 78, 52), "ROSA": (206, 158, 172)}
    for i, c in enumerate(s["colors"][:6]):
        col, row = i % 3, i // 3
        x, yy = 60 + col * (gw + 16), y0 + 150 + row * (gh + 56)
        color_tile(canvas, c, (x, yy, x + gw, yy + gh), (255, 255, 255), ink)
        d.ellipse([x, yy + gh + 14, x + 34, yy + gh + 48],
                  fill=sw.get(c["name"].upper(), (128, 128, 128)), outline=ink, width=2)
        d.text((x + 46, yy + gh + 18), c["name"].upper(), font=font(24), fill=ink)

    # 尺码：黑头表格
    y0 = 8640
    bar(y0, "07", "Guía de tallas")
    rows = s.get("size_table", [])
    cols = [("TALLA", 190), ("HOMBRO", 185), ("PECHO", 185), ("LARGO", 185), ("MANGA", 185)]
    x0, ty = 60, y0 + 150
    d.rectangle([x0, ty, W - 60, ty + 76], fill=ink)
    cx = x0
    for name, cwid in cols:
        d.text((cx + 14, ty + 24), name, font=font(22), fill=(255, 255, 255))
        cx += cwid
    ty += 76
    for i, r in enumerate(rows):
        if i % 2 == 0:
            d.rectangle([x0, ty, W - 60, ty + 96], fill=(240, 235, 226))
        vals = [r["size"], r["shoulder"], r["chest"], r["length"], r["sleeve"]]
        cx = x0
        for (name, cwid), val in zip(cols, vals):
            d.text((cx + 14, ty + 24), str(val), font=font(38 if name != "TALLA" else 40), fill=ink)
            cx += cwid
        ty += 96
        d.line([(x0, ty), (W - 60, ty)], fill=ink, width=1)
    d.rectangle([x0, y0 + 150, W - 60, ty], outline=ink, width=3)
    d.line([(x0, y0 + 150), (x0, ty)], fill=ink, width=3)
    d.line([(W - 60, y0 + 150), (W - 60, ty)], fill=ink, width=3)
    yy = ty + 34
    for line in wrap(d, s["care"], font(24), W - 120):
        d.text((60, yy), line, font=font(24), fill=muted)
        yy += 34


# ------------------------------------------------------------------ collage
def polaroid(canvas, path, box, angle=0.0, caption="", cap_color=(40, 40, 40), pad=18):
    """宝丽来斜贴：白边 + 轻旋转 + 投影。"""
    x0, y0, x1, y1 = box
    iw, ih = x1 - x0, y1 - y0
    card = Image.new("RGBA", (iw + pad * 2, ih + pad * 2 + 56), (255, 255, 255, 255))
    card.paste(cover(load(path), iw, ih), (pad, pad))
    cd = ImageDraw.Draw(card)
    if caption:
        cd.text((pad + 4, ih + pad + 12), caption, font=font(24), fill=cap_color + (255,))
    card = card.rotate(angle, expand=True, resample=Image.BICUBIC)
    shadow = Image.new("RGBA", card.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 60), (0, 0), card.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    sx, sy = cx - shadow.width // 2 + 10, cy - shadow.height // 2 + 14
    canvas.paste(Image.new("RGB", shadow.size, tuple(canvas.getpixel((sx + 4, sy + 4)))),
                 (sx, sy), shadow)
    canvas.paste(card, (cx - card.width // 2, cy - card.height // 2), card)


def v_collage(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))

    def vlabel(x, y, text, color, size=24, color_num=None):
        """竖排标签：逐字或整段旋转 90°。"""
        f = font(size)
        tmp = Image.new("RGBA", (int(d.textlength(text, font=f)) + 8, size + 12), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).text((0, 0), text, font=f, fill=color + (255,))
        canvas.paste(tmp.rotate(90, expand=True), (x, y), tmp.rotate(90, expand=True))

    def head(y, num, kicker, title, size=78, width=None):
        d.line([(80, y), (80, y + 150)], fill=accent, width=5)
        d.text((112, y - 6), num, font=font(56), fill=accent)
        tracked(d, (112 + d.textlength(num, font=font(56)) + 22, y + 12), kicker.upper(), font(22), muted, 6)
        yy = y + 66
        for line in wrap(d, title, font(size), width or (W - 200)):
            d.text((112, yy), line, font=font(size), fill=ink)
            yy += size + 8
        return yy + 10

    # hero：满幅 + 左下宝丽来压角 + 竖排标签
    paste_cover(canvas, s["images"]["hero"], (0, 0, W, 2160))
    shade_bottom(canvas, (0, 0, W, 2160), 0.55, 235, 0.9)
    vlabel(28, 120, "SAGRADO CORAZÓN · MXTMC001", (232, 216, 190), 26)
    d.text((80, 1800), s["product"]["kicker"].upper(), font=font(30), fill=(224, 206, 176))
    y = 1852
    for line in wrap(d, s["product"]["title"], font(64), W - 320):
        d.text((80, y), line, font=font(64), fill=(255, 255, 255))
        y += 74
    d.text((80, y + 6), s["product"]["tagline"], font=font(28), fill=(216, 208, 196))

    # claim：右图左文，宝丽来叠在图上
    y0 = 2160
    yy = head(y0 + 90, "01", "Por qué esta playera", s["claim"]["title"], 64, width=420)
    for line in wrap(d, s["claim"]["body"], font(32), 430):
        d.text((80, yy), line, font=font(32), fill=muted)
        yy += 48
    paste_cover(canvas, s["claim"]["image"], (560, y0 + 90, W, y0 + 640))
    polaroid(canvas, s["claim"]["image"], (600, y0 + 620, 960, y0 + 900), -2.0, "vista trasera")

    # 正反：两张宝丽来错位
    y0 = 3240
    head(y0 + 70, "02", "Vista del producto", "Frontal y posterior", 66)
    polaroid(canvas, s["images"]["front"], (100, y0 + 300, 480, y0 + 840), -3.0, "FRONTAL")
    polaroid(canvas, s["images"]["back"], (520, y0 + 250, 940, y0 + 800), 2.5, "POSTERIOR")

    # 图案：深底 + 竖排标签
    y0 = 4320
    d.rectangle([0, y0, W, y0 + BAND], fill=(14, 13, 12))
    vlabel(30, y0 + 90, "EL DISEÑO", (198, 168, 112), 30)
    d.text((110, y0 + 96), "El diseño de cerca", font=font(62), fill=(255, 255, 255))
    d.text((110, y0 + 182), "Retrato al frente · figura completa atrás", font=font(28), fill=(198, 190, 178))
    paste_fit(canvas, s["images"]["print"], (170, y0 + 250, W - 110, y0 + 1000))

    # 面料 + 规格：卡片式
    y0 = 5400
    head(y0 + 70, "03", "La prenda", "Tejido y composición", 66)
    polaroid(canvas, s["images"]["fabric"], (100, y0 + 290, 460, y0 + 700), -1.5, "micro tejido")
    # 规格框按实际文字高度收边，避免内容冲出描边
    box_top = y0 + 292
    yy = y0 + 330
    for row in s["spec_rows"]:
        d.text((566, yy), row["label"].upper(), font=font(20), fill=accent)
        yy += 28
        for line in wrap(d, row["value"], font(26), W - 640):
            d.text((566, yy), line, font=font(26), fill=ink)
            yy += 34
        yy += 10
    d.rectangle([540, box_top, W - 70, yy + 8], outline=accent, width=2)

    # 工艺：三张斜贴
    y0 = 6480
    head(y0 + 60, "04", "Acabados", "Detalles de confección", 62)
    angles = (-3.0, 1.8, -2.2)
    for i, it in enumerate(s["details"][:3]):
        x = 70 + i * 320
        polaroid(canvas, it["image"], (x, y0 + 310, x + 270, y0 + 690),
                 angles[i], it["label"].lower(), pad=14)

    # 颜色：斜贴 strip
    y0 = 7560
    head(y0 + 60, "05", "Opciones", "Colores disponibles", 62)
    d.text((112, y0 + 196), "Seis colores en el mismo diseño", font=font(28), fill=muted)
    sw = {"NEGRO": (26, 26, 26), "BLANCO": (245, 243, 238), "AZUL": (34, 62, 160),
          "ROJO": (176, 26, 38), "VERDE": (38, 78, 52), "ROSA": (206, 158, 172)}
    gw, gh = (W - 140 - 40) // 3, 268
    for i, c in enumerate(s["colors"][:6]):
        col, row = i % 3, i // 3
        x, yy = 70 + col * (gw + 20), y0 + 270 + row * (gh + 46)
        color_tile(canvas, c, (x, yy, x + gw, yy + gh), (255, 255, 255), (0, 0, 0))
        d.ellipse([x + 10, yy + gh - 44, x + 44, yy + gh - 10],
                  fill=sw.get(c["name"].upper(), (128, 128, 128)), outline=(255, 255, 255), width=2)
        tracked(d, (x, yy + gh + 10), c["name"].upper(), font(22), ink, 3)

    # 尺码：手写感下划线表
    y0 = 8640
    head(y0 + 60, "06", "Medidas", "Guía de tallas", 62)
    d.text((112, y0 + 196), "Medidas en centímetros", font=font(28), fill=muted)
    rows = s.get("size_table", [])
    cols = [("Talla", 200), ("Hombro", 180), ("Pecho", 180), ("Largo", 180), ("Manga", 180)]
    x0, ty = 80, y0 + 270
    cx = x0
    for name, cwid in cols:
        d.text((cx + 8, ty), name.upper(), font=font(24), fill=accent)
        cx += cwid
    ty += 44
    d.line([(x0, ty), (W - 80, ty)], fill=ink, width=3)
    for r in rows:
        ty += 26
        vals = [r["size"], r["shoulder"], r["chest"], r["length"], r["sleeve"]]
        cx = x0
        for (name, cwid), val in zip(cols, vals):
            d.text((cx + 8, ty), str(val), font=font(40 if name == "Talla" else 38), fill=ink)
            cx += cwid
        ty += 74
        d.line([(x0, ty), (W - 80, ty)], fill=(120, 108, 88), width=1)
    yy = ty + 30
    for line in wrap(d, s["care"], font(24), W - 160):
        d.text((80, yy), line, font=font(24), fill=muted)
        yy += 34


# ------------------------------------------------------------- 结构公用件
def dim_h(d, x0, x1, y, label, color, fs=22, bg=None):
    d.line([(x0, y), (x1, y)], fill=color, width=2)
    for x in (x0, x1):
        d.line([(x, y - 12), (x, y + 12)], fill=color, width=2)
    cx = (x0 + x1) // 2
    tw = d.textlength(label, font=font(fs))
    if bg:
        d.rectangle([cx - tw / 2 - 8, y - fs - 8, cx + tw / 2 + 8, y - 2], fill=bg)
    d.text((cx, y - fs - 6), label, font=font(fs), fill=color, anchor="ma")


def dim_v(canvas, d, x, y0, y1, label, color, fs=22, bg=None):
    d.line([(x, y0), (x, y1)], fill=color, width=2)
    for y in (y0, y1):
        d.line([(x - 12, y), (x + 12, y)], fill=color, width=2)
    tmp = Image.new("RGBA", (int(fs * 4), fs + 8), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((0, 0), label, font=font(fs), fill=color)
    tmp = tmp.crop(tmp.getbbox() or (0, 0, fs * 3, fs))
    tmp = tmp.rotate(90, expand=True)
    cy = (y0 + y1) // 2
    px, py = x - tmp.width // 2, cy - tmp.height // 2
    if bg:
        d.rectangle([px - 6, py - 4, px + tmp.width + 6, py + tmp.height + 4], fill=bg)
        d.line([(x, y0), (x, y1)], fill=color, width=2)
    canvas.paste(tmp, (px, py), tmp)


def ticks(d, box, color, n=14, w=2):
    x0, y0, x1, y1 = box
    for (cx, cy, dx, dy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        d.line([(cx, cy), (cx + dx * n, cy)], fill=color, width=w)
        d.line([(cx, cy), (cx, cy + dy * n)], fill=color, width=w)


def color_tile(canvas, c, box, fill=(255, 255, 255), outline=None, scale=0.94):
    """色卡格：底色 + 整件平铺（contain），让衣色本身可辨，不裁到图案中央。"""
    x0, y0, x1, y1 = box
    canvas.paste(Image.new("RGB", (x1 - x0, y1 - y0), tuple(fill)), (x0, y0))
    im = fit(load(c["image"]), int((x1 - x0) * scale), int((y1 - y0) * scale))
    canvas.paste(im, (x0 + (x1 - x0 - im.width) // 2, y0 + (y1 - y0 - im.height) // 2))
    if outline:
        canvas_draw = ImageDraw.Draw(canvas)
        canvas_draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=outline, width=1)


def label_tag(d, xy, text, color, fs=22, bg=None):
    x, y = xy
    d.rectangle([x, y + 3, x + 10, y + 13], fill=color)
    d.text((x + 18, y), text, font=font(fs), fill=color if not bg else color)


def rot_text(canvas, text, xy, color, fs=24, track=0):
    """竖排（顺时针 90°）文字贴图。"""
    f = font(fs)
    w = int(sum(ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(c, font=f) for c in text) + track * len(text))
    tmp = Image.new("RGBA", (max(1, w + 8), fs + 12), (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    x = 4
    for c in text:
        td.text((x, 0), c, font=f, fill=color)
        x += td.textlength(c, font=f) + track
    tmp = tmp.rotate(90, expand=True)
    canvas.paste(tmp, xy, tmp)
    return tmp.size


# --------------------------------------------------------------- techpack
def v_techpack(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))
    ff = s["images"].get("front_flat", s["images"]["front"])
    fb = s["images"].get("back_flat", s["images"]["back"])

    def rule(y, x0=60, x1=W - 60, w=2, col=None):
        d.line([(x0, y), (x1, y)], fill=col or ink, width=w)

    # 表头
    d.text((60, 52), "FICHA TÉCNICA", font=font(22), fill=accent)
    d.text((W - 60, 52), "MXTMC001 · S–XL · 6 COLORES", font=font(20), fill=muted, anchor="ra")
    rule(88)
    ty = 110
    for line in wrap(d, s["product"]["title"], font(36), W - 120):
        d.text((60, ty), line, font=font(36), fill=ink)
        ty += 44
    d.text((60, ty + 2), s["product"]["tagline"], font=font(24), fill=muted)
    rule(236, 60, W - 60, 1, muted)

    # 平铺背面（主视图）+ 尺寸线
    bx = (230, 280, 660, 1460)
    paste_fit(canvas, fb, bx)
    dim_v(canvas, d, 196, 300, 1400, "LARGO", accent, 20, bg)
    dim_h(d, 240, 650, 1494, "PECHO", accent, 20, bg)
    ticks(d, (180, 260, 700, 1480), (200, 200, 200), 16, 1)

    # 平铺正面（小图）
    paste_fit(canvas, ff, (730, 280, 1010, 640))
    d.text((730, 652), "VISTA FRONTAL", font=font(18), fill=accent)
    d.rectangle([730, 676, 1010, 676], fill=(220, 220, 220))

    # 数据网格
    yy = 730
    for row in s["spec_rows"][:3]:
        d.text((730, yy), row["label"].upper(), font=font(17), fill=accent)
        for line in wrap(d, row["value"], font(24), 280):
            d.text((730, yy + 24), line, font=font(24), fill=ink)
            yy += 30
        yy += 24
    yy = 1560
    for i, row in enumerate(s["spec_rows"][3:6]):
        x = 60 + i * 330
        d.text((x, yy), row["label"].upper(), font=font(17), fill=accent)
        d.text((x, yy + 26), row["value"], font=font(26), fill=ink)
        d.line([(x, yy + 66), (x + 290, yy + 66)], fill=(210, 210, 210), width=1)

    # 02 印位
    y0 = 2160
    rule(y0 + 40)
    d.text((60, y0 + 62), "ÁREA DE ESTAMPADO", font=font(20), fill=accent)
    d.text((60, y0 + 96), "Impresión directa sobre la tela, sin bordado ni pedrería", font=font(30), fill=ink)
    for i, (path, name) in enumerate(((ff, "FRENTE"), (fb, "ESPALDA"))):
        x = 60 + i * 500
        box = (x, y0 + 200, x + 460, y0 + 900)
        paste_fit(canvas, path, box)
        d.rectangle(box, outline=(205, 205, 205), width=1)
        ticks(d, box, accent, 12, 2)
        d.text((x, y0 + 916), name, font=font(20), fill=ink)
        d.text((x + 130, y0 + 916), "zona marcada = estampado", font=font(18), fill=muted)

    # 03 面料 + 规格
    y0 = 3240
    rule(y0 + 40)
    d.text((60, y0 + 62), "MATERIA", font=font(20), fill=accent)
    paste_cover(canvas, s["images"]["fabric"], (60, y0 + 110, 520, y0 + 620))
    d.text((60, y0 + 636), "MICRO TEJIDO · punto jersey CVC", font=font(18), fill=muted)
    yy = y0 + 120
    for row in s["spec_rows"]:
        d.text((566, yy), row["label"].upper(), font=font(16), fill=accent)
        d.text((566, yy + 22), row["value"], font=font(26), fill=ink)
        yy += 78
        d.line([(566, yy - 14), (W - 60, yy - 14)], fill=(214, 214, 214), width=1)
    d.text((60, y0 + 700), "COMPOSICIÓN: " + s["spec_rows"][2]["value"], font=font(22), fill=ink)

    # 04 工艺四格
    y0 = 4320
    rule(y0 + 40)
    d.text((60, y0 + 62), "CONFECCIÓN", font=font(20), fill=accent)
    cells = list(s["details"][:3]) + [{"image": s["images"]["fabric"], "label": "Tejido"}]
    cw = (W - 120 - 20) // 2
    chh = 400
    for i, it in enumerate(cells):
        col, row = i % 2, i // 2
        x = 60 + col * (cw + 20)
        yy = y0 + 120 + row * (chh + 56)
        box = (x, yy, x + cw, yy + chh)
        d.rectangle(box, fill=(242, 240, 236))
        im = fit(load(it["image"]), cw - 36, chh - 36)
        canvas.paste(im, (x + (cw - im.width) // 2, yy + (chh - im.height) // 2))
        ticks(d, box, accent, 14, 2)
        d.text((x, yy + chh + 12), it["label"].upper(), font=font(20), fill=ink)
        d.text((x + 150, yy + chh + 12), "detalle de confección", font=font(16), fill=muted)

    # 05 尺码
    y0 = 5400
    rule(y0 + 40)
    d.text((60, y0 + 62), "DIMENSIONES", font=font(20), fill=accent)
    d.text((60, y0 + 96), "Medidas en centímetros, prenda en plano", font=font(24), fill=muted)
    rows = s.get("size_table", [])
    cols = [("TALLA", 170), ("HOMBRO", 200), ("PECHO", 200), ("LARGO", 200), ("MANGA", 190)]
    x0, ty = 60, y0 + 160
    d.rectangle([x0, ty, W - 60, ty + 70], fill=ink)
    cx = x0
    for name, cwid in cols:
        d.text((cx + 14, ty + 22), name, font=font(20), fill=(255, 255, 255))
        cx += cwid
    ty += 70
    for i, r in enumerate(rows):
        if i % 2 == 0:
            d.rectangle([x0, ty, W - 60, ty + 92], fill=(240, 238, 234))
        vals = [r["size"], r["shoulder"], r["chest"], r["length"], r["sleeve"]]
        cx = x0
        for (name, cwid), val in zip(cols, vals):
            d.text((cx + 14, ty + 22), str(val), font=font(36), fill=ink)
            cx += cwid
        ty += 92
        d.line([(x0, ty), (W - 60, ty)], fill=(200, 200, 200), width=1)
    d.text((60, ty + 26), "Tolerancia de medición ±1 cm · Prenda unisex", font=font(20), fill=muted)

    # 06 颜色
    y0 = 6480
    rule(y0 + 40)
    d.text((60, y0 + 62), "COLORWAY", font=font(20), fill=accent)
    d.text((60, y0 + 96), "Seis colores de la misma ficha", font=font(28), fill=ink)
    gw = (W - 120 - 50) // 6
    for i, c in enumerate(s["colors"][:6]):
        x = 60 + i * (gw + 10)
        color_tile(canvas, c, (x, y0 + 170, x + gw, y0 + 690), (255, 255, 255), (190, 190, 190))

    # 07 洗护
    y0 = 7560
    rule(y0 + 40)
    d.text((60, y0 + 62), "CUIDADO", font=font(20), fill=accent)
    care = [("30°", "Agua fría"), ("⃠", "Sin cloro"), ("≋", "Secar a la sombra"), ("✕♨", "No planchar el estampado")]
    for i, (sym, txt) in enumerate(care):
        x = 60 + i * 238
        d.rectangle([x, y0 + 120, x + 214, y0 + 400], outline=ink, width=2)
        d.text((x + 107, y0 + 190), sym, font=font(56), fill=accent, anchor="ma")
        d.text((x + 107, y0 + 310), txt, font=font(20), fill=ink, anchor="ma")
    yy = y0 + 440
    for line in wrap(d, s["care"], font(24), W - 120):
        d.text((60, yy), line, font=font(24), fill=muted)
        yy += 36

    # 08 上身
    y0 = 8640
    paste_cover(canvas, s["images"]["hero"], (460, y0, W, y0 + BAND))
    d.text((60, y0 + 80), "EN USO", font=font(20), fill=accent)
    yy = y0 + 130
    for line in wrap(d, "La misma ficha, puesta.", font(52), 360):
        d.text((60, yy), line, font=font(52), fill=ink)
        yy += 62
    d.text((60, y0 + 300), "Corte unisex recto", font=font(24), fill=muted)
    d.text((60, y0 + 700), "REF. JC101", font=font(20), fill=muted)


# ------------------------------------------------------------------ poster
def v_poster(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))

    def idx(y, n, label):
        d.text((60, y), n, font=font(30), fill=accent)
        d.line([(120, y + 20), (200, y + 20)], fill=accent, width=2)
        tracked(d, (216, y + 6), label.upper(), font(20), muted, 6)

    # 01 首屏：满幅 + 巨型字
    paste_cover(canvas, s["images"]["hero"], (0, 0, W, 2160))
    shade_bottom(canvas, (0, 0, W, 2160), 0.30, 245, 0.7)
    idx(120, "01", "Sagrado Corazón")
    y = 1420
    for line in ("SAGRADO", "CORAZÓN"):
        d.text((56, y), line, font=font(150), fill=ink)
        y += 160
    d.line([(60, y + 20), (420, y + 20)], fill=accent, width=4)
    d.text((60, y + 48), s["product"]["tagline"], font=font(30), fill=muted)

    # 02 背面
    y0 = 2160
    paste_cover(canvas, s["images"]["back"], (0, y0, W, y0 + BAND))
    shade_bottom(canvas, (0, y0, W, y0 + BAND), 0.62, 220, 0.9)
    idx(y0 + 64, "02", "Espalda")
    d.text((60, y0 + 900), "La figura completa,", font=font(58), fill=ink)
    d.text((60, y0 + 968), "con marco dorado", font=font(58), fill=ink)

    # 03 图案微距
    y0 = 3240
    paste_cover(canvas, s["images"]["print"], (0, y0, W, y0 + BAND))
    shade_bottom(canvas, (0, y0, W, y0 + BAND), 0.80, 200, 1.0)
    idx(y0 + 64, "03", "Detalle")
    d.text((60, y0 + 950), "Tinta sobre algodón CVC 180 g", font=font(34), fill=ink)

    # 04 三联
    y0 = 4320
    tri = s["colors"][:3]
    cw = W // 3
    for i, c in enumerate(tri):
        x = i * cw
        color_tile(canvas, c, (x, y0, x + cw, y0 + BAND), (255, 255, 255))
        if i:
            d.line([(x, y0), (x, y0 + BAND)], fill=(10, 10, 10), width=3)
        rot_text(canvas, c["name"].upper(), (x + 20, y0 + BAND - 170), (255, 255, 255), 22, 3)
    idx(y0 + 64, "04", "Tres de seis")

    # 05 吊牌：整页数据卡
    y0 = 5400
    d.rectangle([0, y0, W, y0 + BAND], fill=(238, 234, 226))
    card = (70, y0 + 80, W - 70, y0 + 1000)
    d.rectangle(card, fill=(255, 255, 255))
    d.rectangle([card[0] + 10, card[1] + 10, card[2] - 10, card[3] - 10],
                outline=(24, 22, 20), width=2)
    d.text((card[0] + 40, card[1] + 40), s["product"]["kicker"].upper(), font=font(26), fill=(150, 118, 62))
    d.text((card[0] + 40, card[1] + 84), "Ficha de la prenda", font=font(48), fill=(24, 22, 20))
    d.line([(card[0] + 40, card[1] + 152), (card[2] - 40, card[1] + 152)], fill=(24, 22, 20), width=2)
    yy = card[1] + 176
    for row in s["spec_rows"]:
        d.text((card[0] + 40, yy), row["label"].upper(), font=font(17), fill=(150, 118, 62))
        d.text((card[0] + 300, yy - 4), row["value"], font=font(28), fill=(24, 22, 20))
        yy += 58
        d.line([(card[0] + 40, yy - 12), (card[2] - 40, yy - 12)], fill=(226, 222, 214), width=1)
    d.text((card[0] + 40, yy + 8), "TALLAS", font=font(17), fill=(150, 118, 62))
    d.text((card[0] + 300, yy + 4), " · ".join(r["size"] for r in s.get("size_table", [])),
           font=font(28), fill=(24, 22, 20))

    # 06 尺码：巨型数字
    y0 = 6480
    d.rectangle([0, y0, W, y0 + BAND], fill=(14, 14, 14))
    idx(y0 + 64, "06", "Tallas")
    rows = s.get("size_table", [])
    cw = (W - 120) // max(1, len(rows))
    for i, r in enumerate(rows):
        x = 60 + i * cw
        d.text((x, y0 + 240), r["size"], font=font(96), fill=(255, 255, 255))
        d.line([(x, y0 + 366), (x + cw - 20, y0 + 366)], fill=accent, width=2)
        d.text((x, y0 + 392), "PECHO", font=font(18), fill=accent)
        d.text((x, y0 + 418), str(r["chest"]), font=font(40), fill=(255, 255, 255))
        d.text((x, y0 + 486), "LARGO", font=font(18), fill=accent)
        d.text((x, y0 + 512), str(r["length"]), font=font(40), fill=(255, 255, 255))
        d.text((x, y0 + 580), f"HOMBRO {r['shoulder']}", font=font(20), fill=(180, 176, 168))
        d.text((x, y0 + 610), f"MANGA {r['sleeve']}", font=font(20), fill=(180, 176, 168))

    # 07 六色横条
    y0 = 7560
    paste_cover(canvas, s["images"]["front"], (0, y0, W, y0 + 240))
    cw = W // 6
    for i, c in enumerate(s["colors"][:6]):
        x = i * cw
        color_tile(canvas, c, (x, y0 + 240, x + cw, y0 + BAND), (255, 255, 255))
        d.line([(x, y0 + 240), (x, y0 + BAND)], fill=(10, 10, 10), width=2)
        rot_text(canvas, c["name"].upper(), (x + 12, y0 + BAND - 130), (255, 255, 255), 17, 2)

    # 08 收尾
    y0 = 8640
    paste_cover(canvas, s["images"]["hero"], (0, y0, W, y0 + BAND))
    shade_bottom(canvas, (0, y0, W, y0 + BAND), 0.45, 235, 0.9)
    d.text((W / 2, y0 + 780), "Sagrado Corazón", font=font(64), fill=ink, anchor="ma")
    d.text((W / 2, y0 + 894), s["product"]["tagline"], font=font(26), fill=muted, anchor="ma")


# ------------------------------------------------------------------ mosaic
def v_mosaic(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))

    # 首屏：左侧竖条文字 + 右侧满高图
    LX = 400
    d.rectangle([0, 0, LX, 2160], fill=ink)
    rot_text(canvas, "SAGRADO CORAZÓN", (LX - 62, 120), (240, 206, 150), 26, 8)
    d.text((48, 200), "PLAYERA", font=font(64), fill=(255, 255, 255))
    d.text((48, 272), "UNISEX", font=font(64), fill=accent)
    d.line([(52, 372), (300, 372)], fill=accent, width=4)
    yy = 404
    for line in wrap(d, s["claim"]["title"], font(34), 300):
        d.text((48, yy), line, font=font(34), fill=(232, 226, 214))
        yy += 44
    yy += 20
    for line in wrap(d, s["claim"]["body"], font(24), 300):
        d.text((48, yy), line, font=font(24), fill=(158, 152, 142))
        yy += 34
    paste_cover(canvas, s["images"]["hero"], (LX, 0, W, 2160))

    # 02 图墙：一大四小
    y0 = 2160
    g = 8
    cells = [
        (0, y0, 690, y0 + 690, s["images"]["front"], "FRENTE"),
        (698, y0, W, y0 + 338, s["images"]["back"], "ESPALDA"),
        (698, y0 + 346, W, y0 + 690, s["images"]["print"], "DISEÑO"),
        (0, y0 + 698, 536, y0 + BAND, s["details"][0]["image"], "CUELLO"),
        (544, y0 + 698, W, y0 + BAND, s["details"][1]["image"], "MANGA"),
    ]
    for (x0, yy0, x1, yy1, path, name) in cells:
        paste_cover(canvas, path, (x0, yy0, x1, yy1))
        shade_bottom(canvas, (x0, yy0, x1, yy1), 0.78, 170, 1.0)
        d.text((x0 + 26, yy1 - 34), name, font=font(17), fill=(255, 255, 255))

    # 03 六色 3×2 满格
    y0 = 3240
    gw, gh = W // 3, 540
    for i, c in enumerate(s["colors"][:6]):
        col, row = i % 3, i // 3
        x, yy = col * gw, y0 + row * gh
        color_tile(canvas, c, (x, yy, x + gw - 4, yy + gh - 4), (255, 255, 255))
        d.rectangle([x + 18, yy + 12, x + 18 + 40 + 12 * len(c["name"]), yy + 46], fill=(14, 14, 14))
        d.text((x + 28, yy + 18), c["name"].upper(), font=font(17), fill=(255, 255, 255))

    # 04 面料横条 + 三列规格
    y0 = 4320
    paste_cover(canvas, s["images"]["fabric"], (0, y0, W, y0 + 420))
    d.text((24, y0 + 24), "TEJIDO CVC 180 g", font=font(20), fill=(255, 255, 255))
    rows = s["spec_rows"]
    cw = (W - 96) // 3
    for i, row in enumerate(rows[:6]):
        col, r2 = i % 3, i // 3
        x = 48 + col * cw
        yy = y0 + 470 + r2 * 150
        d.text((x, yy), row["label"].upper(), font=font(16), fill=accent)
        yy2 = yy + 24
        for line in wrap(d, row["value"], font(26), cw - 30):
            d.text((x, yy2), line, font=font(26), fill=ink)
            yy2 += 32

    # 05 工艺满格 2×2
    y0 = 5400
    cw, chh = W // 2, 540
    for i in range(4):
        col, row = i % 2, i // 2
        x, yy = col * cw, y0 + row * chh
        it = (s["details"] + [{"image": s["images"]["print"], "label": "Estampado"}])[min(i, 3)]
        paste_cover(canvas, it["image"], (x, yy, x + cw - 4, yy + chh - 4))
        d.text((x + 26, yy + chh - 40), it["label"].upper(), font=font(17), fill=(255, 255, 255))

    # 06 尺码：满宽大行
    y0 = 6480
    d.rectangle([0, y0, W, y0 + BAND], fill=(18, 18, 18))
    d.text((48, y0 + 60), "GUÍA DE TALLAS", font=font(22), fill=accent)
    d.text((48, y0 + 96), "Medidas en centímetros", font=font(26), fill=(150, 146, 138))
    rows = s.get("size_table", [])
    ty = y0 + 180
    for i, r in enumerate(rows):
        if i % 2 == 0:
            d.rectangle([0, ty, W, ty + 120], fill=(30, 30, 30))
        d.text((48, ty + 26), r["size"], font=font(62), fill=(255, 255, 255))
        d.text((180, ty + 30), "hombro", font=font(16), fill=(150, 146, 138))
        d.text((180, ty + 52), str(r["shoulder"]), font=font(34), fill=(255, 255, 255))
        d.text((330, ty + 30), "pecho", font=font(16), fill=(150, 146, 138))
        d.text((330, ty + 52), str(r["chest"]), font=font(34), fill=(255, 255, 255))
        d.text((480, ty + 30), "largo", font=font(16), fill=(150, 146, 138))
        d.text((480, ty + 52), str(r["length"]), font=font(34), fill=(255, 255, 255))
        d.text((630, ty + 30), "manga", font=font(16), fill=(150, 146, 138))
        d.text((630, ty + 52), str(r["sleeve"]), font=font(34), fill=(255, 255, 255))
        ty += 120
    yy = ty + 30
    for line in wrap(d, s["care"], font(21), W - 96):
        d.text((48, yy), line, font=font(21), fill=(150, 146, 138))
        yy += 30

    # 07-08 收尾满幅
    y0 = 7560
    paste_cover(canvas, s["images"]["hero"], (0, y0, W, y0 + 2160))
    shade_bottom(canvas, (0, y0, W, y0 + 2160), 0.55, 240, 0.85)
    d.text((56, y0 + 1660), "Un mismo diseño,", font=font(66), fill=(255, 255, 255))
    d.text((56, y0 + 1736), "seis colores.", font=font(66), fill=(255, 255, 255))
    d.text((56, y0 + 1840), s["product"]["tagline"], font=font(26), fill=(214, 206, 194))


# --------------------------------------------------------------------- rail
def v_rail(canvas, d, s, t):
    bg, ink, accent, muted = t["bg"], t["ink"], t["accent"], t["muted"]
    canvas.paste(bg, (0, 0, W, H19))
    RX, CX0, CX1 = 128, 168, W - 56

    # 首屏：满幅 + 竖栏覆盖
    paste_cover(canvas, s["images"]["hero"], (0, 0, W, 2160))
    shade_bottom(canvas, (0, 0, W, 2160), 0.38, 245, 0.85)
    d.rectangle([0, 0, RX, 2160], fill=(14, 13, 12))
    d.text((34, 40), "00", font=font(42), fill=accent)
    rot_text(canvas, "INTRODUCCIÓN", (RX - 54, 130), (206, 198, 186), 20, 5)
    y = 1640
    d.text((CX0, y), s["product"]["kicker"].upper(), font=font(24), fill=(226, 208, 176))
    y += 44
    for line in wrap(d, s["product"]["title"], font(62), W - CX0 - 56):
        d.text((CX0, y), line, font=font(62), fill=(255, 255, 255))
        y += 72
    d.text((CX0, y + 8), s["product"]["tagline"], font=font(26), fill=(218, 210, 198))

    def rail(y0, num, label, dark=False):
        col = (255, 255, 255) if dark else ink
        d.line([(RX, y0), (RX, y0 + BAND)], fill=(90, 86, 78) if not dark else (70, 66, 60), width=1)
        d.text((30, y0 + 60), num, font=font(40), fill=accent)
        rot_text(canvas, label.upper(), (RX - 52, y0 + 140), col if not dark else (230, 226, 218), 18, 5)

    # 01 卖点：文左图右
    y0 = 2160
    rail(y0, "01", "Por qué")
    yy = y0 + 90
    for line in wrap(d, s["claim"]["title"], font(52), 360):
        d.text((CX0, yy), line, font=font(52), fill=ink)
        yy += 62
    d.line([(CX0, yy + 10), (CX0 + 180, yy + 10)], fill=accent, width=4)
    yy += 40
    for line in wrap(d, s["claim"]["body"], font(26), 350):
        d.text((CX0, yy), line, font=font(26), fill=muted)
        yy += 38
    paste_cover(canvas, s["claim"]["image"], (CX0 + 400, y0 + 60, CX1, y0 + 1000))

    # 02 正反
    y0 = 3240
    rail(y0, "02", "Vistas")
    cw = (CX1 - CX0 - 20) // 2
    paste_cover(canvas, s["images"]["front"], (CX0, y0 + 80, CX0 + cw, y0 + 860))
    paste_cover(canvas, s["images"]["back"], (CX0 + cw + 20, y0 + 80, CX1, y0 + 860))
    d.text((CX0, y0 + 880), "FRONTAL", font=font(18), fill=accent)
    d.text((CX0 + cw + 20, y0 + 880), "POSTERIOR", font=font(18), fill=accent)

    # 03 图案：通栏大图
    y0 = 4320
    rail(y0, "03", "Diseño")
    paste_fit(canvas, s["images"]["print"], (CX0, y0 + 60, CX1, y0 + 940))
    d.text((CX0, y0 + 960), "Ilustración original impresa al frente y en la espalda", font=font(22), fill=muted)

    # 04 面料
    y0 = 5400
    rail(y0, "04", "Tejido")
    paste_cover(canvas, s["images"]["fabric"], (CX0, y0 + 80, CX0 + 380, y0 + 700))
    d.text((CX0, y0 + 716), "MICRO TEJIDO", font=font(18), fill=accent)
    yy = y0 + 86
    for row in s["spec_rows"]:
        d.text((CX0 + 410, yy), row["label"].upper(), font=font(15), fill=accent)
        d.text((CX0 + 410, yy + 20), row["value"], font=font(24), fill=ink)
        yy += 68
        d.line([(CX0 + 410, yy - 12), (CX1, yy - 12)], fill=(214, 210, 202), width=1)

    # 05 工艺：三条横带
    y0 = 6480
    rail(y0, "05", "Acabados")
    for i, it in enumerate(s["details"][:3]):
        yy = y0 + 70 + i * 320
        paste_cover(canvas, it["image"], (CX0, yy, CX0 + 620, yy + 270))
        d.text((CX0 + 650, yy + 100), it["label"].upper(), font=font(24), fill=ink)
        d.text((CX0 + 650, yy + 136), "detalle", font=font(18), fill=muted)

    # 06 颜色
    y0 = 7560
    rail(y0, "06", "Colores")
    gw = (CX1 - CX0 - 30) // 3
    for i, c in enumerate(s["colors"][:6]):
        col, row = i % 3, i // 3
        x = CX0 + col * (gw + 15)
        yy = y0 + 70 + row * 440
        color_tile(canvas, c, (x, yy, x + gw, yy + 340), (255, 255, 255), (218, 214, 206))
        d.text((x, yy + 350), c["name"].upper(), font=font(18), fill=accent)

    # 07 尺码：条形图
    y0 = 8640
    rail(y0, "07", "Medidas")
    rows = s.get("size_table", [])
    d.text((CX0, y0 + 60), "Pecho (cm)", font=font(20), fill=accent)
    mx = max((r["chest"] for r in rows), default=1)
    for i, r in enumerate(rows):
        yy = y0 + 110 + i * 150
        d.text((CX0, yy), r["size"], font=font(40), fill=ink)
        wmax = 620
        w = int(wmax * r["chest"] / mx)
        d.rectangle([CX0 + 90, yy + 16, CX0 + 90 + w, yy + 58], fill=accent)
        d.text((CX0 + 100 + w, yy + 18), str(r["chest"]), font=font(28), fill=ink)
        d.text((CX0 + 90, yy + 66), f"largo {r['length']} · hombro {r['shoulder']} · manga {r['sleeve']}",
               font=font(18), fill=muted)
    yy = y0 + 760
    for line in wrap(d, s["care"], font(20), CX1 - CX0):
        d.text((CX0, yy), line, font=font(20), fill=muted)
        yy += 28


THEMES = {
    "editorial": {"bg": (247, 244, 238), "ink": (20, 20, 20),
                  "accent": (138, 107, 63), "muted": (111, 106, 97)},
    "oscuro": {"bg": (12, 12, 12), "ink": (245, 241, 232),
               "accent": (200, 162, 74), "muted": (150, 143, 128)},
    "bloque": {"bg": (255, 255, 255), "ink": (17, 17, 17),
               "accent": (180, 35, 31), "muted": (105, 100, 92)},
    "collage": {"bg": (242, 237, 227), "ink": (23, 23, 23),
                "accent": (138, 107, 63), "muted": (108, 100, 88)},
    "techpack": {"bg": (251, 251, 249), "ink": (17, 17, 17),
                 "accent": (176, 32, 40), "muted": (108, 108, 108)},
    "poster": {"bg": (14, 14, 14), "ink": (255, 255, 255),
               "accent": (208, 176, 118), "muted": (206, 200, 190)},
    "mosaic": {"bg": (246, 244, 240), "ink": (16, 16, 16),
               "accent": (150, 24, 32), "muted": (110, 105, 96)},
    "rail": {"bg": (250, 248, 243), "ink": (22, 20, 18),
             "accent": (168, 118, 56), "muted": (118, 110, 98)},
}
BUILDERS = {"editorial": v_editorial, "oscuro": v_oscuro,
            "bloque": v_bloque, "collage": v_collage,
            "techpack": v_techpack, "poster": v_poster,
            "mosaic": v_mosaic, "rail": v_rail}


def footer(canvas, d, s, t, dark=False):
    yy = 9600
    d.line([(80, yy), (W - 80, yy)], fill=(90, 86, 78) if dark else (0, 0, 0), width=2)
    d.text((80, yy + 24), s.get("footer", ""), font=font(24), fill=t["muted"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--variant", required=True, choices=sorted(BUILDERS))
    ap.add_argument("--out", required=True)
    ap.add_argument("--split-1x3", default=None, help="切 1080×3240 上传页的目录")
    a = ap.parse_args()

    s = json.load(open(a.spec, encoding="utf-8"))
    t = THEMES[a.variant]
    canvas = Image.new("RGB", (W, H19), t["bg"])
    d = ImageDraw.Draw(canvas)
    BUILDERS[a.variant](canvas, d, s, t)
    d = ImageDraw.Draw(canvas)
    footer(canvas, d, s, t, dark=t["bg"][0] < 60)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    canvas.save(a.out, "PNG")

    pages = []
    if a.split_1x3:
        os.makedirs(a.split_1x3, exist_ok=True)
        for i in range(3):
            p = os.path.join(a.split_1x3, f"P{i + 1:02d}-{a.variant}.png")
            canvas.crop((0, i * 3240, W, (i + 1) * 3240)).save(p, "PNG")
            pages.append(p)
    print(json.dumps({"out": a.out, "variant": a.variant, "size": list(canvas.size),
                      "split": pages}, ensure_ascii=False))


if __name__ == "__main__":
    main()
