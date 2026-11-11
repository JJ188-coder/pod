#!/usr/bin/env python3
"""Only run through scripts/test-offline.mjs: a local /v2 gateway, no provider traffic."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

if os.environ.get("IMAGE_STUDIO_OFFLINE_TEST") != "1":
    raise SystemExit("Refusing bare network tests; use scripts/test-offline.mjs")

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "image2_mcp.py"
spec = importlib.util.spec_from_file_location("image2_mcp", SCRIPT)
image2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image2)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class FakeGateway:
    def __init__(self):
        self.requests = []
        self.post_status = 200
        self.poll_status = 200
        self.job_status = "succeeded"
        self.no_id = False
        self.bad_json = False
        self.disconnect = False
        self.url_result = False
        self.invalid_image = False
        self.download_failures = 0
        self.on_post = None
        self._counter = 0
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _json(self, code, payload):
                raw = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                with outer._lock:
                    outer._counter += 1
                    number = outer._counter
                    outer.requests.append({"method": "POST", "path": self.path, "body": body,
                                           "authorization": self.headers.get("Authorization"),
                                           "user_agent": self.headers.get("User-Agent")})
                if outer.on_post:
                    outer.on_post()
                if outer.disconnect:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                if outer.post_status != 200:
                    self._json(outer.post_status, {"error": {"message": "quota limit" if outer.post_status == 429 else "gateway failure"}})
                elif outer.bad_json:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"not json")
                elif outer.no_id:
                    self._json(200, {"jobs": []})
                else:
                    self._json(200, {"jobs": [{"id": f"job-{number}", "status": "queued"}]})

            def do_GET(self):
                with outer._lock:
                    outer.requests.append({"method": "GET", "path": self.path})
                if self.path == "/v1/models":
                    self._json(200, {"data": [{"id": "codex/gpt-image-2"}]})
                elif self.path.startswith("/v2/jobs?"):
                    if outer.poll_status != 200:
                        self._json(outer.poll_status, {"error": {"message": "poll unavailable"}})
                        return
                    ids = parse_qs(urlparse(self.path).query)["ids"][0].split(",")
                    result = {"url": f"{outer.base_url}/file.png"} if outer.url_result else {
                        "b64_json": base64.b64encode(b"not an image" if outer.invalid_image else PNG).decode()}
                    self._json(200, {"jobs": [{"id": identifier, "status": outer.job_status,
                                                "result": {"data": [result]}, "error": {"message": "generation failed"}}
                                               for identifier in ids]})
                elif self.path == "/file.png":
                    if outer.download_failures:
                        outer.download_failures -= 1
                        self._json(500, {"error": "download temporarily unavailable"})
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(PNG)))
                    self.end_headers()
                    self.wfile.write(PNG)
                else:
                    self._json(404, {"error": "not found"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def start(self):
        self.thread.start()
        return self

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def calls(self, method, prefix=""):
        return [entry for entry in self.requests if entry["method"] == method and entry["path"].startswith(prefix)]


class Image2Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="image2-v2-test-")
        self.root = Path(self.tmp.name).resolve()
        self.gateway = FakeGateway().start()
        self.env = patch.dict(os.environ, {"IMAGE2_BASE_URL": self.gateway.base_url,
            "IMAGE2_API_KEY": "offline-test-key", "IMAGE2_MODEL": "codex/gpt-image-2",
            "IMAGE2_AUTH_SCHEME": "bearer", "IMAGE2_DATA_DIR": str(self.root / "ledger")})
        self.env.start()

    def tearDown(self):
        self.gateway.close()
        self.env.stop()
        self.tmp.cleanup()

    def arguments(self, request_id="request-a", **updates):
        value = {"prompts": [{"prompt": "offline fixture image", "request_id": request_id}],
                 "output_dir": str(self.root / "out"), "concurrency": 1,
                 "max_wait_min": 0.02, "poll_seconds": 0.2}
        value.update(updates)
        return value

    def generate(self, request_id="request-a", **updates):
        return image2.generate(self.arguments(request_id, **updates))

    def resume(self, request_id="request-a"):
        return image2.image2_result({"request_id": request_id, "max_wait_min": 0.02, "poll_seconds": 0.2})

    def state_file(self, request_id="request-a"):
        return self.root / "ledger" / "requests" / request_id / "state.json"

    def batch(self, count=2, batch_id="test-batch"):
        jobs = [{"request_id": f"batch-job-{i}", "prompt": f"offline fixture {i}",
                 "output_file": str(self.root / "batch-out" / f"{i}.png")} for i in range(count)]
        file = self.root / "manifest.json"
        file.write_text(json.dumps({"batch_id": batch_id, "jobs": jobs}))
        return file, jobs

    def run_batch(self, file, **updates):
        return image2.run_batch({"manifest": str(file), "run": True, "concurrency": 1,
                                "max_wait_min": 0.02, "poll_seconds": 0.2, **updates})

    def test_v2_generation_saves_and_same_request_posts_once(self):
        first = self.generate()
        self.assertEqual(first["status"], "completed", first)
        result = first["results"][0]
        self.assertEqual(Path(result["path"]).read_bytes(), PNG)
        self.assertEqual(result["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual((result["width"], result["height"]), (1, 1))
        self.assertIn("size_warning", result)
        self.assertEqual(self.generate()["status"], "completed")
        posts = self.gateway.calls("POST")
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["path"], "/v2/images/generations")
        self.assertEqual(posts[0]["authorization"], "Bearer offline-test-key")
        self.assertEqual(posts[0]["user_agent"], "curl/8.7.1")
        self.assertEqual(json.loads(posts[0]["body"])["requests"][0]["prompt"], "offline fixture image")
        self.assertEqual(self.state_file().stat().st_mode & 0o777, 0o600)

    def test_edit_references_use_repeated_image_field_in_order(self):
        first = self.root / "one.png"; first.write_bytes(PNG + b"first")
        second = self.root / "two.png"; second.write_bytes(PNG + b"second")
        result = self.generate(images=[str(first), str(second)])
        self.assertEqual(result["status"], "completed", result)
        post = self.gateway.calls("POST")[0]
        self.assertEqual(post["path"], "/v2/images/edits")
        self.assertEqual(post["body"].count(b'name="image"'), 2)
        self.assertNotIn(b'name="image[]"', post["body"])
        self.assertLess(post["body"].index(PNG + b"first"), post["body"].index(PNG + b"second"))

    def test_request_id_conflict_never_posts_again(self):
        self.generate()
        changed = self.arguments()
        changed["prompts"][0]["prompt"] = "changed parameters"
        with self.assertRaisesRegex(RuntimeError, "已绑定"):
            image2.generate(changed)
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_auto_fingerprint_does_not_change_with_output_directory(self):
        args = self.arguments(); args["prompts"][0].pop("request_id")
        first = image2.generate(args)
        args["output_dir"] = str(self.root / "other-output")
        with self.assertRaisesRegex(RuntimeError, "已绑定"):
            image2.generate(args)
        self.assertEqual(len(self.gateway.calls("POST")), 1)
        self.assertTrue(first["results"][0]["request_id"].startswith("req-"))

    def test_unknown_submission_never_reposts_on_5xx_bad_json_missing_id_or_disconnect(self):
        for index, mode in enumerate(("5xx", "bad_json", "no_id", "disconnect")):
            with self.subTest(mode=mode):
                self.gateway.post_status = 503 if mode == "5xx" else 200
                self.gateway.bad_json = mode == "bad_json"
                self.gateway.no_id = mode == "no_id"
                self.gateway.disconnect = mode == "disconnect"
                rid = f"unknown-{index}"
                before = len(self.gateway.calls("POST"))
                for _ in range(2):
                    result = self.generate(rid)
                    self.assertEqual(result["results"][0]["status"], "submission_unknown", result)
                self.assertEqual(len(self.gateway.calls("POST")), before + 1)

    def test_submitting_crash_is_unknown_and_never_posts(self):
        config = image2.load_config()
        items, _, out = image2.normalize(self.arguments(), config)
        items[0]["output_dir"] = str(out)
        prepared = image2._prepare_request(items[0], config)
        state = image2._new_state(prepared); state["status"] = "submitting"
        image2._atomic_json(prepared["state_path"], state)
        self.assertEqual(self.generate()["results"][0]["status"], "submission_unknown")
        self.assertEqual(len(self.gateway.calls("POST")), 0)

    def test_pending_resume_only_queries_remote_id(self):
        self.gateway.job_status = "running"
        result = self.generate(max_wait_min=0)
        self.assertEqual(result["results"][0]["status"], "pending")
        self.gateway.job_status = "succeeded"
        self.assertEqual(self.resume()["status"], "succeeded")
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_download_failure_uses_persisted_result_without_requery_or_generation(self):
        self.gateway.url_result = True
        self.gateway.download_failures = 1
        result = self.generate()
        self.assertEqual(result["results"][0]["status"], "result_ready", result)
        state = json.loads(self.state_file().read_text())
        self.assertTrue(state["result"]["item"]["url"].endswith("/file.png"))
        polls = len(self.gateway.calls("GET", "/v2/jobs"))
        self.gateway.poll_status = 404
        self.assertEqual(self.resume()["status"], "succeeded")
        self.assertEqual(len(self.gateway.calls("GET", "/v2/jobs")), polls)
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_copy_failure_only_retries_copy(self):
        with patch.object(image2, "_copy_verified", side_effect=OSError("injected copy failure")):
            result = self.generate()
        self.assertEqual(result["results"][0]["status"], "result_ready", result)
        polls = len(self.gateway.calls("GET", "/v2/jobs"))
        self.assertEqual(self.resume()["status"], "succeeded")
        self.assertEqual(len(self.gateway.calls("POST")), 1)
        self.assertEqual(len(self.gateway.calls("GET", "/v2/jobs")), polls)

    def test_raw_already_saved_before_crash_does_not_regenerate(self):
        done = self.generate(); file = Path(done["results"][0]["path"])
        state = json.loads(self.state_file().read_text()); state["status"] = "result_ready"
        file.unlink(); image2._atomic_json(self.state_file(), state)
        self.gateway.poll_status = 404
        self.assertEqual(self.resume()["status"], "succeeded")
        self.assertEqual(file.read_bytes(), PNG)
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_output_tampering_is_a_conflict_not_a_cached_success(self):
        first = self.generate()
        file = Path(first["results"][0]["path"]); file.write_bytes(PNG + b"unrelated old image")
        again = self.generate()
        self.assertEqual(again["results"][0]["status"], "conflict", again)
        self.assertEqual(len(self.gateway.calls("POST")), 1)
        self.assertEqual(file.read_bytes(), PNG + b"unrelated old image")

    def test_auth_failure_does_not_retry_post_with_another_scheme(self):
        self.gateway.post_status = 401
        for _ in range(2):
            result = self.generate()
            self.assertEqual(result["results"][0]["status"], "blocked")
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_429_stops_remaining_single_call_and_batch_submissions(self):
        self.gateway.post_status = 429
        prompts = [{"prompt": f"offline {i}", "request_id": f"limited-{i}", "style_id": f"style-{i}"} for i in range(3)]
        value = self.generate(prompts=prompts)
        self.assertEqual(len(self.gateway.calls("POST")), 1, value)
        file, _ = self.batch(3)
        report = self.run_batch(file)
        self.assertFalse(report["ok"])
        self.assertEqual(len(self.gateway.calls("POST")), 2, report)
        self.assertEqual([row["state"] for row in report["jobs"]], ["blocked"] * 3)

    def test_poll_429_stops_queries_and_remaining_new_submissions(self):
        self.gateway.poll_status = 429
        file, _ = self.batch(3)
        report = self.run_batch(file)
        self.assertFalse(report["ok"])
        self.assertEqual(len(self.gateway.calls("POST")), 1, report)
        self.assertEqual(len(self.gateway.calls("GET", "/v2/jobs")), 1, report)

    def test_poll_5xx_stops_current_wait_but_can_resume_later(self):
        self.gateway.poll_status = 503
        first = self.generate()
        self.assertEqual(first["results"][0]["status"], "pending")
        self.assertEqual(len(self.gateway.calls("GET", "/v2/jobs")), 1)
        self.gateway.poll_status = 200
        self.assertEqual(self.resume()["status"], "succeeded")
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_batch_precheck_does_not_create_ledger_and_resume_posts_once(self):
        file, jobs = self.batch()
        precheck = self.run_batch(file, run=False)
        self.assertTrue(precheck["ok"])
        self.assertFalse((self.root / "ledger").exists())
        first = self.run_batch(file)
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["aggregate"]["saved"], 2)
        self.assertEqual(self.run_batch(file)["aggregate"]["saved"], 2)
        self.assertEqual(len(self.gateway.calls("POST")), 2)
        self.assertTrue(all(Path(job["output_file"]).read_bytes() == PNG for job in jobs))

    def test_existing_unrelated_output_blocks_entire_batch_before_post(self):
        file, jobs = self.batch()
        target = Path(jobs[1]["output_file"]); target.parent.mkdir(); target.write_bytes(PNG)
        result = self.run_batch(file)
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.gateway.calls("POST")), 0)

    def test_legacy_or_invalid_batch_ledger_is_not_overwritten(self):
        file, _ = self.batch()
        record = self.root / "ledger" / "batches" / "test-batch" / "batch.json"
        record.parent.mkdir(parents=True); original = b'{"legacy": true}'
        record.write_bytes(original)
        result = self.run_batch(file)
        self.assertFalse(result["ok"])
        self.assertEqual(record.read_bytes(), original)
        self.assertEqual(len(self.gateway.calls("POST")), 0)

    def test_manifest_drift_blocks_reuse_without_post(self):
        file, _ = self.batch(1)
        self.assertTrue(self.run_batch(file)["ok"])
        doc = json.loads(file.read_text()); doc["jobs"][0]["prompt"] = "changed"
        file.write_text(json.dumps(doc))
        report = self.run_batch(file)
        self.assertFalse(report["ok"])
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_cross_job_input_output_and_symlink_alias_are_rejected(self):
        file, jobs = self.batch()
        source = self.root / "ref.png"; source.write_bytes(PNG)
        jobs[0]["output_file"] = str(source)
        jobs[1]["reference_images"] = [str(source)]
        file.write_text(json.dumps({"batch_id": "conflict", "jobs": jobs}))
        with self.assertRaisesRegex(ValueError, "输出不能覆盖输入"):
            self.run_batch(file)
        jobs[0]["output_file"] = str(self.root / "ref-alias.png")
        (self.root / "ref-alias.png").symlink_to(source)
        file.write_text(json.dumps({"batch_id": "conflict", "jobs": jobs}))
        with self.assertRaises(ValueError):
            self.run_batch(file)
        self.assertEqual(len(self.gateway.calls("POST")), 0)

    def test_invalid_image_result_is_not_saved_or_regenerated(self):
        self.gateway.invalid_image = True
        result = self.generate()
        self.assertEqual(result["results"][0]["status"], "result_ready")
        self.assertNotIn("path", result["results"][0])
        self.resume()
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_request_lock_prevents_duplicate_posts_across_processes(self):
        file = self.root / "generate.json"; file.write_text(json.dumps(self.arguments()))
        command = [sys.executable, "-I", "-B", str(SCRIPT), "generate", "--spec", str(file)]
        children = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ.copy()) for _ in range(2)]
        for child in children:
            stdout, stderr = child.communicate(timeout=15)
            self.assertEqual(child.returncode, 0, (stdout, stderr))
            self.assertEqual(json.loads(stdout)["status"], "completed")
        self.assertEqual(len(self.gateway.calls("POST")), 1)

    def test_batch_concurrency_is_real_not_serialized_by_a_submit_gate(self):
        barrier = threading.Barrier(2, timeout=5)
        self.gateway.on_post = barrier.wait
        file, _ = self.batch(2)
        result = self.run_batch(file, concurrency=2)
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(self.gateway.calls("POST")), 2)

    def test_multi_result_terminal_failures_are_not_reported_as_pending(self):
        self.gateway.job_status = "failed"
        self.generate("failed-one"); self.generate("failed-two")
        result = image2.image2_result({"request_ids": ["failed-one", "failed-two"], "max_wait_min": 0})
        self.assertEqual(result["status"], "partial_failure", result)
        self.assertEqual([entry["status"] for entry in result["results"]], ["failed", "failed"])
        self.assertEqual(len(self.gateway.calls("POST")), 2)

    def test_batch_lock_is_kernel_held_and_reusable_without_unlinking(self):
        directory = self.root / "lock-test"
        fd = image2._acquire_lock(directory)
        lock = directory / "executor-v3.lock"
        inode = lock.stat().st_ino
        try:
            with self.assertRaisesRegex(RuntimeError, "持有批次锁"):
                image2._acquire_lock(directory)
            self.assertEqual(lock.stat().st_ino, inode)
        finally:
            image2._release_lock(fd)
        fd = image2._acquire_lock(directory)
        image2._release_lock(fd)
        self.assertEqual(lock.stat().st_ino, inode)
        legacy = directory / "executor.lock"; legacy.write_text('{"pid":1}')
        with self.assertRaisesRegex(RuntimeError, "旧版批次锁"):
            image2._acquire_lock(directory)
        self.assertTrue(legacy.exists())

    def test_check_is_readonly_and_does_not_generate(self):
        value = image2.doctor({})
        self.assertTrue(value["reachable"], value)
        self.assertNotIn("offline-test-key", json.dumps(value))
        self.assertEqual(len(self.gateway.calls("POST")), 0)
        self.assertFalse((self.root / "ledger").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
