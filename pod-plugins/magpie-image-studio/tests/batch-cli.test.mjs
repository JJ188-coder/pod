import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeMagpie, inlineImageResult, textResult, TINY_PNG } from "./fake-magpie.mjs";
import { parseToolResult } from "../dist/core/magpie.js";

const CLI = process.env.MAGPIE_BATCH_CLI ?? fileURLToPath(new URL("../scripts/batch-images.mjs", import.meta.url));

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-batch-test-"));
  const fake = createFakeMagpie();
  const srv = await fake.start();
  const data = path.join(dir, "data");
  const env = {
    ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "home/.config"),
    IMAGE2_BASE_URL: "http://127.0.0.1:9", IMAGE2_API_KEY: "offline-test-key", IMAGE2_DATA_DIR: path.join(dir, "image2-data"),
    MAGPIE_IMAGE_DATA_DIR: data, ZCODE_PROJECT_DIR: path.join(dir, "project"),
    MAGPIE_IMAGE_URL: srv.endpoint, MAGPIE_IMAGE_GENERATE_BUDGET_MS: "8000", MAGPIE_IMAGE_RESULT_BUDGET_MS: "8000",
    MAGPIE_IMAGE_ALLOW_PRIVATE_DOWNLOAD: "false", MAGPIE_IMAGE_MAX_BYTES: "5242880",
  };
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const start = (file, args = [], extra = {}) => {
    const child = spawn(process.execPath, [CLI, "--provider", "magpie", "--manifest", file, ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    const done = new Promise((resolve) => child.once("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      let json;
      try { json = JSON.parse(stdout); } catch { json = { ok: false, error: `非JSON输出: ${stdout} ${stderr}` }; }
      resolve({ code, json, stderr });
    }));
    return { child, done };
  };
  const write = (doc, name = "manifest.json") => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  const job = (id, more = {}) => ({ request_id: `req-${id}`, prompt: `product ${id}`, output_file: path.join(dir, "out", `${id}.png`), ...more });
  const run = (file, args = ["--run", "--poll-seconds", "0.02"], extra) => start(file, args, extra).done;
  return { dir, data, fake, srv, write, job, run, start };
}

function errorResult(text) { return { ...textResult(text), isError: true }; }
async function waitUntil(check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待本地测试条件超时");
}

function readReport(f, batch) {
  return JSON.parse(fs.readFileSync(path.join(f.data, "batches", batch, "latest-report.json"), "utf8"));
}

test("isError 只有明确等待及ID才当pending；错误/限流/仅查询提示均拒绝", () => {
  const parse = (text) => parseToolResult({ ...errorResult(text), _meta: { "usemagpie.ai/pending": "img-1" } });
  assert.equal(parse('The image is still being made. Call generation_result with id "img-1".').kind, "pending");
  for (const text of ["quota exceeded", 'Call generation_result with id "img-1"', 'Generation failed. Call generation_result with id "img-1"', "still being made; HTTP 429", "generation continues; cancelled", "content policy violation"]) {
    assert.equal(parse(text).kind, "failed", text);
  }
});

