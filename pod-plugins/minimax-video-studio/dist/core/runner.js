import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { acquireLease, claimNextQueued, finalizeBatch, getBatch, getJob, getJobs, markAccepted, markFailed, markRunning, markSubmissionUnknown, markSucceeded, reapStaleSubmitting, refreshLease, releaseLease, resetDownloading, setBatchStatus, setFileStatus, } from "./db.js";
import { downloadToFile } from "./download.js";
import { UserError } from "./errors.js";
import { videosDir } from "./paths.js";
import { Provider, readProviderSpec } from "./provider.js";
import { jitter, newOwnerId, safeName } from "./util.js";
import { normalizeConcurrency } from "./validate.js";
import { countsOf, toJobView } from "./views.js";
const LEASE_TTL_MS = 90_000;
const QUERY_CONCURRENCY = 4;
const DOWNLOAD_CONCURRENCY = 2;
const BLOCK_PREFIX = "provider_blocked: ";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function buildDownloadPaths(job, owner) {
    const dir = path.join(videosDir(), job.batch_id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const label = job.output_name ? `${safeName(job.output_name, 48)}-` : "";
    const base = path.join(dir, `${String(job.ordinal).padStart(2, "0")}-${label}${job.id}`);
    return { base, part: `${base}.${owner}.part` };
}
function extensionFor(contentType, remoteUrl) {
    if (contentType.includes("webm"))
        return ".webm";
    if (contentType.includes("quicktime"))
        return ".mov";
    if (contentType.includes("matroska"))
        return ".mkv";
    if (contentType.includes("mp4"))
        return ".mp4";
    try {
        const extension = path.extname(new URL(remoteUrl).pathname).toLowerCase();
        if ([".mp4", ".webm", ".mov", ".m4v", ".mkv"].includes(extension))
            return extension;
    }
    catch {
        // URL 已在下载阶段校验；这里仅用于推断扩展名。
    }
    return ".mp4";
}
function chooseFinalPath(base, contentType, remoteUrl) {
    const extension = extensionFor(contentType, remoteUrl);
    let candidate = `${base}${extension}`;
    if (fs.existsSync(candidate))
        candidate = `${base}-${Date.now()}${extension}`;
    return candidate;
}
export async function runBatch(db, options) {
    const batch = getBatch(db, options.batchId);
    if (!batch)
        throw new UserError(`批次不存在：${options.batchId}`, "batch_not_found");
    const concurrency = normalizeConcurrency(options.concurrency);
    const config = loadConfig();
    const provider = options.provider ?? new Provider(config, options.providerOptions);
    const log = options.log ?? (() => undefined);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const maxWaitMs = Math.max(1000, options.maxWaitMs ?? 60 * 60 * 1000);
    const pollMinMs = Math.max(50, options.pollMinMs ?? 5000);
    const pollMaxMs = Math.max(pollMinMs, options.pollMaxMs ?? 20_000);
    const startedAt = Date.now();
    const leaseName = `batch:${options.batchId}`;
    const owner = newOwnerId();
    if (!acquireLease(db, leaseName, owner, LEASE_TTL_MS)) {
        throw new UserError("该批次已有后台执行器在运行，请等待或先查询状态。", "batch_locked");
    }
    const warnings = [];
    const warn = (message) => {
        if (warnings.length < 20)
            warnings.push(message);
    };
    const attemptedDownloads = new Set();
    let exitReason = "pending";
    let pollMs = pollMinMs;
    let leaseLost = false;
    let blockedReason = null;
    const pause = (message) => {
        if (blockedReason)
            return;
        blockedReason = message;
        setBatchStatus(db, options.batchId, "stopped", `${BLOCK_PREFIX}${message}`);
        warn(`已暂停未派发请求：${message}。已发出的请求无法撤回；核对并解决后才能显式恢复。`);
    };
    const renewLease = () => {
        if (leaseLost)
            return false;
        try {
            if (refreshLease(db, leaseName, owner, LEASE_TTL_MS))
                return true;
        }
        catch {
            // 无法确认持有租约时同样停止，不能继续收费提交。
        }
        leaseLost = true;
        warn("批次执行租约丢失，已停止新派发并收尾在途请求，避免重复提交。");
        controller.abort();
        return false;
    };
    const canDispatch = () => {
        if (signal.aborted || blockedReason)
            return false;
        const note = getBatch(db, options.batchId)?.note;
        if (note?.startsWith(BLOCK_PREFIX))
            pause(note.slice(BLOCK_PREFIX.length));
        return !blockedReason && Date.now() - startedAt < maxWaitMs;
    };
    const heartbeat = setInterval(renewLease, LEASE_TTL_MS / 3);
    heartbeat.unref();
    // 所有在途调用收尾后才释放租约/关闭数据库；不能让 Promise.all 的早退遗漏写账本。
    const runWorkers = async (count, next) => {
        const results = await Promise.allSettled(Array.from({ length: count }, async () => {
            try {
                while (canDispatch()) {
                    if (!await next())
                        break;
                }
            }
            catch (error) {
                controller.abort();
                throw error;
            }
        }));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected")
            throw failed.reason;
    };
    try {
        const reaped = reapStaleSubmitting(db, options.batchId, new Date(Date.now() + 1000).toISOString());
        if (reaped > 0)
            warn(`发现 ${reaped} 个上次中断的提交，已标记为提交结果未知；不会自动重发。`);
        resetDownloading(db, options.batchId);
        if (batch.note?.startsWith(BLOCK_PREFIX)) {
            if (options.resumeBlocked)
                setBatchStatus(db, options.batchId, batch.status, null);
            else
                pause(batch.note.slice(BLOCK_PREFIX.length));
        }
        if (!config.apiKey && !options.provider && getJobs(db, options.batchId).some((job) => ["queued", "accepted", "running"].includes(job.status)))
            pause("缺少 API Key，未提交任何新任务");
        while (true) {
            if (signal.aborted || blockedReason || !renewLease()) {
                exitReason = "stopped";
                break;
            }
            const queryJobs = getJobs(db, options.batchId).filter((job) => (job.status === "accepted" || job.status === "running") && job.provider_id);
            let queryIndex = 0;
            await runWorkers(Math.min(QUERY_CONCURRENCY, queryJobs.length), async () => {
                const job = queryJobs[queryIndex++];
                if (!job || !renewLease())
                    return false;
                const result = await provider.query(job.provider_id, signal);
                if (!renewLease() || signal.aborted)
                    return false;
                const current = getJob(db, job.id);
                if (!current || !["accepted", "running"].includes(current.status) || current.provider_id !== job.provider_id)
                    return true;
                if (result.kind === "running")
                    markRunning(db, job.id, result.progress);
                else if (result.kind === "succeeded") {
                    if (result.url) {
                        markSucceeded(db, job.id, result.url);
                        log(`第 ${job.ordinal} 条生成成功，准备下载。`);
                    }
                    else {
                        markFailed(db, job.id, "供应商报告成功，但没有返回视频地址。");
                        warn(`第 ${job.ordinal} 条成功但没有下载地址。`);
                    }
                }
                else if (result.kind === "failed") {
                    markFailed(db, job.id, result.message, result.violation);
                    warn(`第 ${job.ordinal} 条失败：${result.message}`);
                }
                else {
                    log(`第 ${job.ordinal} 条暂未确认：${result.message}`);
                    if (result.blocked)
                        pause(result.message);
                }
                return true;
            });
            const queuedCount = getJobs(db, options.batchId).filter((job) => job.status === "queued").length;
            await runWorkers(Math.min(concurrency ?? queuedCount, queuedCount), async () => {
                if (!renewLease())
                    return false;
                const claimed = claimNextQueued(db, options.batchId, concurrency, { name: leaseName, owner });
                if (!claimed)
                    return false;
                log(`提交第 ${claimed.ordinal} 条（${claimed.id}）…`);
                let spec;
                try {
                    spec = readProviderSpec(claimed.spec_json);
                }
                catch (error) {
                    markFailed(db, claimed.id, errorMessage(error));
                    return true;
                }
                let result;
                try {
                    result = await provider.submit(spec, signal);
                }
                catch (error) {
                    result = { kind: "unknown", message: `提交异常，禁止自动重发：${errorMessage(error)}` };
                }
                const owned = renewLease();
                if (result.kind === "accepted") {
                    markAccepted(db, claimed.id, result.providerId);
                    log(`第 ${claimed.ordinal} 条已接受：${result.providerId}`);
                }
                else if (result.kind === "rejected") {
                    if (getJob(db, claimed.id)?.status === "submitting")
                        markFailed(db, claimed.id, result.message);
                    warn(`第 ${claimed.ordinal} 条被拒绝：${result.message}`);
                }
                else {
                    markSubmissionUnknown(db, claimed.id, result.message);
                    warn(`第 ${claimed.ordinal} 条提交结果未知，禁止自动重发。`);
                }
                if (owned && result.kind !== "accepted" && result.blocked)
                    pause(result.message);
                return true;
            });
            const downloadJobs = getJobs(db, options.batchId).filter((job) => job.status === "succeeded" && job.file_status !== "ready" && !attemptedDownloads.has(job.id));
            let downloadIndex = 0;
            await runWorkers(Math.min(DOWNLOAD_CONCURRENCY, downloadJobs.length), async () => {
                const job = downloadJobs[downloadIndex++];
                if (!job || !renewLease())
                    return false;
                attemptedDownloads.add(job.id);
                if (!job.remote_url) {
                    setFileStatus(db, job.id, "download_failed", null, "成功但缺少下载地址。");
                    warn(`第 ${job.ordinal} 条缺少下载地址。`);
                    return true;
                }
                let partPath;
                try {
                    setFileStatus(db, job.id, "downloading", null, null);
                    const paths = buildDownloadPaths(job, owner);
                    partPath = paths.part;
                    const result = await downloadToFile(job.remote_url, paths.part, {
                        allowPrivateNetwork: config.allowPrivateNetwork,
                        signal,
                        fetchImpl: options.providerOptions?.fetchImpl,
                    });
                    if (!renewLease() || signal.aborted)
                        throw new Error("本地下载已停止");
                    const finalPath = chooseFinalPath(paths.base, result.contentType, job.remote_url);
                    fs.renameSync(paths.part, finalPath);
                    setFileStatus(db, job.id, "ready", finalPath, null);
                    log(`第 ${job.ordinal} 条已下载：${finalPath}`);
                }
                catch (error) {
                    if (partPath)
                        fs.rmSync(partPath, { force: true });
                    if (leaseLost)
                        return false;
                    if (signal.aborted)
                        setFileStatus(db, job.id, "not_started", null, null);
                    else {
                        const message = errorMessage(error);
                        setFileStatus(db, job.id, "download_failed", null, message);
                        warn(`第 ${job.ordinal} 条下载失败：${message}`);
                    }
                }
                return true;
            });
            if (signal.aborted || blockedReason || !renewLease()) {
                exitReason = "stopped";
                break;
            }
            const status = finalizeBatch(db, options.batchId);
            const jobs = getJobs(db, options.batchId);
            const counts = countsOf(jobs);
            log(`批次 ${options.batchId}：${status}（总数 ${counts.total}，待提交 ${counts.queued}，处理中 ${counts.accepted + counts.running}，未知 ${counts.submission_unknown}，已下载 ${counts.files_ready}）`);
            if (status === "done") {
                exitReason = "done";
                break;
            }
            const hasWork = jobs.some((job) => ["queued", "submitting", "accepted", "running"].includes(job.status)) ||
                jobs.some((job) => job.status === "succeeded" && job.file_status === "not_started");
            if (!hasWork) {
                exitReason = jobs.some((job) => job.status === "submission_unknown") ? "pending" : "partial";
                break;
            }
            if (Date.now() - startedAt >= maxWaitMs)
                break;
            try {
                await sleep(Math.min(jitter(pollMs, 0.15), maxWaitMs - (Date.now() - startedAt)), undefined, { signal });
            }
            catch {
                if (!signal.aborted)
                    throw new Error("等待查询时发生异常");
            }
            pollMs = Math.min(pollMaxMs, Math.round(pollMs * 1.35));
        }
    }
    finally {
        clearInterval(heartbeat);
        try {
            if (!leaseLost && (exitReason === "stopped" || signal.aborted)) {
                finalizeBatch(db, options.batchId, "stopped");
            }
        }
        finally {
            releaseLease(db, leaseName, owner);
        }
    }
    const latest = getBatch(db, options.batchId);
    const jobs = getJobs(db, options.batchId);
    return {
        batch_id: options.batchId,
        status: latest?.status ?? "unknown",
        exit_reason: exitReason,
        elapsed_ms: Date.now() - startedAt,
        counts: countsOf(jobs),
        jobs: jobs.map(toJobView),
        warnings,
        blocked_reason: blockedReason,
    };
}
