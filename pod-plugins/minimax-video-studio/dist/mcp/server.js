import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { abandonJob, attachProviderId, finalizeBatch, getBatch, getJob, getJobs, listBatches, openDb, } from "../core/db.js";
import { collectDiagnostics } from "../core/diagnostics.js";
import { UserError } from "../core/errors.js";
import { parsePrepareInput, prepareBatch } from "../core/prepare.js";
import { Provider } from "../core/provider.js";
import { refreshBatch } from "../core/refresh.js";
import { toBatchView, toJobView } from "../core/views.js";
import { shellQuote } from "../core/util.js";
import { readProgressSnapshot } from "../progress/snapshot.js";
import { startProgressServer } from "../progress/server.js";
const VERSION = "0.2.0";
let progressHandle = null;
async function progressUrlFor(batchId) {
    if (progressHandle && !progressHandle.closed && progressHandle.batchId === batchId) {
        return progressHandle.url;
    }
    if (progressHandle) {
        await progressHandle.close();
        progressHandle = null;
    }
    progressHandle = await startProgressServer({ batchId });
    return progressHandle.url;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function nodeBinary() {
    if (!process.versions.electron && process.release?.name === "node")
        return process.execPath;
    return process.env.MINIMAX_VIDEO_NODE || "node";
}
function resolveCliPath() {
    const candidates = [new URL("./cli.js", import.meta.url), new URL("../cli.js", import.meta.url)];
    for (const candidate of candidates) {
        const candidatePath = fileURLToPath(candidate);
        if (fs.existsSync(candidatePath))
            return candidatePath;
    }
    return fileURLToPath(candidates[0]);
}
function ok(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function fail(error) {
    return {
        content: [{ type: "text", text: `错误：${errorMessage(error)}` }],
        isError: true,
    };
}
const jobInputSchema = z.object({
    prompt: z.string().describe("完整的视频提示词。包含主体、动作、镜头、光线、声音和一致性约束。"),
    aspect_ratio: z.string().optional().describe("portrait/9:16 或 landscape/16:9，默认 portrait。"),
    resolution: z.string().optional().describe("480p、768p 或 1080p。默认 768p。1080p 最长 10 秒。"),
    duration: z.coerce.number().optional().describe("整数秒，1–15；1080p 最多 10 秒。默认 6。"),
    images: z.array(z.string()).optional().describe("最多 9 张参考图：HTTPS URL、本地绝对路径或 data URL。"),
    audios: z.array(z.string()).optional().describe("最多 3 段参考音频。"),
    seed: z.coerce.number().optional().describe("可选随机种子，0–2147483647。"),
    prompt_skill: z.boolean().optional().describe("默认 true；提示词完整时建议 false。"),
    output_name: z.string().optional().describe("可选输出文件名前缀。"),
}).strict();
const server = new McpServer({ name: "minimax-video-studio", version: VERSION });
server.registerTool("video_check", {
    title: "检查视频插件环境",
    description: "检查 Node、SQLite、数据目录、凭据和数据库状态。默认不联网、不调用生成接口、不显示 API Key。生成前先调用一次。",
}, async () => {
    try {
        const cliPath = resolveCliPath();
        const reports = collectDiagnostics({
            cliPath,
            serverBundle: fileURLToPath(import.meta.url),
        });
        return ok({
            ...reports,
            next_step: reports.ready
                ? "环境已就绪，可以准备批次。"
                : "请先运行 node <plugin>/dist/cli.js setup 配置 API Key，或设置 MINIMAX_VIDEO_API_KEY。",
        });
    }
    catch (error) {
        return fail(error);
    }
});
server.registerTool("video_prepare_batch", {
    title: "准备视频批次",
    description: "校验参数、保存素材并登记一个本地批次。此工具不会向供应商提交生成请求，也不会产生生成费用；状态为 queued。返回的 run_command 需要用一次后台 Bash 执行，由后台进程完成提交、轮询和下载。",
    inputSchema: {
        client_request_id: z
            .string()
            .optional()
            .describe("幂等键，同一 ID 与相同内容只登记一次；同 ID 不同内容会报冲突。建议每次新批次生成唯一值。"),
        jobs: z.array(jobInputSchema).min(1).describe("至少一条视频任务，无固定本地批次数量上限；后台默认并发提交本批全部任务。"),
    },
}, async (args) => {
    const db = openDb();
    try {
        const result = await prepareBatch(db, parsePrepareInput(args));
        const batch = getBatch(db, result.batchId);
        if (!batch)
            throw new UserError("批次写入后无法读取，请运行 doctor。", "batch_read_failed");
        const view = toBatchView(batch, result.jobs);
        const cliPath = resolveCliPath();
        const runCommand = `${shellQuote(nodeBinary())} ${shellQuote(cliPath)} run --batch-id ${shellQuote(result.batchId)} --max-wait-min 60`;
        return ok({
            batch_id: result.batchId,
            deduped: result.deduped,
            submitted_to_provider: false,
            status: view.status,
            counts: view.counts,
            jobs: view.jobs.map((job) => ({
                job_id: job.job_id,
                ordinal: job.ordinal,
                status: job.status,
                params: job.params,
            })),
            run_command: runCommand,
            instruction: result.deduped
                ? "该内容与近期批次重复，已返回原批次。仅当尚未运行时才执行一次后台 run_command。"
                : "确认本批费用范围后，用一次 Bash(run_in_background:true) 执行 run_command，默认本批全量并发提交；可显式 --concurrency N 降低并发。不要循环查询或重复登记。",
        });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
server.registerTool("video_status", {
    title: "查询视频状态",
    description: "读取本地批次状态；refresh=true 时只查询已有供应商任务，不会提交新任务或下载视频。若省略 batch_id，返回未完成批次列表。",
    inputSchema: {
        batch_id: z.string().optional().describe("批次 ID。省略时列出未完成批次。"),
        refresh: z.boolean().optional().describe("是否联网刷新已有任务的状态。默认 false。"),
    },
}, async (args) => {
    const db = openDb();
    try {
        if (!args.batch_id) {
            const batches = listBatches(db, { unfinishedOnly: true, limit: 20 }).map((batch) => {
                const view = toBatchView(batch, getJobs(db, batch.id));
                return {
                    batch_id: view.batch_id,
                    status: view.status,
                    created_at: view.created_at,
                    updated_at: view.updated_at,
                    counts: view.counts,
                };
            });
            return ok({ batches, note: "使用 batch_id 查看详情；只有后台 run 会继续生成和下载。" });
        }
        const batch = getBatch(db, args.batch_id);
        if (!batch)
            throw new UserError(`批次不存在：${args.batch_id}`, "batch_not_found");
        let view = toBatchView(batch, getJobs(db, batch.id));
        let refreshed = 0;
        const warnings = [];
        if (args.refresh) {
            const result = await refreshBatch(db, batch.id, new Provider(loadConfig()), { maxJobs: 10 });
            view = result.batch;
            refreshed = result.refreshed;
            warnings.push(...result.warnings);
        }
        const pendingDownloads = view.jobs.filter((job) => job.status === "succeeded" && job.file_status !== "ready").length;
        return ok({
            ...view,
            refreshed,
            warnings,
            download_pending: pendingDownloads,
            hint: pendingDownloads > 0
                ? "有已生成但未落盘的视频。用一次后台 run 完成下载，不会重新生成。"
                : undefined,
        });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
server.registerTool("video_list", {
    title: "列出视频批次",
    description: "列出本地视频批次及状态统计，用于恢复上次任务。默认只列未完成批次。",
    inputSchema: {
        unfinished_only: z.boolean().optional().describe("只列未完成批次，默认 true。"),
        limit: z.coerce.number().optional().describe("最多返回多少条，默认 20。"),
    },
}, async (args) => {
    const db = openDb();
    try {
        const batches = listBatches(db, {
            unfinishedOnly: args.unfinished_only ?? true,
            limit: args.limit ?? 20,
        }).map((batch) => {
            const view = toBatchView(batch, getJobs(db, batch.id));
            return {
                batch_id: view.batch_id,
                status: view.status,
                created_at: view.created_at,
                updated_at: view.updated_at,
                counts: view.counts,
            };
        });
        return ok({ batches });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
server.registerTool("video_open_progress", {
    title: "打开视频进度页",
    description: "在本机启动一个只读进度页并返回浏览器链接。页面定期读取本地任务记录，不提交、不取消、不恢复、不下载，也不查询供应商接口。关闭页面或监控进程不会影响生成任务。",
    inputSchema: {
        batch_id: z.string().describe("批次 ID。"),
    },
}, async (args) => {
    try {
        const snapshot = readProgressSnapshot(args.batch_id);
        const url = await progressUrlFor(args.batch_id);
        return ok({
            url,
            batch_id: args.batch_id,
            status: snapshot.batch_status,
            counts: snapshot.counts,
            terminal: snapshot.terminal,
            note: "页面只读，每 2 秒读取本机记录。关闭页面不影响生成任务；链接含本机访问令牌，不要外传。",
        });
    }
    catch (error) {
        return fail(error);
    }
});
server.registerTool("video_attach_task", {
    title: "补填供应商任务 ID",
    description: "当提交结果显示 submission_unknown 时，如果用户在供应商后台找到了任务 ID，用它把本地任务接回轮询。不会重新提交。",
    inputSchema: {
        job_id: z.string().describe("本地任务 ID。"),
        provider_id: z.string().describe("供应商任务 ID。"),
    },
}, async (args) => {
    const db = openDb();
    try {
        if (!args.provider_id.trim())
            throw new UserError("provider_id 不能为空。", "invalid_provider_id");
        if (args.provider_id.length > 200)
            throw new UserError("provider_id 过长。", "invalid_provider_id");
        const job = attachProviderId(db, args.job_id, args.provider_id.trim());
        const status = finalizeBatch(db, job.batch_id);
        const latest = getJob(db, job.id) ?? job;
        return ok({
            job: toJobView(latest),
            batch_status: status,
            note: "已补填任务 ID。用一次后台 run 继续查询和下载；不会重新提交。",
        });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
server.registerTool("video_abandon_job", {
    title: "本地放弃任务",
    description: "释放一个卡住或无法核对的任务所占的本地并发名额。仅改变本地状态；如已提交，远端任务可能仍在运行并计费，且该接口没有取消能力。",
    inputSchema: {
        job_id: z.string().describe("本地任务 ID。"),
        reason: z.string().optional().describe("放弃原因。"),
    },
}, async (args) => {
    const db = openDb();
    try {
        const job = abandonJob(db, args.job_id, args.reason?.trim() || "用户手动放弃");
        const status = finalizeBatch(db, job.batch_id);
        const latest = getJob(db, job.id) ?? job;
        return ok({
            job: toJobView(latest),
            batch_status: status,
            note: "仅释放本地名额。远端任务不会被取消；如已提交仍可能继续运行并计费。",
        });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    process.stderr.write(`minimax-video-studio MCP 启动失败：${errorMessage(error)}\n`);
    process.exitCode = 1;
});
