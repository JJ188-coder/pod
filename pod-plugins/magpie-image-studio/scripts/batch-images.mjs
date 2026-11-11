#!/usr/bin/env node
/** 整批图片：默认只读预检；--run 并发提交、续查和防覆盖归档。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, findTaskByRequestId, getArtifacts } from "../dist/core/db.js";
import { generateImageTask, refreshImageTask, normalizeGenerateParams, hashParams } from "../dist/core/flow.js";
import { loadConfig } from "../dist/core/config.js";
import { dataDir } from "../dist/core/paths.js";
import { readImageDimensions, sniffImage } from "../dist/core/artifacts.js";
import { isAccessOrQuotaError } from "../dist/core/magpie.js";
import { sha256, stableStringify } from "../dist/core/util.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const finished = (entry) => ["saved", "reused"].includes(entry.state);
const messageOf = (error) => String(error?.message ?? error).replace(/https?:\/\/[^\s"<>]+/g, "[图片或服务地址]");
const fileHash = (file) => sha256(fs.readFileSync(file));

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

function parseArgs(argv) {
  const args = { run: false, maxWaitMin: 60, pollSeconds: 20, provider: "image2" };
  const values = { "--manifest": "manifest", "--concurrency": "concurrency", "--max-wait-min": "maxWaitMin", "--poll-seconds": "pollSeconds", "--provider": "provider" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    requireValue(!seen.has(flag), `参数不能重复：${flag}`);
    seen.add(flag);
    if (flag === "--run") args.run = true;
    else if (flag === "--json") continue;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else {
      requireValue(Object.hasOwn(values, flag), `未知参数：${flag}`);
      const value = argv[++i];
      requireValue(value && !value.startsWith("--"), `${flag} 缺少值`);
      args[values[flag]] = ["--manifest", "--provider"].includes(flag) ? value : Number(value);
    }
  }
  for (const key of ["maxWaitMin", "pollSeconds", "concurrency"]) {
    if (args[key] !== undefined) requireValue(Number.isFinite(args[key]) && args[key] > 0, `${key} 必须为有限正数`);
  }
  if (args.concurrency !== undefined) requireValue(Number.isSafeInteger(args.concurrency), "concurrency 必须为正整数");
  requireValue(args.maxWaitMin <= 1440 && args.pollSeconds <= 86400, "等待/轮询上限不能超过24小时");
  requireValue(["image2", "magpie"].includes(args.provider), `provider 只支持 image2 或 magpie：${args.provider}`);
  return args;
}

/** image2 通道由同目录的 Python 实现执行（multipart/鉴权/重试只有一份代码）。 */
function runImage2(args) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "image2_mcp.py");
  const argv = ["batch", "--manifest", path.resolve(args.manifest), "--concurrency", String(args.concurrency ?? 20),
    "--max-wait-min", String(args.maxWaitMin), "--poll-seconds", String(args.pollSeconds)];
  if (args.run) argv.push("--run");
  const child = spawnSync("python3", ["-I", "-B", script, ...argv], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  try {
    return JSON.parse(child.stdout);
  } catch {
    return {
      ok: false,
      mode: args.run ? "run" : "precheck",
      provider: "image2",
      error: `image2 批次执行失败（exit ${child.status}）：${String(child.stderr || child.stdout || "").slice(0, 800)}`,
    };
  }
}

function checkId(value, label) {
  requireValue(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) && !value.includes(".."), `${label} 必须为1–200位安全字母数字标识，不含空格、斜杠或 ..`);
}

function absolute(file) {
  requireValue(typeof file === "string" && path.isAbsolute(file) && !file.includes("\0") && file === file.trim(), "文件必须使用非空绝对路径");
  return path.resolve(file);
}

function inputFile(file) {
  file = absolute(file);
  requireValue(fs.existsSync(file), `文件不存在：${file}`);
  requireValue(fs.statSync(file).isFile(), `不是普通文件：${file}`);
  return fs.realpathSync(file);
}

