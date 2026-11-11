import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { attachProviderId, getJobs, openDb } from "../dist/core/db.js";
import { prepareBatch } from "../dist/core/prepare.js";
import { runBatch } from "../dist/core/runner.js";
import {
  cleanup,
  clearEnv,
  makeTempDir,
  readBody,
  setupEnv,
  startMockServer,
} from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

test("正常流程：提交一次、轮询、下载，并支持幂等去重", async (t) => {
  const dir = makeTempDir();
  const posts = [];
  let queries = 0;
  let origin = "";

  const mock = await startMockServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/api/generate") {
      posts.push(JSON.parse(await readBody(req)));
      json(res, { id: "task-flow", status: "running" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/api/result") {
      queries += 1;
      if (queries < 3) {
        json(res, { id: "task-flow", status: "running", progress: 50 });
      } else {
        json(res, {
          id: "task-flow",
          status: "succeeded",
          results: [{ url: `${origin}/video.mp4` }],
        });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/video.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.alloc(4096, 7));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  origin = mock.origin;
  setupEnv(origin, dir);
  const db = openDb();

  t.after(async () => {
    db.close();
    await mock.close();
    clearEnv();
    cleanup(dir);
  });

  const job = {
    prompt: "6秒产品展示，透明香水瓶在黑色石台上，镜头缓慢推进。",
    aspectRatio: "9:16",
    resolution: "480p",
    duration: 4,
    promptSkill: false,
  };
  const prepared = await prepareBatch(db, { clientRequestId: "req-flow", jobs: [job] });
  assert.equal(prepared.deduped, false);

  const result = await runBatch(db, {
    batchId: prepared.batchId,
    pollMinMs: 20,
    pollMaxMs: 40,
    maxWaitMs: 8000,
    providerOptions: { submitTimeoutMs: 2000, pollTimeoutMs: 2000 },
  });

  assert.equal(result.status, "done");
  assert.equal(result.exit_reason, "done");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].model, "minimax-h3");
  assert.equal(posts[0].aspectRatio, "portrait");
  assert.equal(posts[0].resolution, "480p");
  assert.equal(posts[0].duration, 4);
  assert.equal(posts[0].promptSkill, false);
  assert.equal(posts[0].replyType, "async");

  const jobRow = getJobs(db, prepared.batchId)[0];
  assert.equal(jobRow.status, "succeeded");
  assert.equal(jobRow.file_status, "ready");
  assert.ok(fs.statSync(jobRow.local_path).size >= 4096);

  const again = await prepareBatch(db, { clientRequestId: "req-flow", jobs: [job] });
  assert.equal(again.deduped, true);
  assert.equal(again.batchId, prepared.batchId);

  await assert.rejects(
    () => prepareBatch(db, { clientRequestId: "req-flow", jobs: [{ ...job, prompt: "不同内容" }] }),
    /不同内容/,
  );
});

