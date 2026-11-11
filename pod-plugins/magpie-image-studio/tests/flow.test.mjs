import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFakeMagpie, inlineImageResult, textResult, TINY_PNG } from "./fake-magpie.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-image-test-"));
process.env.MAGPIE_IMAGE_DATA_DIR = path.join(tempRoot, "data");
process.env.ZCODE_PROJECT_DIR = path.join(tempRoot, "project");

const { openDb, listTasks } = await import("../dist/core/db.js");
const { generateImageTask, refreshImageTask } = await import("../dist/core/flow.js");
const { toTaskView } = await import("../dist/core/views.js");
const { parseToolResult } = await import("../dist/core/magpie.js");

function configFor(endpoint) {
  return {
    endpoint,
    generateBudgetMs: 8_000,
    resultBudgetMs: 8_000,
    maxImageBytes: 5 * 1024 * 1024,
    allowPrivateDownload: false,
  };
}

test("结果解析拒绝服务地址和正文旧文件，元数据ID优先于示例文字", () => {
  const text = 'The image is still being made. Call generation_result with id "text-example" via https://api.example.test/mcp/magpie/image';
  const parsed = parseToolResult({ content: [{ type: "text", text }], _meta: { "usemagpie.ai/pending": "real-job" } });
  assert.equal(parsed.kind, "pending");
  assert.equal(parsed.remoteId, "real-job");
  const file = path.join(tempRoot, "unrelated-old.png");
  fs.writeFileSync(file, TINY_PNG);
  const old = parseToolResult({ content: [{ type: "text", text: `Use old reference ${file}.` }] });
  assert.notEqual(old.kind, "images");
  const pending = parseToolResult({ structuredContent: { status: "running", id: "job-1", url: "https://example.test/progress.png" }, content: [] });
  assert.equal(pending.kind, "pending");
});

test("同一 request_id 只提交一次，重复调用返回原任务", async () => {
  const fake = createFakeMagpie();
  const srv = await fake.start();
  const db = openDb();
  try {
    fake.state.generateResponses.push(inlineImageResult({ id: "gen-1", status: "complete" }));
    const config = configFor(srv.endpoint);

    const first = await generateImageTask(db, { requestId: "dedupe-1", params: { prompt: "a red kettle" } }, config);
    const second = await generateImageTask(db, { requestId: "dedupe-1", params: { prompt: "a red kettle" } }, config);

    assert.equal(fake.state.generateCalls, 1);
    assert.equal(second.deduped, true);
    assert.equal(second.task.id, first.task.id);
    assert.equal(first.task.generation_state, "succeeded");

    const view = toTaskView(db, first.task);
    assert.equal(view.saved, 1);
    assert.equal(fs.existsSync(view.files[0].path), true);
  } finally {
    db.close();
    await srv.stop();
  }
});

test("同一 request_id 但参数不同会报冲突", async () => {
  const fake = createFakeMagpie();
  const srv = await fake.start();
  const db = openDb();
  try {
    fake.state.generateResponses.push(inlineImageResult({ id: "gen-1", status: "complete" }));
    const config = configFor(srv.endpoint);

    await generateImageTask(db, { requestId: "conflict-1", params: { prompt: "first" } }, config);
    await assert.rejects(
      () => generateImageTask(db, { requestId: "conflict-1", params: { prompt: "second" } }, config),
      (error) => error.code === "conflict",
    );
    assert.equal(fake.state.generateCalls, 1);
  } finally {
    db.close();
    await srv.stop();
  }
});

test("pending 后只查询结果，不重新生成", async () => {
  const fake = createFakeMagpie();
  const srv = await fake.start();
  const db = openDb();
  try {
    fake.state.generateResponses.push(textResult({ id: "gen-9", status: "pending" }));
    fake.state.resultResponses.push(inlineImageResult({ id: "gen-9", status: "complete" }));
    const config = configFor(srv.endpoint);

    const created = await generateImageTask(db, { requestId: "pending-1", params: { prompt: "blue mug" } }, config);
    assert.equal(created.task.generation_state, "pending");
    assert.equal(created.task.remote_id, "gen-9");

    const refreshed = await refreshImageTask(db, { taskId: created.task.id }, config);
    assert.equal(refreshed.task.generation_state, "succeeded");
    assert.equal(fake.state.generateCalls, 1);
    assert.equal(fake.state.resultCalls, 1);

    const view = toTaskView(db, refreshed.task);
    assert.equal(view.saved, 1);
  } finally {
    db.close();
    await srv.stop();
  }
});

