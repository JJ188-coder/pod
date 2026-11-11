import { envFlag, numberEnv } from "./util.js";

export const DEFAULT_ENDPOINT = "http://127.0.0.1:3425/mcp/magpie/image";

export interface AppConfig {
  endpoint: string;
  /** 生成调用的内部预算：Magpie 约 20 秒返回图片或任务 ID。 */
  generateBudgetMs: number;
  /** 查询调用的内部预算：generation_result 同样约 20 秒。 */
  resultBudgetMs: number;
  maxImageBytes: number;
  /** URL 下载是否允许任意内网地址；默认只允许与 Magpie 同源。 */
  allowPrivateDownload: boolean;
}

function endpointFromEnv(): string {
  const raw = process.env.MAGPIE_IMAGE_URL?.trim() || DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MAGPIE_IMAGE_URL 不是合法地址：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MAGPIE_IMAGE_URL 必须使用 http 或 https。");
  }
  return url.toString();
}

export function loadConfig(): AppConfig {
  return {
    endpoint: endpointFromEnv(),
    generateBudgetMs: numberEnv("MAGPIE_IMAGE_GENERATE_BUDGET_MS", 25_000),
    resultBudgetMs: numberEnv("MAGPIE_IMAGE_RESULT_BUDGET_MS", 25_000),
    maxImageBytes: numberEnv("MAGPIE_IMAGE_MAX_BYTES", 40 * 1024 * 1024),
    allowPrivateDownload: envFlag("MAGPIE_IMAGE_ALLOW_PRIVATE_DOWNLOAD"),
  };
}
