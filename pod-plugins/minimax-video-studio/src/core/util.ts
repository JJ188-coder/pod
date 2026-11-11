import { createHash, randomBytes, randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitter(ms: number, ratio = 0.2): number {
  const delta = ms * ratio;
  return Math.max(0, Math.round(ms - delta + Math.random() * delta * 2));
}

export function safeName(input: string, maxLength = 48): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return cleaned || "video";
}

export function truncate(input: string, maxLength = 500): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}…`;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function newOwnerId(): string {
  return `${process.pid}-${randomUUID()}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes";
}

export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
