import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getJobs, openDb, updateJob } from "../dist/core/db.js";
import { dbPath } from "../dist/core/paths.js";
import { prepareBatch } from "../dist/core/prepare.js";
import { readProgressSnapshot } from "../dist/progress/snapshot.js";
import { startProgressServer } from "../dist/progress/server.js";
import { cleanup, clearEnv, makeTempDir, setupEnv } from "./helpers.mjs";

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function prepareFixture() {
  const dir = makeTempDir();
  setupEnv("https://example.invalid", dir);
  const db = openDb();
  const prepared = await prepareBatch(db, {
    clientRequestId: "progress-fixture",
    jobs: [
      { prompt: "第一条", resolution: "480p", duration: 4, outputName: "hero" },
      { prompt: "第二条", resolution: "768p", duration: 6 },
      { prompt: "第三条", resolution: "768p", duration: 6 },
      { prompt: "第四条", resolution: "1080p", duration: 8 },
    ],
  });
  const jobs = getJobs(db, prepared.batchId);
  updateJob(db, jobs[0].id, { status: "running", progress: 55, provider_id: "p-55" });
  updateJob(db, jobs[1].id, { status: "running", progress: 0, provider_id: "p-0" });
  updateJob(db, jobs[2].id, { status: "accepted", progress: 0, provider_id: "p-accepted" });
  updateJob(db, jobs[3].id, {
    status: "succeeded",
    progress: 100,
    file_status: "download_failed",
    provider_id: "p-done",
    error: "下载中断\n请重试",
  });
  return { dir, db, batchId: prepared.batchId };
}

test("只读快照：阶段、进度质量与字段最小化", async (t) => {
  const fixture = await prepareFixture();
  t.after(() => {
    fixture.db.close();
    clearEnv();
    cleanup(fixture.dir);
  });

  const snapshot = readProgressSnapshot(fixture.batchId);
  assert.equal(snapshot.batch_id, fixture.batchId);
  assert.equal(snapshot.jobs.length, 4);
  assert.equal(snapshot.observed_at !== "", true);
  assert.equal(snapshot.counts.total, 4);
  assert.equal(snapshot.counts.generating, 2);
  assert.equal(snapshot.counts.accepted, 1);
  assert.equal(snapshot.counts.failed, 1);

  const running = snapshot.jobs[0];
  assert.equal(running.stage, "generating");
  assert.equal(running.progress, 55);
  assert.equal(running.progress_quality, "interface");
  assert.equal(running.display_name, "hero");
  assert.equal(running.params.resolution, "480p");
  assert.equal(running.params.duration, 4);

  const zero = snapshot.jobs[1];
  assert.equal(zero.progress, null);
  assert.equal(zero.progress_quality, "legacy_ambiguous");

  const accepted = snapshot.jobs[2];
  assert.equal(accepted.progress, null);
  assert.equal(accepted.progress_quality, "pending");

  const downloaded = snapshot.jobs[3];
  assert.equal(downloaded.stage, "download_failed");
  assert.equal(downloaded.progress, 100);
  assert.equal(downloaded.progress_quality, "complete");
  assert.equal(downloaded.safe_error, "下载中断 请重试");

  for (const job of snapshot.jobs) {
    assert.equal("prompt" in job, false);
    assert.equal("local_path" in job, false);
    assert.equal("remote_url" in job, false);
    assert.equal("provider_id" in job, false);
  }

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("第一条"), false);
  assert.equal(serialized.includes("test-key"), false);
});

test("只读快照：running=100 不视为完成，缺库与缺批次给出明确错误", async (t) => {
  const fixture = await prepareFixture();
  t.after(() => {
    fixture.db.close();
    clearEnv();
    cleanup(fixture.dir);
  });

  const jobs = getJobs(fixture.db, fixture.batchId);
  updateJob(fixture.db, jobs[0].id, { status: "running", progress: 100 });
  const snapshot = readProgressSnapshot(fixture.batchId);
  assert.equal(snapshot.jobs[0].progress, 100);
  assert.equal(snapshot.jobs[0].progress_quality, "interface_100_pending");
  assert.equal(snapshot.terminal, false);

  assert.throws(() => readProgressSnapshot("b-missing"), /批次不存在/);

  const missingDir = makeTempDir();
  process.env.MINIMAX_VIDEO_DATA_DIR = missingDir;
  assert.throws(() => readProgressSnapshot("b-any"), /任务记录尚不存在/);
  cleanup(missingDir);
});

test("只读连接拒绝对任务库写入", async (t) => {
  const fixture = await prepareFixture();
  t.after(() => {
    fixture.db.close();
    clearEnv();
    cleanup(fixture.dir);
  });

  const readOnly = new DatabaseSync(dbPath(), { readOnly: true });
  t.after(() => readOnly.close());
  assert.throws(
    () => readOnly.prepare("UPDATE jobs SET status = 'failed'").run(),
    /readonly|read-only|attempt to write/i,
  );
});

test("进度服务：页面、令牌、来源校验与只读语义", async (t) => {
  const fixture = await prepareFixture();
  const handle = await startProgressServer({ batchId: fixture.batchId, idleMs: 30_000 });
  const token = new URL(handle.url).hash.replace("#t=", "");

  t.after(async () => {
    await handle.close();
    fixture.db.close();
    clearEnv();
    cleanup(fixture.dir);
  });

  const page = await request(handle.port, "/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.body, /视频生成进度/);
  assert.match(page.body, /X-Progress-Token/);
  assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-content-type-options"], "nosniff");

  const noToken = await request(handle.port, "/api/state");
  assert.equal(noToken.status, 401);

  const wrongToken = await request(handle.port, "/api/state", {
    headers: { "x-progress-token": "0".repeat(48) },
  });
  assert.equal(wrongToken.status, 401);

  const state = await request(handle.port, "/api/state", {
    headers: { "x-progress-token": token },
  });
  assert.equal(state.status, 200);
  const snapshot = JSON.parse(state.body);
  assert.equal(snapshot.batch_id, fixture.batchId);
  assert.equal(snapshot.jobs.length, 4);

  const badHost = await request(handle.port, "/api/state", {
    headers: { host: "evil.example", "x-progress-token": token },
  });
  assert.equal(badHost.status, 403);

  const badOrigin = await request(handle.port, "/api/state", {
    headers: { origin: "http://evil.example", "x-progress-token": token },
  });
  assert.equal(badOrigin.status, 403);

  const post = await request(handle.port, "/api/state", {
    method: "POST",
    headers: { "x-progress-token": token },
  });
  assert.equal(post.status, 405);

  const attempts = getJobs(fixture.db, fixture.batchId).map((job) => job.attempts_submit);
  for (let index = 0; index < 3; index += 1) {
    const repeat = await request(handle.port, "/api/state", {
      headers: { "x-progress-token": token },
    });
    assert.equal(repeat.status, 200);
  }
  assert.deepEqual(
    getJobs(fixture.db, fixture.batchId).map((job) => job.attempts_submit),
    attempts,
    "刷新进度不能增加提交次数",
  );
});

test("进度服务空闲后自行关闭，且不影响任务记录", async (t) => {
  const fixture = await prepareFixture();
  const handle = await startProgressServer({ batchId: fixture.batchId, idleMs: 600 });

  t.after(() => {
    fixture.db.close();
    clearEnv();
    cleanup(fixture.dir);
  });

  assert.equal(handle.closed, false);
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(handle.closed, true);
  const jobs = getJobs(fixture.db, fixture.batchId);
  assert.equal(jobs.length, 4);
  assert.equal(fs.existsSync(dbPath()), true);
});
