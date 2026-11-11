#!/usr/bin/env python3
"""按款清点可上架素材，输出真实达标数。

对每个银河款目（证据/银河-<date>/<style>-<design>-<date>/）统计：
  artwork      生产图/ 里按尺码的前后片 PNG
  effects      效果图/ 里的颜色与视图（可售_X_F|B_*.jpg 或 prev_X_<Size>_<F|B>.jpg）
  main9        能否凑出 9 张主图槽（去重后）
  sku6         六个颜色的 SKU 母图是否齐全（一号厂六色）
  ready6       6 色 × 4 码 = 24 SKU 可建 → 符合现行标准
  ready2       仅黑白两色 → 只能上 8 SKU

用法：
  python3 tools/pod/listing/inventory-readiness.py --effects-root <dir> [--out <json>]
"""
import argparse, glob, json, os, re, collections

SIX = ["Black", "White", "Blue", "Red", "Green", "Pink"]


def color_of(path):
    b = os.path.basename(path)
    m = re.match(r"可售_([A-Za-zÁ-ú]+)_[FB]_", b)
    if m:
        return m.group(1), True
    m = re.match(r"prev_([A-Za-zÁ-ú]+)_(S|M|L|XL|2XL|3XL)_([FB])", b)
    if m:
        return m.group(1), True
    return None, False


def scan_style(d):
    eff_dir = os.path.join(d, "效果图")
    art_dir = os.path.join(d, "生产图")
    arts = sorted(glob.glob(os.path.join(art_dir, "*.png"))) if os.path.isdir(art_dir) else []
    arts = [a for a in arts if "裁边" not in a]

    colors = collections.defaultdict(lambda: {"F": set(), "B": set()})
    files = sorted(os.listdir(eff_dir)) if os.path.isdir(eff_dir) else []
    for fn in files:
        if not fn.lower().endswith((".jpg", ".png")):
            continue
        c, ok = color_of(fn)
        if not ok:
            continue
        face = "B" if re.search(r"[_b]B_|_B\.", fn) else "F"
        colors[c][face].add(fn)

    have = sorted(colors)
    six_ok = all(c in colors for c in SIX) and all(colors[c]["F"] for c in SIX)
    return {
        "style": os.path.basename(d).split("-")[0],
        "dir": os.path.basename(d),
        "artwork_png": len(arts),
        "colors": have,
        "color_count": len(have),
        "six_color": six_ok,
        "front_back": sorted({f for c in colors.values() for f in (c["F"] | c["B"])})[:3],
        "can_six_sku": six_ok,
        "can_two_sku": {"Black", "White"} <= set(have),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--effects-root", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    rows = []
    for d in sorted(glob.glob(os.path.join(a.effects_root, "*"))):
        if not os.path.isdir(d):
            continue
        if not os.path.isdir(os.path.join(d, "效果图")) and not os.path.isdir(os.path.join(d, "生产图")):
            continue
        rows.append(scan_style(d))

    by_style = {}
    for r in rows:
        by_style.setdefault(r["style"], []).append(r)
    merged = []
    for st, lst in sorted(by_style.items()):
        best = max(lst, key=lambda r: (r["six_color"], r["color_count"], r["artwork_png"]))
        best["dupes"] = len(lst)
        merged.append(best)

    summary = {
        "styles": len(merged),
        "six_color_ready": sum(1 for r in merged if r["six_color"]),
        "two_color_ready": sum(1 for r in merged if not r["six_color"] and r["can_two_sku"]),
        "no_effects": sum(1 for r in merged if r["color_count"] == 0),
        "with_artwork": sum(1 for r in merged if r["artwork_png"] > 0),
        "color_count_dist": dict(sorted(collections.Counter(r["color_count"] for r in merged).items())),
    }
    out = {"schema": "pod-readiness-v1", "root": a.effects_root, "summary": summary, "styles": merged}
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
        json.dump(out, open(a.out, "w"), ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return out


if __name__ == "__main__":
    main()
