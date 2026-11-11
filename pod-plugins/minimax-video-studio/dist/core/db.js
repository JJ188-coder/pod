import { DatabaseSync } from "node:sqlite";
import { dataDir, dbPath, ensureDir } from "./paths.js";
import { nowIso } from "./util.js";
const ACTIVE_STATUSES = ["submitting", "accepted", "submission_unknown", "running"];
const UNFINISHED_BATCH_STATUSES = ["queued", "running", "stopped"];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  output_name TEXT,
  status TEXT NOT NULL,
  file_status TEXT NOT NULL DEFAULT 'not_started',
  provider_id TEXT,
  progress INTEGER,
  remote_url TEXT,
  local_path TEXT,
  error TEXT,
  attempts_submit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(batch_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_provider ON jobs(provider_id);
CREATE INDEX IF NOT EXISTS idx_batches_hash ON batches(request_hash, created_at);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;
export function openDb() {
    ensureDir(dataDir());
    const db = new DatabaseSync(dbPath());
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 10000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    const columns = db.prepare("PRAGMA table_info(jobs)").all();
    if (!columns.some((column) => column.name === "output_name")) {
        db.exec("ALTER TABLE jobs ADD COLUMN output_name TEXT;");
    }
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
            // 忽略回滚失败，保留原始错误。
        }
        throw error;
    }
}
export function findBatchByClientRequestId(db, clientRequestId) {
    return db.prepare("SELECT * FROM batches WHERE client_request_id = ?").get(clientRequestId) ?? null;
}
export function findRecentBatchByHash(db, hash, sinceIso) {
    return (db
        .prepare("SELECT * FROM batches WHERE request_hash = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
        .get(hash, sinceIso) ?? null);
}
export function insertBatch(db, batch, jobs) {
    withTransaction(db, () => {
        db.prepare(`INSERT INTO batches (id, client_request_id, request_hash, status, created_at, updated_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(batch.id, batch.client_request_id, batch.request_hash, batch.status, batch.created_at, batch.updated_at, batch.note);
        const statement = db.prepare(`INSERT INTO jobs
       (id, batch_id, ordinal, spec_json, prompt, output_name, status, file_status, provider_id, progress,
        remote_url, local_path, error, attempts_submit, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, NULL)`);
        for (const job of jobs) {
            statement.run(job.id, job.batch_id, job.ordinal, job.spec_json, job.prompt, job.output_name, job.status, job.file_status, job.created_at, job.updated_at);
        }
    });
}
export function getBatch(db, batchId) {
    return db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) ?? null;
}
export function getJobs(db, batchId) {
    return db.prepare("SELECT * FROM jobs WHERE batch_id = ? ORDER BY ordinal").all(batchId);
}
export function getJob(db, jobId) {
    return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) ?? null;
}
export function listBatches(db, options = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    if (options.unfinishedOnly) {
        const placeholders = UNFINISHED_BATCH_STATUSES.map(() => "?").join(",");
        return db
            .prepare(`SELECT * FROM batches WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
            .all(...UNFINISHED_BATCH_STATUSES, limit);
    }
    return db.prepare("SELECT * FROM batches ORDER BY updated_at DESC LIMIT ?").all(limit);
}
export function countActive(db) {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const row = db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN (${placeholders})`).get(...ACTIVE_STATUSES);
    return Number(row.count);
}
export function countActiveForBatch(db, batchId) {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const row = db
        .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE batch_id = ? AND status IN (${placeholders})`)
        .get(batchId, ...ACTIVE_STATUSES);
    return Number(row.count);
}
export function claimNextQueued(db, batchId, maxConcurrent, lease) {
    return withTransaction(db, () => {
        if (lease && !db.prepare("SELECT 1 FROM leases WHERE name = ? AND owner = ? AND expires_at > ?")
            .get(lease.name, lease.owner, Date.now()))
            return null;
        if (maxConcurrent !== undefined && countActive(db) >= maxConcurrent)
            return null;
        const row = db
            .prepare("SELECT * FROM jobs WHERE batch_id = ? AND status = 'queued' ORDER BY ordinal LIMIT 1")
            .get(batchId);
        if (!row)
            return null;
        const timestamp = nowIso();
        const result = db
            .prepare("UPDATE jobs SET status = 'submitting', attempts_submit = attempts_submit + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
            .run(timestamp, row.id);
        if (Number(result.changes) !== 1)
            return null;
        return {
            ...row,
            status: "submitting",
            attempts_submit: row.attempts_submit + 1,
            updated_at: timestamp,
        };
    });
}
const PATCHABLE = new Set([
    "status",
    "file_status",
    "provider_id",
    "progress",
    "remote_url",
    "local_path",
    "error",
    "finished_at",
]);
export function updateJob(db, jobId, patch) {
    const entries = Object.entries(patch).filter(([key]) => PATCHABLE.has(key));
    if (!entries.length)
        return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => (value === undefined ? null : value));
    db.prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), jobId);
}
export function markAccepted(db, jobId, providerId) {
    // 租约丢失后仍可保存迟到的受理 ID，但不能覆盖人工补填、放弃或已完成的任务。
    db.prepare(`UPDATE jobs SET status = 'accepted', provider_id = ?, progress = 0, error = NULL, updated_at = ?
     WHERE id = ? AND status IN ('submitting', 'submission_unknown') AND provider_id IS NULL`).run(providerId, nowIso(), jobId);
}
export function markSubmissionUnknown(db, jobId, error) {
    db.prepare(`UPDATE jobs SET status = 'submission_unknown', error = ?, updated_at = ?
     WHERE id = ? AND status = 'submitting' AND provider_id IS NULL`).run(error, nowIso(), jobId);
}
export function markRunning(db, jobId, progress) {
    updateJob(db, jobId, {
        status: "running",
        progress,
        error: null,
    });
}
export function markSucceeded(db, jobId, remoteUrl) {
    updateJob(db, jobId, {
        status: "succeeded",
        progress: 100,
        remote_url: remoteUrl,
        error: null,
    });
}
export function markFailed(db, jobId, message, violation = false) {
    updateJob(db, jobId, {
        status: violation ? "violation" : "failed",
        error: message,
        finished_at: nowIso(),
    });
}
export function setFileStatus(db, jobId, fileStatus, localPath, error = null) {
    updateJob(db, jobId, {
        file_status: fileStatus,
        local_path: localPath,
        error: error,
    });
}
export function resetDownloading(db, batchId) {
    db.prepare("UPDATE jobs SET file_status = 'not_started', updated_at = ? WHERE batch_id = ? AND file_status = 'downloading'").run(nowIso(), batchId);
}
export function reapStaleSubmitting(db, batchId, cutoffIso) {
    const result = db
        .prepare(`UPDATE jobs
       SET status = 'submission_unknown',
           error = '提交结果未知：进程在等待响应时中断，已保留名额并禁止自动重提。',
           updated_at = ?
       WHERE batch_id = ? AND status = 'submitting' AND updated_at < ?`)
        .run(nowIso(), batchId, cutoffIso);
    return Number(result.changes);
}
export function setBatchStatus(db, batchId, status, note) {
    if (note === undefined) {
        db.prepare("UPDATE batches SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), batchId);
    }
    else {
        db.prepare("UPDATE batches SET status = ?, note = ?, updated_at = ? WHERE id = ?").run(status, note, nowIso(), batchId);
    }
}
export function finalizeBatch(db, batchId, override) {
    const jobs = getJobs(db, batchId);
    let status;
    if (override) {
        status = override;
    }
    else if (getBatch(db, batchId)?.note?.startsWith("provider_blocked: ")) {
        status = "stopped";
    }
    else {
        const total = jobs.length;
        const ready = jobs.filter((job) => job.status === "succeeded" && job.file_status === "ready").length;
        const failed = jobs.filter((job) => job.status === "failed" || job.status === "violation").length;
        const active = jobs.some((job) => ["queued", "submitting", "accepted", "submission_unknown", "running"].includes(job.status));
        const pendingDownload = jobs.some((job) => job.status === "succeeded" &&
            (job.file_status === "not_started" || job.file_status === "downloading"));
        if (total > 0 && ready === total) {
            status = "done";
        }
        else if (active || pendingDownload) {
            status = jobs.every((job) => job.status === "queued") ? "queued" : "running";
        }
        else if (failed === total) {
            status = "failed";
        }
        else {
            status = "partial";
        }
    }
    setBatchStatus(db, batchId, status);
    return status;
}
export function attachProviderId(db, jobId, providerId) {
    const job = getJob(db, jobId);
    if (!job)
        throw new Error(`任务不存在：${jobId}`);
    if (job.status !== "submission_unknown" && job.status !== "submitting") {
        throw new Error(`只有提交状态未知的任务才能补填供应商任务 ID，当前状态为 ${job.status}。`);
    }
    updateJob(db, jobId, {
        status: "accepted",
        provider_id: providerId,
        error: null,
        progress: 0,
    });
    return getJob(db, jobId);
}
export function abandonJob(db, jobId, reason) {
    const job = getJob(db, jobId);
    if (!job)
        throw new Error(`任务不存在：${jobId}`);
    if (["succeeded", "failed", "violation"].includes(job.status)) {
        throw new Error(`任务已结束（${job.status}），无需放弃。`);
    }
    markFailed(db, jobId, `本地放弃：${reason}。远端任务（如已提交）可能仍在运行并计费。`);
    return getJob(db, jobId);
}
export function acquireLease(db, name, owner, ttlMs) {
    return withTransaction(db, () => {
        const now = Date.now();
        const row = db.prepare("SELECT owner, expires_at FROM leases WHERE name = ?").get(name);
        if (!row) {
            db.prepare("INSERT INTO leases (name, owner, expires_at) VALUES (?, ?, ?)").run(name, owner, now + ttlMs);
            return true;
        }
        if (row.owner === owner || Number(row.expires_at) < now) {
            db.prepare("UPDATE leases SET owner = ?, expires_at = ? WHERE name = ?").run(owner, now + ttlMs, name);
            return true;
        }
        return false;
    });
}
export function refreshLease(db, name, owner, ttlMs) {
    const result = db
        .prepare("UPDATE leases SET expires_at = ? WHERE name = ? AND owner = ? AND expires_at > ?")
        .run(Date.now() + ttlMs, name, owner, Date.now());
    return Number(result.changes) === 1;
}
export function releaseLease(db, name, owner) {
    db.prepare("DELETE FROM leases WHERE name = ? AND owner = ?").run(name, owner);
}
