import { createHash, randomBytes } from "node:crypto";
export function nowIso() {
    return new Date().toISOString();
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
export function truncate(input, maxLength = 500) {
    return input.length <= maxLength ? input : `${input.slice(0, maxLength)}…`;
}
export function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}
export function envFlag(name) {
    const value = process.env[name];
    return value === "1" || value === "true" || value === "yes";
}
export function numberEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}
