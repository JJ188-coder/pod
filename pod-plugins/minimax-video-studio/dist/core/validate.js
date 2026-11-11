import dns from "node:dns/promises";
import net from "node:net";
import { UserError } from "./errors.js";
const ASPECT_ALIASES = {
    portrait: "portrait",
    vertical: "portrait",
    "9:16": "portrait",
    "3:4": "portrait",
    "2:3": "portrait",
    "4:5": "portrait",
    "竖屏": "portrait",
    "竖版": "portrait",
    landscape: "landscape",
    horizontal: "landscape",
    "16:9": "landscape",
    "4:3": "landscape",
    "3:2": "landscape",
    "5:4": "landscape",
    "21:9": "landscape",
    "横屏": "landscape",
    "横版": "landscape",
};
const RESOLUTIONS = ["480p", "768p", "1080p"];
export function normalizeAspectRatio(raw) {
    const key = String(raw ?? "portrait").trim().toLowerCase();
    const mapped = ASPECT_ALIASES[key];
    if (!mapped) {
        throw new UserError(`minimax-h3 只支持竖屏或横屏，收到「${String(raw)}」。可用值：portrait/9:16 或 landscape/16:9。`, "invalid_aspect_ratio");
    }
    return mapped;
}
export function normalizeResolution(raw) {
    const key = String(raw ?? "768p").trim().toLowerCase();
    if (key === "720p") {
        throw new UserError("minimax-h3 没有 720p 档位，请使用 480p、768p 或 1080p。", "invalid_resolution");
    }
    if (!RESOLUTIONS.includes(key)) {
        throw new UserError(`分辨率只支持 480p、768p、1080p，收到「${String(raw)}」。`, "invalid_resolution");
    }
    return key;
}
export function normalizeDuration(raw, resolution) {
    const duration = Number(raw ?? 6);
    if (!Number.isInteger(duration)) {
        throw new UserError(`视频时长必须是整数秒，收到「${String(raw)}」。`, "invalid_duration");
    }
    if (duration < 1 || duration > 15) {
        throw new UserError("视频时长支持 1–15 秒。", "invalid_duration");
    }
    if (resolution === "1080p" && duration > 10) {
        throw new UserError("1080p 最多支持 10 秒；需要 11–15 秒请改用 768p 或 480p。", "invalid_duration");
    }
    return duration;
}
export function normalizeConcurrency(raw) {
    if (raw === undefined)
        return undefined;
    const value = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new UserError("concurrency 必须是正整数；省略时并发提交本批全部任务。", "invalid_concurrency");
    }
    return value;
}
export function normalizeSeed(raw) {
    if (raw === undefined || raw === null || raw === "")
        return undefined;
    const seed = Number(raw);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) {
        throw new UserError("seed 必须是 0–2147483647 之间的整数。", "invalid_seed");
    }
    return seed;
}
export function normalizePrompt(raw) {
    if (typeof raw !== "string") {
        throw new UserError("prompt 必须是非空字符串。", "invalid_prompt");
    }
    const prompt = raw.trim();
    if (!prompt) {
        throw new UserError("prompt 不能为空。", "invalid_prompt");
    }
    if (prompt.length > 6000) {
        throw new UserError("prompt 过长（超过 6000 字符），请精简到关键动作、镜头和约束。", "invalid_prompt");
    }
    return prompt;
}
export function assertAssetCount(kind, refs) {
    const max = kind === "images" ? 9 : 3;
    const label = kind === "images" ? "参考图片" : "参考音频";
    if (refs === undefined)
        return;
    if (!Array.isArray(refs)) {
        throw new UserError(`${label}必须是数组。`, "invalid_assets");
    }
    if (refs.length > max) {
        throw new UserError(`${label}最多 ${max} 个，当前 ${refs.length} 个。`, "invalid_assets");
    }
    for (const ref of refs) {
        if (typeof ref !== "string" || !ref.trim()) {
            throw new UserError(`${label}的每一项都必须是非空字符串。`, "invalid_assets");
        }
    }
}
function isPrivateIpv4(address) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127)
        return true;
    if (a === 169 && b === 254)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 100 && b >= 64 && b <= 127)
        return true;
    if (a === 198 && (b === 18 || b === 19))
        return true;
    if (a >= 224)
        return true;
    return false;
}
function isPrivateIpv6(address) {
    const value = address.toLowerCase();
    if (value === "::1" || value === "::")
        return true;
    if (value.startsWith("fc") || value.startsWith("fd"))
        return true;
    if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb"))
        return true;
    if (value.startsWith("::ffff:"))
        return isPrivateIpv4(value.slice("::ffff:".length));
    return false;
}
function isPrivateAddress(address) {
    const version = net.isIP(address);
    if (version === 4)
        return isPrivateIpv4(address);
    if (version === 6)
        return isPrivateIpv6(address);
    return true;
}
function hostOf(url) {
    return url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
}
export async function assertSafeUserAssetUrl(raw, allowPrivateNetwork) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new UserError(`无效的素材链接：${raw}`, "invalid_asset_url");
    }
    if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
        throw new UserError("参考素材链接必须使用 HTTPS。", "insecure_asset_url");
    }
    if (url.username || url.password) {
        throw new UserError("素材链接不能包含用户名或密码。", "invalid_asset_url");
    }
    const host = hostOf(url);
    if (!host)
        throw new UserError("素材链接缺少域名。", "invalid_asset_url");
    if (!allowPrivateNetwork) {
        if (host === "localhost" || host.endsWith(".localhost")) {
            throw new UserError("素材链接不能指向本机地址。", "blocked_asset_url");
        }
        if (net.isIP(host)) {
            if (isPrivateAddress(host))
                throw new UserError("素材链接不能指向内网或保留地址。", "blocked_asset_url");
        }
        else {
            let addresses;
            try {
                addresses = await dns.lookup(host, { all: true, verbatim: true });
            }
            catch {
                throw new UserError(`无法解析素材域名：${host}`, "asset_dns_failed");
            }
            if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
                throw new UserError("素材链接解析到了内网或保留地址，已拒绝。", "blocked_asset_url");
            }
        }
    }
    return url;
}
export function assertSafeDownloadUrl(raw, allowPrivateNetwork) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new UserError(`无效的视频下载地址：${raw}`, "invalid_download_url");
    }
    if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
        throw new UserError("视频下载地址必须使用 HTTPS。", "insecure_download_url");
    }
    const host = hostOf(url);
    if (!allowPrivateNetwork) {
        if (host === "localhost" || host.endsWith(".localhost")) {
            throw new UserError("视频下载地址不能指向本机。", "blocked_download_url");
        }
        if (net.isIP(host) && isPrivateAddress(host)) {
            throw new UserError("视频下载地址不能指向内网或保留地址。", "blocked_download_url");
        }
    }
    return url;
}
