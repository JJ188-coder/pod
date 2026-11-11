#!/usr/bin/env python3
"""把队列中已绑定的真实图案合成到空白底衣模板上，生成上架图。

只做确定性合成：模板 = 本轮生成的黑/白空白底衣平铺图；图案 = 队列 CSV 绑定的
artwork_file（原生 PNG，含 alpha）。不重绘、不生成新图案。
另外输出“图案白底细节图”和衣款级共用尺码表。
"""
import argparse, csv, glob, hashlib, json, os, re
from PIL import Image

def sha(b): return hashlib.sha256(b).digest().hex()

def garment_bbox(im, thr=245):
    """找出非纯白区域，返回 (l,t,r,b)。"""
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    l, t, r, b = w, h, 0, 0
    step = 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if px[x, y] < thr:
                if x < l: l = x
                if x > r: r = x
                if y < t: t = y
                if y > b: b = y
    if r <= l or b <= t:
        return (int(w*0.12), int(h*0.08), int(w*0.88), int(h*0.92))
    return (l, t, r, b)

def compose(template_path, art_path, out_path, width_frac=0.62, top_frac=0.30):
    base = Image.open(template_path).convert("RGB")
    l, t, r, b = garment_bbox(base)
    gw, gh = r - l, b - t
    art = Image.open(art_path).convert("RGBA")
    aw, ah = art.size
    target_w = max(1, int(gw * width_frac))
    target_h = int(ah * target_w / aw)
    max_h = int(gh * 0.72)
    if target_h > max_h:
        target_h = max_h
        target_w = int(aw * target_h / ah)
    art = art.resize((target_w, target_h), Image.LANCZOS)
    x = l + (gw - target_w) // 2
    y = t + int(gh * top_frac)
    base.paste(art, (x, y), art)
    base.save(out_path, "JPEG", quality=92, optimize=True)
    return base.size

def art_on_white(art_path, out_path, size=1254):
    art = Image.open(art_path).convert("RGBA")
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    aw, ah = art.size
    scale = min(size * 0.82 / aw, size * 0.82 / ah)
    art = art.resize((max(1, int(aw * scale)), max(1, int(ah * scale))), Image.LANCZOS)
    canvas.paste(art, ((size - art.size[0]) // 2, (size - art.size[1]) // 2), art)
    canvas.save(out_path, "JPEG", quality=92, optimize=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    batch = os.path.abspath(a.batch)
    root = os.path.abspath(os.path.join(os.path.dirname(batch), "..", "..", ".."))
    stage_root = os.path.join(root, ".local", "pod-images-stage")
    tpl_black = os.path.join(root, ".local", "pod-templates", "blank-black.jpg")
    tpl_white = os.path.join(root, ".local", "pod-templates", "blank-white.jpg")
    for p in (tpl_black, tpl_white):
        if not os.path.isfile(p):
            raise SystemExit("TEMPLATE_MISSING " + p)

    sc = sorted(glob.glob(os.path.join(batch, "素材-20261031-耶稣300款/衣款级尺码表-20261031/*.png")))
    shared_sc = sc[0] if sc else None

    q = sorted(glob.glob(os.path.join(batch, "证据/采集-20261031-耶稣主题来源/300款生产队列-全量绑定候选版-v21*.csv")))[0]
    rows = list(csv.DictReader(open(q, encoding="utf-8-sig")))

    listed = set()
    for f in glob.glob(os.path.join(root, ".local", "pod-listing", "listed-*.txt")):
        listed |= {x.strip() for x in open(f).read().split(",") if x.strip()}

    products, skipped = [], []
    for r in rows:
        style = r["candidate"]
        if style in listed:
            continue
        art_rel = (r.get("artwork_file") or "").strip()
        if not art_rel:
            skipped.append({"style": style, "reason": "no_artwork"})
            continue
        art = os.path.join(batch, "素材-20261031-耶稣300款", art_rel)
        if not os.path.isfile(art):
            skipped.append({"style": style, "reason": "artwork_missing", "path": art_rel})
            continue
        outdir = os.path.join(stage_root, style)
        os.makedirs(outdir, exist_ok=True)
        main1 = os.path.join(outdir, f"{style}-main-01.jpg")
        main2 = os.path.join(outdir, f"{style}-main-02.jpg")
        det = os.path.join(outdir, f"{style}-main-03.jpg")
        compose(tpl_black, art, main1)
        compose(tpl_white, art, main2)
        art_on_white(art, det)
        imgs = [{"file": main1}, {"file": main2}, {"file": det}]
        # 图案特写：原图居中裁切后再白底排版，属真实素材裁切，不是新图
        zoom = os.path.join(outdir, f"{style}-main-06.jpg")
        art_img = Image.open(art).convert("RGBA")
        aw, ah = art_img.size
        box = (int(aw * 0.12), int(ah * 0.10), int(aw * 0.88), int(ah * 0.90))
        crop = art_img.crop(box)
        crop_path = os.path.join(outdir, f"{style}-zoom.png")
        crop.save(crop_path)
        art_on_white(crop_path, zoom)
        imgs.append({"file": zoom})
        back_rel = (r.get("artwork_file_back") or "").strip()
        if back_rel:
            back = os.path.join(batch, "素材-20261031-耶稣300款", back_rel)
            if os.path.isfile(back):
                b1 = os.path.join(outdir, f"{style}-main-04.jpg")
                compose(tpl_black, back, b1, top_frac=0.30)
                imgs.append({"file": b1})
                b2 = os.path.join(outdir, f"{style}-main-05.jpg")
                art_on_white(back, b2)
                imgs.append({"file": b2})
        vars_ = []
        for label, src in (("Negro", main1), ("Blanco", main2)):
            v = os.path.join(outdir, f"{style}-var-{label}.jpg")
            Image.open(src).save(v, "JPEG", quality=92, optimize=True)
            vars_.append({"en": label, "es": label, "image": {"file": v}})
        sc_dst = None
        if shared_sc:
            sc_dst = os.path.join(outdir, f"{style}-sizechart.png")
            Image.open(shared_sc).save(sc_dst)

        theme = (r.get("theme_es") or "Jesús").strip()
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
             "image_note": "空白底衣模板 + 队列绑定真实图案确定性合成；图案白底细节图为原图；尺码表衣款级共用"}
        if sc_dst:
            p["sizeChart"] = {"file": sc_dst}
        products.append(p)
        if a.limit and len(products) >= a.limit:
            break

    json.dump({"products": products}, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(json.dumps({"out": a.out, "products": len(products), "skipped": len(skipped),
                      "first": [p["slug"] for p in products[:10]], "skip_sample": skipped[:5]}, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
