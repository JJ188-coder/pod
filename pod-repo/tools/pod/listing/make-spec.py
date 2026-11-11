#!/usr/bin/env python3
"""把 packs（9 图）拼成 publish.mjs 的 spec（单色 4 码）。

默认：Negro × S/M/L/XL = 4 SKU，价 123 MXN，每 SKU 5 件，包裹 200g 15³。
颜色母图用该款 H01（黑人身上身），尺码表共用。

用法：
  python3 tools/pod/listing/make-spec.py --packs .local/refit-20261102/packs \
      --styles JC002,JC046,JC049 --out /tmp/spec.json
"""
import argparse, json, os

IMAGES = ["H01-duo-negro.jpg", "H02-duo-plaza.jpg", "H03-duo-callejon.jpg",
          "H04-espalda.jpg", "H05-pecho.jpg", "H06-estampado.jpg",
          "H07-tejido.jpg", "H08-tallas.jpg", "H09-otra-vista.jpg"]
SIZE_CHART = os.path.abspath("project/T恤/批次/B20261027-MX-BOT-DEV-01/营销图/JC101-R01-20261102/尺码图.png")
THEMES = {
    "default": "con estampado frontal y trasero",
}


def title_of(style):
    # 标题必须逐款唯一：完全相同会被平台合并成一个商品（实测 3 款并成 1 款 12 SKU）
    return (f"Playera {THEMES['default']} Hombre y Mujer, Cuello Redondo, "
            f"CVC 180 g, Unisex, Tallas S-XL, Modelo {style}")


def desc_of(style):
    return (
        "Playera unisex de cuello redondo con estampado al frente y en la espalda. "
        "Impresión directa sobre la tela, sin bordado ni pedrería.\n\n"
        "Tela punto jersey CVC de 180 g, 50% algodón y 50% poliéster: suave, fresca y con buena caída. "
        "Cuello redondo con cinta de refuerzo, manga corta con doble aguja y bajo recto.\n\n"
        "Tallas S, M, L y XL. Corte unisex recto; revisa la guía de tallas en las imágenes.\n\n"
        "Cuidado: lava del revés en agua fría, no usar blanqueador, secar a la sombra y no planchar sobre el estampado."
    )


def build(packs_dir, styles, prefix):
    products = []
    missing = []
    for st in styles:
        d = os.path.join(packs_dir, st)
        files = [os.path.join(d, n) for n in IMAGES]
        lack = [f for f in files if not os.path.exists(f)]
        if lack:
            missing.append((st, [os.path.basename(x) for x in lack]))
            continue
        slug = st.lower()
        products.append({
            "slug": slug,
            "style": st,
            "title": title_of(st),
            "description": desc_of(st),
            "category": "男士上装/男士T恤",
            "brand": "",
            "images": [{"file": f, "key": f"{prefix}/{slug}/{os.path.basename(f)}"} for f in files],
            "colors": [{"en": "Negro", "es": "Negro",
                        "image": {"file": files[0], "key": f"{prefix}/{slug}/variant/negro.jpg"}}],
            "sizes": ["S", "M", "L", "XL"],
            "price": {"default": 123},
            "quantity": 5,
            "skuPrefix": f"MXTMC001-{st}",
            "parcel": {"weight": 200, "length": 15, "width": 15, "height": 15},
            "sizeChart": {"file": SIZE_CHART, "key": f"{prefix}/{slug}/sizechart/tallas.png"},
            "attributes": {"material": "Algodón,Poliéster", "pattern": "Gráfico",
                           "neckline": "Cuello redondo", "sleeve": "Normal", "style": "Básico"},
        })
    return {"products": products}, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--packs", default=".local/refit-20261102/packs")
    ap.add_argument("--styles", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--prefix", default="lote")
    ap.add_argument("--base-url", default="", help="给出则直接写公网 URL（配合 --host static）")
    a = ap.parse_args()
    styles = [s.strip() for s in a.styles.split(",") if s.strip()]
    spec, missing = build(a.packs, styles, a.prefix)
    if a.base_url:
        B = a.base_url.rstrip("/")
        for p in spec["products"]:
            p["images"] = [f"{B}/{x['key']}" for x in p["images"]]
            p["colors"] = [{**c, "image": f"{B}/{c['image']['key']}"} for c in p["colors"]]
            p["sizeChart"] = f"{B}/{p['sizeChart']['key']}"
    json.dump(spec, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(json.dumps({"out": a.out, "products": len(spec["products"]),
                      "sku_per_product": 4, "missing": missing[:5]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
