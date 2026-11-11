import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { UserError } from "./errors.js";
import { ensureDir, projectDir } from "./paths.js";
import type { ParsedImage } from "./magpie.js";
import { sha256 } from "./util.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SavedArtifact {
  localPath: string;
  bytes: number;
  digest: string;
}

export function resolveOutputDir(raw: string | undefined, taskId: string): string {
  const root = projectDir();
  if (!raw || !raw.trim()) {
    return path.join(root, "generated-images", taskId);
  }
  const value = raw.trim();
  if (path.isAbsolute(value)) return path.resolve(value);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UserError("相对输出目录不能超出当前项目；需要写到别处请提供绝对路径。", "invalid_output_dir");
  }
  return resolved;
}

interface SniffedImage {
  ext: string;
  mimeType: string;
}

/** 只读文件头取尺寸；模型可能忽略 size，因此产物尺寸需要如实回传。 */
export function readImageDimensions(filePath: string): { width: number; height: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const buffer = head.subarray(0, read);
    if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

export function sniffImage(buffer: Buffer): SniffedImage | null {  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mimeType: "image/jpeg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mimeType: "image/webp" };
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) {
    return { ext: "gif", mimeType: "image/gif" };
  }
  return null;
}

function isPrivateHost(host: string): boolean {
  const value = host.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (value === "::1" || value === "::") return true;
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return a >= 224;
  }
  if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8")) return true;
  return false;
}

function assertDownloadUrl(raw: string, endpointOrigin: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`无效的图片地址：${raw}`, "invalid_image_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UserError("图片地址必须使用 http 或 https。", "invalid_image_url");
  }
  if (url.username || url.password) {
    throw new UserError("图片地址不能包含用户名或密码。", "invalid_image_url");
  }
  if (url.origin === endpointOrigin) return url;
  if (allowPrivate) return url;
  if (url.protocol !== "https:") {
    throw new UserError(`图片地址不是 Magpie 同源，必须使用 HTTPS：${url.origin}`, "insecure_image_url");
  }
  if (isPrivateHost(url.hostname)) {
    throw new UserError(`图片地址指向内网：${url.hostname}，已拒绝。`, "blocked_image_url");
  }
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new UserError("图片响应为空。", "download_failed");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UserError(`图片超过大小上限（${maxBytes} 字节）。`, "image_too_large");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UserError(`图片超过大小上限（${maxBytes} 字节）。`, "image_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function downloadImage(
  raw: string,
  config: AppConfig,
): Promise<{ buffer: Buffer; finalUrl: string }> {
  const endpointOrigin = new URL(config.endpoint).origin;
  let current = assertDownloadUrl(raw, endpointOrigin, config.allowPrivateDownload);
  let response: Response | null = null;

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetch(current, {
      redirect: "manual",
      headers: { Accept: "image/*,*/*;q=0.5" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new UserError("图片下载重定向缺少 Location。", "download_failed");
    if (redirects === 3) throw new UserError("图片下载重定向次数过多。", "download_failed");
    current = assertDownloadUrl(new URL(location, current).toString(), endpointOrigin, config.allowPrivateDownload);
  }

  if (!response) throw new UserError("图片下载没有返回响应。", "download_failed");
  if (!response.ok) throw new UserError(`图片下载失败：HTTP ${response.status}。`, "download_failed");

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/") || contentType.includes("json")) {
    throw new UserError(`图片地址返回了非图片内容（${contentType || "未知"}）。`, "download_failed");
  }

  const buffer = await readCapped(response, config.maxImageBytes);
  return { buffer, finalUrl: current.toString() };
}

function writeAtomic(destDir: string, baseName: string, buffer: Buffer): string {
  ensureDir(destDir, 0o755);
  const target = path.join(destDir, baseName);
  const temp = path.join(destDir, `.${baseName}.${process.pid}.part`);
  fs.rmSync(temp, { force: true });
  try {
    fs.writeFileSync(temp, buffer, { mode: 0o644 });
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`写入图片失败：${message}`, "write_failed");
  }
  return target;
}

export async function saveArtifact(
  image: ParsedImage,
  ordinal: number,
  outputDir: string,
  config: AppConfig,
): Promise<SavedArtifact> {
  let buffer: Buffer;
  if (image.source === "inline") {
    buffer = Buffer.from(image.value, "base64");
    if (!buffer.length) throw new UserError("Magpie 返回了空图片数据。", "empty_image");
    if (buffer.length > config.maxImageBytes) {
      throw new UserError(`图片超过大小上限（${config.maxImageBytes} 字节）。`, "image_too_large");
    }
  } else if (image.source === "file") {
    const stat = fs.statSync(image.value);
    if (stat.size > config.maxImageBytes) {
      throw new UserError(`图片超过大小上限（${config.maxImageBytes} 字节）。`, "image_too_large");
    }
    buffer = fs.readFileSync(image.value);
  } else {
    const downloaded = await downloadImage(image.value, config);
    buffer = downloaded.buffer;
  }

  const sniffed = sniffImage(buffer);
  if (!sniffed) {
    throw new UserError("下载或返回的数据不是可识别的 PNG/JPEG/WebP/GIF 图片。", "invalid_image_bytes");
  }

  const baseName = `${String(ordinal + 1).padStart(2, "0")}.${sniffed.ext}`;
  const localPath = writeAtomic(outputDir, baseName, buffer);
  return { localPath, bytes: buffer.length, digest: sha256(buffer) };
}
