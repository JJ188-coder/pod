import fs from "node:fs";
import { UserError } from "./errors.js";
import { dataDir, ensureDir } from "./paths.js";
import { envFlag } from "./util.js";

export const DEFAULT_BASE_URL = "https://grsaiapi.com";

export type AssetEncoding = "data_url" | "raw";

export interface StoredCredentials {
  apiKey?: string;
  baseUrl?: string;
}

export interface AppConfig {
  baseUrl: string;
  apiKey: string | null;
  apiKeySource: "env" | "file" | "none";
  assetEncoding: AssetEncoding;
  allowPrivateNetwork: boolean;
  dataDir: string;
}

function credentialsFile(): string {
  return `${dataDir()}/credentials.json`;
}

export function readCredentials(): StoredCredentials | null {
  const file = credentialsFile();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredCredentials;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCredentials(credentials: StoredCredentials): string {
  ensureDir(dataDir());
  const file = credentialsFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

export function clearCredentials(): boolean {
  const file = credentialsFile();
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function normalizeBaseUrl(raw: string, allowPrivateNetwork: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UserError(`无效的 API 地址：${raw}`, "invalid_base_url");
  }
  if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
    throw new UserError("API 地址必须使用 HTTPS（本地测试可设置 MINIMAX_VIDEO_ALLOW_HTTP=1）。", "insecure_base_url");
  }
  if (url.username || url.password) {
    throw new UserError("API 地址不能包含用户名或密码。", "invalid_base_url");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new UserError("API 地址只填写域名，例如 https://grsaiapi.com，不要带路径。", "invalid_base_url");
  }
  return url.origin;
}

export function loadConfig(): AppConfig {
  const allowPrivateNetwork = envFlag("MINIMAX_VIDEO_ALLOW_HTTP") || envFlag("MINIMAX_VIDEO_ALLOW_PRIVATE_NETWORK");
  const stored = readCredentials();
  const envKey = process.env.MINIMAX_VIDEO_API_KEY?.trim() || null;
  const fileKey = stored?.apiKey?.trim() || null;
  const apiKey = envKey ?? fileKey;
  const baseUrlRaw = process.env.MINIMAX_VIDEO_BASE_URL?.trim() || stored?.baseUrl?.trim() || DEFAULT_BASE_URL;
  const encodingRaw = (process.env.MINIMAX_VIDEO_ASSET_ENCODING || "data_url").toLowerCase();
  const assetEncoding: AssetEncoding = encodingRaw === "raw" || encodingRaw === "raw_base64" ? "raw" : "data_url";

  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw, allowPrivateNetwork),
    apiKey,
    apiKeySource: envKey ? "env" : fileKey ? "file" : "none",
    assetEncoding,
    allowPrivateNetwork,
    dataDir: dataDir(),
  };
}
