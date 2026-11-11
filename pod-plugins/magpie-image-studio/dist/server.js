import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./core/config.js";
import { listTasks, openDb } from "./core/db.js";
import { UserError } from "./core/errors.js";
import { generateImageTask, refreshImageTask } from "./core/flow.js";
import { listMagpieTools } from "./core/magpie.js";
import { dataDir, projectDir } from "./core/paths.js";
import { toTaskView } from "./core/views.js";
const VERSION = "0.3.0";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function ok(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function fail(error) {
    const code = error instanceof UserError ? error.code : "internal_error";
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ error: errorMessage(error), code }, null, 2),
            },
        ],
        isError: true,
    };
}
const server = new McpServer({ name: "magpie-image-studio", version: VERSION });
server.registerTool("image_check", {
    title: "检查生图环境",
    description: "检查运行时、任务账本和本机 Magpie 生图接口是否可用。只读取工具列表，不会生成图片，也不会启动或安装任何服务。出图前先调用一次。",
}, async () => {
    try {
        const config = loadConfig();
        const db = openDb();
        let sqliteVersion = "unknown";
        try {
            const row = db.prepare("SELECT sqlite_version() AS version").get();
            sqliteVersion = row.version;
        }
        finally {
            db.close();
        }
        let upstream;
        try {
            const listed = await listMagpieTools(config.endpoint);
            upstream = {
                reachable: true,
                server: listed.server,
                tools: listed.toolNames,
                has_generate_image: listed.toolNames.includes("generate_image"),
                has_generation_result: listed.toolNames.includes("generation_result"),
                generate_input_schema: listed.generateSchema,
            };
        }
        catch (error) {
            upstream = { reachable: false, error: errorMessage(error) };
        }
        const ready = upstream.reachable === true && upstream.has_generate_image === true;
        return ok({
            ready,
            node: process.version,
            sqlite: sqliteVersion,
            endpoint: config.endpoint,
            data_dir: dataDir(),
            project_dir: projectDir(),
            generate_budget_ms: config.generateBudgetMs,
            result_budget_ms: config.resultBudgetMs,
            upstream,
            next_step: ready
                ? "环境就绪。用 image_generate 出图；同一 request_id 重试不会重复提交。"
                : "Magpie 接口不可用。请确认本机 Magpie 正在运行且该地址可访问；本插件不会自动启动它。",
        });
    }
    catch (error) {
        return fail(error);
    }
});
server.registerTool("image_generate", {
    title: "生成图片",
    description: "向本机 Magpie 提交一次生图请求，并把图片保存到项目目录。必须自己生成并复用 request_id：同一 request_id 只提交一次，重试会返回原任务而不是再次生成。商品图先用product-fidelity编译同款同色真实参考，不能仅靠文字/图案代替商品照片；落盘不代表保真验收通过。参数含义与 Magpie 的 generate_image 一致。",
    inputSchema: {
        prompt: z.string().describe("完整提示词：主体、风格、构图、颜色，以及需要准确渲染的文字。"),
        request_id: z
            .string()
            .optional()
            .describe("本地防重标识。同一意图重试必须复用；用户明确要再生成一组时换新的。省略会自动生成，但失去防重能力。"),
        n: z.coerce.number().optional().describe("生成张数，1–4，默认 1。"),
        size: z.string().optional().describe("尺寸 1024x1024，或比例 16:9。默认跟随 Magpie/模型设置。"),
        quality: z.string().optional().describe("low、medium、high 或 auto，仅模型支持时有效。"),
        background: z.string().optional().describe("transparent、opaque 或 auto，仅模型支持时有效。"),
        model: z.string().optional().describe("可选模型名，如 codex/gpt-image-2。一般省略，跟随 Magpie 当前设置。"),
        reference_images: z
            .array(z.string())
            .optional()
            .describe("参考图：http(s) 链接、data URL，或本机绝对路径（仅同机时可用）。"),
        output_dir: z
            .string()
            .optional()
            .describe("输出目录。相对路径以当前项目为基准；省略时写入 generated-images/<任务ID>/。"),
    },
}, async (args) => {
    const config = loadConfig();
    const db = openDb();
    try {
        const result = await generateImageTask(db, {
            requestId: args.request_id,
            outputDir: args.output_dir,
            params: {
                prompt: args.prompt,
                n: args.n,
                size: args.size,
                quality: args.quality,
                background: args.background,
                model: args.model,
                reference_images: args.reference_images,
            },
        }, config);
        return ok({
            ...toTaskView(db, result.task),
            deduped: result.deduped,
            save_failures: result.saveFailures,
        });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
server.registerTool("image_result", {
    title: "查询并保存图片",
    description: "查询已有任务并补保存图片，永远不会重新调用生成。任务处于等待中时用同一个 task_id 反复调用即可。若提交时断线且没拿到 Magpie 任务 ID，可在 Magpie 中找到 ID 后用 remote_id 补填。",
    inputSchema: {
        task_id: z.string().describe("image_generate 返回的本地任务 ID。"),
        remote_id: z
            .string()
            .optional()
            .describe("仅当任务缺少 Magpie 任务 ID 时补填；不能替换已记录的不同 ID。"),
    },
}, async (args) => {
    const config = loadConfig();
    const db = openDb();
    try {
        const result = await refreshImageTask(db, { taskId: args.task_id, remoteId: args.remote_id }, config);
        return ok({
            ...toTaskView(db, result.task),
            note: result.note,
            save_failures: result.saveFailures,
        });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
server.registerTool("image_list", {
    title: "列出本插件任务",
    description: "列出本插件账本中的任务，用于找回上次生成。只读本地记录，不联网，也不代表 Magpie 的全部任务。",
    inputSchema: {
        unfinished_only: z.boolean().optional().describe("只列未完成任务，默认 true。"),
        limit: z.coerce.number().optional().describe("最多返回多少条，默认 20。"),
    },
}, async (args) => {
    const db = openDb();
    try {
        const tasks = listTasks(db, {
            unfinishedOnly: args.unfinished_only ?? true,
            limit: args.limit ?? 20,
        }).map((task) => ({
            task_id: task.id,
            request_id: task.request_id,
            state: task.generation_state,
            remote_id: task.remote_id,
            requested: task.n,
            received: task.images_received,
            saved: task.images_saved,
            output_dir: task.output_dir,
            created_at: task.created_at,
            updated_at: task.updated_at,
        }));
        return ok({ tasks });
    }
    catch (error) {
        return fail(error);
    }
    finally {
        db.close();
    }
});
async function main() {
    // 账本目录不可写时尽早失败，避免到出图后才发现无法记录。
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    process.stderr.write(`magpie-image-studio MCP 启动失败：${errorMessage(error)}\n`);
    process.exitCode = 1;
});
