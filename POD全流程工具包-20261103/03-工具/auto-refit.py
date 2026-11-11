#!/usr/bin/env python3
"""自动识别净版照里的两件黑衣，按爆款比例贴图（可复现、可量）。

流程：
  1) 亮度阈值找近黑像素 → 膨胀 → 连通域，取面积最大的两块为两件衣服
  2) 取 bbox，内缩得到「衣身面板」（去掉袖子/边缘）
  3) 按比例算印位：正面小胸标宽 = 面板宽 × 13%；背面图宽 = 面板宽 × 70%
  4) 调 compose-refit 贴图

用法：
  python3 tools/pod/listing/auto-refit.py --base b.png --front F.png --back B.png \
      --out o.jpg [--front-ratio 0.13] [--back-ratio 0.70]
"""
import argparse, json, os, subprocess, sys
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))


def components(mask):
    """4 邻域连通域，返回 [(area, bbox)]，按面积降序。"""
    w, h = mask.size
    px = mask.load()
    seen = [[False] * w for _ in range(h)]
    out = []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if seen[y][x] or px[x, y] == 0:
                continue
            stack = [(x, y)]
            seen[y][x] = True
            n = 0
            x0 = x1 = x
            y0 = y1 = y
            while stack:
                cx, cy = stack.pop()
                n += 1
                x0, x1 = min(x0, cx), max(x1, cx)
                y0, y1 = min(y0, cy), max(y1, cy)
                for dx, dy in ((2, 0), (-2, 0), (0, 2), (0, -2)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and px[nx, ny]:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            if n > (w * h) * 0.002:
                out.append((n, (x0, y0, x1, y1)))
    out.sort(reverse=True)
    return out


def detect_panels(base_path, thresh=62):
    im = Image.open(base_path).convert("RGB")
    W, H = im.size
    g = im.convert("L")
    mask = g.point(lambda v: 255 if v < thresh else 0).filter(ImageFilter.MaxFilter(7))
    comps = components(mask)[:2]
    if len(comps) < 2:
        raise SystemExit(f"只找到 {len(comps)} 块黑衣，无法定位：{base_path}")
    panels = []
    for _, (x0, y0, x1, y1) in comps:
        w, h = x1 - x0, y1 - y0
        # 内缩：左右各 8%（去袖口），上 3%（去领），下 12%（去下摆卷边）
        panels.append({
            "x0": x0 + w * 0.08, "x1": x1 - w * 0.08,
            "y0": y0 + h * 0.03, "y1": y1 - h * 0.12,
            "raw": [x0, y0, x1, y1],
        })
    panels.sort(key=lambda p: p["x0"])  # 左 → 右
    return {"w": W, "h": H, "left": panels[0], "right": panels[1]}


def target_boxes(panels, front_ratio=0.13, back_ratio=0.70, badge_aspect=0.643):
    """左面板=男装正面，右面板=女装背面。"""
    f, b = panels["left"], panels["right"]
    fw, fh = f["x1"] - f["x0"], f["y1"] - f["y0"]
    bw, bh = b["x1"] - b["x0"], b["y1"] - b["y0"]

    bwid = fw * front_ratio
    bhei = bwid / badge_aspect
    # 胸标贴男装左胸（观者右侧），中心放在面板 72% 处
    cx = f["x0"] + fw * 0.72
    fx0, fx1 = cx - bwid / 2, cx + bwid / 2
    fy0 = f["y0"] + fh * 0.06
    fy1 = fy0 + bhei

    wb = bw * back_ratio
    bx0 = b["x0"] + (bw - wb) / 2
    bx1 = bx0 + wb
    by0 = b["y0"] + bh * 0.08
    return {"front": (fx0, fy0, fx1, fy1), "back": (bx0, by0, bx1, b["y1"] - bh * 0.06)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--front", required=True)
    ap.add_argument("--back", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--front-ratio", type=float, default=0.13)
    ap.add_argument("--back-ratio", type=float, default=0.70)
    a = ap.parse_args()

    p = detect_panels(a.base)
    t = target_boxes(p, a.front_ratio, a.back_ratio)
    pct = lambda box: ",".join(f"{v / (p['w'] if i % 2 == 0 else p['h']) * 100:.2f}"
                               for i, v in enumerate(box))
    cmd = [sys.executable, os.path.join(HERE, "compose-refit.py"),
           "--base", a.base, "--front", a.front, "--front-box", pct(t["front"]),
           "--back", a.back, "--back-box", pct(t["back"]), "--back-fit", "width",
           "--out", a.out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-600:], file=sys.stderr)
        raise SystemExit(1)
    info = json.loads(r.stdout)
    fw, fh = t["front"][2] - t["front"][0], t["front"][3] - t["front"][1]
    bw2, bh2 = t["back"][2] - t["back"][0], t["back"][3] - t["back"][1]
    panel_fw = p["left"]["x1"] - p["left"]["x0"]
    panel_bw = p["right"]["x1"] - p["right"]["x0"]
    info["measured"] = {
        "front_width_pct_of_shirt": round(fw / panel_fw * 100, 1),
        "front_height_pct_of_shirt": round(fh / (p["left"]["y1"] - p["left"]["y0"]) * 100, 1),
        "back_width_pct_of_shirt": round(bw2 / panel_bw * 100, 1),
        "back_height_pct_of_shirt": round(bh2 / (p["right"]["y1"] - p["right"]["y0"]) * 100, 1),
    }
    info["panels"] = p
    print(json.dumps(info, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
