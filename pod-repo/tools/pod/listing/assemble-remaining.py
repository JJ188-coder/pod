#!/usr/bin/env python3
"""为尚未上架的款组装上架图：合并 商品图-R01、银河效果图、效果图路线 三类真实素材。

优先用原生 1254x1254 的 商品图-R01 主图/详情；不足时补银河效果渲染（522x696，
低于平台 600 最低边，按 2x LANCZOS 放大，事实写入 image_note）。不做 AI 重绘。
"""
import argparse, csv, glob, hashlib, json, os, re
from PIL import Image

def sha(b): return hashlib.sha256(b).hexdigest()

def upscale(src, dst, min_edge=600, factor=2):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    if min(w, h) < min_edge:
        im = im.resize((w * factor, h * factor), Image.LANCZOS)
    im.save(dst, "JPEG", quality=92, optimize=True)
    return im.size

def collect(batch, style):
    ev = os.path.join(batch, "证据")
    r01 = []
    for d in glob.glob(os.path.join(ev, f"银河-{style}-2026103*", "商品图-R01")):
        r01 += sorted(glob.glob(os.path.join(d, "主图", "*")))
        r01 += sorted(glob.glob(os.path.join(d, "详情", "*")))
        r01 += sorted(glob.glob(os.path.join(d, "SKU", "*")))
    eff = []
    for d in glob.glob(os.path.join(ev, "银河-20261030", f"{style}-*")):
        eff += sorted(glob.glob(os.path.join(d, "效果图", "*.jpg")))
    route = []
    for d in glob.glob(os.path.join(batch, "素材-20261031-耶稣300款", f"{style}-效果图路线*")):
        route += sorted(glob.glob(os.path.join(d, "主图", "*")))
        route += sorted(glob.glob(os.path.join(d, "详情-1x1", "*")))
    return r01, eff, route

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--styles", required=True, help="逗号分隔")
    a = ap.parse_args()
    batch = os.path.abspath(a.batch)
    ev = os.path.join(batch, "证据")
    root = os.path.abspath(os.path.join(os.path.dirname(batch), "..", "..", ".."))
    stage_root = os.path.join(root, ".local", "pod-images-stage")

    sc = sorted(glob.glob(os.path.join(batch, "素材-20261031-耶稣300款/衣款级尺码表-20261031/*.png")))
    shared_sc = sc[0] if sc else None

    themes = {}
    q = sorted(glob.glob(os.path.join(ev, "采集-20261031-耶稣主题来源/300款生产队列-全量绑定候选版-v21*.csv")))
    if q:
        for r in csv.DictReader(open(q[0], encoding="utf-8-sig")):
            if r.get("candidate") and r.get("theme_es"):
                themes[r["candidate"]] = r["theme_es"].strip()

    products = []
    for style in [s.strip() for s in a.styles.split(",") if s.strip()]:
        r01, eff, route = collect(batch, style)
        # 去重并按优先级排序：R01 主图 > R01 详情 > route 主图 > R01 SKU > 效果图
        ordered, seen = [], set()
        for f in r01[:0] + [x for x in r01 if "/主图/" in x] + [x for x in r01 if "/详情/" in x] + route + [x for x in r01 if "/SKU/" in x] + eff:
            if not os.path.isfile(f):
                continue
            h = sha(open(f, "rb").read())
            if h in seen:
                continue
            seen.add(h)
            ordered.append(f)
        if len(ordered) < 5:
            print("SKIP", style, len(ordered))
            continue
        outdir = os.path.join(stage_root, style)
        os.makedirs(outdir, exist_ok=True)
        imgs = []
        for i, src in enumerate(ordered[:9], 1):
            dst = os.path.join(outdir, f"{style}-main-{i:02d}.jpg")
            upscale(src, dst)
            imgs.append({"file": dst})
        # 变体图：优先 R01 SKU，其次效果图
        sku = [x for x in r01 if "/SKU/" in x]
        blacks = [x for x in sku if "egro" in x or "Black" in x] or [x for x in eff if "Black" in os.path.basename(x)]
        whites = [x for x in sku if "lanco" in x or "White" in x] or [x for x in eff if "White" in os.path.basename(x)]
        blacks = blacks or ordered[:1]
        whites = whites or ordered[:1]
        vars_ = []
        for label, srcs in (("Negro", blacks), ("Blanco", whites)):
            dst = os.path.join(outdir, f"{style}-var-{label}.jpg")
            upscale(srcs[0], dst)
            vars_.append({"en": label, "es": label, "image": {"file": dst}})
        sc_dst = None
        if shared_sc:
            sc_dst = os.path.join(outdir, f"{style}-sizechart.png")
            Image.open(shared_sc).save(sc_dst)
        theme = themes.get(style, "Jesús")
        title = (f"Playera para adulto {theme} | Venta por pieza, no es conjunto | 2 Colores | "
                 f"Estampado Frente y Espalda | CVC 180 g 50% Algodón 50% Poliéster | Tallas S a XL | {style}")
        desc = ("Playera para adulto con diseño original de Jesús. Venta por pieza.\n\n"
                "Estampado al frente y en la espalda.\n\n"
                "Composición según el proveedor: 50% algodón y 50% poliéster, tejido CVC. "
                "Cuello redondo y manga corta.\n\n"
                "Colores: negro y blanco. Tallas S, M, L y XL. Consulta la guía de tallas antes de elegir. "
                "Las medidas de la prenda están en centímetros; el contorno de pecho es la circunferencia completa.\n\n"
                "Incluye una playera. Las imágenes ilustran el diseño; los tonos pueden variar según la pantalla. "
                "No incluye accesorios.\n\nLava al revés y evita planchar directamente el estampado.")
        p = {"slug": style, "skuPrefix": f"MXTMC001-{style}", "title": title, "description": desc,
             "category": "男士上装/男士T恤", "images": imgs, "colors": vars_,
             "sizes": ["S", "M", "L", "XL"], "price": {"Negro": 123, "Blanco": 123}, "quantity": 5,
             "parcel": {"weight": 200, "length": 15, "width": 15, "height": 15},
             "attributes": {"material": "Algodón,Poliéster", "pattern": "Estampado",
                            "neckline": "Cuello redondo", "sleeve": "Manga corta"},
             "image_note": "商品图-R01 原生图优先；不足处用银河效果渲染 522x696 以 2x LANCZOS 放大；尺码表衣款级共用；无 AI 重绘"}
        if sc_dst:
            p["sizeChart"] = {"file": sc_dst}
        products.append(p)
    json.dump({"products": products}, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(json.dumps({"out": a.out, "products": len(products), "styles": [p["slug"] for p in products]}, ensure_ascii=False))

if __name__ == "__main__":
    main()