test("提交断线且没有任务 ID 时标记 submission_unknown，且不自动重发", async () => {
  const db = openDb();
  try {
    const deadEndpoint = "http://127.0.0.1:1/mcp/magpie/image";
    const config = configFor(deadEndpoint);

    const created = await generateImageTask(db, { requestId: "unknown-1", params: { prompt: "green cup" } }, config);
    assert.equal(created.task.generation_state, "submission_unknown");
    assert.equal(created.task.remote_id, null);

    const retried = await generateImageTask(db, { requestId: "unknown-1", params: { prompt: "green cup" } }, config);
    assert.equal(retried.deduped, true);
    assert.equal(retried.task.generation_state, "submission_unknown");
  } finally {
    db.close();
  }
});

test("请求 4 张只返回 2 张时如实报告缺项", async () => {
  const fake = createFakeMagpie();
  const srv = await fake.start();
  const db = openDb();
  try {
    fake.state.generateResponses.push({
      content: [
        { type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" },
        { type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" },
        { type: "text", text: JSON.stringify({ status: "complete" }) },
      ],
    });
    const config = configFor(srv.endpoint);

    const created = await generateImageTask(db, { requestId: "partial-1", params: { prompt: "poster", n: 4 } }, config);
    const view = toTaskView(db, created.task);

    assert.equal(view.requested, 4);
    assert.equal(view.received, 2);
    assert.equal(view.saved, 2);
    assert.match(view.next_step, /2\/4/);
    assert.equal(fake.state.generateCalls, 1);
  } finally {
    db.close();
    await srv.stop();
  }
});

test("保存失败后只重试下载，不重新生成", async () => {
  const fake = createFakeMagpie();
  const srv = await fake.start();
  const db = openDb();
  try {
    fake.state.imageFailuresLeft = 1;
    fake.state.generateResponses.push(
      textResult({ id: "gen-url", status: "complete", url: srv.imageUrl("first.png") }),
    );
    const config = configFor(srv.endpoint);

    const created = await generateImageTask(db, { requestId: "resave-1", params: { prompt: "lamp" } }, config);
    const afterCreate = toTaskView(db, created.task);
    assert.equal(afterCreate.state, "succeeded");
    assert.equal(afterCreate.saved, 0);
    assert.equal(afterCreate.files[0].file_state, "failed");

    const refreshed = await refreshImageTask(db, { taskId: created.task.id }, config);
    const view = toTaskView(db, refreshed.task);
    assert.equal(view.saved, 1);
    assert.equal(fake.state.generateCalls, 1);
    assert.equal(fake.state.resultCalls, 0);
  } finally {
    db.close();
    await srv.stop();
  }
});

test("真实等待返回：_meta 中的任务 ID 被识别为 pending", async () => {
  const fake = createFakeMagpie();
  const srv = await fake.start();
  const db = openDb();
  try {
    fake.state.generateResponses.push({
      content: [
        {
          type: "text",
          text: 'The image is still being made (20 s so far; it can take a few minutes). It goes on without this call. Don\'t ask for it again: call generation_result with id "img_test1" to wait for it and get it.\n',
        },
      ],
      _meta: { "usemagpie.ai/pending": "img_test1" },
    });
    const config = configFor(srv.endpoint);

    const created = await generateImageTask(db, { requestId: "meta-pending-1", params: { prompt: "booth" } }, config);
    assert.equal(created.task.generation_state, "pending");
    assert.equal(created.task.remote_id, "img_test1");
    assert.equal(fake.state.generateCalls, 1);
  } finally {
    db.close();
    await srv.stop();
  }
});

test("列表能找回任务且不会重复记录", async () => {
  const db = openDb();
  try {
    const tasks = listTasks(db, { unfinishedOnly: false, limit: 50 });
    const ids = tasks.map((task) => task.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(tasks.some((task) => task.request_id === "dedupe-1"), true);
  } finally {
    db.close();
  }
});

test("非法张数会被拒绝且不产生任务", async () => {
  const db = openDb();
  try {
    const before = listTasks(db, { unfinishedOnly: false, limit: 100 }).length;
    await assert.rejects(
      () => generateImageTask(db, { requestId: "bad-n", params: { prompt: "x", n: 9 } }, configFor("http://127.0.0.1:1/mcp")),
      (error) => error.code === "invalid_n",
    );
    assert.equal(listTasks(db, { unfinishedOnly: false, limit: 100 }).length, before);
  } finally {
    db.close();
  }
});
