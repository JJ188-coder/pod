import { finalizeBatch, getBatch, getJobs, markFailed, markRunning, markSucceeded, setBatchStatus } from "./db.js";
import { toBatchView } from "./views.js";
export async function refreshBatch(db, batchId, provider, options = {}) {
    const batch = getBatch(db, batchId);
    if (!batch)
        throw new Error(`批次不存在：${batchId}`);
    const limit = Math.max(1, Math.min(options.maxJobs ?? 10, 20));
    const warnings = [];
    let refreshed = 0;
    for (const job of getJobs(db, batchId)) {
        if (refreshed >= limit)
            break;
        if (options.signal?.aborted)
            break;
        if (job.status !== "accepted" && job.status !== "running")
            continue;
        if (!job.provider_id)
            continue;
        refreshed += 1;
        const result = await provider.query(job.provider_id, options.signal);
        if (result.kind === "running") {
            markRunning(db, job.id, result.progress);
        }
        else if (result.kind === "succeeded") {
            if (result.url)
                markSucceeded(db, job.id, result.url);
            else
                markFailed(db, job.id, "供应商报告成功，但没有返回视频地址。");
        }
        else if (result.kind === "failed") {
            markFailed(db, job.id, result.message, result.violation);
        }
        else if (warnings.length < 10) {
            warnings.push(`第 ${job.ordinal} 条：${result.message}`);
        }
        if (result.kind === "unknown" && result.blocked) {
            setBatchStatus(db, batchId, "stopped", `provider_blocked: ${result.message}`);
            break;
        }
    }
    const status = finalizeBatch(db, batchId);
    const latest = getBatch(db, batchId) ?? batch;
    const jobs = getJobs(db, batchId);
    return {
        batch: toBatchView({ ...latest, status }, jobs),
        refreshed,
        warnings,
    };
}