test("全批静态预检拒绝非法参数、路径、重复项与假扩展；不建DB不发请求", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.dir, "source.png");
  fs.writeFileSync(source, TINY_PNG);
  const badDocs = [
    { batch_id: "..", jobs: [f.job(1)] },
    { batch_id: "bad", jobs: [f.job(1, { output_file: undefined })] },
    { batch_id: "bad", jobs: [f.job(1, { request_id: "../escape" })] },
    { batch_id: "bad", jobs: [f.job(1, { request_id: " x" })] },
    { batch_id: "bad", jobs: [f.job(1, { request_id: "x".repeat(201) })] },
    { batch_id: "bad", jobs: [f.job(1, { reference_images: [f.dir] })] },
    { batch_id: "bad", jobs: [f.job(1, { reference_images: [path.join(f.dir, "missing.png")] })] },
    { batch_id: "bad", jobs: [f.job(1), f.job(1)] },
    { batch_id: "bad", jobs: [f.job(1), f.job(2, { output_file: f.job(1).output_file })] },
    { batch_id: "bad", jobs: [f.job(1, { n: 2 })] },
    { batch_id: "bad", jobs: [f.job(1)], local_files: [{ source, output_file: path.join(f.dir, "wrong.jpg") }] },
  ];
  for (const doc of badDocs) {
    const result = await f.run(f.write(doc));
    assert.notEqual(result.code, 0);
    assert.equal(result.json.ok, false);
  }
  const good = f.write({ batch_id: "good", jobs: [f.job(1)] });
  for (const args of [["--concurrency", "NaN"], ["--concurrency", "1.5"], ["--concurrency", "0"], ["--max-wait-min", "-1"], ["--poll-seconds", "Infinity"], ["--poll-seconds"], ["--typo"],
    ["--manifest", good], ["--concurrency", "1", "--concurrency", "2"], ["--provider", "image2"]]) {
    assert.notEqual((await f.run(good, ["--run", ...args])).code, 0, args.join(" "));
  }
  const precheck = await f.run(good, []);
  assert.equal(precheck.json.mode, "precheck");
  assert.equal(precheck.json.ok, true);
  assert.equal(fs.existsSync(f.data), false);
  assert.equal(f.fake.state.generateCalls, 0);
});

