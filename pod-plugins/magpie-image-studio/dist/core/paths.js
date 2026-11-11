import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function dataDir() {
    const configured = process.env.MAGPIE_IMAGE_DATA_DIR?.trim();
    if (configured)
        return path.resolve(configured);
    return path.join(os.homedir(), ".zcode", "magpie-image-studio");
}
export function ensureDir(dir, mode = 0o700) {
    fs.mkdirSync(dir, { recursive: true, mode });
    try {
        fs.chmodSync(dir, mode);
    }
    catch {
        // 某些文件系统不支持 chmod；不阻断出图。
    }
}
export function dbPath() {
    return path.join(dataDir(), "state.db");
}
export function projectDir() {
    return process.env.ZCODE_PROJECT_DIR?.trim() || process.cwd();
}
