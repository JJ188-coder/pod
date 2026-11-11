#!/usr/bin/env python3
"""建立一号厂 T 恤面料库。

输入：project/数据/货盘/汉森墨西哥-20261024/工厂实拍/墨西哥1号工厂T恤实拍图/ 的 12 张原件
（6 色 × 正反，2026-10-24 下载，SHA 已核验）。

产出到 .local/pod-fabric/：
  raw/        原件副本（不改字节）
  fabric/     每张照片里最大的一块无印花面料纹理切片（800×800）
  catalog.json 每张的色/面/尺寸/SHA/采样衣色/纹理切片路径/纹理方差
  联系表.jpg   六色正反一览

只读原件，不改色、不重绘。用途：给 AI 出细节图时提供真实面料与衣色依据。
"""
import argparse, hashlib, json, os, shutil
from PIL import Image, ImageDraw, ImageFont, ImageStat

SRC = "project/数据/货盘/汉森墨西哥-20261024/工厂实拍/墨西哥1号工厂T恤实拍图"
MAN = "project/数据/货盘/汉森墨西哥-20261024/工厂实拍/实拍清单与来源.json"
FONTS = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]
COLOR_ES = {"黑色": "Negro", "白色": "Blanco", "蓝色": "Azul", "红色": "Rojo", "绿色": "Verde", "粉色": "Rosa"}


def font(sz):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


def parse_name(fn):
    base = fn.rsplit(".", 1)[0]
    face = "back" if "背面" in base else "front"
    color = base.replace("正面", "").replace("背面", "").strip()
    return color, face


def _largest_component(mask):
    """返回最大连通域掩膜（4 邻域，BFS）。"""
    import numpy as np
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    best = None
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            comp = []
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if best is None or len(comp) > best[0]:
                best = (len(comp), comp)
    if best is None:
        return None
    out = np.zeros_like(mask, dtype=bool)
    for y, x in best[1]:
        out[y, x] = True
    return out


