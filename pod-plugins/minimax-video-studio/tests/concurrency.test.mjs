import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireLease, abandonJob, attachProviderId, claimNextQueued, finalizeBatch, getBatch, getJobs, openDb, refreshLease, updateJob } from "../dist/core/db.js";
import { prepareBatch } from "../dist/core/prepare.js";
import { runBatch } from "../dist/core/runner.js";
import { normalizeConcurrency } from "../dist/core/validate.js";
import { Provider } from "../dist/core/provider.js";
import { loadConfig } from "../dist/core/config.js";
import { refreshBatch } from "../dist/core/refresh.js";
import { cleanup, clearEnv, makeTempDir, readBody, setupEnv, startMockServer } from "./helpers.mjs";

const response = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const video = () => new Response(Buffer.alloc(2048, 3), { headers: { "content-type": "video/mp4" } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const options = { pollMinMs: 50, pollMaxMs: 50, maxWaitMs: 5000 };

async function fixture(t, count, id = "concurrency", origin = "https://example.invalid") {
  const dir = makeTempDir();
  setupEnv(origin, dir);
  const db = openDb();
  t.after(() => { db.close(); clearEnv(); cleanup(dir); });
  const batch = await prepareBatch(db, {
    clientRequestId: id,
    jobs: Array.from({ length: count }, (_, i) => ({ prompt: `视频 ${i + 1}`, resolution: "480p", duration: 3 })),
  });
  return { dir, db, batchId: batch.batchId };
}

function successFetch(onSubmit) {
  return async (input, init = {}) => {
    if (init.method === "POST") return onSubmit(input, init);
    if (String(input).includes("/v1/api/result")) {
      return response({ status: "succeeded", results: [{ url: "https://cdn.example.invalid/video.mp4" }] });
    }
    assert.equal(String(input), "https://cdn.example.invalid/video.mp4");
    return video();
  };
}

test("20条真实HTTP屏障：首个受理响应前全批到达，查询4/下载2独立限流，重跑不重提", { timeout: 15000 }, async (t) => {
  const barrier = deferred();
  const entered = deferred();
  let posts = 0, activePosts = 0, peakPosts = 0;
  let activeQueries = 0, peakQueries = 0, activeDownloads = 0, peakDownloads = 0;
  const mock = await startMockServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method === "POST" && url.pathname === "/v1/api/generate") {
      await readBody(req);
      const id = ++posts;
      peakPosts = Math.max(peakPosts, ++activePosts);
      if (posts === 20) entered.resolve();
      await barrier.promise;
      activePosts--;
      send({ id: `task-${id}` });
    } else if (url.pathname === "/v1/api/result") {
      assert.equal(posts, 20);
      peakQueries = Math.max(peakQueries, ++activeQueries);
      await sleep(20);
      activeQueries--;
      send({ status: "succeeded", results: [{ url: `${mock.origin}/video.mp4` }] });
    } else if (url.pathname === "/video.mp4") {
      peakDownloads = Math.max(peakDownloads, ++activeDownloads);
      await sleep(20);
      activeDownloads--;
      res.writeHead(200, { "content-type": "video/mp4" }); res.end(Buffer.alloc(2048, 7));
    } else { res.writeHead(404); res.end(); }
  });
  t.after(() => mock.close());
  const { db, batchId } = await fixture(t, 20, "barrier20", mock.origin);
  const run = runBatch(db, { ...options, batchId, providerOptions: { submitTimeoutMs: 2000, pollTimeoutMs: 2000 } });
  let timer;
  try {
    await Promise.race([entered.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("20条未同时到达")), 3000);
    })]);
    assert.equal(peakPosts, 20);
    await assert.rejects(runBatch(db, { batchId }), /已有后台执行器/);
  } finally {
    clearTimeout(timer);
    barrier.resolve();
    await run;
  }
  const result = await run;
  assert.equal(result.exit_reason, "done");
  assert.equal(result.counts.files_ready, 20);
  assert.equal(new Set(result.jobs.map((job) => job.provider_id)).size, 20);
  assert.equal(peakQueries, 4);
  assert.equal(peakDownloads, 2);
  assert.ok(result.jobs.every((job) => job.attempts_submit === 1));
  const again = await runBatch(db, { ...options, batchId });
  assert.equal(again.exit_reason, "done");
  assert.equal(posts, 20);
});

