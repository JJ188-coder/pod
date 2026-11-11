#!/usr/bin/env python3
"""生成 1:9 详情长图（1080×9720）。

九屏节奏（每屏 1080 高，首屏占两屏）：
  01 首屏      2160  模特主图 + 品名 + 定位
  02 卖点      1080  一句话核心卖点 + 佐证图
  03 正反      1080  正面 / 背面并列
  04 图案      1080  真实印花放大（深底）
  05 面料      1080  面料微距 + 规格表
  06 工艺      1080  领口 / 袖口 / 下摆 三联
  07 颜色      1080  六色陈列
  08 尺码      1080  尺码表 + 洗护要点

只使用本款已确认素材。用法：
  python3 tools/pod/listing/make-detail-1x9.py --spec <json> --out <png>
"""
import argparse, json, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, BAND = 1080, 1080
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


def paste_fit(canvas, path, box, cover=False):
    x0, y0, x1, y1 = box
    im = Image.open(path).convert("RGB")
    bw, bh = x1 - x0, y1 - y0
    s = max(bw / im.width, bh / im.height) if cover else min(bw / im.width, bh / im.height)
    im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    if cover:
        l, t = (im.width - bw) // 2, (im.height - bh) // 2
        canvas.paste(im.crop((l, t, l + bw, t + bh)), (x0, y0))
    else:
        canvas.paste(im, (x0 + (bw - im.width) // 2, y0 + (bh - im.height) // 2))


def head(d, y, kicker, title, sub, accent, ink, muted, size=84):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    s = json.load(open(a.spec, encoding="utf-8"))
    bg, ink, accent, muted = (tuple(s["theme"][k]) for k in ("bg", "ink", "accent", "muted"))
    canvas = Image.new("RGB", (W, 9720), bg)
    d = ImageDraw.Draw(canvas)

    # 01 首屏（2160）
    hero = s["images"]["hero"]
    paste_fit(canvas, hero, (0, 0, W, 2160), cover=True)
    # 底部压暗：从 42% 处开始，保证文字区对比度
    shade = Image.new("L", (1, 2160))
    for y in range(2160):
        t = max(0.0, (y - 900) / 1260)
        shade.putpixel((0, y), int(248 * t ** 0.85))
    shade = shade.resize((W, 2160))
    dark = Image.new("RGB", (W, 2160), (8, 8, 8))
    canvas.paste(Image.composite(dark, canvas.crop((0, 0, W, 2160)), shade), (0, 0))
    d = ImageDraw.Draw(canvas)
    y = 1620
    d.text((80, y), s["product"]["kicker"].upper(), font=font(32), fill=(224, 206, 176))
    y += 62
    f1 = font(78)
    for line in wrap(d, s["product"]["title"], f1, W - 160):
        d.text((80, y), line, font=f1, fill=(255, 255, 255))
        y += 88
    y += 18
    d.text((80, y), s["product"]["tagline"], font=font(34), fill=(226, 218, 206))

    # 02 卖点（先文字，再按实际高度放图）
    y0 = 2160
    y = head(d, y0 + 100, s["claim"]["kicker"], s["claim"]["title"], "", accent, ink, muted, 72)
    f = font(40)
    for line in wrap(d, s["claim"]["body"], f, W - 160):
        d.text((80, y), line, font=f, fill=muted)
        y += 54
    img_top = max(y + 40, y0 + 560)
    paste_fit(canvas, s["claim"]["image"], (80, img_top, W - 80, y0 + 1020), cover=True)

    # 03 正反
    y0 = 3240
    head(d, y0 + 90, "Vista del producto", "Frontal y posterior", "", accent, ink, muted, 76)
    cw = (W - 160 - 24) // 2
    paste_fit(canvas, s["images"]["front"], (80, y0 + 330, 80 + cw, y0 + 330 + 640), cover=True)
    paste_fit(canvas, s["images"]["back"], (80 + cw + 24, y0 + 330, W - 80, y0 + 330 + 640), cover=True)
    d.text((80, y0 + 990), "FRONTAL", font=font(26), fill=accent)
    d.text((80 + cw + 24, y0 + 990), "POSTERIOR", font=font(26), fill=accent)

    # 04 图案（深底）
    y0 = 4320
    d.rectangle([0, y0, W, y0 + BAND], fill=(12, 12, 12))
    head(d, y0 + 90, "Detalle", "El diseño de cerca", "", (200, 168, 110), (255, 255, 255), (200, 192, 180), 76)
    paste_fit(canvas, s["images"]["print"], (80, y0 + 250, W - 80, y0 + 1010))

    # 05 面料
    y0 = 5400
    head(d, y0 + 90, "La prenda", "Tejido y composición", "", accent, ink, muted, 76)
    paste_fit(canvas, s["images"]["fabric"], (80, y0 + 330, 560, y0 + 990), cover=True)
    yy = y0 + 340
    for row in s["spec_rows"]:
        d.text((620, yy), row["label"].upper(), font=font(24), fill=accent)
        yy += 34
        for line in wrap(d, row["value"], font(32), W - 700):
            d.text((620, yy), line, font=font(32), fill=ink)
            yy += 42
        yy += 22

    # 06 工艺三联
    y0 = 6480
    head(d, y0 + 90, "Acabados", "Detalles de confección", "", accent, ink, muted, 76)
    cw = (W - 160 - 48) // 3
    for i, it in enumerate(s["details"][:3]):
        x = 80 + i * (cw + 24)
        paste_fit(canvas, it["image"], (x, y0 + 330, x + cw, y0 + 890), cover=True)
        d.text((x, y0 + 908), it["label"].upper(), font=font(24), fill=accent)

    # 07 颜色
    y0 = 7560
    head(d, y0 + 90, "Opciones", "Colores disponibles", "Seis colores en el mismo diseño", accent, ink, muted, 76)
    cols = s["colors"]
    gw = (W - 160 - 48) // 3
    gh = 300
    for i, c in enumerate(cols[:6]):
        col, row = i % 3, i // 3
        x = 80 + col * (gw + 24)
        yy = y0 + 340 + row * (gh + 60)
        paste_fit(canvas, c["image"], (x, yy, x + gw, yy + gh), cover=True)
        d.text((x, yy + gh + 10), c["name"].upper(), font=font(24), fill=accent)

    # 08 尺码（本地大字排版，不用小图）
    y0 = 8640
    head(d, y0 + 80, "Medidas", "Guía de tallas", "Medidas en centímetros", accent, ink, muted, 76)
    rows = s.get("size_table", [])
    cols = [("Talla", 200), ("Hombro", 180), ("Pecho", 180), ("Largo", 180), ("Manga", 180)]
    x0, ty = 80, y0 + 330
    d.line([(x0, ty), (W - 80, ty)], fill=ink, width=3)
    cx = x0
    for name, cwid in cols:
        d.text((cx + 10, ty + 26), name.upper(), font=font(26), fill=accent)
        cx += cwid
    ty += 84
    d.line([(x0, ty), (W - 80, ty)], fill=(0, 0, 0), width=1)
    for i, r in enumerate(rows):
        if i % 2 == 0:
            d.rectangle([x0, ty, W - 80, ty + 104], fill=(238, 233, 224))
        vals = [r["size"], r["shoulder"], r["chest"], r["length"], r["sleeve"]]
        cx = x0
        for (name, cwid), val in zip(cols, vals):
            d.text((cx + 10, ty + 28), str(val), font=font(40 if name == "Talla" else 38), fill=ink)
            cx += cwid
        ty += 104
        d.line([(x0, ty), (W - 80, ty)], fill=(0, 0, 0), width=1)
    yy = ty + 36
    for line in wrap(d, s["care"], font(24), W - 160):
        d.text((80, yy), line, font=font(24), fill=muted)
        yy += 34

    # 页脚
    d.line([(80, 9600), (W - 80, 9600)], fill=(0, 0, 0), width=2)
    d.text((80, 9626), s.get("footer", ""), font=font(26), fill=muted)

    canvas.save(a.out, "PNG")
    print(json.dumps({"out": a.out, "size": list(canvas.size)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
