import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir(): string {
  const configured = process.env.MAGPIE_IMAGE_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".zcode", "magpie-image-studio");
}

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // 某些文件系统不支持 chmod；不阻断出图。
  }
}

export function dbPath(): string {
  return path.join(dataDir(), "state.db");
}

export function projectDir(): string {
  return process.env.ZCODE_PROJECT_DIR?.trim() || process.cwd();
}
