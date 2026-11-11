import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanup, makeTempDir } from "./helpers.mjs";

test("MCP 进程可以握手、列出工具并执行本地自检", async (t) => {
  const dir = makeTempDir();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.bundle.mjs")],
    env: {
      ...process.env,
      MINIMAX_VIDEO_DATA_DIR: dir,
      MINIMAX_VIDEO_API_KEY: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "minimax-video-test", version: "1.0.0" });

  t.after(async () => {
    await client.close();
    cleanup(dir);
  });

  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "video_abandon_job",
    "video_attach_task",
    "video_check",
    "video_list",
    "video_open_progress",
    "video_prepare_batch",
    "video_status",
  ]);

  const result = await client.callTool({ name: "video_check", arguments: {} });
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text);
  const report = JSON.parse(text);
  assert.equal(report.ok, true);
  assert.equal(report.ready, false);
  assert.equal(report.credentials.configured, false);
  assert.ok(report.cli_path.endsWith("dist/cli.js"));

  const preparedResult = await client.callTool({
    name: "video_prepare_batch",
    arguments: {
      client_request_id: "mcp-prepare-1",
      jobs: Array.from({ length: 20 }, (_, index) => ({
        prompt: `MCP 登记测试 ${index + 1}`,
        aspect_ratio: "9:16",
        resolution: "480p",
        duration: 3,
      })),
    },
  });
  const prepared = JSON.parse(preparedResult.content.find((item) => item.type === "text")?.text);
  assert.equal(prepared.submitted_to_provider, false);
  assert.equal(prepared.status, "queued");
  assert.equal(prepared.jobs.length, 20);
  assert.doesNotMatch(prepared.run_command, /--concurrency/);
  assert.equal(tools.tools.find((tool) => tool.name === "video_prepare_batch").inputSchema.properties.jobs.maxItems, undefined);
  assert.match(prepared.run_command, /dist\/cli\.js'? run --batch-id /);

  const statusResult = await client.callTool({
    name: "video_status",
    arguments: { batch_id: prepared.batch_id },
  });
  const status = JSON.parse(statusResult.content.find((item) => item.type === "text")?.text);
  assert.equal(status.status, "queued");
  assert.equal(status.jobs[0].status, "queued");

  const progressResult = await client.callTool({
    name: "video_open_progress",
    arguments: { batch_id: prepared.batch_id },
  });
  assert.equal(progressResult.isError, undefined);
  const progress = JSON.parse(progressResult.content.find((item) => item.type === "text")?.text);
  assert.match(progress.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{48}$/);
  assert.equal(progress.batch_id, prepared.batch_id);
  assert.equal(progress.counts.total, 20);
  assert.equal(progress.terminal, false);
});