test("Magpie备用批次保留商品参考锁、事实来源和输出SHA，不声明视觉通过", async (t) => {
  const f = await fixture(t);
  const ref = path.join(f.dir, "product.png"), facts = path.join(f.dir, "facts.json");
  fs.writeFileSync(ref, TINY_PNG); fs.writeFileSync(facts, '{"source":"offline fixture"}');
  const lock = { product_id: "TEST", color: "Navy", refs: [{ role: "product", file: ref }], review_status: "pending", policy_version: 1 };
  const job = f.job("locked-product", { reference_images: [ref], product_lock: lock, facts_source: facts,
    product_category: "garment", product_facts: ["Offline fixture only"] });
  f.fake.state.generateResponses.push(inlineImageResult({ status: "complete" }));
  const result = await f.run(f.write({ batch_id: "product-lock", jobs: [job] }));
  assert.equal(result.json.ok, true, JSON.stringify(result.json));
  assert.deepEqual(result.json.jobs[0].product_lock, lock);
  assert.equal(result.json.jobs[0].facts_source, facts);
  assert.match(result.json.jobs[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.json.jobs[0].product_lock.review_status, "pending");
});

test("80个AI任务与10张本地尺码图同批交付90图，每款平铺", async (t) => {
  const f = await fixture(t);
  f.fake.state.generateResponses.push(inlineImageResult({ status: "complete" }));
  const source = path.join(f.dir, "chart.png");
  fs.writeFileSync(source, TINY_PNG);
  const jobs = [], local_files = [];
  for (let p = 0; p < 10; p += 1) {
    const out = path.join(f.dir, `product-${p}`, "生成图");
    for (let i = 1; i <= 8; i += 1) jobs.push(f.job(`${p}-${i}`, { output_file: path.join(out, `0${i}-Blanco.png`) }));
    local_files.push({ source, output_file: path.join(out, "09-尺码.png") });
  }
  const manifest = f.write({ batch_id: "mixed", jobs, local_files });
  const result = await f.run(manifest);
  assert.equal(result.json.ok, true, JSON.stringify(result.json));
  assert.equal(result.json.aggregate.saved, 80);
  assert.equal(result.json.aggregate.local_copied, 10);
  assert.equal(f.fake.state.generateCalls, 80);
  for (let p = 0; p < 10; p += 1) assert.equal(fs.readdirSync(path.join(f.dir, `product-${p}`, "生成图"), { withFileTypes: true }).filter((x) => x.isFile()).length, 9);
  const again = await f.run(manifest);
  assert.equal(again.json.aggregate.deduped, 80);
  assert.equal(again.json.aggregate.submitted, 0);
  assert.equal(again.json.aggregate.saved, 80);
  assert.equal(f.fake.state.generateCalls, 80);
  assert.deepEqual(readReport(f, "mixed"), again.json);
});

test("真实90任务屏障：首个返回前90个generate全部进入，峰值=90，之后才查询", async (t) => {
  const f = await fixture(t);
  let release, active = 0, peak = 0, started = 0, timedOut = false;
  const barrier = new Promise((resolve) => { release = resolve; });
  const timer = setTimeout(() => { timedOut = true; release(); }, 6000);
  t.after(() => { clearTimeout(timer); release(); });
  f.fake.state.onGenerate = async () => {
    const id = ++started;
    active += 1;
    peak = Math.max(peak, active);
    if (started === 90) release();
    await barrier;
    active -= 1;
    return textResult({ id: `g-${id}`, status: "pending" });
  };
  let firstQueryStarted;
  f.fake.state.onResult = async ({ id }) => {
    firstQueryStarted ??= started;
    return inlineImageResult({ id, status: "complete" });
  };
  const result = await f.run(f.write({ batch_id: "barrier", jobs: Array.from({ length: 90 }, (_, i) => f.job(i)) }));
  clearTimeout(timer);
  assert.equal(timedOut, false, "屏障未集齐，不能宣称90并发");
  assert.equal(result.json.ok, true, JSON.stringify(result.json));
  assert.equal(peak, 90);
  assert.equal(firstQueryStarted, 90);
  assert.equal(f.fake.state.generateCalls, 90);
  assert.equal(f.fake.state.resultCalls, 90);
  assert.equal(result.json.aggregate.saved, 90);
});

test("pending超时及查询错误保留任务，重跑只查询不重新生成", async (t) => {
  const f = await fixture(t);
  f.fake.state.generateResponses.push(textResult({ id: "g1", status: "pending" }));
  f.fake.state.resultResponses.push(textResult({ id: "g1", status: "pending" }));
  const file = f.write({ batch_id: "resume", jobs: [f.job(1)] });
  const first = await f.run(file, ["--run", "--max-wait-min", "0.005", "--poll-seconds", "0.02"]);
  assert.equal(first.json.ok, false);
  assert.equal(first.json.aggregate.pending, 1);
  f.fake.state.resultResponses = [errorResult("HTTP 429 quota exceeded")];
  const denied = await f.run(file);
  assert.equal(denied.json.jobs[0].generation_state, "pending");
  assert.equal(denied.json.ok, false);
  f.fake.state.resultResponses = [inlineImageResult({ id: "g1", status: "complete" })];
  const done = await f.run(file);
  assert.equal(done.json.ok, true);
  assert.equal(f.fake.state.generateCalls, 1);
});

test("成功但下载失败续跑补保存；raw丢失不冒充已完成", async (t) => {
  const f = await fixture(t);
  f.fake.state.imageFailuresLeft = 2;
  f.fake.state.generateResponses.push(textResult({ id: "url1", status: "complete", url: f.srv.imageUrl("one.png") }));
  const file = f.write({ batch_id: "download", jobs: [f.job(1)] });
  const first = await f.run(file);
  assert.equal(first.json.ok, false);
  assert.equal(first.json.jobs[0].generation_state, "succeeded");
  assert.equal(first.json.jobs[0].state, "save_missing");
  const second = await f.run(file);
  assert.equal(second.json.ok, true, JSON.stringify(second.json));
  assert.equal(f.fake.state.generateCalls, 1);
  assert.equal(f.fake.state.resultCalls, 0);
  fs.unlinkSync(second.json.jobs[0].copied_from);
  const missing = await f.run(file);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.jobs[0].state, "save_missing");
  assert.equal(f.fake.state.generateCalls, 1);
});

test("提交断线没有ID时立即报告unknown，同清单不重发", async (t) => {
  const f = await fixture(t);
  const file = f.write({ batch_id: "unknown", jobs: [f.job(1)] });
  const before = Date.now();
  const first = await f.run(file, ["--run"], { MAGPIE_IMAGE_URL: "http://127.0.0.1:1/mcp" });
  assert.ok(Date.now() - before < 4000);
  assert.equal(first.json.aggregate.submission_unknown, 1);
  assert.equal(first.json.jobs[0].remote_id, null);
  const second = await f.run(file);
  assert.equal(second.json.aggregate.deduped, 1);
  assert.equal(second.json.aggregate.submitted, 0);
  assert.equal(f.fake.state.generateCalls, 0);
});

