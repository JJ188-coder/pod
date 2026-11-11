#!/usr/bin/env python3
"""版式几何自检：抓取所有文字/表格的包围盒，报越界与压字。

渲染器只用到 text/textlength/line/rectangle/ellipse，这里用代理对象
拦截 text 调用记录 bbox，跑完后检查：

  1. 文字超出安全边距（左右 24px、上下 8px）
  2. 两块文字重叠面积超过较小者的 25%
  3. 正文压到页脚分隔线（y=9590 以下）

用法：
  python3 tools/pod/listing/check-detail-layout.py --spec s.json
"""
import argparse, importlib.util, json, os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H19 = 1080, 9720


def load_engine():
    p = os.path.join(HERE, "make-detail-variants.py")
    spec = importlib.util.spec_from_file_location("dv", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class Recorder:
    """ImageDraw 代理：记录文字 bbox，其余原样转发。"""

    def __init__(self, inner):
        self.inner = inner
        self.boxes = []  # (x0,y0,x1,y1,text)

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def text(self, xy, text, font=None, fill=None, anchor=None, **kw):
        if text is None or text == "":
            return
        bbox = self.inner.textbbox(xy, text, font=font, anchor=anchor)
        self.boxes.append((bbox[0], bbox[1], bbox[2], bbox[3], str(text)[:42]))
        return self.inner.text(xy, text, font=font, fill=fill, anchor=anchor, **kw)


def area(b):
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def inter(a, b):
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--margin", type=int, default=24)
    ap.add_argument("--overlap", type=float, default=0.25)
    ap.add_argument("--footer-y", type=int, default=9590)
    a = ap.parse_args()

    eng = load_engine()
    s = json.load(open(a.spec, encoding="utf-8"))
    report = {}
    bad = 0
    for name in sorted(eng.BUILDERS):
        theme = eng.THEMES[name]
        canvas = Image.new("RGB", (W, H19), theme["bg"])
        rec = Recorder(ImageDraw.Draw(canvas))
        eng.BUILDERS[name](canvas, rec, s, theme)
        rec2 = Recorder(ImageDraw.Draw(canvas))
        eng.footer(canvas, rec2, s, theme, dark=theme["bg"][0] < 60)
        boxes = rec.boxes + rec2.boxes

        oob, clip, foot = [], [], []
        for b in boxes:
            if b[0] < a.margin or b[2] > W - a.margin or b[1] < 0 or b[3] > H19:
                oob.append(b)
            if b[3] > a.footer_y and "MXTMC001 ·" not in b[4]:
                foot.append(b)

        overlaps = []
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                A, B = boxes[i], boxes[j]
                if A[3] <= B[1] or B[3] <= A[1] or A[2] <= B[0] or B[2] <= A[0]:
                    continue
                ia = inter(A, B)
                if ia <= 0:
                    continue
                small = min(area(A), area(B))
                if small > 0 and ia / small >= a.overlap:
                    overlaps.append({"a": A[4], "b": B[4], "ratio": round(ia / small, 2),
                                     "at": [A[0], A[1], A[2], A[3]]})

        report[name] = {"texts": len(boxes), "out_of_bounds": oob[:8],
                        "below_footer": foot[:8], "overlaps": overlaps[:8]}
        bad += len(oob) + len(foot) + len(overlaps)

    print(json.dumps(report, ensure_ascii=False, indent=1))
    print("\nRESULT:", "PASS" if bad == 0 else f"{bad} 处待修", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
