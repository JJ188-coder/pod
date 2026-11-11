#!/usr/bin/env python3
"""把已存在的银河效果图组装成平台上架图 + 生成批量上架规格。

只使用真实素材：银河效果渲染（可售_*.jpg）、衣款级共用尺码表。
效果图原生 522x696，低于平台主图 600 最低边，因此按 2x LANCZOS 放大后保存，
放大事实写入 spec 的 image_note，不冒充原生高分辨率、不做 AI 重绘。

用法：
  python3 tools/pod/listing/assemble-from-effects.py --batch <批次目录> --out <spec.json>
"""
import argparse, csv, glob, hashlib, json, os, re
from PIL import Image

SIZE_ORDER = ["XL", "L", "M", "S"]
COLORS = [("Black", "Negro"), ("White", "Blanco")]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def effect_files(d):
    return glob.glob(os.path.join(d, "可售_*.jpg")) + glob.glob(os.path.join(d, "prev_*.jpg"))


def pick(files):
    """返回 {(color,face,size): path}；兼容三套命名。

    A 可售_{Color}_{前片|后片}_..._{Size}.jpg
    B prev_{Color}_{Size}_{F|B}.jpg
    C 可售_{Color}_{F|B}[_{code}]_522x696.jpg  —— 文件名无尺码，按出现顺序套 XL,L,M,S
    """
    out, unlabeled = {}, []
    for f in files:
        n = os.path.basename(f)
        m = re.search(r"(Black|White)_(前片|后片)_.*?(S|M|L|XL)\.jpg$", n)
        if m:
            out[(m.group(1), m.group(2), m.group(3))] = f
            continue
        m2 = re.search(r"prev_(Black|White)_(S|M|L|XL)_([FB])\.jpg$", n)
        if m2:
            out[(m2.group(1), "前片" if m2.group(3) == "F" else "后片", m2.group(2))] = f
            continue
        m3 = re.search(r"可售_(Black|White)_([FB])(?:_([A-Za-z0-9]+))?_522x696\.jpg$", n)
        if m3:
            unlabeled.append((m3.group(1), "前片" if m3.group(2) == "F" else "后片", m3.group(3) or "", f))
    groups = {}
    for color, face, code, f in unlabeled:
        groups.setdefault((color, face), []).append((code, f))
    for (color, face), items in groups.items():
        for i, (code, f) in enumerate(sorted(items)):
            if i < len(SIZE_ORDER):
                out.setdefault((color, face, SIZE_ORDER[i]), f)
    return out


def upscale(src, dst, min_edge=600, factor=2):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    if min(w, h) < min_edge:
        im = im.resize((w * factor, h * factor), Image.LANCZOS)
    im.save(dst, "JPEG", quality=92, optimize=True)
    return im.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--exclude", default="", help="逗号分隔，已在售款号")
    a = ap.parse_args()

    batch = os.path.abspath(a.batch)
    ev = os.path.join(batch, "证据")
    stage_root = os.path.join(os.path.dirname(batch.rstrip("/")), "..", "..", "..", ".local", "pod-images-stage")
    stage_root = os.path.normpath(stage_root)

    # 衣款级共用尺码表
    sc_candidates = sorted(glob.glob(os.path.join(batch, "素材-20261031-耶稣300款/衣款级尺码表-20261031/*.png")))
    shared_sc = sc_candidates[0] if sc_candidates else None

    # 主题西语名
    themes = {}
    q = sorted(glob.glob(os.path.join(ev, "采集-20261031-耶稣主题来源/300款生产队列-全量绑定候选版-v21*.csv")))
    if q:
        for r in csv.DictReader(open(q[0], encoding="utf-8-sig")):
            if r.get("candidate") and r.get("theme_es"):
                themes[r["candidate"]] = r["theme_es"].strip()

    exclude = {x.strip() for x in a.exclude.split(",") if x.strip()}

    # 款号 -> 效果图目录
    style_dirs = {}
    for d in sorted(glob.glob(os.path.join(ev, "银河-20261030", "JC*-*"))):
        m = re.match(r"(JC\d+)-", os.path.basename(d))
        if not m:
            continue
        e = os.path.join(d, "效果图")
        if os.path.isdir(e) and effect_files(e):
            style_dirs.setdefault(m.group(1), e)

    products, skipped = [], []
    for style in sorted(style_dirs, key=lambda s: int(re.sub(r"\D", "", s) or 0)):
        if style in exclude:
            continue
        files = effect_files(style_dirs[style])
        # 按内容去重：同一张渲染图会被不同颜色复用，不能当多张商品图
        uniq, seen = [], set()
        for f in sorted(files):
            h = sha(open(f, "rb").read())
            if h in seen:
                continue
            seen.add(h)
            uniq.append(f)
        # 主图优先黑/白正面，其余按文件名兜底
        def rank(f):
            n = os.path.basename(f)
            c = 0 if "Black" in n else 1 if "White" in n else 2
            face = 0 if ("前片" in n or "_F" in n) else 1
            return (c, face, n)
        ordered = sorted(uniq, key=rank)
        mains = ordered[:9]
        if len(mains) < 4:
            skipped.append({"style": style, "reason": "insufficient_unique_effects", "unique": len(mains)})
            continue
        black = next((f for f in uniq if "Black" in os.path.basename(f)), uniq[0])
        white = next((f for f in uniq if "White" in os.path.basename(f)), uniq[min(1, len(uniq) - 1)])
        outdir = os.path.join(stage_root, style)
        os.makedirs(outdir, exist_ok=True)
        imgs = []
        for i, src in enumerate(mains, 1):
            dst = os.path.join(outdir, f"{style}-main-{i:02d}.jpg")
            upscale(src, dst)
            imgs.append({"file": dst})
        vars_ = []
        for label, src in (("Negro", black), ("Blanco", white)):
            dst = os.path.join(outdir, f"{style}-var-{label}.jpg")
            upscale(src, dst)
            vars_.append({"en": label, "es": label, "image": {"file": dst}})
        sc_dst = None
        if shared_sc:
            sc_dst = os.path.join(outdir, f"{style}-sizechart.png")
            im = Image.open(shared_sc)
            im.save(sc_dst)

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
        p = {
            "slug": style,
            "skuPrefix": f"MXTMC001-{style}",
            "title": title,
            "description": desc,
            "category": "男士上装/男士T恤",
            "images": imgs,
            "colors": vars_,
            "sizes": ["S", "M", "L", "XL"],
            "price": {"Negro": 123, "Blanco": 123},
            "quantity": 5,
            "parcel": {"weight": 200, "length": 15, "width": 15, "height": 15},
            "attributes": {"material": "Algodón,Poliéster", "pattern": "Estampado",
                           "neckline": "Cuello redondo", "sleeve": "Manga corta"},
            "image_note": "由银河效果渲染 522x696 以 2x LANCZOS 放大到 1044x1392；尺码表为衣款级共用件；无 AI 重绘",
        }
        if sc_dst:
            p["sizeChart"] = {"file": sc_dst}
        products.append(p)

    spec = {"products": products}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
    print(json.dumps({"out": a.out, "products": len(products), "skipped": len(skipped),
                      "shared_sizechart": shared_sc, "first_skipped": skipped[:5]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
