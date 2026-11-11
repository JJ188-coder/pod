#!/usr/bin/env python3
"""Dependency-free MCP bridge for the private image2 (ChatGPT Pro gpt-image-2) gateway.

Primary image provider for this machine. Works as an MCP stdio server, and also as a
plain CLI (`check` / `generate`) so it is usable before ZCode reloads plugin MCP config.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import mimetypes
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from urllib.parse import urlencode, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterator


VERSION = "0.3.0"
DEFAULT_BASE_URL = "https://image2.bri-king.com"
DEFAULT_MODEL = "codex/gpt-image-2"
CONFIG_PATH = Path.home() / ".config" / "image2-studio" / "config.json"
SIZES = {"1024x1024", "1536x1024", "1024x1536", "auto"}
QUALITIES = {"low", "medium", "high", "auto", "xhigh", "max"}
MAX_PROMPTS = 8
MAX_IMAGE_BYTES = 25 * 1024 * 1024
TIMEOUT_SECONDS = 420
_SEND_LOCK = threading.Lock()

TOOLS = [
    {
        "name": "image2_generate",
        "description": (
            "用 image2 网关（ChatGPT Pro / gpt-image-2）异步出图。"
            "商品图请先经 product-fidelity 编译绑定同款同色真实参考图；生成完成仅为 review pending，不代表验收合格。"
            "支持纯文生图和参考图改图；结果落盘并返回文件路径，未完成时返回 task_id/request_id。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompts": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "properties": {
                            "style_id": {"type": "string", "description": "本批唯一的英文短标识，用于文件名"},
                            "title": {"type": "string", "description": "给用户看的中文名称"},
                            "prompt": {"type": "string", "description": "完整提示词"},
                            "request_id": {"type": "string", "description": "稳定请求标识；同ID只恢复，不重复提交"},
                            "variant": {"type": "string", "description": "仅明确要求重新生成时更换，代表新的生成请求"},
                            "images": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "参考图：本机绝对路径、http(s) 链接或 data URL；省略则纯文生图",
                            },
                            "size": {"type": "string"},
                            "quality": {"type": "string"},
                        },
                        "required": ["prompt"],
                    },
                },
                "images": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "本批所有 prompt 共用的参考图，单条 prompt 的 images 会覆盖它",
                },
                "size": {"type": "string", "enum": sorted(SIZES), "default": "1024x1024"},
                "quality": {"type": "string", "enum": sorted(QUALITIES), "default": "high"},
                "background": {
                    "type": "string",
                    "enum": ["transparent", "opaque", "auto"],
                    "description": "可选；仅在网关支持时生效",
                },
                "concurrency": {"type": "integer", "minimum": 1, "maximum": 20, "default": 2},
                "max_wait_min": {"type": "number", "minimum": 0, "maximum": 60, "default": 1},
                "poll_seconds": {"type": "number", "minimum": 0.2, "maximum": 60, "default": 3},
                "output_dir": {"type": "string"},
            },
            "required": ["prompts"],
        },
    },
    {
        "name": "image2_result",
        "description": "仅按 request_id/task_id 续查并下载已提交任务；绝不重新提交生成请求。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "request_id": {"type": "string"},
                "task_id": {"type": "string"},
                "request_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 100},
                "max_wait_min": {"type": "number", "minimum": 0, "maximum": 60},
                "poll_seconds": {"type": "number", "minimum": 0.2, "maximum": 60},
            },
        },
    },
    {
        "name": "image2_check",
        "description": "检查 image2 网关配置与连通性（不泄露 API Key），并报告当前模型、尺寸与质量默认值。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _clean_text(value: Any, *, field: str, required: bool = False, max_length: int = 2000) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{field} is required")
    if len(text) > max_length:
        raise ValueError(f"{field} is too long")
    return text


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def load_config() -> dict[str, str]:
    base_url = os.environ.get("IMAGE2_BASE_URL", "").strip().rstrip("/")
    key = os.environ.get("IMAGE2_API_KEY", "").strip()
    model = os.environ.get("IMAGE2_MODEL", "").strip()
    private = _read_json(CONFIG_PATH)
    if isinstance(private, dict):
        base_url = base_url or str(private.get("base_url") or "").strip().rstrip("/")
        key = key or str(private.get("api_key") or "").strip()
        model = model or str(private.get("model") or "").strip()
    return {
        "base_url": base_url or DEFAULT_BASE_URL,
        "api_key": key,
        "model": model or DEFAULT_MODEL,
        "auth_scheme": (os.environ.get("IMAGE2_AUTH_SCHEME", "").strip()
                        or (str(private.get("auth_scheme") or "").strip() if isinstance(private, dict) else "")
                        or "bearer"),
        "default_size": str((private or {}).get("default_size") or "1024x1024") if isinstance(private, dict) else "1024x1024",
        "default_quality": str((private or {}).get("default_quality") or "high") if isinstance(private, dict) else "high",
    }


def _auth_header(key: str, scheme: str) -> str:
    """Gateway spec shows a raw `Authorization: <key>`; some relays expect `Bearer <key>`."""
    if key.lower().startswith("bearer "):
        return key
    return f"Bearer {key}" if scheme == "bearer" else key


def resolve_image(value: str) -> tuple[bytes, str, str]:
    """Return (bytes, filename, content_type) for a local path, http(s) URL or data URL."""
    ref = _clean_text(value, field="image", required=True, max_length=2000)
    if ref.startswith("data:"):
        header, _, payload = ref.partition(",")
        if ";base64" not in header:
            raise ValueError("data URL must be base64 encoded")
        mime = header[5:].split(";")[0] or "image/png"
        raw = base64.b64decode(payload, validate=True)
        name = "reference." + (mimetypes.guess_extension(mime) or ".png").lstrip(".")
        return raw, name, mime
    if ref.startswith("http://") or ref.startswith("https://"):
        request = urllib.request.Request(ref, headers={"User-Agent": f"image2-studio/{VERSION}"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read(MAX_IMAGE_BYTES + 1)
                mime = (response.headers.get("Content-Type") or "image/png").split(";")[0]
        except urllib.error.URLError as exc:
            raise RuntimeError(f"cannot download reference image: {exc}") from None
        if len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("reference image is larger than 25MB")
        return raw, Path(urlparse(ref).path).name or "reference.png", mime
    path = Path(ref).expanduser()
    if not path.is_file():
        raise ValueError(f"reference image not found: {path}")
    raw = path.read_bytes()
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("reference image is larger than 25MB")
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return raw, path.name, mime


def _multipart(fields: dict[str, str], images: list[tuple[bytes, str, str]]) -> tuple[bytes, str]:
    boundary = f"----image2{VERSION.replace('.', '')}{int(time.time() * 1000)}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        if value is None or value == "":
            continue
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode("utf-8")
        )
    for index, (raw, filename, mime) in enumerate(images):
        field_name = "image"
        safe_name = re.sub(r'[^A-Za-z0-9._-]+', "-", filename) or f"image-{index + 1}.png"
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{field_name}"; filename="{safe_name}"\r\n'
                f"Content-Type: {mime}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(raw)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _dimensions(raw: bytes) -> tuple[int, int] | None:
    """Best-effort width/height for PNG, JPEG and WEBP without extra dependencies."""
    if raw.startswith(b"\x89PNG") and len(raw) >= 24:
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if raw.startswith(b"\xff\xd8"):
        offset = 2
        while offset + 9 < len(raw):
            if raw[offset] != 0xFF:
                offset += 1
                continue
            marker = raw[offset + 1]
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                offset += 2
                continue
            length = int.from_bytes(raw[offset + 2:offset + 4], "big")
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                return (int.from_bytes(raw[offset + 7:offset + 9], "big"),
                        int.from_bytes(raw[offset + 5:offset + 7], "big"))
            if length < 2:
                return None
            offset += 2 + length
        return None
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        chunk = raw[12:16]
        if chunk == b"VP8X" and len(raw) >= 30:
            return (1 + int.from_bytes(raw[24:27], "little"), 1 + int.from_bytes(raw[27:30], "little"))
        if chunk == b"VP8 " and len(raw) >= 30:
            return (int.from_bytes(raw[26:28], "little") & 0x3FFF,
                    int.from_bytes(raw[28:30], "little") & 0x3FFF)
    return None


def _size_warning(requested: str, dims: tuple[int, int] | None) -> str:
    if not dims or requested not in SIZES or requested == "auto":
        return ""
    width, height = dims
    try:
        want_w, want_h = (int(part) for part in requested.split("x"))
    except ValueError:
        return ""
    if (width, height) != (want_w, want_h):
        return f"请求 {requested}，实际 {width}x{height}（模型/参考图决定尺寸，需要固定比例请裁切或选参考图）"
    return ""


REQUEST_SCHEMA_VERSION = 1
DEFAULT_MAX_WAIT_MIN = 1.0
DEFAULT_POLL_SECONDS = 3.0


class _GatewayHTTPError(RuntimeError):
    def __init__(self, code: int, detail: str):
        self.code = code
        self.detail = detail[:400]
        super().__init__(f"image2 HTTP {code}")


class _GatewayTransportError(RuntimeError):
    pass


def _state_root() -> Path:
    return Path(os.environ.get("IMAGE2_DATA_DIR") or (Path.home() / ".zcode" / "image2-studio"))


def _request_dir(request_id: str) -> Path:
    return _state_root() / "requests" / request_id


def _atomic_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".part", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    _atomic_bytes(path, raw)
    try:
        path.chmod(0o600)
    except OSError:
        pass


@contextmanager
def _request_lock(request_id: str) -> Iterator[Path]:
    directory = _request_dir(request_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        directory.chmod(0o700)
    except OSError:
        pass
    lock_path = directory / "request.lock"
    with lock_path.open("a+b") as handle:
        try:
            os.fchmod(handle.fileno(), 0o600)
        except OSError:
            pass
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield directory
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _safe_gateway(base_url: str) -> str:
    parts = urlparse(base_url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return f"{parts.scheme}://{host}{parts.path.rstrip('/')}"


def _v2_request(url: str, key: str, *, body: bytes | None = None,
                content_type: str = "application/json", timeout: int = TIMEOUT_SECONDS,
                scheme: str = "bearer") -> dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "Authorization": _auth_header(key, scheme),
        "User-Agent": "curl/8.7.1",
    }
    if body is not None:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_IMAGE_BYTES * 2 + 1)
            if len(raw) > MAX_IMAGE_BYTES * 2:
                raise RuntimeError("image2 JSON response is too large")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        if key:
            detail = detail.replace(key, "[redacted]")
        raise _GatewayHTTPError(exc.code, detail) from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise _GatewayTransportError(f"image2 request outcome unknown: {getattr(exc, 'reason', str(exc))}") from None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise RuntimeError("image2 returned non-JSON body") from None
    if not isinstance(value, dict):
        raise RuntimeError("image2 returned unexpected JSON shape")
    return value


def _safe_error(error: Any, key: str = "") -> str:
    text = str(error or "unknown image2 error")
    if key:
        text = text.replace(key, "[redacted]")
    text = re.sub(r"https?://[^\s\"'<>]+", "[redacted-url]", text)
    return text[:400]


def _normalize_result_item(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("image2 job succeeded without a result object")
    items = result.get("data")
    if not isinstance(items, list) or not items or not isinstance(items[0], dict):
        raise RuntimeError("image2 job returned no result image")
    return items[0]


def _image_bytes(item: dict[str, Any]) -> tuple[bytes, str]:
    encoded = item.get("b64_json") or item.get("b64")
    if isinstance(encoded, str) and encoded:
        raw = base64.b64decode(encoded, validate=True)
    else:
        url = item.get("url") or item.get("image_url")
        if not isinstance(url, str) or urlparse(url).scheme not in {"http", "https"}:
            raise RuntimeError("image2 returned neither b64_json nor a download URL")
        request = urllib.request.Request(url, headers={"User-Agent": "curl/8.7.1"})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                raw = response.read(MAX_IMAGE_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RuntimeError(f"image2 result download failed: {getattr(exc, 'reason', str(exc))}") from None
    mime = str(item.get("mime_type") or "").strip()
    extension = _sniff(raw)
    dims = _dimensions(raw)
    if not extension or not dims or min(dims) <= 0 or len(raw) > MAX_IMAGE_BYTES:
        raise RuntimeError("image2 result is not a recognized image with valid dimensions within 25MB")
    if not mime:
        mime = {"jpg": "image/jpeg", "webp": "image/webp", "png": "image/png"}[extension]
    return raw, f"{extension}|{mime}"


def _load_state(path: Path, request_id: str, binding: dict[str, Any]) -> dict[str, Any] | None:
    if not path.exists():
        return None
    value = _read_json(path)
    if not isinstance(value, dict) or value.get("schema_version") != REQUEST_SCHEMA_VERSION:
        raise RuntimeError(f"旧版或无效任务状态只读阻塞，不覆盖：{path}")
    if value.get("request_id") != request_id or value.get("binding") != binding:
        raise RuntimeError(f"request_id 已绑定到不同参数/参考图/批次；拒绝覆盖：{request_id}")
    return value


def _persist_state(path: Path, state: dict[str, Any]) -> None:
    _atomic_json(path, state)


def _request_binding(item: dict[str, Any], config: dict[str, str], refs: list[tuple[bytes, str, str]],
                     endpoint: str, *, batch_id: str = "", manifest_hash: str = "") -> dict[str, Any]:
    metadata = {
        key: item[key]
        for key in ("product_lock", "product_category", "product_facts", "facts_source")
        if key in item
    }
    binding = {
        "gateway": _safe_gateway(config["base_url"]),
        "endpoint": endpoint,
        "model": config["model"],
        "params": {
            "prompt": item["prompt"],
            "size": item["size"],
            "quality": item["quality"],
            "background": item.get("background") or "",
            "variant": item.get("variant") or "",
        },
        "reference_images": [
            {"sha256": hashlib.sha256(raw).hexdigest(), "mime_type": mime}
            for raw, _name, mime in refs
        ],
        "metadata": metadata,
    }
    if batch_id:
        binding.update({"batch_id": batch_id, "manifest_hash": manifest_hash})
    return binding


def _prepare_request(item: dict[str, Any], config: dict[str, str], *, batch_id: str = "",
                     manifest_hash: str = "") -> dict[str, Any]:
    refs = [resolve_image(ref) for ref in item.get("images", [])]
    endpoint = "/v2/images/edits" if refs else "/v2/images/generations"
    binding = _request_binding(item, config, refs, endpoint, batch_id=batch_id, manifest_hash=manifest_hash)
    fingerprint = {key: binding[key] for key in ("gateway", "endpoint", "model", "params", "reference_images")}
    explicit = item.get("request_id")
    request_id = _check_id(explicit, "request_id") if explicit else "req-" + hashlib.sha256(
        json.dumps(fingerprint, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if not item.get("output_file") and not item.get("output_prefix"):
        output_dir = Path(str(item.get("output_dir") or Path.home() / "Pictures" / "image2-studio"))
        item["output_dir"] = str(output_dir)
        item["output_prefix"] = str(output_dir / f"image-{request_id[-16:]}")
        binding = _request_binding(item, config, refs, endpoint, batch_id=batch_id, manifest_hash=manifest_hash)
    if item.get("product_lock"):
        lock = item["product_lock"]
        if not isinstance(lock, dict) or not isinstance(lock.get("refs"), list):
            raise ValueError("product_lock.refs 必須為陣列")
        locked_refs = lock["refs"]
        if len(locked_refs) != len(refs):
            raise ValueError("product_lock.refs 与 reference_images 数量不一致")
        for index, (locked, resolved) in enumerate(zip(locked_refs, refs)):
            if not isinstance(locked, dict):
                raise ValueError(f"product_lock.refs[{index}] 必须是对象")
            file_value = str(locked.get("file") or "")
            if not file_value or Path(file_value).expanduser().resolve() != Path(item["images"][index]).expanduser().resolve():
                raise ValueError(f"product_lock.refs[{index}].file 与 reference_images 不一致")
            actual_sha = hashlib.sha256(resolved[0]).hexdigest()
            if str(locked.get("sha256") or "").lower() != actual_sha:
                raise ValueError(f"product_lock.refs[{index}] SHA256 与 reference_images 不一致")
    binding.update({
        "output_file": item.get("output_file") or "",
        "output_dir": str(item.get("output_dir") or ""),
        "output_prefix": str(item.get("output_prefix") or ""),
    })
    return {
        "request_id": request_id,
        "binding": binding,
        "item": item,
        "refs": refs,
        "endpoint": endpoint,
        "state_path": _request_dir(request_id) / "state.json",
    }


def _new_state(prepared: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": REQUEST_SCHEMA_VERSION,
        "request_id": prepared["request_id"],
        "binding": prepared["binding"],
        "output_file": prepared["item"].get("output_file") or "",
        "output_prefix": prepared["item"].get("output_prefix") or "",
        "output_dir": prepared["item"].get("output_dir") or "",
        "status": "queued",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _post_body(prepared: dict[str, Any], config: dict[str, str]) -> tuple[bytes, str]:
    item = prepared["item"]
    if prepared["refs"]:
        fields = {
            "model": config["model"],
            "prompt": item["prompt"],
            "size": item["size"],
            "quality": item["quality"],
            "background": item.get("background") or "",
        }
        return _multipart(fields, prepared["refs"])
    request = {
        "requests": [{
            "prompt": item["prompt"],
            "quality": item["quality"],
            "size": item["size"],
            "model": config["model"],
            **({"background": item["background"]} if item.get("background") else {}),
        }]
    }
    return json.dumps(request, ensure_ascii=False).encode("utf-8"), "application/json"


def _has_output(state: dict[str, Any]) -> Path | None:
    output_file = state.get("output_file") or state["binding"].get("output_file")
    if output_file:
        target = Path(output_file).expanduser()
        return target if target.exists() else None
    prefix = state["binding"].get("output_prefix")
    if prefix:
        directory = Path(prefix).parent
        if directory.is_dir():
            for path in directory.iterdir():
                if path.name.startswith(Path(prefix).name + ".") and path.is_file():
                    return path
    return None


def _finish_from_raw(state: dict[str, Any], directory: Path) -> dict[str, Any]:
    raw_path_value = state.get("raw_path")
    expected_sha = str(state.get("raw_sha256") or "")
    target_value = state.get("output_file") or state["binding"].get("output_file") or ""
    target = Path(target_value).expanduser() if target_value else None
    existing = _has_output(state)
    if existing is not None:
        if not expected_sha:
            state.update(status="conflict", error=f"目标已存在但无已持久化 SHA256，拒绝盲复用：{existing}")
            return state
        if existing.is_symlink() or not existing.is_file() or _sha_file(existing) != expected_sha:
            state.update(status="conflict", error=f"目标已存在但 SHA256 不匹配，拒绝覆盖/复用：{existing}")
            return state
        target = existing
        state.update(status="succeeded", output_file=str(target), output_sha256=expected_sha)
        state.pop("error", None)
        return state
    if not raw_path_value or not expected_sha:
        return state
    raw_path = Path(raw_path_value)
    if not raw_path.is_file() or raw_path.is_symlink() or _sha_file(raw_path) != expected_sha:
        state.update(status="conflict", error="已持久化原图缺失或 SHA256 不匹配；不会重新提交")
        return state
    if target is None:
        prefix = state["binding"].get("output_prefix")
        if not prefix:
            state.update(status="conflict", error="任务缺少输出路径绑定")
            return state
        target = Path(f"{prefix}.{raw_path.suffix.lstrip('.')}" ).expanduser()
    try:
        copied = _copy_verified(raw_path, target, expected_sha=expected_sha)
    except (RuntimeError, OSError) as exc:
        state.update(status="result_ready", error=_safe_error(exc))
        return state
    state.update(status="succeeded", output_file=str(target), output_sha256=expected_sha,
                 copy_state=copied["state"])
    state.pop("error", None)
    return state


def _submit_request(prepared: dict[str, Any], config: dict[str, str]) -> dict[str, Any]:
    request_id = prepared["request_id"]
    state_path = prepared["state_path"]
    with _request_lock(request_id) as directory:
        state = _load_state(state_path, request_id, prepared["binding"]) or _new_state(prepared)
        if state["status"] == "submitting":
            state.update(status="submission_unknown", error="进程在提交中断开；未知请求绝不重发")
            _persist_state(state_path, state)
            return state
        if state["status"] != "queued":
            return state
        existing = _has_output(state)
        if existing is not None:
            state.update(status="conflict", error=f"目标已存在且没有此请求的持久化 SHA256，拒绝盲复用：{existing}")
            _persist_state(state_path, state)
            return state
        stop_event = prepared.get("stop_event")
        if stop_event is not None and stop_event.is_set():
            state.update(status="blocked", error="同批任务已触发鉴权/额度阻断，尚未提交")
            _persist_state(state_path, state)
            return state

        _persist_state(state_path, state)
        state.update(status="submitting", submitted_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        _persist_state(state_path, state)
        body, content_type = _post_body(prepared, config)
        try:
            payload = _v2_request(
                f"{config['base_url'].rstrip('/')}{prepared['endpoint']}", config["api_key"],
                body=body, content_type=content_type, timeout=TIMEOUT_SECONDS,
                scheme=config.get("auth_scheme") or "bearer",
            )
        except _GatewayHTTPError as exc:
            quota = "quota" in exc.detail.lower() or "额度" in exc.detail
            if exc.code >= 500 or exc.code in {408, 425}:
                state.update(status="submission_unknown", error=_safe_error(f"{exc}; {_safe_error(exc.detail, config['api_key'])}"))
            elif exc.code in {401, 403, 429} or quota:
                state.update(status="blocked", error=_safe_error(f"{exc}; {_safe_error(exc.detail, config['api_key'])}"),
                             blocked_reason="auth" if exc.code in {401, 403} else "quota")
            else:
                state.update(status="failed", error=_safe_error(f"{exc}; {_safe_error(exc.detail, config['api_key'])}"))
            _persist_state(state_path, state)
            if state["status"] == "blocked" and stop_event is not None:
                stop_event.set()
            return state
        except (_GatewayTransportError, RuntimeError, ValueError, OSError) as exc:
            state.update(status="submission_unknown", error=_safe_error(exc, config["api_key"]))
            _persist_state(state_path, state)
            return state
        jobs = payload.get("jobs")
        remote_id = jobs[0].get("id") if isinstance(jobs, list) and jobs and isinstance(jobs[0], dict) else None
        if not isinstance(remote_id, (str, int)) or not str(remote_id).strip() or "," in str(remote_id):
            state.update(status="submission_unknown", error="提交响应没有有效 jobs[0].id；绝不重发")
            _persist_state(state_path, state)
            return state
        state.update(status="pending", remote_id=str(remote_id), gateway_status=(jobs[0].get("status") or "queued"))
        state.pop("error", None)
        _persist_state(state_path, state)
        return state


def _get_job(remote_id: str, config: dict[str, str]) -> dict[str, Any]:
    query = urlencode({"ids": remote_id})
    payload = _v2_request(
        f"{config['base_url'].rstrip('/')}/v2/jobs?{query}", config["api_key"],
        timeout=60, scheme=config.get("auth_scheme") or "bearer",
    )
    jobs = payload.get("jobs")
    if not isinstance(jobs, list):
        raise RuntimeError("image2 poll response has no jobs array")
    for job in jobs:
        if isinstance(job, dict) and str(job.get("id") or "") == remote_id:
            return job
    raise RuntimeError("image2 poll response did not include the requested job")


def _advance_request(prepared: dict[str, Any], config: dict[str, str]) -> dict[str, Any]:
    request_id = prepared["request_id"]
    state_path = prepared["state_path"]
    with _request_lock(request_id) as directory:
        state = _load_state(state_path, request_id, prepared["binding"])
        if state is None:
            return _new_state(prepared)
        if state.get("status") in {"failed", "conflict"}:
            return state
        if state.get("raw_sha256"):
            state = _finish_from_raw(state, directory)
            _persist_state(state_path, state)
            return state
        if state.get("status") == "result_ready" and state.get("result", {}).get("item"):
            try:
                raw, info = _image_bytes(state["result"]["item"])
                extension, mime = info.split("|", 1)
                raw_path = directory / f"raw.{extension}"
                _atomic_bytes(raw_path, raw)
                dims = _dimensions(raw)
                state.update(status="result_ready", raw_path=str(raw_path), raw_sha256=hashlib.sha256(raw).hexdigest(),
                             mime_type=mime, bytes=len(raw), width=dims[0] if dims else None,
                             height=dims[1] if dims else None)
                state.pop("error", None)
                state = _finish_from_raw(state, directory)
                if state.get("status") == "succeeded":
                    state["size_warning"] = _size_warning(prepared["item"]["size"], dims)
                    if not state["size_warning"]:
                        state.pop("size_warning", None)
            except (RuntimeError, ValueError, OSError) as exc:
                state.update(status="result_ready", error=_safe_error(exc, config["api_key"]))
            _persist_state(state_path, state)
            return state
        if state.get("status") == "submitting":
            state.update(status="submission_unknown", error="进程在提交中断开；未知请求绝不重发")
            _persist_state(state_path, state)
            return state
        remote_id = str(state.get("remote_id") or "")
        if not remote_id:
            return state
        try:
            job = _get_job(remote_id, config)
        except (_GatewayHTTPError, _GatewayTransportError, RuntimeError, OSError) as exc:
            if isinstance(exc, _GatewayHTTPError) and exc.code in {401, 403, 429}:
                state.update(status="blocked", blocked_reason="auth" if exc.code in {401, 403} else "quota",
                             error=_safe_error(f"{exc}; {_safe_error(exc.detail, config['api_key'])}"))
                if prepared.get("stop_event") is not None:
                    prepared["stop_event"].set()
            elif isinstance(exc, _GatewayHTTPError) and (exc.code >= 500 or exc.code in {408, 425}):
                state["last_poll_error"] = _safe_error(f"{exc}; {_safe_error(exc.detail, config['api_key'])}")
            else:
                state["last_poll_error"] = _safe_error(exc, config["api_key"])
            _persist_state(state_path, state)
            return state
        state.pop("last_poll_error", None)
        state.pop("error", None)
        status = str(job.get("status") or "").lower()
        state["gateway_status"] = status or "unknown"
        if state.get("status") == "result_ready" and state.get("error"):
            _persist_state(state_path, state)
            return state
        if status in {"queued", "running", "pending", "processing"}:
            state.update(status="pending")
            _persist_state(state_path, state)
            return state
        if status == "failed":
            error = job.get("error")
            message = _safe_error(error.get("message") if isinstance(error, dict) else error, config["api_key"])
            blocked = bool(re.search(r"quota|额度|rate.?limit|(?:HTTP\s*)?(?:401|403|429)\b", message, re.I))
            state.update(status="blocked" if blocked else "failed", error=message)
            if blocked and prepared.get("stop_event") is not None:
                prepared["stop_event"].set()
            _persist_state(state_path, state)
            return state
        if status != "succeeded":
            state.update(status="pending", last_poll_error=f"未知 job 状态：{status or 'empty'}")
            _persist_state(state_path, state)
            return state
        try:
            item = _normalize_result_item(job)
            encoded = item.get("b64_json") or item.get("b64")
            url = item.get("url") or item.get("image_url")
            result_kind = "base64" if isinstance(encoded, str) and encoded else "url" if isinstance(url, str) else "unknown"
            state.update(status="result_ready", result={
                "kind": result_kind,
                "item": item,
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            _persist_state(state_path, state)
            raw, info = _image_bytes(item)
            extension, mime = info.split("|", 1)
            raw_path = directory / f"raw.{extension}"
            _atomic_bytes(raw_path, raw)
            dims = _dimensions(raw)
            state.update(
                status="result_ready", raw_path=str(raw_path), raw_sha256=hashlib.sha256(raw).hexdigest(),
                mime_type=mime, bytes=len(raw), width=dims[0] if dims else None,
                height=dims[1] if dims else None,
            )
            state.pop("error", None)
            state = _finish_from_raw(state, directory)
            if state.get("status") == "succeeded":
                state["size_warning"] = _size_warning(prepared["item"]["size"], dims)
                if not state["size_warning"]:
                    state.pop("size_warning", None)
            _persist_state(state_path, state)
            return state
        except (RuntimeError, ValueError, OSError) as exc:
            state.update(status="result_ready", error=_safe_error(exc, config["api_key"]))
            _persist_state(state_path, state)
            return state


def _wait_request(prepared: dict[str, Any], config: dict[str, str], deadline: float,
                  poll_seconds: float, state: dict[str, Any] | None = None) -> dict[str, Any]:
    state = state or _advance_request(prepared, config)
    while (state.get("status") in {"pending", "result_ready"} and not state.get("error")
           and not state.get("last_poll_error") and time.monotonic() < deadline
           and not (prepared.get("stop_event") is not None and prepared["stop_event"].is_set())):
        time.sleep(min(poll_seconds, max(0.0, deadline - time.monotonic())))
        if time.monotonic() >= deadline:
            break
        state = _advance_request(prepared, config)
    return state


def _result_view(prepared: dict[str, Any], state: dict[str, Any], elapsed_ms: int) -> dict[str, Any]:
    item = prepared["item"]
    status = str(state.get("status") or "pending")
    view_status = "succeeded" if status == "succeeded" else status
    result: dict[str, Any] = {
        "index": item.get("index", 1),
        "style_id": item.get("style_id") or item.get("request_id") or prepared["request_id"],
        "title": item.get("title") or item.get("request_id") or prepared["request_id"],
        "size": item["size"],
        "quality": item["quality"],
        "reference_images": len(item.get("images", [])),
        "request_id": prepared["request_id"],
        "task_id": prepared["request_id"],
        "status": view_status,
        "endpoint": prepared["endpoint"],
        "duration_ms": elapsed_ms,
    }
    if state.get("remote_id"):
        result["remote_id"] = state["remote_id"]
    if state.get("status") == "succeeded":
        result.update(
            path=str(Path(state["output_file"]).resolve()),
            mime_type=state.get("mime_type"),
            bytes=state.get("bytes"),
            width=state.get("width"),
            height=state.get("height"),
            sha256=state.get("raw_sha256"),
        )
        if state.get("size_warning"):
            result["size_warning"] = state["size_warning"]
    if state.get("error") or state.get("last_poll_error"):
        result["error"] = state.get("error") or state["last_poll_error"]
    for key in ("product_lock", "product_category", "product_facts", "facts_source"):
        if key in item:
            result[key] = item[key]
    return result


def normalize(arguments: dict[str, Any], config: dict[str, str]) -> tuple[list[dict[str, Any]], int, Path]:
    raw_prompts = arguments.get("prompts")
    if not isinstance(raw_prompts, list) or not raw_prompts:
        raise ValueError("prompts must contain between 1 and 8 planned prompts")
    if len(raw_prompts) > MAX_PROMPTS:
        raise ValueError("prompts must contain between 1 and 8 planned prompts")
    shared_images = arguments.get("images") or []
    if not isinstance(shared_images, list):
        raise ValueError("images must be a list")
    background = _clean_text(arguments.get("background"), field="background", max_length=20)
    if background and background not in {"transparent", "opaque", "auto"}:
        raise ValueError("background must be transparent, opaque or auto")
    default_size = _clean_text(arguments.get("size"), field="size", max_length=20) or config["default_size"]
    default_quality = _clean_text(arguments.get("quality"), field="quality", max_length=20) or config["default_quality"]
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_prompts, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"prompts[{index - 1}] must be an object")
        prompt = _clean_text(item.get("prompt"), field="prompt", required=True, max_length=8000)
        raw_style = _clean_text(item.get("style_id"), field="style_id", max_length=80) or f"image-{index:02d}"
        style_id = re.sub(r"[^a-z0-9-]+", "-", raw_style.lower()).strip("-") or f"image-{index:02d}"
        if style_id in seen:
            raise ValueError(f"duplicate style_id: {style_id}")
        seen.add(style_id)
        images = item.get("images")
        if images is None:
            images = shared_images
        if not isinstance(images, list) or len(images) > 8:
            raise ValueError(f"prompts[{index - 1}].images must be a list of at most 8 references")
        size = _clean_text(item.get("size"), field="size", max_length=20) or default_size
        quality = _clean_text(item.get("quality"), field="quality", max_length=20) or default_quality
        if size not in SIZES:
            raise ValueError(f"unsupported size: {size}")
        if quality not in QUALITIES:
            raise ValueError(f"unsupported quality: {quality}")
        normalized_item = {
            "index": index,
            "style_id": style_id,
            "title": _clean_text(item.get("title"), field="title", max_length=120) or f"图片 {index}",
            "prompt": prompt,
            "images": [str(ref) for ref in images],
            "size": size,
            "quality": quality,
            "background": _clean_text(item.get("background"), field="background", max_length=20) or background,
            "variant": _clean_text(item.get("variant"), field="variant", max_length=120),
        }
        if item.get("request_id"):
            normalized_item["request_id"] = _check_id(item["request_id"], f"prompts[{index - 1}].request_id")
        for key in ("product_lock", "product_category", "product_facts", "facts_source"):
            if key in item:
                normalized_item[key] = item[key]
        normalized.append(normalized_item)
    concurrency = int(arguments.get("concurrency", 2) or 2)
    if not 1 <= concurrency <= 20:
        raise ValueError("concurrency must be between 1 and 20")
    output_value = _clean_text(arguments.get("output_dir"), field="output_dir", max_length=1000)
    output_dir = Path(output_value).expanduser() if output_value else Path.home() / "Pictures" / "image2-studio"
    output_dir.mkdir(parents=True, exist_ok=True)
    if output_dir.is_symlink():
        raise RuntimeError("output directory must not be a symlink")
    return normalized, concurrency, output_dir


def _wait_options(arguments: dict[str, Any]) -> tuple[float, float]:
    try:
        max_wait_min = float(arguments.get("max_wait_min", DEFAULT_MAX_WAIT_MIN))
        poll_seconds = float(arguments.get("poll_seconds", DEFAULT_POLL_SECONDS))
    except (TypeError, ValueError):
        raise ValueError("max_wait_min / poll_seconds 必须是数字") from None
    if not 0 <= max_wait_min <= 1440:
        raise ValueError("max_wait_min 必须在 0–1440 之间")
    if not 0.2 <= poll_seconds <= 86400:
        raise ValueError("poll_seconds 必须在 0.2–86400 之间")
    return max_wait_min * 60, poll_seconds


def _execute_prepared(prepared: dict[str, Any], config: dict[str, str], deadline: float,
                      poll_seconds: float, *, submit: bool) -> dict[str, Any]:
    started = time.monotonic()
    state = _submit_request(prepared, config) if submit else _advance_request(prepared, config)
    if state.get("status") == "blocked" and prepared.get("stop_event") is not None:
        prepared["stop_event"].set()
    if submit and (state.get("status") in {"pending", "result_ready"} or state.get("raw_sha256")):
        state = _advance_request(prepared, config)
    if state.get("status") in {"pending", "result_ready"}:
        state = _wait_request(prepared, config, deadline, poll_seconds, state)
    return _result_view(prepared, state, round((time.monotonic() - started) * 1000))


def _aggregate(results: list[dict[str, Any]], config: dict[str, str], output_dir: Path,
               concurrency: int, started: float) -> dict[str, Any]:
    results.sort(key=lambda item: item["index"])
    succeeded = sum(item["status"] == "succeeded" for item in results)
    requested = len(results)
    statuses = {item["status"] for item in results}
    if succeeded == requested:
        status = "completed"
    elif statuses & {"pending", "result_ready"}:
        status = "pending"
    else:
        status = "partial_failure"
    value = {
        "status": status,
        "gateway": _safe_gateway(config["base_url"]),
        "model": config["model"],
        "requested": requested,
        "succeeded": succeeded,
        "failed": sum(item["status"] in {"failed", "conflict"} for item in results),
        "pending": sum(item["status"] in {"pending", "result_ready", "submitting", "submission_unknown", "blocked", "queued"} for item in results),
        "concurrency": concurrency,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "output_dir": str(output_dir.resolve()),
        "results": results,
    }
    if status == "pending":
        value["task_id"] = results[0].get("task_id") if requested == 1 else None
        value["request_id"] = results[0].get("request_id") if requested == 1 else None
    return value


def generate(arguments: dict[str, Any]) -> dict[str, Any]:
    config = load_config()
    if not config["api_key"]:
        raise RuntimeError(f"image2 API key is not configured in {CONFIG_PATH}")
    prompts, concurrency, output_dir = normalize(arguments, config)
    wait_seconds, poll_seconds = _wait_options(arguments)
    deadline = time.monotonic() + wait_seconds
    started = time.monotonic()
    prepared_items: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    for item in prompts:
        item["output_dir"] = str(output_dir)
        try:
            prepared_items.append(_prepare_request(item, config))
        except (ValueError, RuntimeError, OSError) as exc:
            results.append({
                "index": item["index"], "style_id": item["style_id"], "title": item["title"],
                "size": item["size"], "quality": item["quality"],
                "reference_images": len(item["images"]), "status": "failed", "error": _safe_error(exc),
            })
    stop_event = threading.Event()
    for prepared in prepared_items:
        prepared["stop_event"] = stop_event
    def worker(prepared: dict[str, Any]) -> dict[str, Any]:
        return _execute_prepared(prepared, config, deadline, poll_seconds, submit=True)
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="image2") as executor:
        futures = [executor.submit(worker, prepared) for prepared in prepared_items]
        for future in as_completed(futures):
            results.append(future.result())
    return _aggregate(results, config, output_dir, concurrency, started)


def image2_result(arguments: dict[str, Any]) -> dict[str, Any]:
    config = load_config()
    if not config["api_key"]:
        raise RuntimeError(f"image2 API key is not configured in {CONFIG_PATH}")
    wait_seconds, poll_seconds = _wait_options(arguments)
    identifiers = arguments.get("request_ids")
    if identifiers is None:
        identifiers = [arguments.get("request_id") or arguments.get("task_id")]
    if not isinstance(identifiers, list) or not identifiers or len(identifiers) > 100:
        raise ValueError("request_id/task_id 或最多 100 个 request_ids 必填")
    prepared_items = []
    for identifier in identifiers:
        request_id = _check_id(identifier, "request_id")
        state_path = _request_dir(request_id) / "state.json"
        state = _read_json(state_path)
        if not isinstance(state, dict):
            batch_state = _read_json(_state_root() / "batches" / request_id / "batch.json")
            if isinstance(batch_state, dict) and batch_state.get("schema_version") != REQUEST_SCHEMA_VERSION:
                raise RuntimeError(f"旧版或无新 schema 的批次只读阻塞：{request_id}")
            raise ValueError(f"找不到可恢复的任务状态：{request_id}")
        if state.get("schema_version") != REQUEST_SCHEMA_VERSION or state.get("request_id") != request_id:
            raise RuntimeError(f"旧版或无效任务状态只读阻塞：{request_id}")
        binding = state.get("binding")
        if not isinstance(binding, dict) or binding.get("gateway") != _safe_gateway(config["base_url"]):
            raise RuntimeError(f"任务绑定到不同网关：{request_id}")
        if binding.get("model") != config["model"]:
            raise RuntimeError(f"任务绑定到不同模型：{request_id}")
        item = {
            "index": len(prepared_items) + 1,
            "style_id": request_id,
            "title": request_id,
            "prompt": binding.get("params", {}).get("prompt", ""),
            "images": [],
            "size": binding.get("params", {}).get("size", "1024x1024"),
            "quality": binding.get("params", {}).get("quality", "high"),
            "background": binding.get("params", {}).get("background", ""),
            "request_id": request_id,
            **binding.get("metadata", {}),
        }
        prepared_items.append({
            "request_id": request_id,
            "binding": binding,
            "item": item,
            "refs": [],
            "endpoint": binding.get("endpoint"),
            "state_path": state_path,
        })
    deadline = time.monotonic() + wait_seconds
    started = time.monotonic()
    results = []
    for prepared in prepared_items:
        results.append(_execute_prepared(prepared, config, deadline, poll_seconds, submit=False))
    if len(results) == 1:
        item = results[0]
        return {
            "status": item["status"], "request_id": item["request_id"], "task_id": item["task_id"],
            "remote_id": item.get("remote_id"), "result": item,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
    statuses = {item["status"] for item in results}
    status = "completed" if statuses == {"succeeded"} else "pending" if statuses & {"pending", "result_ready"} else "partial_failure"
    return {
        "status": status,
        "requested": len(results), "succeeded": sum(item["status"] == "succeeded" for item in results),
        "results": results, "duration_ms": round((time.monotonic() - started) * 1000),
    }


RATIO_TO_SIZE = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "2:3": "1024x1536",
    "9:16": "1024x1536",
    "4:3": "1536x1024",
    "3:2": "1536x1024",
    "16:9": "1536x1024",
}
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")


def _check_id(value: Any, label: str) -> str:
    text = str(value or "")
    if not ID_PATTERN.match(text) or ".." in text:
        raise ValueError(f"{label} 非法：{text!r}（1–200 位字母数字/点/横线/下划线，字母数字开头）")
    return text


def _map_size(value: Any, default: str = "1024x1024") -> str:
    text = _clean_text(value, field="size", max_length=20).lower() or default
    if text in SIZES:
        return text
    if text in RATIO_TO_SIZE:
        return RATIO_TO_SIZE[text]
    raise ValueError(f"不支持的尺寸 {text!r}；可用 1024x1024/1536x1024/1024x1536/auto 或 1:1/3:4/4:3/9:16/16:9")


def _sniff(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw) >= 24 and raw[12:16] == b"IHDR":
        return "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "webp"
    return ""


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_verified(source: Path, target: Path, expected_sha: str = "") -> dict[str, Any]:
    raw = source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if expected_sha and digest != expected_sha:
        raise RuntimeError(f"原始图片内容已变化，不能当作已验收结果复制：{source}")
    actual = _sniff(raw)
    if not actual:
        raise RuntimeError(f"源文件不是可识别的图片：{source}")
    declared = target.suffix.lower().lstrip(".").replace("jpeg", "jpg")
    if declared and declared != actual:
        raise RuntimeError(f"目标声明 .{declared} 但源是 {actual}，不伪装写入：{target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".part", dir=target.parent)
    temp = Path(temp_name)
    state = "saved"
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temp, target)
        except FileExistsError:
            if target.is_symlink() or not target.is_file() or target.read_bytes() != raw:
                raise RuntimeError(f"目标已存在不同内容或不是普通文件，未覆盖：{target}") from None
            state = "reused"
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass
    return {"state": state, "sha256": digest, "bytes": len(raw), "copied_to": str(target)}


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"无法读取清单：{exc}") from None
    if not isinstance(doc, dict):
        raise ValueError("清单根必须为对象")
    batch_id = _check_id(doc.get("batch_id"), "batch_id")
    raw_jobs = doc.get("jobs") or []
    raw_locals = doc.get("local_files") or []
    if not isinstance(raw_jobs, list) or not isinstance(raw_locals, list) or not (raw_jobs or raw_locals):
        raise ValueError("jobs/local_files 必须为数组且不能同时为空")

    outputs: dict[str, str] = {}
    ids: set[str] = set()
    inputs: dict[Path, str] = {path.resolve(): _sha_file(path)}
    if isinstance(doc.get("_product_fidelity"), dict):
        source_spec = Path(str(doc["_product_fidelity"].get("source_spec") or "")).expanduser()
        if not source_spec.is_absolute() or not source_spec.is_file():
            raise ValueError("商品 source_spec 必须是已存在的绝对路径文件")
        inputs[source_spec.resolve()] = _sha_file(source_spec)
    jobs: list[dict[str, Any]] = []
    local_files: list[dict[str, Any]] = []

    def register_output(value: Any, label: str) -> Path:
        target = Path(str(value or "")).expanduser()
        if not target.is_absolute():
            raise ValueError(f"{label}.output_file 必须是绝对路径：{value!r}")
        if target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"} or target.is_symlink():
            raise ValueError(f"{label}.output_file 必须是普通图片路径，不能是符号链接")
        target = target.resolve()
        if target.exists() and not target.is_file():
            raise ValueError(f"{label}.output_file 已被非文件占用")
        key = str(target).lower()
        if key in outputs:
            raise ValueError(f"output_file 重复：{target}")
        outputs[key] = label
        return target

    for index, job in enumerate(raw_jobs):
        label = f"jobs[{index}]"
        if not isinstance(job, dict):
            raise ValueError(f"{label} 必须为对象")
        request_id = _check_id(job.get("request_id"), f"{label}.request_id")
        if request_id in ids:
            raise ValueError(f"request_id 重复：{request_id}")
        ids.add(request_id)
        if job.get("n") not in (None, 1):
            raise ValueError(f"{label}.n 必须为 1")
        prompt = _clean_text(job.get("prompt"), field=f"{label}.prompt", required=True, max_length=8000)
        refs = job.get("reference_images") or []
        if not isinstance(refs, list) or len(refs) > 8:
            raise ValueError(f"{label}.reference_images 必须是最多 8 项的数组")
        ref_paths: list[str] = []
        for ref in refs:
            ref_path = Path(str(ref)).expanduser()
            if not ref_path.is_absolute():
                raise ValueError(f"{label} 参考图必须是绝对路径：{ref!r}")
            if not ref_path.is_file() or ref_path.is_symlink():
                raise ValueError(f"{label} 参考图不存在或不是普通文件：{ref}")
            ref_path = ref_path.resolve()
            if not _sniff(ref_path.read_bytes()):
                raise ValueError(f"{label} 参考图不是可识别的图片：{ref}")
            ref_paths.append(str(ref_path))
            inputs[ref_path] = _sha_file(ref_path)
        quality = _clean_text(job.get("quality") or doc.get("quality"), field="quality", max_length=20) or "high"
        if quality not in QUALITIES:
            raise ValueError(f"{label}.quality 不支持：{quality}")
        normalized_job = {
            "request_id": request_id,
            "prompt": prompt,
            "images": ref_paths,
            "size": _map_size(job.get("size") or doc.get("size")),
            "quality": quality,
            "output_file": str(register_output(job.get("output_file"), label)),
        }
        for key in ("product_lock", "product_category", "product_facts", "facts_source", "facts_source_sha256"):
            if key in job:
                normalized_job[key] = job[key]
        if job.get("facts_source"):
            facts = Path(str(job["facts_source"])).expanduser()
            if not facts.is_absolute() or not facts.is_file():
                raise ValueError(f"{label}.facts_source 必须是已存在的绝对路径文件")
            inputs[facts.resolve()] = _sha_file(facts)
            lock = job.get("product_lock")
            if isinstance(lock, dict) and inputs[facts.resolve()] != lock.get("facts_sha256"):
                raise ValueError(f"{label}.facts_source SHA256 不匹配")
        if normalized_job.get("product_lock"):
            lock = normalized_job["product_lock"]
            if not isinstance(lock, dict) or not isinstance(lock.get("refs"), list):
                raise ValueError(f"{label}.product_lock.refs 必须为数组")
            if len(lock["refs"]) != len(ref_paths):
                raise ValueError(f"{label}.product_lock.refs 与 reference_images 数量不一致")
            for ref_index, locked_ref in enumerate(lock["refs"]):
                if not isinstance(locked_ref, dict):
                    raise ValueError(f"{label}.product_lock.refs[{ref_index}] 必须为对象")
                if Path(str(locked_ref.get("file") or "")).expanduser().resolve() != Path(ref_paths[ref_index]).resolve():
                    raise ValueError(f"{label}.product_lock.refs[{ref_index}].file 与 reference_images 不一致")
                if str(locked_ref.get("sha256") or "").lower() != inputs[Path(ref_paths[ref_index])]:
                    raise ValueError(f"{label}.product_lock.refs[{ref_index}] SHA256 与 reference_images 不一致")
        jobs.append(normalized_job)

    for index, item in enumerate(raw_locals):
        label = f"local_files[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{label} 必须为对象")
        source = Path(str(item.get("source") or "")).expanduser()
        if not source.is_absolute() or not source.is_file() or source.is_symlink():
            raise ValueError(f"{label}.source 必须是已存在的绝对路径普通文件")
        target = register_output(item.get("output_file"), label)
        source = source.resolve()
        inputs[source] = _sha_file(source)
        actual = _sniff(source.read_bytes())
        if not actual:
            raise ValueError(f"{label}.source 不是可识别的图片")
        declared = target.suffix.lower().lstrip(".").replace("jpeg", "jpg")
        if actual and declared and declared != actual:
            raise ValueError(f"{label} 目标声明 .{declared} 但源是 {actual}，不伪装写入")
        local_files.append({"source": str(source), "output_file": str(target)})

    input_keys = {str(entry).lower() for entry in inputs}
    for key in outputs:
        if key in input_keys:
            raise ValueError(f"输出不能覆盖输入文件：{key}")

    binding = {"manifest": doc, "inputs": sorted([str(entry), digest] for entry, digest in inputs.items())}
    return {
        "doc": doc,
        "batch_id": batch_id,
        "jobs": jobs,
        "local_files": local_files,
        "hash": hashlib.sha256(json.dumps(binding, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest(),
    }


def _acquire_lock(batch_dir: Path) -> int:
    batch_dir.mkdir(parents=True, exist_ok=True)
    if (batch_dir / "executor.lock").exists():
        raise RuntimeError("旧版批次锁需先核对原任务，不自动接管或删除")
    fd = os.open(batch_dir / "executor-v3.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise RuntimeError("已有执行器持有批次锁，不并发跑同一批次") from None
    return fd


def _release_lock(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def run_batch(arguments: dict[str, Any]) -> dict[str, Any]:
    manifest_path = Path(str(arguments.get("manifest") or "")).expanduser()
    if not manifest_path.is_file():
        raise ValueError(f"清单不存在：{manifest_path}")
    manifest = load_manifest(manifest_path.resolve())
    jobs, local_files = manifest["jobs"], manifest["local_files"]
    concurrency = int(arguments.get("concurrency") or 20)
    if not 1 <= concurrency <= 20:
        raise ValueError("concurrency must be between 1 and 20")
    if not arguments.get("run"):
        return {
            "ok": True, "mode": "precheck", "provider": "image2", "batch_id": manifest["batch_id"],
            "manifest_hash": manifest["hash"], "counts": {"jobs": len(jobs), "local_files": len(local_files)},
            "concurrency": min(concurrency, max(1, len(jobs))),
            "sizes": sorted({job["size"] for job in jobs}),
            "note": "仅静态预检：未联网、未建目录；--run 才提交生成。",
        }
    config = load_config()
    if not config["api_key"]:
        raise RuntimeError(f"image2 API key is not configured in {CONFIG_PATH}")
    wait_seconds, poll_seconds = _wait_options(arguments)
    batch_dir = _state_root() / "batches" / manifest["batch_id"]
    batch_lock = _acquire_lock(batch_dir)
    started = time.monotonic()
    report: dict[str, Any] = {
        "ok": False, "mode": "run", "provider": "image2", "batch_id": manifest["batch_id"],
        "manifest_hash": manifest["hash"], "batch_dir": str(batch_dir), "concurrency": concurrency,
        "jobs": [
            {"request_id": job["request_id"], "output_file": job["output_file"], "size": job["size"],
             "quality": job["quality"], "reference_images": len(job["images"]),
             **{key: job[key] for key in ("product_lock", "product_category", "product_facts", "facts_source") if key in job},
             **({"review_status": "pending"} if job.get("product_lock") else {}), "state": "queued"}
            for job in jobs
        ],
        "local_files": [{**item, "state": "queued"} for item in local_files],
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    try:
        record_file = batch_dir / "batch.json"
        if record_file.exists():
            record = _read_json(record_file)
            if not isinstance(record, dict) or record.get("schema_version") != REQUEST_SCHEMA_VERSION:
                raise RuntimeError("旧版/无新 schema 的 batch.json 只读阻塞，不覆盖")
            if record.get("batch_id") != manifest["batch_id"] or record.get("manifest_hash") != manifest["hash"]:
                raise RuntimeError("batch_id 已绑定到不同的清单内容或本地输入已变化；拒绝覆盖批次记录")
        else:
            _atomic_json(record_file, {
                "schema_version": REQUEST_SCHEMA_VERSION, "batch_id": manifest["batch_id"],
                "manifest_hash": manifest["hash"], "provider": "image2", "created_at": report["started_at"],
            })
        for entry, item in zip(report["local_files"], local_files):
            try:
                entry.update(_copy_verified(Path(item["source"]), Path(item["output_file"])))
            except (RuntimeError, OSError) as exc:
                entry.update(state="conflict", error=_safe_error(exc))
        if any(entry["state"] not in {"saved", "reused"} for entry in report["local_files"]):
            raise RuntimeError("本地尺码图归档失败，未提交新的生成任务")
        stop_event = threading.Event()
        prepared_jobs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for index, (entry, job) in enumerate(zip(report["jobs"], jobs), start=1):
            item = {
                "index": index, "style_id": job["request_id"], "title": job["request_id"],
                "request_id": job["request_id"], "prompt": job["prompt"], "images": job["images"],
                "size": job["size"], "quality": job["quality"], "background": "",
                "output_file": job["output_file"], **{key: job[key] for key in ("product_lock", "product_category", "product_facts", "facts_source") if key in job},
            }
            try:
                prepared = _prepare_request(item, config, batch_id=manifest["batch_id"], manifest_hash=manifest["hash"])
                prepared["stop_event"] = stop_event
                with _request_lock(prepared["request_id"]):
                    prior = _load_state(prepared["state_path"], prepared["request_id"], prepared["binding"])
                target = Path(job["output_file"])
                if target.exists() and (not prior or not prior.get("raw_sha256")
                                        or _sha_file(target) != prior["raw_sha256"]):
                    raise RuntimeError("目标已存在且不属于本任务，整批停止新提交")
                if prior and prior.get("status") == "blocked":
                    stop_event.set()
                prepared_jobs.append((entry, prepared))
            except (RuntimeError, ValueError, OSError) as exc:
                entry.update(state="conflict", error=_safe_error(exc))
        if any(entry["state"] == "conflict" for entry in report["jobs"]):
            raise RuntimeError("提交前整批参数/目标校验失败，未派发新任务")

        def worker(pair: tuple[dict[str, Any], dict[str, Any]]) -> None:
            entry, prepared = pair
            result = _execute_prepared(prepared, config, time.monotonic() + wait_seconds, poll_seconds, submit=True)
            status = result["status"]
            entry.update(
                state={"succeeded": "saved", "pending": "pending", "submission_unknown": "submission_unknown",
                       "blocked": "blocked", "conflict": "conflict", "failed": "failed", "result_ready": "result_ready"}.get(status, status),
                duration_ms=result.get("duration_ms"), task_id=result.get("task_id"), remote_id=result.get("remote_id"),
            )
            if status == "succeeded":
                entry.update(
                    output_file=result.get("path"), sha256=result.get("sha256"), mime_type=result.get("mime_type"),
                    bytes=result.get("bytes"), width=result.get("width"), height=result.get("height"),
                )
                if result.get("size_warning"):
                    entry["size_warning"] = result["size_warning"]
            if result.get("error"):
                entry["error"] = result["error"]
            if status == "blocked":
                stop_event.set()

        with ThreadPoolExecutor(max_workers=min(concurrency, max(1, len(prepared_jobs))), thread_name_prefix="image2-batch") as executor:
            list(executor.map(worker, prepared_jobs))
    except Exception as exc:  # noqa: BLE001 - 批次级错误写进报告
        report["error"] = _safe_error(exc, config.get("api_key", ""))
        for entry in [*report["jobs"], *report["local_files"]]:
            if entry["state"] == "queued":
                entry["state"] = "blocked"
                entry["error"] = report["error"]
    finally:
        done_states = {"saved", "reused"}
        report["aggregate"] = {
            "jobs_total": len(report["jobs"]), "local_files_total": len(report["local_files"]),
            "saved": sum(entry["state"] in done_states for entry in report["jobs"]),
            "reused_existing": 0,
            "pending": sum(entry["state"] in {"pending", "result_ready", "submission_unknown", "blocked", "queued"} for entry in report["jobs"]),
            "failed": sum(entry["state"] in {"failed", "conflict", "blocked"} for entry in report["jobs"]),
            "local_copied": sum(entry["state"] in {"saved", "reused"} for entry in report["local_files"]),
        }
        report["ok"] = bool(
            not report.get("error") and all(entry["state"] in done_states for entry in report["jobs"])
            and all(entry["state"] in {"saved", "reused"} for entry in report["local_files"])
        )
        report["duration_ms"] = round((time.monotonic() - started) * 1000)
        report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            _atomic_json(batch_dir / "latest-report.json", report)
        finally:
            _release_lock(batch_lock)
    return report


def doctor(_arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    config = load_config()
    result: dict[str, Any] = {
        "configured": bool(config["api_key"]),
        "config_path": str(CONFIG_PATH),
        "base_url": _safe_gateway(config["base_url"]),
        "model": config["model"],
        "default_size": config["default_size"],
        "default_quality": config["default_quality"],
        "auth_scheme": config.get("auth_scheme") or "bearer",
        "reachable": False,
    }
    if not config["api_key"]:
        result["message"] = f"write api_key into {CONFIG_PATH} or set IMAGE2_API_KEY"
        return result
    started = time.monotonic()
    try:
        _v2_request(f"{config['base_url'].rstrip('/')}/v1/models", config["api_key"],
                    timeout=20, scheme=result["auth_scheme"])
        result["reachable"] = True
        result["latency_ms"] = round((time.monotonic() - started) * 1000)
    except (RuntimeError, ValueError, OSError) as exc:
        result["message"] = _safe_error(exc, config["api_key"])
    return result


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "image2_generate":
        return generate(arguments)
    if name == "image2_result":
        return image2_result(arguments)
    if name == "image2_check":
        return doctor(arguments)
    raise ValueError(f"unknown tool: {name}")


def mcp_tool_result(name: str, value: dict[str, Any]) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]
    if name in {"image2_generate", "image2_result"}:
        images = value.get("results", [])
        if not images and isinstance(value.get("result"), dict):
            images = [value["result"]]
        for item in images:
            if item.get("status") != "succeeded":
                continue
            path = Path(str(item.get("path") or ""))
            if not path.is_file():
                continue
            content.append(
                {
                    "type": "image",
                    "data": base64.b64encode(path.read_bytes()).decode("ascii"),
                    "mimeType": str(item.get("mime_type") or "image/png"),
                }
            )
    return {"content": content, "structuredContent": value, "isError": False}


def send(message: dict[str, Any]) -> None:
    encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _SEND_LOCK:
        sys.stdout.write(encoded)
        sys.stdout.flush()


def reply(request_id: Any, value: dict[str, Any]) -> None:
    send({"jsonrpc": "2.0", "id": request_id, "result": value})


def handle(message: dict[str, Any]) -> None:
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        reply(
            request_id,
            {
                "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-03-26"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "image2-studio", "version": VERSION},
                "instructions": (
                    "image2 网关（ChatGPT Pro / gpt-image-2）是本机首选生图通道。"
                    "商品图请先经 product-fidelity 编译绑定同款同色真实参考图；生成完成仅为 review pending，不代表验收合格。"
                    "提示词由当前模型规划，本服务负责出图、落盘并返回文件路径；image2_result 只续查/下载，绝不重生成。"
                ),
            },
        )
    elif method in {"notifications/initialized", "notifications/cancelled"}:
        return
    elif method == "ping":
        reply(request_id, {})
    elif method == "tools/list":
        reply(request_id, {"tools": TOOLS})
    elif method == "tools/call":
        params = message.get("params") or {}
        name = str(params.get("name", ""))
        try:
            value = call_tool(name, dict(params.get("arguments") or {}))
            reply(request_id, mcp_tool_result(name, value))
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller as tool error
            reply(request_id, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
    elif request_id is not None:
        send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"method not found: {method}"}})


def serve() -> None:
    workers = max(2, min(4, int(os.environ.get("IMAGE2_MCP_WORKERS", "4"))))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="image2-mcp") as executor:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    continue
                if message.get("method") == "tools/call":
                    executor.submit(handle, message)
                else:
                    handle(message)
            except Exception as exc:  # noqa: BLE001 - protocol-level parse error
                send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})


def cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="image2", description="image2 gateway CLI (same engine as the MCP server)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="check config and gateway reachability")

    gen = sub.add_parser("generate", help="generate one or more images")
    gen.add_argument("--prompt", action="append", default=[], help="prompt; repeat for a batch")
    gen.add_argument("--title", action="append", default=[], help="optional title per prompt")
    gen.add_argument("--style-id", action="append", default=[], help="optional style id per prompt")
    gen.add_argument("--image", action="append", default=[], help="reference image (path/url/data URL); repeat as needed")
    gen.add_argument("--spec", help="JSON file: {prompts:[{prompt,images,size,quality,title,style_id}],images,size,quality,...}")
    gen.add_argument("--size", default="", choices=["", *sorted(SIZES)])
    gen.add_argument("--quality", default="", choices=["", *sorted(QUALITIES)])
    gen.add_argument("--background", default="", choices=["", "transparent", "opaque", "auto"])
    gen.add_argument("--concurrency", type=int, default=2)
    gen.add_argument("--max-wait-min", type=float, default=DEFAULT_MAX_WAIT_MIN)
    gen.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)
    gen.add_argument("--out", default="", help="output directory")

    result_cmd = sub.add_parser("result", help="resume an existing request without generating")
    result_cmd.add_argument("--request-id", required=True)
    result_cmd.add_argument("--max-wait-min", type=float, default=DEFAULT_MAX_WAIT_MIN)
    result_cmd.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)

    batch_cmd = sub.add_parser("batch", help="precheck or run a manifest batch through image2")
    batch_cmd.add_argument("--manifest", required=True, help="absolute path of the batch manifest JSON")
    batch_cmd.add_argument("--run", action="store_true", help="submit for real; without it only static precheck")
    batch_cmd.add_argument("--concurrency", type=int, default=20)
    batch_cmd.add_argument("--max-wait-min", type=float, default=DEFAULT_MAX_WAIT_MIN)
    batch_cmd.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)
    args = parser.parse_args(argv)

    if args.command == "check":
        value = doctor({})
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0 if value.get("reachable") else 1

    if args.command == "result":
        value = image2_result({"request_id": args.request_id, "max_wait_min": args.max_wait_min,
                               "poll_seconds": args.poll_seconds})
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0 if value.get("status") == "succeeded" else 3

    if args.command == "batch":
        value = run_batch({"manifest": args.manifest, "run": args.run, "concurrency": args.concurrency,
                           "max_wait_min": args.max_wait_min, "poll_seconds": args.poll_seconds})
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0 if value.get("ok") else 3

    if args.spec:
        spec = json.loads(Path(args.spec).expanduser().read_text(encoding="utf-8"))
        if not isinstance(spec, dict):
            raise SystemExit("--spec must contain a JSON object")
        arguments = dict(spec)
    else:
        if not args.prompt:
            raise SystemExit("provide --prompt or --spec")
        prompts = []
        for index, prompt in enumerate(args.prompt):
            item: dict[str, Any] = {"prompt": prompt}
            if index < len(args.title):
                item["title"] = args.title[index]
            if index < len(args.style_id):
                item["style_id"] = args.style_id[index]
            if args.image:
                item["images"] = args.image
            prompts.append(item)
        arguments = {"prompts": prompts, "concurrency": args.concurrency,
                     "max_wait_min": args.max_wait_min, "poll_seconds": args.poll_seconds}
    for key in ("size", "quality", "background", "out"):
        value = getattr(args, key, "")
        if value and not arguments.get("output_dir" if key == "out" else key):
            arguments["output_dir" if key == "out" else key] = value
    value = generate(arguments)
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0 if value["status"] == "completed" else 1


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(cli(sys.argv[1:]))
    serve()
