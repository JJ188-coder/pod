import { DatabaseSync } from "node:sqlite";
import { ConflictError, UserError } from "./errors.js";
import { ensureDir, dbPath, dataDir } from "./paths.js";
import { nowIso } from "./util.js";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  prompt TEXT NOT NULL,
  params_json TEXT NOT NULL,
  n INTEGER NOT NULL,
  output_dir TEXT NOT NULL,
  generation_state TEXT NOT NULL,
  remote_id TEXT,
  images_received INTEGER NOT NULL DEFAULT 0,
  attempts_submit INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  raw_response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_value TEXT,
  mime_type TEXT,
  file_state TEXT NOT NULL,
  local_path TEXT,
  bytes INTEGER,
  sha256 TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(generation_state, updated_at);
`;
export function openDb() {
    ensureDir(dataDir());
    const db = new DatabaseSync(dbPath());
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 10000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    return db;
}
function withTransaction(db, fn) {
    db.exec("BEGIN IMMEDIATE;");
    try {
        const result = fn();
        db.exec("COMMIT;");
        return result;
    }
    catch (error) {
        try {
            db.exec("ROLLBACK;");
        }
        catch {
            // 回滚失败时保留原始错误。
        }
        throw error;
    }
}
export function getTask(db, taskId) {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) ?? null;
}
export function findTaskByRequestId(db, requestId) {
    return (db.prepare("SELECT * FROM tasks WHERE request_id = ?").get(requestId) ?? null);
}
/**
 * 在同一事务里登记任务并取得唯一提交资格。
 * 同一 request_id 且请求内容相同 -> 返回已有任务（created=false），调用方不得再次提交。
 * 同一 request_id 但内容不同 -> 报冲突。
 */
export function claimTask(db, input) {
    return withTransaction(db, () => {
        const existing = findTaskByRequestId(db, input.requestId);
        if (existing) {
            if (existing.request_hash !== input.requestHash) {
                throw new ConflictError(`request_id「${input.requestId}」已用于不同的生成参数。若确实要再生成一组，请换一个新的 request_id。`);
            }
            return { task: existing, created: false };
        }
        const timestamp = nowIso();
        db.prepare(`INSERT INTO tasks
       (id, request_id, request_hash, prompt, params_json, n, output_dir, generation_state,
        remote_id, images_received, attempts_submit, error, raw_response,
        created_at, updated_at, last_checked_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submitting', NULL, 0, 1, NULL, NULL, ?, ?, NULL, NULL)`).run(input.id, input.requestId, input.requestHash, input.prompt, input.paramsJson, input.n, input.outputDir, timestamp, timestamp);
        const task = getTask(db, input.id);
        if (!task)
            throw new UserError("任务写入后无法读取。", "task_read_failed");
        return { task, created: true };
    });
}
const PATCHABLE = new Set([
    "generation_state",
    "remote_id",
    "images_received",
    "error",
    "raw_response",
    "last_checked_at",
    "finished_at",
]);
export function patchTask(db, taskId, patch) {
    const entries = Object.entries(patch).filter(([key, value]) => PATCHABLE.has(key) && value !== undefined);
    if (entries.length) {
        const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
        db.prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value), nowIso(), taskId);
    }
    const task = getTask(db, taskId);
    if (!task)
        throw new UserError(`任务不存在：${taskId}`, "task_not_found");
    return task;
}
export function attachRemoteId(db, taskId, remoteId) {
    return withTransaction(db, () => {
        const task = getTask(db, taskId);
        if (!task)
            throw new UserError(`任务不存在：${taskId}`, "task_not_found");
        if (task.remote_id && task.remote_id !== remoteId) {
            throw new ConflictError(`任务已记录 Magpie 任务 ID「${task.remote_id}」，不能用「${remoteId}」替换。`);
        }
        if (task.generation_state === "succeeded") {
            throw new ConflictError("任务已生成完成，不需要补填 Magpie 任务 ID。");
        }
        return patchTask(db, taskId, { remote_id: remoteId, generation_state: "pending" });
    });
}
export function getArtifacts(db, taskId) {
    return db
        .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY ordinal")
        .all(taskId);
}
/** 只记录图片定位信息；已有 ready 文件的行保留其文件状态。 */
export function upsertArtifacts(db, taskId, artifacts) {
    withTransaction(db, () => {
        const timestamp = nowIso();
        const insert = db.prepare(`INSERT INTO artifacts
       (task_id, ordinal, source, source_value, mime_type, file_state, local_path, bytes, sha256, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(task_id, ordinal) DO UPDATE SET
         source = excluded.source,
         source_value = excluded.source_value,
         mime_type = excluded.mime_type,
         updated_at = excluded.updated_at`);
        for (const artifact of artifacts) {
            insert.run(taskId, artifact.ordinal, artifact.source, artifact.sourceValue, artifact.mimeType, timestamp, timestamp);
        }
    });
}
export function patchArtifact(db, taskId, ordinal, patch) {
    db.prepare(`UPDATE artifacts
     SET file_state = ?, local_path = ?, bytes = ?, sha256 = ?, error = ?, updated_at = ?
     WHERE task_id = ? AND ordinal = ?`).run(patch.fileState, patch.localPath ?? null, patch.bytes ?? null, patch.sha256 ?? null, patch.error ?? null, nowIso(), taskId, ordinal);
}
export function listTasks(db, options = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const unfinished = ["submitting", "pending", "submission_unknown"];
    const rows = options.unfinishedOnly
        ? db
            .prepare(`SELECT * FROM tasks WHERE generation_state IN (${unfinished.map(() => "?").join(",")})
           ORDER BY updated_at DESC LIMIT ?`)
            .all(...unfinished, limit)
        : db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map((row) => ({ ...row, images_saved: countSaved(db, row.id) }));
}
export function countSaved(db, taskId) {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE task_id = ? AND file_state = 'ready'")
        .get(taskId);
    return Number(row.count);
}
