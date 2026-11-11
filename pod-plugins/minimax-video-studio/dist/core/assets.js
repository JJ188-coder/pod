import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { assetsDir } from "./paths.js";
import { assertAssetCount, assertSafeUserAssetUrl } from "./validate.js";
import { isHttpUrl } from "./util.js";
const IMAGE_LIMIT = 20 * 1024 * 1024;
const AUDIO_LIMIT = 30 * 1024 * 1024;
const TOTAL_LIMIT = 40 * 1024 * 1024;
const ENCODED_LIMIT = 52 * 1024 * 1024;
const EXT_TO_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
};
const MIME_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
};
export function mimeForFile(filePath) {
    return EXT_TO_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
function extensionForMime(mime, fallback) {
    return MIME_TO_EXT[mime.toLowerCase()] ?? fallback;
}
function parseDataUrl(ref) {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(ref);
    if (!match)
        return null;
    if (!match[2]) {
        throw new UserError("素材 data URL 必须使用 base64 编码。", "invalid_data_url");
    }
    const mime = (match[1] || "application/octet-stream").toLowerCase();
    const data = Buffer.from(match[3], "base64");
    if (!data.length) {
        throw new UserError("素材 data URL 解码后为空。", "invalid_data_url");
    }
    return { mime, data };
}
function limitFor(kind) {
    return kind === "image" ? IMAGE_LIMIT : AUDIO_LIMIT;
}
function formatMb(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
export async function stageAssets(refs, options) {
    const listKey = options.kind === "image" ? "images" : "audios";
    assertAssetCount(listKey, refs);
    if (!Array.isArray(refs) || !refs.length)
        return [];
    const dir = assetsDir(options.batchId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const staged = [];
    let total = 0;
    for (const [index, rawRef] of refs.entries()) {
        const ref = String(rawRef).trim();
        if (isHttpUrl(ref)) {
            await assertSafeUserAssetUrl(ref, options.allowPrivateNetwork);
            staged.push(ref);
            continue;
        }
        const dataUrl = parseDataUrl(ref);
        if (dataUrl) {
            const limit = limitFor(options.kind);
            if (dataUrl.data.length > limit) {
                throw new UserError(`${options.kind === "image" ? "参考图片" : "参考音频"}第 ${index + 1} 个文件 ${formatMb(dataUrl.data.length)}，超过单文件上限 ${formatMb(limit)}。`, "asset_too_large");
            }
            total += dataUrl.data.length;
            if (total > TOTAL_LIMIT) {
                throw new UserError(`素材总大小超过 ${formatMb(TOTAL_LIMIT)}，请减少素材数量或压缩文件。`, "asset_too_large");
            }
            const ext = extensionForMime(dataUrl.mime, options.kind === "image" ? ".png" : ".mp3");
            const destination = path.join(dir, `${options.kind}-${index + 1}${ext}`);
            fs.writeFileSync(destination, dataUrl.data, { mode: 0o600 });
            fs.chmodSync(destination, 0o600);
            staged.push(destination);
            continue;
        }
        const source = path.resolve(ref);
        let stat;
        try {
            stat = fs.statSync(source);
        }
        catch {
            throw new UserError(`找不到素材文件：${source}`, "asset_not_found");
        }
        if (!stat.isFile()) {
            throw new UserError(`素材路径不是文件：${source}`, "asset_not_file");
        }
        const limit = limitFor(options.kind);
        if (stat.size > limit) {
            throw new UserError(`${options.kind === "image" ? "参考图片" : "参考音频"}第 ${index + 1} 个文件 ${formatMb(stat.size)}，超过单文件上限 ${formatMb(limit)}。`, "asset_too_large");
        }
        total += stat.size;
        if (total > TOTAL_LIMIT) {
            throw new UserError(`素材总大小超过 ${formatMb(TOTAL_LIMIT)}，请减少素材数量或压缩文件。`, "asset_too_large");
        }
        const ext = path.extname(source).toLowerCase() || (options.kind === "image" ? ".png" : ".mp3");
        const destination = path.join(dir, `${options.kind}-${index + 1}${ext}`);
        if (source !== destination) {
            fs.copyFileSync(source, destination);
            fs.chmodSync(destination, 0o600);
        }
        staged.push(destination);
    }
    return staged;
}
export function encodeAssetRefs(refs, encoding) {
    if (!refs || !refs.length)
        return undefined;
    let total = 0;
    return refs.map((ref) => {
        if (isHttpUrl(ref))
            return ref;
        let buffer;
        try {
            buffer = fs.readFileSync(ref);
        }
        catch {
            throw new UserError(`素材文件已丢失，无法提交：${ref}。请重新准备批次。`, "asset_missing_at_submit");
        }
        total += buffer.length;
        if (total > ENCODED_LIMIT) {
            throw new UserError("编码后的素材总大小过大，请减少或压缩素材后重新准备批次。", "asset_too_large");
        }
        const base64 = buffer.toString("base64");
        if (encoding === "raw")
            return base64;
        return `data:${mimeForFile(ref)};base64,${base64}`;
    });
}
