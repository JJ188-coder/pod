import { resolveOutputDir } from "./artifacts.js";
import { attachRemoteId, claimTask, countSaved, getArtifacts, getTask, patchTask, } from "./db.js";
import { UserError } from "./errors.js";
import { callGenerateImage, callGenerationResult, isAccessOrQuotaError, parseToolResult, } from "./magpie.js";
import { materialize } from "./materialize.js";
import { newId, sha256, stableStringify } from "./util.js";
const MAX_PROMPT = 8_000;
function trimOptional(value, label, maxLength = 60) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value !== "string")
        throw new UserError(`${label}必须是字符串。`, "invalid_argument");
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.length > maxLength)
        throw new UserError(`${label}过长。`, "invalid_argument");
    return trimmed;
}
export function normalizeGenerateParams(raw) {
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) {
        throw new UserError("prompt 不能为空。", "invalid_prompt");
    }
    const prompt = raw.prompt.trim();
    if (prompt.length > MAX_PROMPT) {
        throw new UserError(`prompt 超过 ${MAX_PROMPT} 字符，请精简。`, "invalid_prompt");
    }
    const n = raw.n === undefined || raw.n === null ? 1 : Number(raw.n);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
        throw new UserError("n 必须是 1–4 的整数。", "invalid_n");
    }
    const size = trimOptional(raw.size, "size", 20);
    if (size && !/^\d{2,5}x\d{2,5}$/i.test(size) && !/^\d{1,2}:\d{1,2}$/.test(size)) {
        throw new UserError("size 需要写成 1024x1024 或比例 16:9。", "invalid_size");
    }
    let referenceImages;
    if (raw.reference_images !== undefined && raw.reference_images !== null) {
        if (!Array.isArray(raw.reference_images)) {
            throw new UserError("reference_images 必须是数组。", "invalid_reference_images");
        }
        if (raw.reference_images.length > 16) {
            throw new UserError("reference_images 最多 16 个。", "invalid_reference_images");
        }
        referenceImages = raw.reference_images.map((item, index) => {
            if (typeof item !== "string" || !item.trim()) {
                throw new UserError(`reference_images 第 ${index + 1} 项必须是非空字符串。`, "invalid_reference_images");
            }
            return item.trim();
        });
    }
    return {
        prompt,
        n,
        size,
        quality: trimOptional(raw.quality, "quality", 20),
        background: trimOptional(raw.background, "background", 20),
        model: trimOptional(raw.model, "model", 60),
        reference_images: referenceImages,
    };
}
function upstreamArguments(params) {
    const args = { prompt: params.prompt };
    if (params.n !== undefined)
        args.n = params.n;
    if (params.size)
        args.size = params.size;
    if (params.quality)
        args.quality = params.quality;
    if (params.background)
        args.background = params.background;
    if (params.model)
        args.model = params.model;
    if (params.reference_images?.length)
        args.reference_images = params.reference_images;
    return args;
}
/** 只按生成参数去重；输出目录变化不影响“是否已提交”的判断。 */
export function hashParams(params) {
    return sha256(stableStringify(params));
}
export async function generateImageTask(db, input, config) {
    const params = normalizeGenerateParams(input.params);
    const requestId = (input.requestId?.trim() || newId("req")).slice(0, 200);
    const taskId = newId("img");
    const outputDir = resolveOutputDir(input.outputDir, taskId);
    const { task, created } = claimTask(db, {
        id: taskId,
        requestId,
        requestHash: hashParams(params),
        prompt: params.prompt,
        paramsJson: JSON.stringify(params),
        n: params.n ?? 1,
        outputDir,
    });
    if (!created) {
        return { task, deduped: true, saveFailures: [] };
    }
    const outcome = await callGenerateImage(upstreamArguments(params), config.generateBudgetMs, config.endpoint);
    if (!outcome.ok) {
        const failure = outcome.failure;
        const next = patchTask(db, task.id, {
            generation_state: failure.transportError ? "submission_unknown" : "failed",
            error: failure.message,
            last_checked_at: new Date().toISOString(),
        });
        return { task: next, deduped: false, saveFailures: [] };
    }
    const parsed = parseToolResult(outcome.result);
    if (parsed.kind === "pending") {
        const next = patchTask(db, task.id, {
            generation_state: "pending",
            remote_id: parsed.remoteId,
            error: null,
            raw_response: JSON.stringify(parsed.raw),
            last_checked_at: new Date().toISOString(),
        });
        return { task: next, deduped: false, saveFailures: [] };
    }
    if (parsed.kind === "failed") {
        const next = patchTask(db, task.id, {
            generation_state: "failed",
            remote_id: parsed.remoteId,
            error: parsed.error,
            raw_response: JSON.stringify(parsed.raw),
            last_checked_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
        });
        return { task: next, deduped: false, saveFailures: [] };
    }
    const updated = patchTask(db, task.id, {
        generation_state: "succeeded",
        remote_id: parsed.remoteId,
        images_received: parsed.images.length,
        error: null,
        raw_response: JSON.stringify(parsed.raw),
        last_checked_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
    });
    const materialized = await materialize(db, updated, parsed.images.map((image, ordinal) => ({ ordinal, image })), config);
    const latest = getTask(db, task.id) ?? updated;
    return { task: latest, deduped: false, saveFailures: materialized.failures };
}
export async function refreshImageTask(db, input, config) {
    let task = getTask(db, input.taskId);
    if (!task)
        throw new UserError(`任务不存在：${input.taskId}`, "task_not_found");
    // 已生成完成的任务只需补保存，不再改动远端 ID，避免把补下载变成冲突。
    if (task.generation_state !== "succeeded" && input.remoteId?.trim() && input.remoteId.trim() !== task.remote_id) {
        task = attachRemoteId(db, task.id, input.remoteId.trim());
    }
    if (task.generation_state === "succeeded") {
        const artifacts = getArtifacts(db, task.id);
        const saved = countSaved(db, task.id);
        if (saved >= artifacts.length && saved > 0) {
            return { task, note: "所有已知图片均已保存，无需再次查询。", saveFailures: [] };
        }
        // 用已记录的地址重试保存，不重新生成。
        const recoverable = artifacts
            .filter((row) => row.file_state !== "ready" && (row.source === "url" || row.source === "file"))
            .map((row) => ({
            ordinal: row.ordinal,
            image: {
                source: row.source,
                value: row.source_value ?? "",
                mimeType: row.mime_type,
            },
        }));
        if (recoverable.length) {
            const materialized = await materialize(db, task, recoverable, config);
            const latest = getTask(db, task.id) ?? task;
            return { task: latest, note: "已重试保存已有图片，未重新生成。", saveFailures: materialized.failures };
        }
    }
    if (!task.remote_id) {
        return {
            task,
            note: "任务没有 Magpie 任务 ID，无法查询。若在 Magpie 中能找到 ID，请用 remote_id 补填；没有 ID 时只能重新发起一次新的生成。",
            saveFailures: [],
        };
    }
    const outcome = await callGenerationResult(task.remote_id, config.resultBudgetMs, config.endpoint);
    if (!outcome.ok) {
        const next = patchTask(db, task.id, { last_checked_at: new Date().toISOString() });
        return {
            task: next,
            note: `查询失败（${outcome.message}）。任务 ID 已保留，可稍后再次查询；不会重新生成。`,
            saveFailures: [],
        };
    }
    const parsed = parseToolResult(outcome.result);
    // 工具/认证/额度错误是本次查询受阻，不能据此把已提交任务改为生成失败。
    if (parsed.kind === "failed" && (outcome.result.isError || isAccessOrQuotaError(parsed.error))) {
        const next = patchTask(db, task.id, { last_checked_at: new Date().toISOString() });
        return { task: next, note: `查询失败（${parsed.error}）。保留任务，停止自动查询。`, saveFailures: [] };
    }
    if (parsed.kind === "pending") {
        const next = patchTask(db, task.id, {
            generation_state: "pending",
            error: null,
            raw_response: JSON.stringify(parsed.raw),
            last_checked_at: new Date().toISOString(),
        });
        return { task: next, note: "仍在生成中，请稍后再查询。", saveFailures: [] };
    }
    if (parsed.kind === "failed") {
        const next = patchTask(db, task.id, {
            generation_state: "failed",
            error: parsed.error,
            raw_response: JSON.stringify(parsed.raw),
            last_checked_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
        });
        return { task: next, note: "Magpie 报告生成失败。", saveFailures: [] };
    }
    const updated = patchTask(db, task.id, {
        generation_state: "succeeded",
        images_received: parsed.images.length,
        error: null,
        raw_response: JSON.stringify(parsed.raw),
        last_checked_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
    });
    const materialized = await materialize(db, updated, parsed.images.map((image, ordinal) => ({ ordinal, image })), config);
    const latest = getTask(db, task.id) ?? updated;
    return {
        task: latest,
        note: materialized.failures.length ? "已取回结果，但部分图片保存失败。" : "已取回并保存图片。",
        saveFailures: materialized.failures,
    };
}
