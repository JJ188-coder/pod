#!/usr/bin/env python3
"""按比例把图案确定性合成到净版衣服上（印位可量、可复现）。

不用生成模型猜比例：给出目标框（占画幅百分比），这里按框缩放贴图，
再用衣面亮度做乘法着色，让印花跟着布纹明暗走，避免"贴纸感"。

用法：
  python3 tools/pod/listing/compose-refit.py --base b.png --front f.png \
      --front-box 34,30,39.2,42.2 --back bk.png --back-box 63,30.4,90,73.6 \
      --out o.jpg

框格式 x0,y0,x1,y1，单位是画幅百分比。
"""
import argparse, json
from PIL import Image, ImageChops, ImageFilter


def pct_box(box, W, H):
    x0, y0, x1, y1 = [float(v) for v in box.split(",")]
    return (int(W * x0 / 100), int(H * y0 / 100), int(W * x1 / 100), int(H * y1 / 100))


def paste_art(base, art_path, box, shade=0.55, feather=3, dark_bg=True, fit="min"):
    """把 art 按 box 缩放贴到 base 上，返回新图。

    dark_bg=True 时按亮度重建透明度：银河生产图的深色底常常是不透明的，
    直接 alpha 贴会在黑衣服上留一块深色方块（实测踩过），必须按亮度抠掉。
    """
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    art = Image.open(art_path).convert("RGBA")
    if fit == "width":
        s = bw / art.width
    elif fit == "height":
        s = bh / art.height
    else:
        s = min(bw / art.width, bh / art.height)
    art = art.resize((max(1, int(art.width * s)), max(1, int(art.height * s))), Image.LANCZOS)
    ax = x0 + (bw - art.width) // 2
    ay = y0 + (bh - art.height) // 2

    # 衣面亮度 → 乘法着色
    region = base.crop((ax, ay, ax + art.width, ay + art.height)).convert("L")
    hist = region.histogram()
    acc = 0
    med = 1
    half = sum(hist) // 2
    for i, n in enumerate(hist):
        acc += n
        if acc >= half:
            med = max(i, 1)
            break
    ratio = region.point(lambda v: min(255, int(255 * (min(2.2, max(0.35, v / med))) ** shade)))
    mult = Image.merge("RGB", (ratio, ratio, ratio))

    rgb = art.convert("RGB")
    shaded = Image.blend(rgb, ImageChops.multiply(rgb, mult), 0.55)
    alpha = art.getchannel("A")
    if dark_bg:
        lum = rgb.convert("L")
        floor = 14
        lift = lum.point(lambda v: max(0, min(255, int((v - floor) * 255 / (255 - floor) * 1.7))))
        alpha = ImageChops.multiply(alpha, lift)
    if feather:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    layer = shaded.convert("RGBA")
    layer.putalpha(alpha)
    out = base.convert("RGBA")
    out.alpha_composite(layer, (ax, ay))
    return out.convert("RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--front", default=None)
    ap.add_argument("--front-box", default=None)
    ap.add_argument("--back", default=None)
    ap.add_argument("--back-box", default=None)
    ap.add_argument("--shade", type=float, default=0.55)
    ap.add_argument("--front-fit", default="min", choices=["min", "width", "height"])
    ap.add_argument("--back-fit", default="width", choices=["min", "width", "height"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    base = Image.open(a.base).convert("RGB")
    W, H = base.size
    steps = []
    if a.front and a.front_box:
        b = pct_box(a.front_box, W, H)
        base = paste_art(base, a.front, b, a.shade, fit=a.front_fit)
        steps.append({"layer": "front", "box_px": b, "box_pct": a.front_box,
                      "w_pct_of_frame": round((b[2] - b[0]) / W * 100, 2),
                      "h_pct_of_frame": round((b[3] - b[1]) / H * 100, 2)})
    if a.back and a.back_box:
        b = pct_box(a.back_box, W, H)
        base = paste_art(base, a.back, b, a.shade, fit=a.back_fit)
        steps.append({"layer": "back", "box_px": b, "box_pct": a.back_box,
                      "w_pct_of_frame": round((b[2] - b[0]) / W * 100, 2),
                      "h_pct_of_frame": round((b[3] - b[1]) / H * 100, 2)})
    base.save(a.out, "JPEG", quality=95, optimize=True)
    print(json.dumps({"out": a.out, "size": list(base.size), "layers": steps,
                      "base": a.base}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
