#!/usr/bin/env python3
"""生成 1:3 详情图（1080×3240），支持三种版式。

平台详情图只接受 1:3，每张由三段 1080×1080 纵向拼接。

版式：
  hero    —— 标题 + 大图 + 说明（正反、图案、颜色、尺码）
  spec    —— 标题 + 左规格表 / 右面料特写 + 洗护要点
  details —— 标题 + 2×2 工艺细节图 + 说明

只使用本款已确认素材与事实，不生成新图。

用法：
  python3 tools/pod/listing/make-detail-1x3.py --spec <json> --out <dir>
"""
import argparse, json, os
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 3240
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            cur = trial
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
        left = (im.width - bw) // 2
        top = (im.height - bh) // 2
        im = im.crop((left, top, left + bw, top + bh))
        canvas.paste(im, (x0, y0))
    else:
        canvas.paste(im, (x0 + (bw - im.width) // 2, y0 + (bh - im.height) // 2))


def header(d, page, accent, ink, muted, title_size=92):
    y = 120
    d.text((80, y), page["kicker"].upper(), font=font(34), fill=accent)
    y += 66
    f_t = font(title_size)
    for line in wrap(d, page["title"], f_t, W - 160):
        d.text((80, y), line, font=f_t, fill=ink)
        y += title_size + 12
    y += 14
    f_s = font(38)
    for line in wrap(d, page.get("subtitle", ""), f_s, W - 160):
        d.text((80, y), line, font=f_s, fill=muted)
        y += 52
    d.line([(80, y + 26), (260, y + 26)], fill=accent, width=6)


def footer(d, spec, page, muted):
    d.line([(80, H - 120), (W - 80, H - 120)], fill=(0, 0, 0), width=2)
    txt = spec.get("footer", "")
    f = font(26)
    while d.textlength(txt, font=f) > W - 260 and len(txt) > 10:
        txt = txt[:-2]
    if txt != spec.get("footer", ""):
        txt = txt.rstrip(" ·-/") + "…"
    d.text((80, H - 96), txt, font=f, fill=muted)
    d.text((W - 80, H - 96), page.get("index", ""), font=f, fill=muted, anchor="ra")


def body_text(d, page, accent, ink, muted, y):
    d.text((80, y), page.get("block_title", ""), font=font(52), fill=ink)
    y += 86
    f_b = font(38)
    for line in wrap(d, page.get("body", ""), f_b, W - 160):
        d.text((80, y), line, font=f_b, fill=muted)
        y += 56
    if page.get("bullets"):
        y += 20
        for b in page["bullets"]:
            d.text((80, y), "—", font=f_b, fill=accent)
            for line in wrap(d, b, f_b, W - 240):
                d.text((130, y), line, font=f_b, fill=muted)
                y += 52
            y += 12


def page_hero(canvas, d, spec, page):
    theme = spec["theme"]
    accent, ink, muted = tuple(theme["accent"]), tuple(theme["ink"]), tuple(theme["muted"])
    header(d, page, accent, ink, muted)
    if page.get("hero"):
        paste_fit(canvas, page["hero"], (40, 560, W - 40, 2180))
    body_text(d, page, accent, ink, muted, 2240)
    footer(d, spec, page, muted)


def page_spec(canvas, d, spec, page):
    theme = spec["theme"]
    accent, ink, muted = tuple(theme["accent"]), tuple(theme["ink"]), tuple(theme["muted"])
    header(d, page, accent, ink, muted)

    # 段2：左规格表 / 右面料特写
    top, bottom = 560, 2180
    img_x0 = 620
    if page.get("fabric"):
        paste_fit(canvas, page["fabric"], (img_x0, top, W - 40, bottom), cover=True)

    y = top + 10
    f_label = font(28)
    f_value = font(40)
    for row in page.get("spec_rows", []):
        d.text((80, y), row["label"].upper(), font=f_label, fill=accent)
        y += 40
        for line in wrap(d, row["value"], f_value, img_x0 - 120):
            d.text((80, y), line, font=f_value, fill=ink)
            y += 50
        y += 26
        d.line([(80, y), (img_x0 - 80, y)], fill=(0, 0, 0, 40), width=1)
        y += 22

    body_text(d, page, accent, ink, muted, 2240)
    footer(d, spec, page, muted)


def page_details(canvas, d, spec, page):
    theme = spec["theme"]
    accent, ink, muted = tuple(theme["accent"]), tuple(theme["ink"]), tuple(theme["muted"])
    header(d, page, accent, ink, muted)

    items = page.get("items", [])[:4]
    if items:
        top = 540
        cell_w = (W - 160 - 24) // 2
        cell_h = 740
        for i, it in enumerate(items):
            col, row = i % 2, i // 2
            x = 80 + col * (cell_w + 24)
            y = top + row * (cell_h + 40)
            paste_fit(canvas, it["image"], (x, y, x + cell_w, y + cell_h), cover=True)
            d.text((x, y + cell_h + 8), it["label"].upper(), font=font(30), fill=accent)

    body_text(d, page, accent, ink, muted, 2260)
    footer(d, spec, page, muted)


BUILDERS = {"hero": page_hero, "spec": page_spec, "details": page_details}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding="utf-8"))
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for i, page in enumerate(spec["pages"], 1):
        canvas = Image.new("RGB", (W, H), tuple(spec["theme"]["bg"]))
        d = ImageDraw.Draw(canvas)
        p = {**page, "index": f"{i}/{len(spec['pages'])}"}
        BUILDERS[page.get("type", "hero")](canvas, d, spec, p)
        name = f"D{i:02d}-{page['slug']}.png"
        canvas.save(os.path.join(a.out, name), "PNG")
        rows.append({"file": name, "type": page.get("type", "hero"), "size": [W, H]})
    print(json.dumps({"out": a.out, "pages": rows}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