function outputFile(file) {
  file = absolute(file);
  requireValue(IMAGE_EXTS.has(path.extname(file).toLowerCase()), `output_file 必须有图片扩展名：${file}`);
  const rest = [];
  let parent = path.dirname(file);
  while (!fs.existsSync(parent)) {
    rest.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  requireValue(fs.statSync(parent).isDirectory(), `输出父路径不是目录：${parent}`);
  fs.accessSync(parent, fs.constants.W_OK);
  file = path.join(fs.realpathSync(parent), ...rest, path.basename(file));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  requireValue(!stat || (stat.isFile() && !stat.isSymbolicLink()), `输出已被非普通文件占用：${file}`);
  return file;
}

function imageBuffer(source, target) {
  const buffer = fs.readFileSync(source);
  const image = sniffImage(buffer);
  const declared = path.extname(target).toLowerCase().replace(/^\.jpeg$/, ".jpg");
  requireValue(image && `.${image.ext}` === declared, `目标声明 ${path.extname(target)} 但源是 ${image?.ext ?? "未知格式"}，不伪装写入`);
  return buffer;
}

function readManifest(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  requireValue(doc && typeof doc === "object" && !Array.isArray(doc), "清单根必须为对象");
  checkId(doc.batch_id, "batch_id");
  const jobs = doc.jobs ?? [];
  const localFiles = doc.local_files ?? [];
  requireValue(Array.isArray(jobs) && Array.isArray(localFiles) && jobs.length + localFiles.length > 0, "jobs/local_files 必须为数组且不能同时为空");
  const errors = [];
  const targets = new Set();
  const ids = new Set();
  const inputs = new Map();
  const registerInput = (file) => {
    const real = inputFile(file);
    inputs.set(real, fileHash(real));
  };
  const registerOutput = (item) => {
    const target = outputFile(item.output_file);
    // macOS 常见文件系统大小写不敏感，保守拒绝仅大小写不同的目标。
    const key = target.toLowerCase();
    requireValue(!targets.has(key), `output_file 重复：${target}`);
    targets.add(key);
    return target;
  };
  const entries = jobs.map((job, index) => {
    try {
      requireValue(job && typeof job === "object" && !Array.isArray(job), "任务必须为对象");
      checkId(job.request_id, "request_id");
      requireValue(!ids.has(job.request_id), `request_id 重复：${job.request_id}`);
      ids.add(job.request_id);
      requireValue(job.n === undefined || job.n === 1, "每项 n 必须为1");
      const params = normalizeGenerateParams({ ...job, n: 1 });
      for (const ref of params.reference_images ?? []) registerInput(ref);
      const product = job.product_lock ? { product_lock: job.product_lock, product_category: job.product_category,
        product_facts: job.product_facts, facts_source: job.facts_source, facts_source_sha256: job.facts_source_sha256 } : {};
      if (job.facts_source) registerInput(job.facts_source);
      return { request_id: job.request_id, params, output_file: registerOutput(job), ...product };
    } catch (error) {
      errors.push(`jobs[${index}]: ${messageOf(error)}`);
    }
  });
  const locals = localFiles.map((item, index) => {
    try {
      requireValue(item && typeof item === "object" && !Array.isArray(item), "本地文件项必须为对象");
      registerInput(item.source);
      const target = registerOutput(item);
      const buffer = imageBuffer(item.source, target);
      requireValue(!fs.existsSync(target) || fs.readFileSync(target).equals(buffer), `目标已存在不同内容：${target}`);
      return { source: inputFile(item.source), output_file: target };
    } catch (error) {
      errors.push(`local_files[${index}]: ${messageOf(error)}`);
    }
  });
  for (const file of inputs.keys()) {
    if (targets.has(file.toLowerCase())) errors.push(`输出不能覆盖输入文件：${file}`);
  }
  if (errors.length) throw Object.assign(new Error("清单预校验失败，未产生生成请求"), { detail: errors });
  const inputHashes = [...inputs].sort(([a], [b]) => a.localeCompare(b));
  return { doc, entries, locals, hash: sha256(stableStringify({ manifest: doc, input_hashes: inputHashes })) };
}

function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function deadOwner(file) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (owner.host !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "executor.lock");
  const token = randomUUID();
  const temp = path.join(dir, `executor.${token}.tmp`);
  fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { flag: "wx", mode: 0o600 });
  try {
    try { fs.linkSync(temp, file); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 串行回收确定死亡的锁；回收中崩溃则保守阻塞，不能删除活进程的新锁。
      const reclaim = `${file}.reclaim`;
      let fd;
      try {
        fd = fs.openSync(reclaim, "wx", 0o600);
        requireValue(deadOwner(file), "已有执行器持有锁；无法确定死亡的锁不会自动移除");
        fs.unlinkSync(file);
        fs.linkSync(temp, file);
      } catch (error) {
        throw new Error(`已有执行器持有锁或锁待人工核对：${messageOf(error)}`);
      } finally {
        if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(reclaim); }
      }
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(file, "utf8"));
      if (owner.token === token) fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") process.stderr.write(`批次锁释放需核对：${messageOf(error)}\n`);
    }
  };
}