test("SDK超时也必须保留unknown；另一批次不能沿用同ID掩盖参考变化", async (t) => {
  const f = await fixture(t);
  f.fake.state.onGenerate = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return textResult({ id: "late-id", status: "pending" });
  };
  const file = f.write({ batch_id: "timeout", jobs: [f.job(1)] });
  const first = await f.run(file, ["--run"], { MAGPIE_IMAGE_GENERATE_BUDGET_MS: "1000" });
  assert.equal(first.json.aggregate.submission_unknown, 1, JSON.stringify(first.json));
  assert.equal(f.fake.state.generateCalls, 1);
  const again = await f.run(file);
  assert.equal(again.json.aggregate.submitted, 0);
  const another = await f.run(f.write({ batch_id: "different-batch", jobs: [f.job(1)] }, "another.json"));
  assert.equal(another.json.ok, false);
  assert.match(another.json.error, /另一批次/);
  assert.equal(f.fake.state.generateCalls, 1);
});

test("后置request冲突或已占用目标必须在整批新增提交之前失败", async (t) => {
  const f = await fixture(t);
  f.fake.state.generateResponses.push(inlineImageResult({ status: "complete" }));
  assert.equal((await f.run(f.write({ batch_id: "seed", jobs: [f.job(1)] }))).json.ok, true);
  const clash = await f.run(f.write({ batch_id: "clash", jobs: [f.job(2), f.job(1, { prompt: "different" })] }));
  assert.equal(clash.json.ok, false);
  assert.equal(clash.json.aggregate.submitted, 0);
  assert.equal(f.fake.state.generateCalls, 1);
  fs.writeFileSync(f.job(3).output_file, "existing unrelated image");
  const occupied = await f.run(f.write({ batch_id: "occupied", jobs: [f.job(2), f.job(3)] }));
  assert.equal(occupied.json.ok, false);
  assert.equal(f.fake.state.generateCalls, 1);
  assert.equal(fs.readFileSync(f.job(3).output_file, "utf8"), "existing unrelated image");
});

test("批次绑定本地引用及尺码内容，损坏记录不覆盖", async (t) => {
  const f = await fixture(t);
  const ref = path.join(f.dir, "ref.png"), chart = path.join(f.dir, "chart.png");
  fs.writeFileSync(ref, TINY_PNG);
  fs.writeFileSync(chart, TINY_PNG);
  f.fake.state.generateResponses.push(inlineImageResult({ status: "complete" }));
  const file = f.write({ batch_id: "binding", jobs: [f.job(1, { reference_images: [ref] })], local_files: [{ source: chart, output_file: path.join(f.dir, "out", "chart.png") }] });
  assert.equal((await f.run(file)).json.ok, true);
  const record = path.join(f.data, "batches", "binding", "batch.json");
  const original = fs.readFileSync(record, "utf8");
  fs.appendFileSync(ref, "changed");
  assert.equal((await f.run(file)).json.ok, false);
  assert.equal(fs.readFileSync(record, "utf8"), original);
  fs.writeFileSync(ref, TINY_PNG);
  fs.unlinkSync(path.join(f.dir, "out", "chart.png"));
  fs.appendFileSync(chart, "changed");
  assert.equal((await f.run(file)).json.ok, false);
  fs.writeFileSync(chart, TINY_PNG);
  fs.writeFileSync(record, "{broken");
  assert.equal((await f.run(file)).json.ok, false);
  assert.equal(fs.readFileSync(record, "utf8"), "{broken");
  assert.equal(f.fake.state.generateCalls, 1);
});

