import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function dataDir() {
    const configured = process.env.MINIMAX_VIDEO_DATA_DIR?.trim();
    if (configured)
        return path.resolve(configured);
    return path.join(os.homedir(), ".zcode", "minimax-video-studio");
}
export function ensureDir(dir, mode = 0o700) {
    fs.mkdirSync(dir, { recursive: true, mode });
    try {
        fs.chmodSync(dir, mode);
    }
    catch {
        // 文件系统可能不支持 chmod；权限检查会在 doctor 中报告。
    }
}
export function dbPath() {
    return path.join(dataDir(), "state.db");
}
export function credentialsPath() {
    return path.join(dataDir(), "credentials.json");
}
export function videosDir() {
    return path.join(dataDir(), "videos");
}
export function assetsDir(batchId) {
    return path.join(dataDir(), "assets", batchId);
}
export function prepareDataDirs() {
    ensureDir(dataDir());
    ensureDir(videosDir());
}