function copyImage(source, target, expectedSha) {
  const buffer = imageBuffer(source, target);
  const digest = sha256(buffer);
  requireValue(!expectedSha || digest === expectedSha, "原始图片内容已变化，不能当作已验收结果复制");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.part`;
  let state = "saved";
  try {
    fs.writeFileSync(temp, buffer, { flag: "wx" });
    try { fs.linkSync(temp, target); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = fs.lstatSync(target);
      requireValue(stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(target).equals(buffer), "目标已存在不同内容，未覆盖");
      state = "reused";
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { state, sha256: digest, bytes: buffer.length, dimensions: readImageDimensions(target), copied_from: source, copied_to: target };
}

async function pool(items, concurrency, worker) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) await worker(items[index++]);
  }));
}

function taskState(entry, task) {
  entry.task_id = task.id;
  entry.remote_id = task.remote_id;
  entry.generation_state = task.generation_state;
  entry.state = task.generation_state;
  entry.error = task.error ? messageOf(task.error) : null;
  if (["submitting", "submission_unknown", "pending"].includes(entry.state) && !task.remote_id) {
    entry.note = "没有远端任务ID，停止等待；需人工核对/补填ID，不自动重发。";
  }
}

function summarize(report) {
  const jobs = report.jobs;
  const locals = report.local_files;
  report.aggregate = {
    jobs_total: jobs.length, local_files_total: locals.length,
    submitted: jobs.filter((e) => e.submitted).length,
    deduped: jobs.filter((e) => e.deduped).length,
    succeeded: jobs.filter((e) => e.generation_state === "succeeded").length,
    saved: jobs.filter(finished).length,
    pending: jobs.filter((e) => e.generation_state === "pending").length,
    submission_unknown: jobs.filter((e) => ["submitting", "submission_unknown"].includes(e.generation_state)).length,
    failed: jobs.filter((e) => ["failed", "save_missing", "copy_failed"].includes(e.state)).length,
    blocked: jobs.filter((e) => e.state === "blocked").length,
    local_copied: locals.filter(finished).length,
    local_conflicts: locals.filter((e) => !finished(e)).length,
    output_conflicts: [...jobs, ...locals].filter((e) => e.state === "conflict").length,
  };
  report.ok = !report.error && [...jobs, ...locals].every(finished);
  report.finished_at = new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return { ok: true, usage: "node scripts/batch-images.mjs --manifest /abs/batch.json [--provider image2|magpie] [--run] [--concurrency N] [--max-wait-min 60] [--poll-seconds 20]" };
  requireValue(args.manifest, "缺少 --manifest");
  if (args.provider === "image2") return runImage2(args);
  const { doc, entries, locals, hash } = readManifest(path.resolve(args.manifest));
  const dir = path.join(dataDir(), "batches", doc.batch_id);
  const concurrency = Math.min(args.concurrency ?? entries.length, entries.length) || 1;
  if (!args.run) return {
    ok: true, mode: "precheck", batch_id: doc.batch_id, manifest_hash: hash,
    counts: { jobs: entries.length, local_files: locals.length }, concurrency,
    note: "仅静态文件/参数预检，未建DB、未联网；--run 会在提交前整批检查账本与目标冲突。",
  };

  const release = acquireLock(dir);
  let db;
  let report;
  try {
    const recordFile = path.join(dir, "batch.json");
    if (fs.existsSync(recordFile)) {
      const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      requireValue(record?.batch_id === doc.batch_id && record?.manifest_hash === hash, "batch_id 已绑定到不同的清单内容或本地输入已变化；拒绝覆盖批次记录");
    }
    const config = loadConfig();
    report = {
      ok: false, mode: "run", batch_id: doc.batch_id, manifest_hash: hash, batch_dir: dir, concurrency,
      jobs: entries.map(({ params: _params, ...e }, i) => ({ ...e, output_dir: path.join(dir, "raw", `job-${String(i + 1).padStart(3, "0")}-${e.request_id}`), state: "queued", submitted: false, deduped: false })),
      local_files: locals.map((e) => ({ ...e, state: "queued" })),
      started_at: new Date().toISOString(),
    };
    if (entries.length) db = openDb();
    const prior = new Map();
    const errors = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = report.jobs[i];
      const task = findTaskByRequestId(db, entry.request_id);
      if (task) prior.set(entry.request_id, task);
      if (task && task.request_hash !== hashParams(entries[i].params)) errors.push(`${entry.request_id}: 已用于不同的生成参数`);
      if (task && task.output_dir !== entry.output_dir) errors.push(`${entry.request_id}: 属于另一批次/单图任务，请恢复原清单而非跨批复用ID`);
      if (fs.existsSync(entry.output_file)) {
        const digest = fileHash(entry.output_file);
        const first = task && getArtifacts(db, task.id).find((a) => a.ordinal === 0);
        if (!first?.sha256 || first.sha256 !== digest) errors.push(`${entry.request_id}: 目标已存在不同或无法核对的内容`);
      }
    }
    requireValue(!errors.length, `提交前整批检查失败：${errors.join("；")}`);
    if (!fs.existsSync(recordFile)) writeJson(recordFile, { batch_id: doc.batch_id, manifest_hash: hash, created_at: report.started_at });

    for (const entry of report.local_files) {
      try { Object.assign(entry, copyImage(entry.source, entry.output_file)); }
      catch (error) { entry.state = "conflict"; entry.error = messageOf(error); }
    }
    requireValue(report.local_files.every(finished), "本地尺码图归档失败，未提交新的生成任务");
    const deadline = Date.now() + args.maxWaitMin * 60_000;
    let stopReason = [...prior.values()].some((task) => isAccessOrQuotaError(task.error ?? ""))
      ? "账本仍有认证/限流/额度错误，未派发任务保持阻塞；先解决原错误并核对记录，不自动绕过。" : null;
    const paramsById = new Map(entries.map((entry) => [entry.request_id, entry.params]));
    await pool(report.jobs, concurrency, async (entry) => {
      const existing = prior.get(entry.request_id);
      if (existing) { taskState(entry, existing); entry.deduped = true; return; }
      if (stopReason) { entry.state = "blocked"; entry.note = stopReason; return; }
      try {
        const params = paramsById.get(entry.request_id);
        const result = await generateImageTask(db, { requestId: entry.request_id, outputDir: entry.output_dir, params }, config);
        taskState(entry, result.task);
        entry.deduped = result.deduped;
        entry.submitted = !result.deduped;
        entry.save_failures = result.saveFailures.map((e) => ({ ...e, error: messageOf(e.error) }));
        if (isAccessOrQuotaError(entry.error ?? "")) stopReason = "认证/限流/额度受阻，停止尚未派发任务；已提交项保留，不自动重发。";
      } catch (error) {
        const claimed = findTaskByRequestId(db, entry.request_id);
        if (claimed) { taskState(entry, claimed); entry.submitted = true; }
        else entry.state = "failed";
        entry.error = messageOf(error);
        stopReason = "提交发生异常，停止剩余新任务；先核对账本，不自动重发。";
      }
    });

    const refresh = async (entry) => {
      try {
        const result = await refreshImageTask(db, { taskId: entry.task_id }, config);
        taskState(entry, result.task);
        entry.note = messageOf(result.note);
        entry.save_failures = result.saveFailures.map((e) => ({ ...e, error: messageOf(e.error) }));
        if (/查询失败/.test(result.note)) entry.poll_stopped = true;
        if (isAccessOrQuotaError(result.note)) stopReason = "查询遇到认证/限流/额度限制，已停止自动查询。";
      } catch (error) {
        entry.note = `查询/补保存异常：${messageOf(error)}；保留任务，稍后续跑。`;
        entry.poll_stopped = true;
      }
    };
    // 提交阶段全部返回后才查询；已成功但下载失败的任务只补保存一次。
    await pool(report.jobs.filter((e) => e.generation_state === "succeeded" && (e.deduped || e.save_failures?.length)), concurrency, async (e) => {
      if (!stopReason) await refresh(e);
    });
    const pending = () => report.jobs.filter((e) => ["pending", "submitting", "submission_unknown"].includes(e.generation_state) && e.remote_id && !e.poll_stopped);
    while (!stopReason && pending().length && Date.now() < deadline) {
      await pool(pending(), concurrency, async (e) => { if (!stopReason) await refresh(e); });
      const remaining = deadline - Date.now();
      if (!stopReason && pending().length && remaining > 0) await new Promise((r) => setTimeout(r, Math.min(args.pollSeconds * 1000, remaining)));
    }
    for (const entry of pending()) entry.note = stopReason ?? "达到等待上限；保留原任务，用同一清单续跑，不重复生成。";
    if (stopReason) report.stop_reason = stopReason;

    for (const entry of report.jobs) {
      if (!entry.task_id) continue;
      const artifacts = getArtifacts(db, entry.task_id);
      entry.files = artifacts.map((a) => ({ ordinal: a.ordinal + 1, file_state: a.file_state, path: a.local_path, sha256: a.sha256, copied_to: null }));
      if (entry.generation_state !== "succeeded") continue;
      const first = artifacts.find((a) => a.ordinal === 0 && a.file_state === "ready");
      if (!first?.local_path || !fs.existsSync(first.local_path)) {
        entry.state = "save_missing";
        entry.error = "远端生成完成但原始图片未保存或已丢失；不声明完成、不重新生成。";
        continue;
      }
      try {
        Object.assign(entry, copyImage(first.local_path, entry.output_file, first.sha256));
        entry.error = null;
        entry.files.find((f) => f.ordinal === 1).copied_to = entry.output_file;
      } catch (error) {
        entry.state = "conflict";
        entry.error = messageOf(error);
      }
    }
  } catch (error) {
    if (!report) throw error;
    report.error = messageOf(error);
    for (const entry of [...report.jobs, ...report.local_files]) {
      if (entry.state === "queued") entry.state = "blocked";
    }
  } finally {
    try {
      if (report) { summarize(report); writeJson(path.join(dir, "latest-report.json"), report); }
    } finally {
      try { db?.close(); } finally { release(); }
    }
  }
  return report;
}

main().then((report) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 3;
}).catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: messageOf(error), detail: error.detail }, null, 2)}\n`);
  process.exitCode = 2;
});