test("提交超时标记为未知且绝不自动重发，可补填任务 ID 恢复", async (t) => {
  const dir = makeTempDir();
  setupEnv("https://example.invalid", dir);
  const db = openDb();

  let postCalls = 0;
  const fakeFetch = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET").toUpperCase();
    if (method === "POST") {
      postCalls += 1;
      throw new DOMException("timed out", "TimeoutError");
    }
    if (url.includes("/v1/api/result")) {
      return new Response(
        JSON.stringify({
          id: "manual-task",
          status: "succeeded",
          results: [{ url: "https://cdn.example.com/v.mp4" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("cdn.example.com")) {
      return new Response(Buffer.alloc(2048, 3), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  t.after(() => {
    db.close();
    cleanup(dir);
    clearEnv();
  });

  const prepared = await prepareBatch(db, {
    clientRequestId: "req-unknown",
    jobs: [{ prompt: "测试提交超时", resolution: "480p", duration: 3 }],
  });

  const first = await runBatch(db, {
    batchId: prepared.batchId,
    pollMinMs: 20,
    pollMaxMs: 30,
    maxWaitMs: 400,
    providerOptions: { fetchImpl: fakeFetch, submitTimeoutMs: 100, pollTimeoutMs: 200 },
  });
  assert.equal(first.jobs[0].status, "submission_unknown");
  assert.equal(postCalls, 1);

  const second = await runBatch(db, {
    batchId: prepared.batchId,
    pollMinMs: 20,
    pollMaxMs: 30,
    maxWaitMs: 200,
    providerOptions: { fetchImpl: fakeFetch, submitTimeoutMs: 100, pollTimeoutMs: 200 },
  });
  assert.equal(second.jobs[0].status, "submission_unknown");
  assert.equal(postCalls, 1, "未知提交不能被自动重发");

  const jobId = getJobs(db, prepared.batchId)[0].id;
  attachProviderId(db, jobId, "manual-task");

  const resumed = await runBatch(db, {
    batchId: prepared.batchId,
    pollMinMs: 20,
    pollMaxMs: 30,
    maxWaitMs: 5000,
    providerOptions: { fetchImpl: fakeFetch, submitTimeoutMs: 100, pollTimeoutMs: 200 },
  });
  assert.equal(resumed.status, "done");
  assert.equal(postCalls, 1, "恢复任务只轮询和下载，不重新提交");
  assert.equal(getJobs(db, prepared.batchId)[0].file_status, "ready");
});

test("下载失败只重试下载，不重新生成", async (t) => {
  const dir = makeTempDir();
  let videoFail = true;
  let postCalls = 0;
  let origin = "";

  const mock = await startMockServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/api/generate") {
      postCalls += 1;
      await readBody(req);
      json(res, { id: `task-${postCalls}`, status: "running" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/api/result") {
      json(res, {
        id: "task-1",
        status: "succeeded",
        results: [{ url: `${origin}/video.mp4` }],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/video.mp4") {
      if (videoFail) {
        res.statusCode = 500;
        res.end("temporary failure");
      } else {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(Buffer.alloc(4096, 5));
      }
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  origin = mock.origin;
  setupEnv(origin, dir);
  const db = openDb();

  t.after(async () => {
    db.close();
    await mock.close();
    clearEnv();
    cleanup(dir);
  });

  const prepared = await prepareBatch(db, {
    clientRequestId: "req-download",
    jobs: [{ prompt: "测试下载恢复", resolution: "480p", duration: 3 }],
  });

  const first = await runBatch(db, {
    batchId: prepared.batchId,
    pollMinMs: 20,
    pollMaxMs: 30,
    maxWaitMs: 3000,
    providerOptions: { submitTimeoutMs: 2000, pollTimeoutMs: 2000 },
  });
  assert.equal(first.exit_reason, "partial");
  assert.equal(first.jobs[0].file_status, "download_failed");
  assert.equal(postCalls, 1);

  videoFail = false;
  const second = await runBatch(db, {
    batchId: prepared.batchId,
    pollMinMs: 20,
    pollMaxMs: 30,
    maxWaitMs: 3000,
    providerOptions: { submitTimeoutMs: 2000, pollTimeoutMs: 2000 },
  });
  assert.equal(second.status, "done");
  assert.equal(second.jobs[0].file_status, "ready");
  assert.equal(postCalls, 1, "只应重试下载，不应重新生成");
});

test("两个批次共享全局并发名额", async (t) => {
  const dir = makeTempDir();
  const posts = [];
  let activePosts = 0;
  let maxActivePosts = 0;
  let origin = "";

  const mock = await startMockServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/api/generate") {
      activePosts += 1;
      maxActivePosts = Math.max(maxActivePosts, activePosts);
      posts.push(JSON.parse(await readBody(req)));
      await sleep(80);
      activePosts -= 1;
      json(res, { id: `task-${posts.length}`, status: "running" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/api/result") {
      json(res, {
        id: url.searchParams.get("id"),
        status: "succeeded",
        results: [{ url: `${origin}/video.mp4` }],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/video.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.alloc(4096, 9));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  origin = mock.origin;
  setupEnv(origin, dir);
  const dbA = openDb();
  const dbB = openDb();

  t.after(async () => {
    dbA.close();
    dbB.close();
    await mock.close();
    clearEnv();
    cleanup(dir);
  });

  const preparedA = await prepareBatch(dbA, {
    clientRequestId: "req-concurrency-a",
    jobs: [
      { prompt: "并发测试 A1", resolution: "480p", duration: 3 },
      { prompt: "并发测试 A2", resolution: "480p", duration: 3 },
    ],
  });
  const preparedB = await prepareBatch(dbB, {
    clientRequestId: "req-concurrency-b",
    jobs: [
      { prompt: "并发测试 B1", resolution: "480p", duration: 3 },
      { prompt: "并发测试 B2", resolution: "480p", duration: 3 },
    ],
  });

  const options = {
    pollMinMs: 20,
    pollMaxMs: 40,
    maxWaitMs: 15_000,
    concurrency: 1,
    providerOptions: { submitTimeoutMs: 3000, pollTimeoutMs: 3000 },
  };
  const [resultA, resultB] = await Promise.all([
    runBatch(dbA, { ...options, batchId: preparedA.batchId }),
    runBatch(dbB, { ...options, batchId: preparedB.batchId }),
  ]);

  assert.equal(resultA.status, "done");
  assert.equal(resultB.status, "done");
  assert.equal(posts.length, 4);
  assert.equal(maxActivePosts, 1, "全局同时提交数不能超过并发上限");
});
