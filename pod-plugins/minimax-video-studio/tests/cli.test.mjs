import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { cleanup, makeTempDir, readBody, startMockServer } from "./helpers.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const envFor = (dir, origin) => ({
  ...process.env,
  MINIMAX_VIDEO_DATA_DIR: dir,
  MINIMAX_VIDEO_API_KEY: "test-key",
  MINIMAX_VIDEO_BASE_URL: origin,
  MINIMAX_VIDEO_ALLOW_HTTP: "1",
  MINIMAX_VIDEO_CONCURRENCY: "",
});

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("CLI文件登记20条不生成；默认全量运行、恢复不重提、环境变量可以主动降并发", { timeout: 20000 }, async (t) => {
  const dir = makeTempDir();
  let posts = 0;
  const waiting = [];
  const mock = await startMockServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method === "POST") {
      await readBody(req);
      const id = ++posts;
      waiting.push(() => send({ id: `task-${id}` }));
      if (posts === 20) for (const release of waiting) release();
    } else if (url.pathname === "/v1/api/result") {
      send({ status: "succeeded", results: [{ url: `${mock.origin}/v.mp4` }] });
    } else {
      res.writeHead(200, { "content-type": "video/mp4" }); res.end(Buffer.alloc(2048, 1));
    }
  });
  t.after(async () => { await mock.close(); cleanup(dir); });
  const env = envFor(dir, mock.origin);
  delete env.MINIMAX_VIDEO_CONCURRENCY;
  const file = path.join(dir, "batch.json");
  fs.writeFileSync(file, JSON.stringify({
    client_request_id: "cli-20",
    jobs: Array.from({ length: 20 }, (_, i) => ({ prompt: `本地CLI测试${i}`, duration: 3, resolution: "480p", prompt_skill: false })),
  }));
  const prepare = () => JSON.parse(execFileSync(process.execPath, [cli, "prepare", "--file", file], { env, encoding: "utf8" }));
  const prepared = prepare();
  assert.equal(prepared.submitted_to_provider, false);
  assert.equal(prepared.counts.queued, 20);
  assert.equal(posts, 0);
  assert.doesNotMatch(prepared.run_command, /--concurrency/);
  assert.equal(prepare().batch_id, prepared.batch_id);
  const args = ["run", "--batch-id", prepared.batch_id, "--poll-min", "0.05", "--poll-max", "0.05", "--max-wait-min", "0.1"];
  const result = await runCli(args, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posts, 20);
  assert.equal(JSON.parse(result.stdout).counts.files_ready, 20);
  const resumed = await runCli(args, { ...env, MINIMAX_VIDEO_CONCURRENCY: "2" });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(posts, 20);
});

test("CLI拒绝无值/非法并发与格式不符清单，不退回默认全量执行", async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const env = envFor(dir, "https://example.invalid");
  delete env.MINIMAX_VIDEO_CONCURRENCY;
  for (const extra of [["--concurrency"], ["--concurrency", "0"], ["--concurrency", "1.5"], ["--concurrency", "Infinity"], ["--resume-blocked=false"]]) {
    const result = await runCli(["run", "--batch-id", "not-real", ...extra], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /concurrency|resume-blocked/);
  }
  const badEnv = await runCli(["run", "--batch-id", "not-real"], { ...env, MINIMAX_VIDEO_CONCURRENCY: "NaN" });
  assert.equal(badEnv.code, 1);
  assert.match(badEnv.stderr, /concurrency/);
  for (const input of [{ jobs: [] }, { jobs: [null] }, { jobs: [{ prompt: "valid", prompt_skill: "false" }] }, { jobs: [{ prompt: "valid", aspectRatio: "landscape" }] }]) {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify(input));
    const result = await runCli(["prepare", "--file", file], env);
    assert.equal(result.code, 1);
  }
});