test("显式并发2确实同时提交2条，且生成完成前不释放名额", async (t) => {
  const { db, batchId } = await fixture(t, 6);
  let posts = 0, activePosts = 0, peakPosts = 0, peakActive = 0;
  const fetchImpl = successFetch(async () => {
    const id = ++posts;
    peakPosts = Math.max(peakPosts, ++activePosts);
    peakActive = Math.max(peakActive, getJobs(db, batchId).filter((job) => ["submitting", "accepted", "running"].includes(job.status)).length);
    await sleep(20);
    activePosts--;
    return response({ id: `task-${id}` });
  });
  const result = await runBatch(db, { ...options, batchId, concurrency: 2, providerOptions: { fetchImpl } });
  assert.equal(result.exit_reason, "done");
  assert.equal(posts, 6);
  assert.equal(peakPosts, 2);
  assert.equal(peakActive, 2);
});

test("默认全批提交不被其他批次的未知任务占用固定名额", async (t) => {
  const { db, batchId } = await fixture(t, 20, "default-no-global-cap");
  const other = await prepareBatch(db, { clientRequestId: "other", jobs: [{ prompt: "其他批次" }] });
  updateJob(db, other.jobs[0].id, { status: "submission_unknown" });
  let posts = 0;
  const fetchImpl = successFetch(async () => response({ id: `task-${++posts}` }));
  const result = await runBatch(db, { ...options, batchId, providerOptions: { fetchImpl } });
  assert.equal(result.exit_reason, "done");
  assert.equal(posts, 20);
  assert.equal(getJobs(db, other.batchId)[0].status, "submission_unknown");
});

test("401/402/403/429和额度错误持久暂停未派发项，显式恢复也不重提失败项", async (t) => {
  for (const [status, message] of [[401, "denied"], [402, "payment"], [403, "denied"], [429, "busy"], [400, "余额不足"], [200, "insufficient credits"]]) {
    await t.test(`${status} ${message}`, async (t) => {
      const { db, batchId } = await fixture(t, 6);
      let posts = 0;
      let reject = true;
      const fetchImpl = successFetch(async () => {
        const id = ++posts;
        return reject ? response({ status: "failed", message }, status) : response({ id: `task-${id}` });
      });
      const first = await runBatch(db, { ...options, batchId, concurrency: 2, providerOptions: { fetchImpl } });
      assert.equal(first.exit_reason, "stopped");
      assert.equal(first.counts.queued, 4);
      assert.equal(first.counts.failed, 2);
      assert.equal(posts, 2);
      assert.ok(first.blocked_reason);
      if (status !== 200) assert.ok(first.jobs[0].error.includes(`HTTP ${status}`));
      assert.match(getBatch(db, batchId).note, /^provider_blocked:/);
      reject = false;
      const held = await runBatch(db, { ...options, batchId, providerOptions: { fetchImpl } });
      assert.equal(held.exit_reason, "stopped");
      assert.equal(posts, 2, "重启不能自动解除限流保护");
      const resumed = await runBatch(db, { ...options, batchId, resumeBlocked: true, providerOptions: { fetchImpl } });
      assert.equal(resumed.exit_reason, "partial");
      assert.equal(resumed.counts.files_ready, 4);
      assert.equal(posts, 6);
      assert.ok(resumed.jobs.every((job) => job.attempts_submit === 1));
    });
  }
});

test("全量并发遇限流如实记录已发请求；迟到受理ID仍保存，不假称取消", async (t) => {
  const { db, batchId } = await fixture(t, 20);
  let posts = 0, queries = 0;
  const fetchImpl = async (input, init) => {
    if (init.method !== "POST") { queries++; throw new Error("不应继续查询"); }
    const id = ++posts;
    if (id === 1) return response({ message: "busy" }, 429);
    await sleep(20);
    return response({ id: `task-${id}` });
  };
  const result = await runBatch(db, { ...options, batchId, providerOptions: { fetchImpl } });
  assert.equal(result.exit_reason, "stopped");
  assert.equal(posts, 20);
  assert.equal(queries, 0);
  assert.equal(result.counts.accepted, 19);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.submitting, 0);
});

