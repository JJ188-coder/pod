import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { UserError } from "./errors.js";
import { assertSafeDownloadUrl } from "./validate.js";

export interface DownloadOptions {
  allowPrivateNetwork: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  bytes: number;
  contentType: string;
  finalUrl: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function combinedSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function downloadToFile(
  url: string,
  partPath: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = combinedSignal(options.timeoutMs ?? 900_000, options.signal);
  let current = assertSafeDownloadUrl(url, options.allowPrivateNetwork).toString();
  let response: Response | null = null;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { Accept: "video/*,*/*;q=0.8" },
    });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    const location = response.headers.get("location");
    if (!location) {
      throw new UserError(`视频下载重定向缺少 Location（HTTP ${response.status}）。`, "download_failed");
    }
    current = assertSafeDownloadUrl(new URL(location, current).toString(), options.allowPrivateNetwork).toString();
    if (redirects === 5) {
      throw new UserError("视频下载重定向次数过多。", "download_failed");
    }
  }

  if (!response) {
    throw new UserError("视频下载没有返回响应。", "download_failed");
  }
  if (REDIRECT_STATUSES.has(response.status)) {
    throw new UserError("视频下载重定向次数过多。", "download_failed");
  }
  if (!response.ok) {
    throw new UserError(`视频下载失败：HTTP ${response.status}。`, "download_failed");
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("text/") || contentType.includes("json")) {
    throw new UserError(`视频下载返回了非视频内容（${contentType || "未知类型"}）。`, "download_failed");
  }
  if (!response.body) {
    throw new UserError("视频下载响应为空。", "download_failed");
  }

  fs.mkdirSync(path.dirname(partPath), { recursive: true, mode: 0o700 });
  fs.rmSync(partPath, { force: true });

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
      fs.createWriteStream(partPath, { mode: 0o600 }),
    );
  } catch (error) {
    fs.rmSync(partPath, { force: true });
    throw new UserError(`视频下载中断：${errorMessage(error)}`, "download_failed");
  }

  const stat = fs.statSync(partPath);
  if (stat.size < 1024) {
    fs.rmSync(partPath, { force: true });
    throw new UserError("视频文件过小，可能是错误页或空响应。", "download_failed");
  }
  fs.chmodSync(partPath, 0o600);

  return { bytes: stat.size, contentType, finalUrl: current };
}
