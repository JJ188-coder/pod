import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePrepareInput, prepareBatch } from "./core/prepare.js";
import { normalizeConcurrency } from "./core/validate.js";
import {
  clearCredentials,
  DEFAULT_BASE_URL,
  loadConfig,
  normalizeBaseUrl,
  readCredentials,
  writeCredentials,
} from "./core/config.js";
import {
  abandonJob,
  attachProviderId,
  finalizeBatch,
  getBatch,
  getJob,
  getJobs,
  listBatches,
  openDb,
} from "./core/db.js";
import { collectDiagnostics } from "./core/diagnostics.js";
import { UserError } from "./core/errors.js";
import { Provider } from "./core/provider.js";
import { refreshBatch } from "./core/refresh.js";
import { runBatch } from "./core/runner.js";
import { toBatchView, toJobView } from "./core/views.js";
import { credentialsPath } from "./core/paths.js";
import { envFlag, shellQuote } from "./core/util.js";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new UserError(`--${name} 必须是数字。`, "invalid_flag");
  return parsed;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new UserError("当前不是交互终端。请使用 --from-env 从 MINIMAX_VIDEO_API_KEY 导入。", "not_tty");
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new UserError("已取消。", "cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (char >= " ") {
          value += char;
          process.stdout.write("*");
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function commandSetup(flags: Flags): Promise<number> {
  if (flags.clear) {
    const removed = clearCredentials();
    printJson({ cleared: removed, path: credentialsPath() });
    return 0;
  }

  const existing = readCredentials();
  let apiKey: string;
  if (flags["from-env"]) {
    apiKey = process.env.MINIMAX_VIDEO_API_KEY?.trim() ?? "";
    if (!apiKey) {
      throw new UserError("MINIMAX_VIDEO_API_KEY 为空。", "missing_env_key");
    }
  } else {
    const label = existing?.apiKey ? "API Key（回车保留现有）：" : "API Key：";
    const input = (await readHidden(label)).trim();
    apiKey = input || existing?.apiKey || "";
    if (!apiKey) throw new UserError("未输入 API Key。", "missing_key");
  }

  const baseUrlFlag = stringFlag(flags, "base-url");
  const allowPrivate =
    envFlag("MINIMAX_VIDEO_ALLOW_HTTP") || envFlag("MINIMAX_VIDEO_ALLOW_PRIVATE_NETWORK");
  const baseUrl = normalizeBaseUrl(
    baseUrlFlag || existing?.baseUrl || DEFAULT_BASE_URL,
    allowPrivate,
  );
  const file = writeCredentials({ apiKey, baseUrl });
  printJson({
    saved: true,
    path: file,
    base_url: baseUrl,
    note: "API Key 以明文保存在仅当前用户可读的 0600 文件中；未联网验证。",
  });
  return 0;
}

function commandDoctor(): number {
  const cliPath = fileURLToPath(import.meta.url);
  const serverBundle = fileURLToPath(new URL("./server.bundle.mjs", import.meta.url));
  const report = collectDiagnostics({ cliPath, serverBundle });
  printJson(report);
  return report.ok ? 0 : 1;
}

async function commandPrepare(flags: Flags): Promise<number> {
  const file = stringFlag(flags, "file");
  if (!file) throw new UserError("缺少 --file 批次JSON路径。", "missing_file");
  const input = parsePrepareInput(JSON.parse(fs.readFileSync(file, "utf8")));
  const db = openDb();
  try {
    const result = await prepareBatch(db, input);
    const batch = getBatch(db, result.batchId);
    if (!batch) throw new UserError("批次写入后无法读取。", "batch_read_failed");
    printJson({
      ...toBatchView(batch, result.jobs),
      deduped: result.deduped,
      submitted_to_provider: false,
      run_command: `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} run --batch-id ${shellQuote(result.batchId)} --max-wait-min 60`,
      instruction: "仅登记；确认本批费用范围后启动一次后台 run，默认本批全量并发提交。",
    });
    return 0;
  } finally {
    db.close();
  }
}

async function commandRun(flags: Flags): Promise<number> {
  const batchId = stringFlag(flags, "batch-id");
  if (!batchId) throw new UserError("缺少 --batch-id。", "missing_batch_id");
  const maxWaitMin = Math.max(0.1, numberFlag(flags, "max-wait-min", 60));
  const pollMin = Math.max(0.05, numberFlag(flags, "poll-min", 5));
  const pollMax = Math.max(pollMin, numberFlag(flags, "poll-max", 20));
  const concurrency = normalizeConcurrency(flags.concurrency ?? process.env.MINIMAX_VIDEO_CONCURRENCY);
  if (flags["resume-blocked"] !== undefined && flags["resume-blocked"] !== true) {
    throw new UserError("--resume-blocked 不接受参数值。", "invalid_flag");
  }

  const db = openDb();
  const controller = new AbortController();
  const onSignal = (signal: string) => {
    process.stderr.write(`\n收到 ${signal}：停止本地执行；远端任务不会被取消。\n`);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const result = await runBatch(db, {
      batchId,
      maxWaitMs: maxWaitMin * 60_000,
      pollMinMs: pollMin * 1000,
      pollMaxMs: pollMax * 1000,
      concurrency,
      resumeBlocked: flags["resume-blocked"] === true,
      signal: controller.signal,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    printJson(result);
    if (result.exit_reason === "done") return 0;
    if (result.exit_reason === "pending") return 2;
    if (result.exit_reason === "partial") return 3;
    return 130;
  } finally {
    releaseSignalHandlers(onSignal);
    db.close();
  }
}

function releaseSignalHandlers(handler: (signal: string) => void): void {
  process.off("SIGINT", handler);
  process.off("SIGTERM", handler);
}

async function commandStatus(flags: Flags): Promise<number> {
  const batchId = stringFlag(flags, "batch-id");
  const db = openDb();
  try {
    if (!batchId) {
      const batches = listBatches(db, { unfinishedOnly: false, limit: 20 }).map((batch) =>
        toBatchView(batch, getJobs(db, batch.id)),
      );
      printJson({ batches });
      return 0;
    }

    const batch = getBatch(db, batchId);
    if (!batch) throw new UserError(`批次不存在：${batchId}`, "batch_not_found");

    if (flags.refresh) {
      const result = await refreshBatch(db, batchId, new Provider(loadConfig()), { maxJobs: 10 });
      printJson({ ...result.batch, refreshed: result.refreshed, warnings: result.warnings });
    } else {
      printJson(toBatchView(batch, getJobs(db, batchId)));
    }
    return 0;
  } finally {
    db.close();
  }
}

function commandAttach(flags: Flags): number {
  const jobId = stringFlag(flags, "job-id");
  const providerId = stringFlag(flags, "provider-id");
  if (!jobId || !providerId) throw new UserError("缺少 --job-id 或 --provider-id。", "missing_flag");
  if (providerId.length > 200) throw new UserError("provider-id 过长。", "invalid_flag");
  const db = openDb();
  try {
    const job = attachProviderId(db, jobId, providerId.trim());
    const status = finalizeBatch(db, job.batch_id);
    printJson({ job: toJobView(getJob(db, job.id) ?? job), batch_status: status });
    return 0;
  } finally {
    db.close();
  }
}

function commandAbandon(flags: Flags): number {
  const jobId = stringFlag(flags, "job-id");
  if (!jobId) throw new UserError("缺少 --job-id。", "missing_flag");
  const reason = stringFlag(flags, "reason") || "用户手动放弃";
  const db = openDb();
  try {
    const job = abandonJob(db, jobId, reason);
    const status = finalizeBatch(db, job.batch_id);
    printJson({
      job: toJobView(getJob(db, job.id) ?? job),
      batch_status: status,
      note: "仅释放本地名额；如已提交，远端任务可能仍在运行并计费。",
    });
    return 0;
  } finally {
    db.close();
  }
}

function commandHelp(): number {
  process.stdout.write(`minimax-video-studio CLI

用法：
  node dist/cli.js setup [--base-url URL] [--from-env] [--clear]
  node dist/cli.js doctor
  node dist/cli.js prepare --file /absolute/batch.json
  node dist/cli.js run --batch-id ID [--max-wait-min 60] [--poll-min 5] [--poll-max 20] [--concurrency N] [--resume-blocked]
  node dist/cli.js status [--batch-id ID] [--refresh]
  node dist/cli.js list
  node dist/cli.js attach --job-id JOB --provider-id TASK
  node dist/cli.js abandon --job-id JOB [--reason TEXT]

说明：
  prepare 只登记，不生成；JSON 字段与 video_prepare_batch 一致。
  run 默认本批全量并发；--concurrency N 或 MINIMAX_VIDEO_CONCURRENCY 可主动限流。
  查询并发 4、下载并发 2，与生成并发独立。
  --resume-blocked 仅在人工核对并解决认证/额度/限流后使用，不重提失败或未知项。
  run 退出码：0 完成；2 待继续或需核对未知提交；3 部分失败；130 本地停止/异常保护。
  stop 只停止本地执行，不会取消远端任务。
`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const flags = parseFlags(argv.slice(1));

  if (command === "setup") return commandSetup(flags);
  if (command === "doctor") return commandDoctor();
  if (command === "prepare") return commandPrepare(flags);
  if (command === "run") return commandRun(flags);
  if (command === "status") return commandStatus(flags);
  if (command === "list") {
    const listFlags = { ...flags };
    delete listFlags["batch-id"];
    return commandStatus(listFlags);
  }
  if (command === "attach") return commandAttach(flags);
  if (command === "abandon") return commandAbandon(flags);
  if (command === "help" || command === "--help" || command === "-h") return commandHelp();
  throw new UserError(`未知命令：${command}`, "unknown_command");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`错误：${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
