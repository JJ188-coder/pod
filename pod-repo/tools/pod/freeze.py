#!/usr/bin/env python3
"""
freeze.py — 素材冻结：把「这一批文件就是这一版」写成可复核的 freeze.json + manifest.json。

用法：
  python3 tools/pod/freeze.py <商品包目录> [--product JC124] [--version R01]
  python3 tools/pod/freeze.py --verify <freeze.json>

冻结只证明：文件真实存在、能解码、指纹一致、角色齐、图案透明且达到清晰度线。
它不证明工厂适印、供货、价格或发布授权。
"""
import argparse
import hashlib
import io
import json
import os
import sys
from datetime import datetime, timezone

try:
    from PIL import Image
except ImportError:
    print(json.dumps({"ok": False, "error": "PIL_MISSING"}))
    sys.exit(2)

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
ROLE_RULES = [
    ("pattern", ("生产图", "pattern", "印图", "artwork")),
    ("hero", ("主图", "hero", "/h0", "\\h0")),
    ("detail", ("详情", "detail", "/d0", "\\d0")),
    ("sku", ("sku", "variant", "颜色图", "color")),
    ("sizechart", ("尺码", "sizechart", "tallas")),
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def role_of(rel):
    low = rel.lower()
    for role, keys in ROLE_RULES:
        if any(k in low for k in keys):
            return role
    return "other"


def inspect(path, rel, min_edge):
    data = open(path, "rb").read()
    row = {
        "role": role_of(rel),
        "path": rel,
        "sha256": sha256(path),
        "bytes": len(data),
        "decoded": False,
    }
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            row.update({
                "decoded": True,
                "format": im.format,
                "mode": im.mode,
                "width": im.width,
                "height": im.height,
                "long_edge": max(im.width, im.height),
                "has_alpha": im.mode in ("RGBA", "LA") or "transparency" in im.info,
            })
            if im.mode in ("RGBA", "LA"):
                alpha = im.getchannel("A")
                box = alpha.getbbox()
                row["alpha_bbox"] = list(box) if box else None
                row["alpha_coverage"] = round(
                    sum(1 for p in alpha.getdata() if p > 0) / (im.width * im.height), 4
                )
            if row["role"] == "pattern":
                row["meets_min_edge"] = row["long_edge"] >= min_edge
    except Exception as exc:  # noqa: BLE001
        row["error"] = str(exc)[:160]
    return row


def build(pack, product, version, min_edge):
    pack = os.path.abspath(pack)
    if not os.path.isdir(pack):
        return {"ok": False, "error": "PACK_NOT_FOUND", "pack": pack}

    files = []
    for root, _, names in os.walk(pack):
        for name in sorted(names):
            ext = os.path.splitext(name)[1].lower()
            if ext not in IMAGE_EXT:
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, pack)
            files.append(inspect(full, rel, min_edge))

    by_role = {}
    for row in files:
        by_role.setdefault(row["role"], []).append(row)

    patterns = by_role.get("pattern", [])
    gates = {
        "images_present": len(files) > 0,
        "all_decoded": all(f["decoded"] for f in files) if files else False,
        "pattern_present": len(patterns) > 0,
        "pattern_transparent": all(f.get("has_alpha") for f in patterns) if patterns else False,
        "pattern_min_edge": all(f.get("meets_min_edge") for f in patterns) if patterns else False,
        "hero_present": bool(by_role.get("hero")),
        "detail_present": bool(by_role.get("detail")),
        "sizechart_present": bool(by_role.get("sizechart")),
    }
    required = ["images_present", "all_decoded", "pattern_present", "pattern_transparent", "pattern_min_edge"]
    materials_ready = all(gates[k] for k in required)

    freeze = {
        "schema": "pod-freeze-v1",
        "product": product or os.path.basename(pack),
        "version": version or "R01",
        "pack": pack,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "min_edge": min_edge,
        "gates": gates,
        "materials_ready": materials_ready,
        "counts": {k: len(v) for k, v in by_role.items()},
        "files": files,
        "notes": [
            "materials_ready 只表示本地素材可进入下一段，不等于工厂适印、供货或发布授权。",
            "任意文件改动都会让本冻结失效，需重新冻结并升版本。",
        ],
    }
    manifest = {
        "schema": "pod-manifest-v1",
        "product": freeze["product"],
        "version": freeze["version"],
        "created_at": freeze["created_at"],
        "freeze_sha256_of_list": hashlib.sha256(
            json.dumps([{"role": f["role"], "path": f["path"], "sha256": f["sha256"]} for f in files],
                       ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest(),
        "roles": {k: [f["path"] for f in v] for k, v in by_role.items()},
        "files": [{"role": f["role"], "path": f["path"], "sha256": f["sha256"],
                   "width": f.get("width"), "height": f.get("height")} for f in files],
    }
    return {"ok": materials_ready, "freeze": freeze, "manifest": manifest}


def verify(freeze_path):
    freeze_path = os.path.abspath(freeze_path)
    if not os.path.isfile(freeze_path):
        return {"ok": False, "error": "FREEZE_NOT_FOUND", "file": freeze_path}
    freeze = json.load(open(freeze_path))
    base = freeze.get("pack") or os.path.dirname(os.path.dirname(freeze_path))
    bad = []
    for row in freeze.get("files", []):
        full = os.path.join(base, row["path"])
        if not os.path.isfile(full):
            bad.append({"path": row["path"], "error": "MISSING"})
            continue
        actual = sha256(full)
        if actual != row["sha256"]:
            bad.append({"path": row["path"], "error": "SHA_MISMATCH", "expected": row["sha256"], "actual": actual})
    return {
        "ok": not bad,
        "file": freeze_path,
        "checked": len(freeze.get("files", [])),
        "mismatches": bad,
        "materials_ready": freeze.get("materials_ready"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pack", nargs="?")
    ap.add_argument("--product", default="")
    ap.add_argument("--version", default="")
    ap.add_argument("--min-edge", type=int, default=3000)
    ap.add_argument("--verify", default="")
    ap.add_argument("--write", action="store_true", default=True)
    args = ap.parse_args()

    if args.verify:
        result = verify(args.verify)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result["ok"] else 1)

    if not args.pack:
        print(json.dumps({"ok": False, "error": "PACK_REQUIRED"}))
        sys.exit(2)

    built = build(args.pack, args.product, args.version, args.min_edge)
    if not built.get("ok") and "freeze" not in built:
        print(json.dumps(built, ensure_ascii=False, indent=2))
        sys.exit(1)

    pack = os.path.abspath(args.pack)
    with open(os.path.join(pack, "freeze.json"), "w", encoding="utf-8") as f:
        json.dump(built["freeze"], f, ensure_ascii=False, indent=2)
    with open(os.path.join(pack, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(built["manifest"], f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "ok": built["ok"],
        "freeze": os.path.join(pack, "freeze.json"),
        "manifest": os.path.join(pack, "manifest.json"),
        "materials_ready": built["freeze"]["materials_ready"],
        "gates": built["freeze"]["gates"],
        "counts": built["freeze"]["counts"],
    }, ensure_ascii=False, indent=2))
    sys.exit(0 if built["ok"] else 1)


if __name__ == "__main__":
    main()
