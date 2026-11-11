#!/usr/bin/env python3
"""
remove-white-bg.py — 把纯白底图案抠成透明 PNG（通道图）。

用法：
  python3 tools/pod/remove-white-bg.py --image <白底图> --out <透明.png> [--thresh 28]

只对“背景接近纯白且与边缘连通”的图有效；被主体包围的白色高光会保留。
输出同名 .json 报告（尺寸、alpha 覆盖率、边缘是否触边、目标尺寸估算 DPI）。
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

MARK = (1, 254, 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--thresh", type=int, default=28)
    ap.add_argument("--print-cm", default="")
    a = ap.parse_args()

    im = Image.open(a.image).convert("RGB")
    w, h = im.size
    work = im.copy()
    pixels = work.load()

    # 从四边每隔 16px 取样，把所有与边缘连通的近白区域填成标记色。
    seeds = []
    for x in range(0, w, 16):
        seeds.append((x, 0)); seeds.append((x, h - 1))
    for y in range(0, h, 16):
        seeds.append((0, y)); seeds.append((w - 1, y))

    filled = 0
    for seed in seeds:
        r, g, b = pixels[seed]
        if (r, g, b) == MARK:
            continue
        if min(r, g, b) < 200:
            continue
        ImageDraw.floodfill(work, seed, MARK, thresh=a.thresh)
        filled += 1

    arr = np.asarray(work)
    bg = np.all(arr == np.array(MARK, dtype=np.uint8), axis=2)
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    alpha_im = Image.fromarray(alpha, mode="L")
    # 收 1px 去掉白边，再轻微羽化
    alpha_im = alpha_im.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.0))

    out = im.convert("RGBA")
    out.putalpha(alpha_im)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    out.save(a.out)

    a_arr = np.asarray(alpha_im)
    opaque = int((a_arr > 8).sum())
    bbox = Image.fromarray(a_arr, mode="L").getbbox()
    border = np.concatenate([a_arr[0, :], a_arr[-1, :], a_arr[:, 0], a_arr[:, -1]])
    dpi = None
    if a.print_cm:
        w_cm, h_cm = [float(v) for v in a.print_cm.lower().split("x")]
        dpi = {"width_dpi": round(w / (w_cm / 2.54), 1), "height_dpi": round(h / (h_cm / 2.54), 1)}

    report = {
        "ok": True,
        "source": a.image,
        "out": a.out,
        "width": w,
        "height": h,
        "flood_seeds_used": filled,
        "alpha_opaque_ratio": round(opaque / (w * h), 4),
        "alpha_bbox": list(bbox) if bbox else None,
        "touches_border": bool((border > 8).any()),
        "estimated_dpi": dpi,
        "note": "白底抠图：仅去掉与边缘连通的近白像素；主体内部白色保留。边缘白边已收 1px。",
    }
    with open(a.out + ".json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
