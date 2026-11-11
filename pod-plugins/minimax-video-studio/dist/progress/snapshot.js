import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../core/paths.js";
import { truncate } from "../core/util.js";
export class ProgressError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "ProgressError";
    }
}
const ACTIVE_STATUSES = [
    "queued",
    "submitting",
    "accepted",
    "submission_unknown",
    "running",
];
export function stageOf(status, fileStatus) {
    if (status === "queued")
        return "local_queue";
    if (status === "submitting")
        return "submitting";
    if (status === "accepted")
        return "accepted";
    if (status === "submission_unknown")
        return "submission_unknown";
    if (status === "running")
        return "generating";
    if (status === "failed" || status === "violation")
        return "failed";
    if (fileStatus === "ready")
        return "ready";
    if (fileStatus === "downloading")
        return "downloading";
    if (fileStatus === "download_failed")
        return "download_failed";
    return "download_pending";
}
/**
 * 进度值只按记录原样解释，不推断、不补齐、不单调修正。
 * 旧版本在受理时写入 0，且解析层曾把 null/空串/布尔变成 0，因此 0 不能当作实测值。
 */
export function progressView(status, raw) {
    if (status === "succeeded")
        return { progress: 100, progress_quality: "complete" };
    if (status === "failed" || status === "violation") {
        return { progress: null, progress_quality: "not_applicable" };
    }
    if (status !== "running")
        return { progress: null, progress_quality: "pending" };
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (value === null)
        return { progress: null, progress_quality: "unknown" };
    if (value <= 0 || value > 100) {
        return { progress: null, progress_quality: "legacy_ambiguous" };
    }
    if (value >= 100)
        return { progress: 100, progress_quality: "interface_100_pending" };
    return { progress: Math.round(value), progress_quality: "interface" };
}
function safeError(value) {
    if (!value)
        return null;
    const cleaned = value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned ? truncate(cleaned, 160) : null;
}
function displayName(row) {
    const name = row.output_name?.trim();
    return name ? truncate(name, 48) : `第 ${row.ordinal} 条`;
}
function paramsOf(raw) {
    try {
        const parsed = JSON.parse(raw);
        const duration = Number(parsed.duration);
        return {
            aspect_ratio: parsed.aspectRatio === "landscape" ? "landscape" : "portrait",
            resolution: typeof parsed.resolution === "string" ? parsed.resolution : "768p",
            duration: Number.isFinite(duration) ? duration : 0,
        };
    }
    catch {
        return { aspect_ratio: "portrait", resolution: "768p", duration: 0 };
    }
}
function countsOf(jobs) {
    const counts = {
        total: jobs.length,
        waiting: 0,
        accepted: 0,
        generating: 0,
        succeeded: 0,
        ready: 0,
        failed: 0,
        unknown: 0,
    };
    for (const job of jobs) {
        if (job.stage === "local_queue" || job.stage === "submitting")
            counts.waiting += 1;
        else if (job.stage === "accepted")
            counts.accepted += 1;
        else if (job.stage === "generating")
            counts.generating += 1;
        else if (job.stage === "ready")
            counts.ready += 1;
        else if (job.stage === "failed")
            counts.failed += 1;
        else if (job.stage === "submission_unknown")
            counts.unknown += 1;
        else if (job.stage === "download_pending" || job.stage === "downloading")
            counts.succeeded += 1;
        if (job.stage === "download_failed")
            counts.failed += 1;
    }
    return counts;
}
function isTerminal(jobs) {
    const active = jobs.some((job) => ACTIVE_STATUSES.includes(job.status) ||
        (job.status === "succeeded" &&
            (job.file_status === "not_started" || job.file_status === "downloading")));
    return !active;
}
function openReadOnly(file) {
    try {
        const db = new DatabaseSync(file, { readOnly: true });
        db.exec("PRAGMA query_only = ON;");
        db.exec("PRAGMA busy_timeout = 2000;");
        return db;
    }
    catch {
        throw new ProgressError("无法以只读方式打开任务记录。", "db_unavailable");
    }
}
export function readProgressSnapshot(batchId, now = new Date()) {
    const file = dbPath();
    if (!fs.existsSync(file)) {
        throw new ProgressError("任务记录尚不存在。", "db_missing");
    }
    const db = openReadOnly(file);
    try {
        const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
        if (!columns.has("status")) {
            throw new ProgressError("任务记录结构不可识别。", "db_schema_unsupported");
        }
        const outputExpr = columns.has("output_name") ? "output_name" : "NULL AS output_name";
        const batch = db
            .prepare("SELECT id, status, created_at, updated_at FROM batches WHERE id = ?")
            .get(batchId);
        if (!batch) {
            throw new ProgressError(`批次不存在：${batchId}`, "batch_not_found");
        }
        const rows = db
            .prepare(`SELECT id, ordinal, ${outputExpr}, spec_json, status, file_status, progress, error, created_at, updated_at
         FROM jobs WHERE batch_id = ? ORDER BY ordinal`)
            .all(batchId);
        const jobs = rows.map((row) => {
            const progress = progressView(row.status, row.progress);
            return {
                job_id: row.id,
                ordinal: row.ordinal,
                display_name: displayName(row),
                status: row.status,
                file_status: row.file_status,
                stage: stageOf(row.status, row.file_status),
                progress: progress.progress,
                progress_quality: progress.progress_quality,
                params: paramsOf(row.spec_json),
                created_at: row.created_at,
                record_updated_at: row.updated_at,
                safe_error: safeError(row.error),
            };
        });
        return {
            batch_id: batch.id,
            batch_status: batch.status,
            observed_at: now.toISOString(),
            terminal: isTerminal(jobs),
            counts: countsOf(jobs),
            jobs,
        };
    }
    catch (error) {
        if (error instanceof ProgressError)
            throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new ProgressError(`读取任务记录失败：${message}`, "db_read_failed");
    }
    finally {
        db.close();
    }
}
