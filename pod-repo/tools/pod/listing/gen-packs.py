#!/usr/bin/env python3
"""按爆款比例批量出「可导入包」：9 张主图 + 规格 JSON。

输入：--styles JC002,JC046,...  以及 .local/refit-20261102/可用款-前后片.json
输出：<out>/<style>/H01..H09.jpg + spec-<style>.json

规则（来自 top01 实测，见 复刻记录-爆款比例-20261102.json）：
  正面胸标宽 = 衣身宽 13%    背面大图宽 = 衣身宽 70%
底图与面板标定见 .local/refit-20261102/bases.json
"""
import argparse, glob, json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
REF = os.path.join(ROOT, ".local", "refit-20261102")
COMPOSE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "compose-refit.py")
FABRIC = os.path.join(ROOT, ".local", "pod-fabric", "fabric", "Negro-front.jpg")
SIZE_CHART = os.path.join(ROOT, "project", "T恤", "批次", "B20261027-MX-BOT-DEV-01",
                          "营销图", "JC101-R01-20261102", "尺码图.png")
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def f(sz):
    return ImageFont.truetype(FONT, sz)


def compose(base, art_f, art_b, out, bases):
    b = bases[os.path.basename(base)]
    fx0, fy0, fx1, fy1 = b["front"]
    bx0, by0, bx1, by1 = b["back"]
    fw, fh = fx1 - fx0, fy1 - fy0
    bw, bh = bx1 - bx0, by1 - by0
    bwid = fw * 0.13
    bhei = bwid / 0.643
    cx = fx0 + fw * 0.72
    front = (cx - bwid / 2, fy0 + fh * 0.06, cx + bwid / 2, fy0 + fh * 0.06 + bhei)
    wb = bw * 0.70
    sx = bx0 + (bw - wb) / 2 + bw * b.get("shift", 0)
    back = (sx, by0 + bh * 0.08, sx + wb, by1 - bh * 0.06)
    fmt = lambda t: ",".join(f"{v:.2f}" for v in t)
    r = subprocess.run([sys.executable, COMPOSE, "--base", base,
                        "--front", art_f, "--front-box", fmt(front),
                        "--back", art_b, "--back-box", fmt(back),
                        "--back-fit", "width", "--out", out],
                       capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-300:])


def square(src, out, size=1080):
    im = Image.open(src).convert("RGB")
    s = max(size / im.width, size / im.height)
    im = im.resize((int(im.width * s) + 1, int(im.height * s) + 1), Image.LANCZOS)
    l, t = (im.width - size) // 2, (im.height - size) // 2
    im.crop((l, t, l + size, t + size)).save(out, "JPEG", quality=92)


def crop_zoom(src, out, box_pct, size=(1086, 1448)):
    im = Image.open(src).convert("RGB")
    W, H = im.size
    x0, y0, x1, y1 = [v / 100 for v in box_pct]
    im.crop((int(W * x0), int(H * y0), int(W * x1), int(H * y1))).resize(size, Image.LANCZOS) \
        .save(out, "JPEG", quality=92)


def print_tile(art_b, out, size=1080):
    """图案微距：深底方图。"""
    c = Image.new("RGB", (size, size), (10, 10, 10))
    im = Image.open(art_b).convert("RGBA")
    # 按亮度重建透明度，避免黑底方块
    rgb = im.convert("RGB")
    alpha = im.getchannel("A")
    lum = rgb.convert("L").point(lambda v: max(0, min(255, int((v - 14) * 255 / 241 * 1.7))))
    from PIL import ImageChops
    alpha = ImageChops.multiply(alpha, lum).filter(ImageFilter.GaussianBlur(2))
    s = min(int(size * 0.86) / im.width, int(size * 0.86) / im.height)
    im2 = rgb.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    a2 = alpha.resize(im2.size, Image.LANCZOS)
    c.paste(im2, ((size - im2.width) // 2, (size - im2.height) // 2), a2)
    c.save(out, "JPEG", quality=93)


def build(style, arts, outdir, bases, title):
    os.makedirs(outdir, exist_ok=True)
    base1 = os.path.join(REF, "base-blank-duo.png")
    base2 = os.path.join(REF, "base-2.png")
    base3 = os.path.join(REF, "base-3.png")
    p = lambda n: os.path.join(outdir, n)
    F, B = arts["F"], arts["B"]

    compose(base1, F, B, p("H01-duo-negro.jpg"), bases)
    compose(base2, F, B, p("H02-duo-plaza.jpg"), bases)
    compose(base3, F, B, p("H03-duo-callejon.jpg"), bases)
    crop_zoom(p("H01-duo-negro.jpg"), p("H04-espalda.jpg"), (58, 20, 100, 84))
    crop_zoom(p("H01-duo-negro.jpg"), p("H05-pecho.jpg"), (24, 18, 60, 60))
    print_tile(B, p("H06-estampado.jpg"))
    square(FABRIC, p("H07-tejido.jpg"))
    square(SIZE_CHART, p("H08-tallas.jpg"))
    crop_zoom(p("H02-duo-plaza.jpg"), p("H09-otra-vista.jpg"), (0, 0, 100, 100))

    spec = {
        "slug": style.lower(),
        "style": style,
        "title": title,
        "images": [f"H0{i}-" for i in range(1, 10)],
        "rules": {"front_width_pct_of_shirt": 13, "back_width_pct_of_shirt": 70,
                  "source": "top01 实测"},
    }
    json.dump(spec, open(os.path.join(outdir, "spec-preview.json"), "w"), ensure_ascii=False, indent=1)
    return [p(f"H0{i}-{n}.jpg") for i, n in enumerate(
        ["duo-negro", "duo-plaza", "duo-callejon", "espalda", "pecho",
         "estampado", "tejido", "tallas", "otra-vista"], 1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--styles", required=True, help="逗号分隔款号")
    ap.add_argument("--out", default=os.path.join(REF, "packs"))
    ap.add_argument("--title-prefix", default="Playera con estampado frontal y trasero, cuello redondo, CVC 180 g")
    a = ap.parse_args()

    arts_all = json.load(open(os.path.join(REF, "可用款-前后片.json"), encoding="utf-8"))
    bases = json.load(open(os.path.join(REF, "bases.json"), encoding="utf-8"))
    out = {}
    for st in [s.strip() for s in a.styles.split(",") if s.strip()]:
        if st not in arts_all:
            print("SKIP 无前后片:", st); continue
        arts = arts_all[st]
        d = os.path.join(a.out, st)
        files = build(st, arts, d, bases, f"{a.title_prefix} · {st}")
        out[st] = {"dir": d, "images": files, "art_F": arts["F"], "art_B": arts["B"]}
        print(st, "9 图 ok ->", d)
    json.dump(out, open(os.path.join(a.out, "packs.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
