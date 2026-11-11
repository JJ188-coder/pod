import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { UserError } from "./errors.js";
import { truncate } from "./util.js";
const CLIENT_INFO = { name: "magpie-image-studio", version: "0.3.0" };
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function isAccessOrQuotaError(message) {
    return /\b(?:401|403|429)\b|unauthori[sz]ed|forbidden|rate[ _-]?limit|too many requests|quota|insufficient (?:balance|credits)|payment required|额度|限流|余额不足|未授权/i.test(message);
}
async function withClient(endpoint, fn) {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    try {
        await client.connect(transport);
        return await fn(client);
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
function assertBudget(budgetMs) {
    if (!Number.isFinite(budgetMs) || budgetMs < 1_000)
        return 25_000;
    return Math.round(budgetMs);
}
export async function listMagpieTools(endpoint = loadConfig().endpoint) {
    return withClient(endpoint, async (client) => {
        const listed = await client.listTools(undefined, { timeout: assertBudget(10_000) });
        const generate = listed.tools.find((tool) => tool.name === "generate_image");
        return {
            server: client.getServerVersion() ?? null,
            toolNames: listed.tools.map((tool) => tool.name),
            generateSchema: generate?.inputSchema ?? null,
        };
    });
}
async function callTool(name, args, budgetMs, endpoint) {
    const result = await withClient(endpoint, (client) => client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: assertBudget(budgetMs) }));
    return result;
}
/** 生成调用：区分“服务端明确拒绝”（未生成）与“结果未知”（可能已生成）。 */
export async function callGenerateImage(args, budgetMs, endpoint) {
    try {
        const result = await callTool("generate_image", args, budgetMs, endpoint);
        return { ok: true, result };
    }
    catch (error) {
        if (error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed) {
            return { ok: false, failure: { transportError: false, message: error.message } };
        }
        return { ok: false, failure: { transportError: true, message: errorMessage(error) } };
    }
}
/** 查询调用：只读，可以安全重复。 */
export async function callGenerationResult(remoteId, budgetMs, endpoint) {
    try {
        const result = await callTool("generation_result", { id: remoteId }, budgetMs, endpoint);
        return { ok: true, result };
    }
    catch (error) {
        return { ok: false, message: errorMessage(error), transportError: !(error instanceof McpError) };
    }
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function textOf(content) {
    if (!Array.isArray(content))
        return "";
    return content
        .map((block) => (isPlainObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
}
const ID_KEYS = ["id", "generation_id", "generationId", "job_id", "jobId", "task_id", "taskId"];
const URL_KEYS = ["url", "urls", "image_url", "imageUrl", "image_urls", "imageUrls", "images", "files", "path", "paths"];
const STATUS_KEYS = ["status", "state"];
function scan(value, out, depth = 0) {
    if (depth > 6 || value === null || value === undefined)
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            scan(item, out, depth + 1);
        return;
    }
    if (!isPlainObject(value))
        return;
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string") {
            const trimmed = item.trim();
            if (ID_KEYS.includes(key) && trimmed && trimmed.length <= 200)
                out.ids.push(trimmed);
            if (URL_KEYS.includes(key)) {
                if (/^https?:\/\//i.test(trimmed))
                    out.urls.push(trimmed);
                else if (trimmed.startsWith("data:image/"))
                    out.urls.push(trimmed);
                else if (path.isAbsolute(trimmed) && IMAGE_EXTENSIONS.has(path.extname(trimmed).toLowerCase())) {
                    out.paths.push(trimmed);
                }
            }
            if (STATUS_KEYS.includes(key) && trimmed.length <= 40)
                out.statuses.push(trimmed.toLowerCase());
            if ((key === "error" || key === "message" || key === "detail") && trimmed)
                out.messages.push(trimmed);
        }
        else if (typeof item === "number" && ID_KEYS.includes(key)) {
            out.ids.push(String(item));
        }
        else {
            if (URL_KEYS.includes(key) && Array.isArray(item)) {
                for (const entry of item) {
                    if (typeof entry === "string" && /^https?:\/\//i.test(entry))
                        out.urls.push(entry);
                    else if (isPlainObject(entry)) {
                        const nested = entry.url ?? entry.href ?? entry.path;
                        if (typeof nested === "string" && /^https?:\/\//i.test(nested))
                            out.urls.push(nested);
                    }
                }
            }
            scan(item, out, depth + 1);
        }
    }
}
function parseJsonLoose(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
}
function unique(values) {
    return [...new Set(values)];
}
export function parseToolResult(result) {
    const raw = summarizeRaw(result);
    const content = result.content ?? [];
    const scanResult = { ids: [], urls: [], paths: [], statuses: [], messages: [] };
    const inline = [];
    for (const block of content) {
        if (!isPlainObject(block))
            continue;
        if (block.type === "image" && typeof block.data === "string") {
            inline.push({
                source: "inline",
                value: block.data,
                mimeType: typeof block.mimeType === "string" ? block.mimeType : null,
            });
        }
        else if (block.type === "resource_link" && typeof block.uri === "string") {
            if (/^https?:\/\//i.test(block.uri))
                scanResult.urls.push(block.uri);
        }
        else if (block.type === "resource" && isPlainObject(block.resource)) {
            const resource = block.resource;
            const blob = "blob" in resource && typeof resource.blob === "string" ? resource.blob : null;
            if (blob) {
                inline.push({
                    source: "inline",
                    value: blob,
                    mimeType: typeof resource.mimeType === "string" ? resource.mimeType : null,
                });
            }
            else if (typeof resource.uri === "string" && /^https?:\/\//i.test(resource.uri)) {
                scanResult.urls.push(resource.uri);
            }
        }
    }
    if (isPlainObject(result.structuredContent))
        scan(result.structuredContent, scanResult);
    // Magpie 实测把等待中的任务 ID 放在 _meta 里，正文只有一句提示。
    const meta = result._meta;
    let authoritativeId = null;
    if (meta && typeof meta === "object") {
        for (const [key, value] of Object.entries(meta)) {
            if (typeof value === "string" && /pending|task|job|generation/i.test(key) && value.trim()) {
                authoritativeId ??= value.trim();
                scanResult.ids.unshift(value.trim());
            }
            if (/files/i.test(key) && Array.isArray(value)) {
                for (const entry of value) {
                    if (isPlainObject(entry) && typeof entry.url === "string" && /^https?:\/\//i.test(entry.url)) {
                        scanResult.urls.push(entry.url);
                    }
                }
            }
        }
    }
    const text = textOf(content);
    const parsedText = parseJsonLoose(text);
    if (parsedText !== undefined)
        scan(parsedText, scanResult);
    // 正文里的 "call generation_result with id \"...\"" 也是任务 ID 的来源。
    for (const match of text.matchAll(/generation_result[^\n]{0,80}?id\s+["“'`]([^"”'`\s]+)["”'`]/gi)) {
        scanResult.ids.unshift(match[1]);
    }
    // 纯文本仅接受明确的图片URL；服务地址/文档和正文提到的本机旧文件不是产物证明。
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>()]+/gi)) {
        const url = match[0].replace(/[.,;，。、]+$/u, "");
        if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url))
            scanResult.urls.push(url);
    }
    const remoteId = authoritativeId ?? unique(scanResult.ids)[0] ?? null;
    const status = unique(scanResult.statuses)[0] ?? null;
    if (result.isError) {
        // Magpie 的等待中返回也可能是 isError：只有正文是已知等待语义且能取出任务 ID 时才算 pending；
        // 含 ID 不代表 pending，明确失败/违规的返回仍然 failed。
        const waiting = /still being made|generation continues|still (?:generating|processing)|正在生成|仍在生成/i.test(text) ||
            (status !== null && /^(pending|running|processing|queued|generating)$/i.test(status));
        const hardFailed = (status !== null && /fail|cancel|error|expired|violat|reject|denied/i.test(status)) ||
            /\b(?:failed|failure|error|cancelled|canceled|expired|rejected)\b|violat|policy|content.{0,20}(block|flag|reject)|nsfw|生成失败|已取消/i.test(text) ||
            isAccessOrQuotaError(text);
        if (remoteId && waiting && !hardFailed) {
            return { kind: "pending", remoteId, status, raw };
        }
        const message = unique([...scanResult.messages, text]).filter(Boolean).join("；");
        return { kind: "failed", error: truncate(message || "Magpie 返回工具错误。", 800), remoteId, raw };
    }
    if (status && /fail|cancel|error|expired/i.test(status)) {
        return { kind: "failed", error: truncate(unique(scanResult.messages).join("；") || `状态：${status}`, 800), remoteId, raw };
    }
    if (remoteId && ((status !== null && /^(pending|running|processing|queued|generating)$/i.test(status))
        || (/still being made|generation continues|still (?:generating|processing)|正在生成|仍在生成/i.test(text) && !inline.length))) {
        return { kind: "pending", remoteId, status, raw };
    }
    if (inline.length) {
        return { kind: "images", images: inline, remoteId, status, raw };
    }
    const urls = unique(scanResult.urls).filter((value) => !value.startsWith("data:"));
    const dataUrls = unique(scanResult.urls).filter((value) => value.startsWith("data:image/"));
    if (dataUrls.length) {
        return {
            kind: "images",
            images: dataUrls.map((value) => ({
                source: "inline",
                value: value.slice(value.indexOf(",") + 1),
                mimeType: value.slice(5, value.indexOf(";")),
            })),
            remoteId,
            status,
            raw,
        };
    }
    if (urls.length) {
        return {
            kind: "images",
            images: urls.map((value) => ({ source: "url", value, mimeType: null })),
            remoteId,
            status,
            raw,
        };
    }
    const files = unique(scanResult.paths).filter((value) => fs.existsSync(value));
    if (files.length) {
        return {
            kind: "images",
            images: files.map((value) => ({ source: "file", value, mimeType: null })),
            remoteId,
            status,
            raw,
        };
    }
    if (remoteId) {
        return { kind: "pending", remoteId, status, raw };
    }
    const leftover = unique([...scanResult.messages, text]).filter(Boolean).join("；");
    return {
        kind: "failed",
        error: truncate(leftover || "无法识别 Magpie 返回内容，请用 image_check 检查接口版本。", 800),
        remoteId,
        raw,
    };
}
/** 结构化保存原始返回，剔除 base64 图片数据，便于排查真实返回格式。 */
export function summarizeRaw(result) {
    const clone = (value, depth = 0) => {
        if (depth > 5)
            return "[truncated]";
        if (Array.isArray(value))
            return value.slice(0, 12).map((item) => clone(item, depth + 1));
        if (isPlainObject(value)) {
            const out = {};
            for (const [key, item] of Object.entries(value)) {
                if ((key === "data" || key === "blob") && typeof item === "string" && item.length > 256) {
                    out[key] = `[base64 ${item.length} chars]`;
                }
                else {
                    out[key] = clone(item, depth + 1);
                }
            }
            return out;
        }
        if (typeof value === "string")
            return truncate(value, 2_000);
        return value;
    };
    return clone(result);
}
export function ensureNonEmpty(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new UserError(`${label}不能为空。`, "invalid_argument");
    }
    return value.trim();
}
