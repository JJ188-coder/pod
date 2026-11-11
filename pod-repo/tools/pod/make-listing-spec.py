#!/usr/bin/env python3
"""
make-listing-spec.py — 从已生成的营销图目录生成 TikTok Shop 批量表 spec。

前提：<pack>/营销图/upload/H01.jpg … H09.jpg 已存在且为 3:4；<pack>/尺码/tallas.png 存在。
用法：
  python3 tools/pod/make-listing-spec.py --pack <商品包目录> --code UKIYOE1 \
    --title "..." --description "..." [--color Blanco] [--sizes S,M,L,XL,2XL,3XL] \
    [--price 123] [--prefix MXTMC001-UKIYOE1]
"""
import argparse
import json
import os
import unicodedata


def slug(text):
    """去重音变 ASCII，避免图床 URL 里出现 %C3%B3 这类编码导致平台抓不到图。"""
    norm = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in norm if not unicodedata.combining(ch)).lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", required=True)
    ap.add_argument("--code", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--description", required=True)
    ap.add_argument("--color", default="Blanco")
    ap.add_argument("--colors-file", default="")
    ap.add_argument("--sizes", default="S,M,L,XL,2XL,3XL")
    ap.add_argument("--price", type=float, default=123)
    ap.add_argument("--prefix", default="")
    ap.add_argument("--sku-prefix", default="")
    ap.add_argument("--category", default="男士上装/男士T恤")
    ap.add_argument("--attributes", default='{"material":"Algodón,Poliéster","pattern":"Gráfico","neckline":"Cuello redondo","sleeve":"Normal","style":"Básico"}')
    ap.add_argument("--weight", type=float, default=200)
    ap.add_argument("--length", type=float, default=15)
    ap.add_argument("--width", type=float, default=15)
    ap.add_argument("--height", type=float, default=15)
    ap.add_argument("--quantity", type=int, default=5)
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    pack = os.path.abspath(a.pack)
    up = os.path.join(pack, "营销图/upload")
    images = []
    for i in range(1, 10):
        f = os.path.join(up, f"H{i:02d}.jpg")
        if not os.path.isfile(f):
            raise SystemExit(f"MISSING_IMAGE {f}")
        images.append({"file": f, "key": f"{a.code.lower()}/H{i:02d}.jpg"})

    color_img = os.path.abspath(os.path.join(up, "H01.jpg"))
    if a.colors_file:
        colors = json.load(open(a.colors_file, encoding="utf-8"))
        for c in colors:
            c["image"] = {"file": os.path.abspath(c["image"]), "key": f"{a.code.lower()}/variant/{slug(c['es'])}.jpg"}
    else:
        colors = [{
            "en": a.color, "es": a.color,
            "image": {"file": color_img, "key": f"{a.code.lower()}/variant/{slug(a.color)}.jpg"},
        }]
    size_chart = os.path.abspath(os.path.join(pack, "尺码/tallas.png"))
    if not os.path.isfile(size_chart):
        raise SystemExit(f"MISSING_SIZE_CHART {size_chart}")

    spec = {
        "products": [{
            "slug": a.code.lower(),
            "style": a.code,
            "title": a.title,
            "description": a.description,
            "category": a.category,
            "brand": "",
            "images": images,
            "colors": colors,
            "sizes": [s.strip() for s in a.sizes.split(",") if s.strip()],
            "price": {"default": a.price},
            "quantity": a.quantity,
            "skuPrefix": a.sku_prefix or a.prefix or f"MXTMC001-{a.code}",
            "parcel": {"weight": a.weight, "length": a.length, "width": a.width, "height": a.height},
            "sizeChart": {"file": size_chart, "key": f"{a.code.lower()}/sizechart/tallas.png"},
            "attributes": json.loads(a.attributes),
        }]
    }
    out = a.out or os.path.join(pack, "listing-spec.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
    print(json.dumps({"ok": True, "spec": out, "images": len(images), "sizes": spec["products"][0]["sizes"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
