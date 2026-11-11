#!/usr/bin/env python3
"""按官方 TikTok Shop MX 模板生成批量发品表格（图片列填公网 URL 直链）。

实测规则（改了会被平台拒，不要动）：
- 属性列（材质/图案/领型…）必须填西语值；中文值预检报「不支持使用汉字」。
- Template 表第 6 行起是数据区；第 1/3/4/5 行（英文键/中文标签/必填标记/说明）必须原样保留。
- 每个 SKU 一行；同一商品的公共字段（标题/描述/包裹/属性）必须逐行完全一致。
- 图片列只接受 HTTPS 直链；平台在导入前会真的抓图，抓不到会在在线编辑器里报
  「无法处理该图片 URL」，所以调用前必须逐张验过。

用法：
  build-workbook.py --spec products.json --template t.xlsx --out out.xlsx
products.json 两种形状都接受：
  {"products": [ {...}, {...} ]}   一个文件多款（批量表的正常用法）
  {...}                            单款（等价于 products 里只有一项）
"""
import argparse, hashlib, json, sys
import openpyxl

REQUIRED = ["title", "description", "category", "images", "colors", "sizes", "price", "quantity", "skuPrefix"]
MAX_COLS = 43
FIRST_DATA_ROW = 6


def clear_data(ws):
    for r in range(FIRST_DATA_ROW, ws.max_row + 1):
        for c in range(1, MAX_COLS + 1):
            try:
                ws.cell(r, c).value = None
            except AttributeError:
                pass


def write_product(ws, p, row_start, defaults):
    for k in REQUIRED:
        if k not in p:
            raise SystemExit(f"MISSING_SPEC_FIELD {k}")
    if not p["images"]:
        raise SystemExit("NO_IMAGES")
    if len(p["images"]) > 9:
        raise SystemExit("TOO_MANY_PRODUCT_IMAGES (max 9)")

    merged = {**defaults, **p}
    price_map = merged["price"] if isinstance(merged["price"], dict) else {"default": merged["price"]}
    qty = int(merged["quantity"])
    attrs = merged.get("attributes", {})
    parcel = merged.get("parcel", {"weight": 200, "length": 15, "width": 15, "height": 15})
    row, written = row_start, []

    for color in merged["colors"]:
        price = price_map.get(color["en"], price_map.get("default"))
        if price is None:
            raise SystemExit(f"NO_PRICE_FOR_COLOR {color['en']}")
        for size in merged["sizes"]:
            v = {
                1: merged["category"],
                2: merged.get("brand", ""),        # 留空 = 无品牌
                3: merged["title"],
                4: merged["description"],
            }
            for i, url in enumerate(merged["images"]):
                if not isinstance(url, str) or not url.startswith("https://"):
                    raise SystemExit(f"IMAGE_URL_NOT_HTTPS col={5+i} value={url!r} (先用 --host 托管再建表)")
                v[5 + i] = url
            v[16] = merged.get("variant1Name", "Color")
            v[17] = color["es"]
            if color.get("image"):
                v[18] = color["image"]
            v[19] = merged.get("variant2Name", "Talla")
            v[20] = size
            v[21] = parcel["weight"]
            v[22] = parcel["length"]
            v[23] = parcel["width"]
            v[24] = parcel["height"]
            v[26] = price
            v[27] = qty
            v[28] = f"{merged['skuPrefix']}-{color['en'].upper()}-{size}"
            if merged.get("sizeChart"):
                v[32] = merged["sizeChart"]
            v[33] = attrs.get("material", "Algodón,Poliéster")
            for col, key in ((34, "pattern"), (35, "neckline"), (36, "sleeve"), (37, "season"),
                             (38, "style"), (39, "fit"), (40, "elasticity"), (41, "wash")):
                if key in attrs:
                    v[col] = attrs[key]
            for c, val in v.items():
                try:
                    ws.cell(row, c).value = val
                except AttributeError:
                    raise SystemExit(f"MERGED_CELL col={c} row={row}")
            written.append({"row": row, "product": merged["skuPrefix"], "color": color["en"], "size": size, "price": price, "sku": v[28]})
            row += 1
    return row, written


def build(spec, template, out):
    products = spec.get("products") or [spec]
    if not isinstance(products, list) or not products:
        raise SystemExit("NO_PRODUCTS")
    defaults = spec.get("defaults", {})

    wb = openpyxl.load_workbook(template)
    ws = wb["Template"]
    clear_data(ws)

    row, written = FIRST_DATA_ROW, []
    for p in products:
        row, w = write_product(ws, p, row, defaults)
        written.extend(w)

    wb.save(out)
    data = open(out, "rb").read()
    return {
        "out": out,
        "products": len(products),
        "rows": len(written),
        "skuCount": len(written),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "prices": sorted({w["price"] for w in written}),
        "skus": [w["sku"] for w in written],
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding="utf-8"))
    print(json.dumps(build(spec, a.template, a.out), ensure_ascii=False, indent=1))