test("同批不同清单并发不能覆盖绑定；死锁接管仅续跑", async (t) => {
  const f = await fixture(t);
  f.fake.state.generateResponses.push(textResult({ id: "locked1", status: "pending" }));
  f.fake.state.resultResponses.push(textResult({ id: "locked1", status: "pending" }));
  const file = f.write({ batch_id: "locked", jobs: [f.job(1)] });
  const first = f.start(file, ["--run", "--poll-seconds", "10"]);
  await waitUntil(() => f.fake.state.resultCalls >= 1);
  const record = path.join(f.data, "batches", "locked", "batch.json");
  const original = fs.readFileSync(record, "utf8");
  const second = await f.run(f.write({ batch_id: "locked", jobs: [f.job(2)] }, "different.json"));
  assert.equal(second.json.ok, false);
  assert.match(second.json.error, /持有锁/);
  assert.equal(fs.readFileSync(record, "utf8"), original);
  first.child.kill("SIGKILL");
  await first.done;
  f.fake.state.resultResponses = [inlineImageResult({ id: "locked1", status: "complete" })];
  const third = await f.run(file);
  assert.equal(third.json.ok, true, JSON.stringify(third.json));
  assert.equal(f.fake.state.generateCalls, 1);
});

test("小并发遇401/403/429/配额停止尚未派发任务，不自动重试失败项", async (t) => {
  const f = await fixture(t);
  f.fake.state.generateResponses.push(errorResult("HTTP 429 quota exceeded"));
  const file = f.write({ batch_id: "throttle", jobs: [f.job(1), f.job(2), f.job(3)] });
  const first = await f.run(file, ["--run", "--concurrency", "1"]);
  assert.equal(f.fake.state.generateCalls, 1);
  assert.equal(first.json.aggregate.failed, 1);
  assert.equal(first.json.aggregate.blocked, 2);
  assert.equal(first.json.ok, false);
  const again = await f.run(file, ["--run", "--concurrency", "1"]);
  assert.equal(again.json.aggregate.blocked, 2);
  assert.equal(f.fake.state.generateCalls, 1, "重启不能自动绕过账本中的限流错误");
});

test("单项复制异常仍输出全批汇总，不能将冲突旧文件标为copied_to", async (t) => {
  const f = await fixture(t);
  const a = f.job(1), b = f.job(2, { output_file: path.join(f.dir, "bad-parent", "two.png") }), c = f.job(3);
  f.fake.state.onGenerate = async () => {
    fs.mkdirSync(path.dirname(a.output_file), { recursive: true });
    fs.writeFileSync(a.output_file, "do not replace");
    fs.writeFileSync(path.dirname(b.output_file), "not a directory");
    return inlineImageResult({ status: "complete" });
  };
  const result = await f.run(f.write({ batch_id: "copy-errors", jobs: [a, b, c] }));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.jobs.length, 3);
  assert.equal(result.json.jobs[0].state, "conflict");
  assert.equal(result.json.jobs[1].state, "conflict");
  assert.equal(result.json.jobs[2].state, "saved");
  assert.equal(result.json.jobs[0].files[0].copied_to, null);
  assert.equal(result.json.jobs[0].sha256, undefined);
  assert.equal(fs.readFileSync(a.output_file, "utf8"), "do not replace");
  assert.equal(result.json.aggregate.saved, 1);
  assert.deepEqual(readReport(f, "copy-errors"), result.json);
});

test("local-only无需网络；生成格式不符保留原图但不伪装目标扩展", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.dir, "src.png");
  fs.writeFileSync(source, TINY_PNG);
  const local = await f.run(f.write({ batch_id: "local", local_files: [{ source, output_file: path.join(f.dir, "flat", "09.png") }] }));
  assert.equal(local.json.ok, true);
  assert.equal(fs.existsSync(path.join(f.data, "state.db")), false);
  assert.equal(f.fake.state.generateCalls, 0);
  f.fake.state.generateResponses.push(inlineImageResult({ status: "complete" }));
  const wrong = await f.run(f.write({ batch_id: "format", jobs: [f.job(1, { output_file: path.join(f.dir, "out.jpg") })] }));
  assert.equal(wrong.json.ok, false);
  assert.equal(wrong.json.jobs[0].state, "conflict");
  assert.equal(fs.existsSync(path.join(f.dir, "out.jpg")), false);
  assert.equal(fs.existsSync(wrong.json.jobs[0].files[0].path), true);
});
