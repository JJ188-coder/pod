#!/usr/bin/env python3
"""
extract-print.py — 从商品照片里把印花区域抠出来（重建件，不是原生生产图）。

用法：
  python3 tools/pod/extract-print.py --image <照片> --box x1,y1,x2,y2 \
    --out <输出.png> [--scale 4] [--print-cm 33x51.5]

输出：裁切并放大的 PNG + 同名 .json 质量报告（源像素、输出像素、目标尺寸下估算 DPI、
reconstructed=true）。它只能逼近原图，不能恢复照片里不存在的细节。
"""
import argparse
import json
import os

from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--box", required=True, help="x1,y1,x2,y2")
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=4)
    ap.add_argument("--print-cm", default="", help="目标印花尺寸，如 33x51.5")
    a = ap.parse_args()

    x1, y1, x2, y2 = [int(v) for v in a.box.split(",")]
    im = Image.open(a.image).convert("RGB")
    if not (0 <= x1 < x2 <= im.width and 0 <= y1 < y2 <= im.height):
        raise SystemExit(f"BOX_OUT_OF_RANGE image={im.size} box={a.box}")

    crop = im.crop((x1, y1, x2, y2))
    out_w = int(round(crop.width * a.scale))
    out_h = int(round(crop.height * a.scale))
    up = crop.resize((out_w, out_h), Image.LANCZOS)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    up.save(a.out)

    dpi = None
    if a.print_cm:
        w_cm, h_cm = [float(v) for v in a.print_cm.lower().split("x")]
        dpi = {
            "width_dpi": round(out_w / (w_cm / 2.54), 1),
            "height_dpi": round(out_h / (h_cm / 2.54), 1),
        }

    report = {
        "ok": True,
        "source": a.image,
        "box": [x1, y1, x2, y2],
        "source_px": [crop.width, crop.height],
        "output_px": [out_w, out_h],
        "scale": a.scale,
        "print_cm": a.print_cm or None,
        "estimated_dpi": dpi,
        "reconstructed": True,
        "note": "从照片重建：含布料纹理与光照，细节不保证；冻结/上架前必须人工对比原稿。",
    }
    with open(a.out + ".json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