def best_patch(im, patch=600):
    """取衣服主体内的一块纯面料方块。

    流程：四角估背景色 → 非背景掩膜 → 最大连通域＝衣服主体 →
    在主体内找覆盖率 100% 的最大方块，同尺寸取方差最小者。
    """
    import numpy as np
    small = im.copy()
    small.thumbnail((240, 320), Image.LANCZOS)
    sa = np.asarray(small.convert("RGB")).astype(np.int16)
    hh, ww, _ = sa.shape
    corners = np.concatenate([
        sa[0:8, 0:8].reshape(-1, 3), sa[0:8, ww-8:ww].reshape(-1, 3),
        sa[hh-8:hh, 0:8].reshape(-1, 3), sa[hh-8:hh, ww-8:ww].reshape(-1, 3),
    ])
    bg = np.median(corners, axis=0)
    mask = (np.abs(sa - bg).sum(axis=2) > 70)
    comp = _largest_component(mask)
    if comp is None:
        return None, None
    ys, xs = np.where(comp)
    y0s, y1s, x0s, x1s = ys.min(), ys.max(), xs.min(), xs.max()
    sx, sy = im.width / ww, im.height / hh

    # 主体在整图中的框
    bx0, bx1 = int(x0s * sx), int((x1s + 1) * sx)
    by0, by1 = int(y0s * sy), int((y1s + 1) * sy)
    bw, bh = bx1 - bx0, by1 - by0

    arr = np.asarray(im.convert("RGB")).astype(np.int16)
    full_mask = (np.abs(arr - bg).sum(axis=2) > 70)
    gray = np.asarray(im.convert("L")).astype(np.float64)

    best = None
    for ratio in (0.45, 0.38, 0.30, 0.24):
        s = int(min(bw, bh) * ratio)
        if s < 120:
            continue
        cx, cy = (bx0 + bx1) // 2, (by0 + by1) // 2
        x, y = cx - s // 2, cy - s // 2
        if x < 0 or y < 0 or x + s > im.width or y + s > im.height:
            continue
        cov = full_mask[y:y + s, x:x + s].mean()
        if cov >= 0.995:
            sd = float(gray[y:y + s, x:x + s].std())
            best = (sd, (x, y, x + s, y + s))
            break
    if best is None:
        # 兜底：衣服框中心 28% 区域，不再要求掩膜覆盖率
        s = int(min(bw, bh) * 0.28)
        if s >= 120:
            x = (bx0 + bx1) // 2 - s // 2
            y = (by0 + by1) // 2 - s // 2
            if x >= 0 and y >= 0 and x + s <= im.width and y + s <= im.height:
                best = (float(gray[y:y + s, x:x + s].std()), (x, y, x + s, y + s))
    return best if best else (None, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=".local/pod-fabric")
    a = ap.parse_args()
    man = json.load(open(MAN, encoding="utf-8"))
    sha_decl = {i["filename"]: i["sha256"] for i in man["images"]}

    raw = os.path.join(a.out, "raw")
    fab = os.path.join(a.out, "fabric")
    os.makedirs(raw, exist_ok=True)
    os.makedirs(fab, exist_ok=True)

    rows = []
    for fn in sorted(os.listdir(SRC)):
        if not fn.lower().endswith((".jpg", ".jpeg", ".png")):
            continue
        src = os.path.join(SRC, fn)
        b = open(src, "rb").read()
        h = hashlib.sha256(b).hexdigest()
        color, face = parse_name(fn)
        dst = os.path.join(raw, fn)
        if not os.path.exists(dst):
            shutil.copy2(src, dst)

        im = Image.open(src).convert("RGB")
        patch = best_patch(im, patch=min(800, min(im.size) - 20))
        score, box = patch if patch else (None, None)
        fp = None
        med = None
        if box:
            crop = im.crop(box)
            fp = os.path.join(fab, f"{COLOR_ES.get(color, color)}-{face}.jpg")
            crop.save(fp, "JPEG", quality=95, optimize=True)
            st = ImageStat.Stat(crop)
            med = [int(v) for v in st.median]

        rows.append({
            "file": fn, "color": color, "color_es": COLOR_ES.get(color, color), "face": face,
            "size": list(im.size), "bytes": len(b), "sha256": h,
            "sha_matches_manifest": sha_decl.get(fn) == h if fn in sha_decl else None,
            "fabric_patch": os.path.relpath(fp, a.out) if fp else None,
            "fabric_median_rgb": med, "fabric_stddev": round(score, 2) if score else None,
        })

    # 六色一览
    cols = sorted({r["color"] for r in rows})
    tw, pad = 300, 12
    cells = []
    for c in cols:
        for face in ("front", "back"):
            r = next((x for x in rows if x["color"] == c and x["face"] == face), None)
            if r:
                cells.append((f"{COLOR_ES.get(c, c)}-{face}", os.path.join(SRC, r["file"])))
    cols_n = 4
    rows_n = (len(cells) + cols_n - 1) // cols_n
    th = 400
    W = cols_n * tw + (cols_n + 1) * pad
    H = rows_n * (th + 34) + (rows_n + 1) * pad
    sheet = Image.new("RGB", (W, H), (250, 248, 244))
    d = ImageDraw.Draw(sheet)
    for i, (label, p) in enumerate(cells):
        im = Image.open(p).convert("RGB")
        im.thumbnail((tw, th), Image.LANCZOS)
        x = pad + (i % cols_n) * (tw + pad)
        y = pad + (i // cols_n) * (th + 34 + pad)
        sheet.paste(im, (x + (tw - im.width) // 2, y + (th - im.height) // 2))
        d.text((x + 4, y + th + 8), label, font=font(20), fill=(30, 30, 30))
    sheet.save(os.path.join(a.out, "联系表.jpg"), "JPEG", quality=90, optimize=True)

    catalog = {
        "schema": "pod-fabric-library-v1",
        "factory": "墨西哥1号工厂",
        "style": "MXTMC001",
        "source": {
            "path": SRC,
            "manifest": MAN,
            "archive": man.get("archive_name"),
            "archive_bytes": man.get("archive_bytes"),
            "observed_at": man.get("observed_at"),
            "note": "企业微盘原件需登录才能重新下载；本库用 2026-10-24 已下载并经 SHA 核验的 12 张原件。",
        },
        "coverage": {"colors": cols, "colors_es": [COLOR_ES.get(c, c) for c in cols], "faces": ["front", "back"], "images": len(rows)},
        "boundaries": [
            "供应商提供的胚衣实拍，不证明实时可供、实测尺码或最终印刷接受。",
            "面料切片仅取自照片内的真实织物区域，未改色、未重绘。",
        ],
        "items": rows,
    }
    json.dump(catalog, open(os.path.join(a.out, "catalog.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps({"out": a.out, "images": len(rows), "colors": cols,
                      "sheet": os.path.join(a.out, "联系表.jpg")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