test("查询限流保持已受理状态，停止新查询与新提交", async (t) => {
  const { db, batchId } = await fixture(t, 12);
  for (const job of getJobs(db, batchId).slice(0, 8)) updateJob(db, job.id, { status: "accepted", provider_id: job.id });
  let queries = 0, posts = 0;
  const fetchImpl = async (input, init) => {
    if (init.method === "POST") { posts++; throw new Error("不应提交"); }
    queries++;
    return response({ status: "failed", message: "denied" }, 403);
  };
  const result = await runBatch(db, { ...options, batchId, providerOptions: { fetchImpl } });
  assert.equal(result.exit_reason, "stopped");
  assert.equal(queries, 4);
  assert.equal(posts, 0);
  assert.equal(result.counts.accepted, 8);
  assert.equal(result.counts.queued, 4);
  assert.equal(result.counts.failed, 0);
});

test("提交中停止：先收尾全部在途调用，再释放锁；恢复不重发未知项", async (t) => {
  const { db, batchId } = await fixture(t, 5);
  const controller = new AbortController();
  const bothEntered = deferred();
  let posts = 0, settled = 0;
  const fetchImpl = async (input, init) => {
    assert.equal(init.method, "POST");
    posts++;
    if (posts === 2) bothEntered.resolve();
    await new Promise((resolve) => {
      if (init.signal.aborted) resolve();
      else init.signal.addEventListener("abort", resolve, { once: true });
    });
    await sleep(20);
    settled++;
    throw new DOMException("stopped", "AbortError");
  };
  const run = runBatch(db, { ...options, batchId, concurrency: 2, signal: controller.signal, providerOptions: { fetchImpl } });
  await bothEntered.promise;
  controller.abort();
  const result = await run;
  assert.equal(settled, 2);
  assert.equal(result.exit_reason, "stopped");
  assert.equal(result.counts.submission_unknown, 2);
  assert.equal(result.counts.queued, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases").get().n, 0);
  const again = await runBatch(db, { ...options, batchId, concurrency: 2, maxWaitMs: 1000, providerOptions: { fetchImpl } });
  assert.equal(again.counts.submission_unknown, 2);
  assert.equal(posts, 2);
});

test("等待超过90秒仍自动续租，同批执行器不能接管；丢锁后不派发新项", async (t) => {
  const { db, batchId } = await fixture(t, 4);
  const entered = deferred(), release = deferred();
  let posts = 0;
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  t.after(() => t.mock.timers.reset());
  const fetchImpl = async (input, init) => {
    assert.equal(init.method, "POST");
    posts++;
    entered.resolve();
    await release.promise;
    return response({ id: "late-accepted" });
  };
  const run = runBatch(db, { ...options, maxWaitMs: 600000, batchId, concurrency: 1, providerOptions: { fetchImpl } });
  await entered.promise;
  try {
    for (let i = 0; i < 4; i++) t.mock.timers.tick(30000);
    const lease = db.prepare("SELECT * FROM leases WHERE name = ?").get(`batch:${batchId}`);
    assert.equal(lease.expires_at, now + 120000 + 90000);
    await assert.rejects(runBatch(db, { batchId }), /已有后台执行器/);
    db.prepare("UPDATE leases SET owner = 'replacement' WHERE name = ?").run(`batch:${batchId}`);
    t.mock.timers.tick(30000);
  } finally {
    release.resolve();
    await run;
    t.mock.timers.reset();
  }
  const result = await run;
  assert.equal(result.exit_reason, "stopped");
  assert.equal(posts, 1);
  assert.equal(result.counts.queued, 3);
  assert.equal(result.jobs[0].provider_id, "late-accepted");
  assert.equal(db.prepare("SELECT owner FROM leases WHERE name = ?").get(`batch:${batchId}`).owner, "replacement");
});

test("意外查询异常也等待同组请求收尾，不能关闭DB后还有异步写入", async (t) => {
  const { db, batchId } = await fixture(t, 4);
  for (const job of getJobs(db, batchId)) updateJob(db, job.id, { status: "accepted", provider_id: job.id });
  let entered = 0, settled = 0;
  const provider = {
    async query() {
      const id = ++entered;
      try {
        if (id === 1) throw new Error("local query error");
        await sleep(30);
        return { kind: "running", progress: 10 };
      } finally { settled++; }
    },
  };
  await assert.rejects(runBatch(db, { ...options, batchId, provider }), /local query error/);
  assert.equal(entered, 4);
  assert.equal(settled, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases").get().n, 0);
});

test("429正文断线仍触发保护，查询错误不篡改远端状态", async (t) => {
  const { db, batchId } = await fixture(t, 4);
  const fetchImpl = async () => ({
    ok: false, status: 429,
    text: async () => { throw new Error("body disconnected"); },
  });
  const provider = new Provider(loadConfig(), { fetchImpl });
  const query = await provider.query("existing-id");
  assert.equal(query.kind, "unknown");
  assert.equal(query.blocked, true);
  const result = await runBatch(db, { ...options, batchId, concurrency: 1, providerOptions: { fetchImpl } });
  assert.equal(result.exit_reason, "stopped");
  assert.equal(result.counts.submission_unknown, 1);
  assert.equal(result.counts.queued, 3);
  assert.match(result.blocked_reason, /HTTP 429/);
});

test("人工刷新遇限流写入暂停原因，后续查看和重跑不能抹掉", async (t) => {
  const { db, batchId } = await fixture(t, 3);
  updateJob(db, getJobs(db, batchId)[0].id, { status: "accepted", provider_id: "existing-id" });
  let requests = 0;
  const fetchImpl = async () => { requests++; return response({ message: "busy" }, 429); };
  const refreshed = await refreshBatch(db, batchId, new Provider(loadConfig(), { fetchImpl }));
  assert.equal(refreshed.batch.status, "stopped");
  assert.equal(refreshed.batch.jobs[0].status, "accepted");
  assert.equal(finalizeBatch(db, batchId), "stopped");
  const result = await runBatch(db, { ...options, batchId, providerOptions: { fetchImpl } });
  assert.equal(result.exit_reason, "stopped");
  assert.equal(requests, 1);
  assert.equal(result.counts.queued, 2);
});

test("迟到提交和查询响应不能覆盖人工补填ID或放弃状态", async (t) => {
  const { db, batchId } = await fixture(t, 2);
  const jobs = getJobs(db, batchId);
  const controller = new AbortController();
  const provider = {
    async submit(spec) {
      if (spec.prompt === jobs[0].prompt) {
        attachProviderId(db, jobs[0].id, "manual-id");
        return { kind: "accepted", providerId: "late-id" };
      }
      abandonJob(db, jobs[1].id, "手工核对后放弃");
      controller.abort();
      return { kind: "unknown", message: "late timeout" };
    },
  };
  const first = await runBatch(db, { ...options, batchId, signal: controller.signal, provider });
  assert.equal(first.jobs[0].provider_id, "manual-id");
  assert.equal(first.jobs[1].status, "failed");
  const second = await runBatch(db, { ...options, batchId, provider: {
    async query() {
      abandonJob(db, jobs[0].id, "手工核对后放弃");
      return { kind: "running", progress: 50 };
    },
  } });
  assert.equal(second.counts.failed, 2);
});

test("并发参数严格校验，过期租约不得认领新任务或复活", async (t) => {
  assert.equal(normalizeConcurrency(undefined), undefined);
  assert.equal(normalizeConcurrency("20"), 20);
  assert.equal(normalizeConcurrency(1000), 1000);
  for (const value of [0, -1, 1.5, Infinity, NaN, true, "", " ", "all", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeConcurrency(value), /正整数/);
  }
  const { db, batchId } = await fixture(t, 1);
  assert.equal(acquireLease(db, `batch:${batchId}`, "old", 1), true);
  db.prepare("UPDATE leases SET expires_at = 0").run();
  assert.equal(refreshLease(db, `batch:${batchId}`, "old", 90000), false);
  assert.equal(claimNextQueued(db, batchId, undefined, { name: `batch:${batchId}`, owner: "old" }), null);
  assert.equal(getJobs(db, batchId)[0].attempts_submit, 0);
});
