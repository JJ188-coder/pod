function parseSpec(json) {
    try {
        const parsed = JSON.parse(json);
        return parsed && parsed.model === "minimax-h3" ? parsed : null;
    }
    catch {
        return null;
    }
}
export function toJobView(row) {
    const spec = parseSpec(row.spec_json);
    return {
        job_id: row.id,
        ordinal: row.ordinal,
        status: row.status,
        file_status: row.file_status,
        progress: row.progress,
        prompt: row.prompt,
        params: {
            aspect_ratio: spec?.aspectRatio ?? "portrait",
            resolution: spec?.resolution ?? "768p",
            duration: spec?.duration ?? 0,
            seed: spec?.seed ?? null,
            prompt_skill: spec?.promptSkill ?? true,
            images: spec?.images?.length ?? 0,
            audios: spec?.audios?.length ?? 0,
        },
        provider_id: row.provider_id,
        remote_url: row.remote_url,
        local_path: row.local_path,
        error: row.error,
        attempts_submit: row.attempts_submit,
    };
}
export function countsOf(jobs) {
    const counts = {
        total: jobs.length,
        queued: 0,
        submitting: 0,
        accepted: 0,
        submission_unknown: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        violation: 0,
        files_ready: 0,
        files_pending: 0,
        files_failed: 0,
    };
    for (const job of jobs) {
        counts[job.status] = (counts[job.status] ?? 0) + 1;
        if (job.file_status === "ready")
            counts.files_ready += 1;
        else if (job.file_status === "download_failed")
            counts.files_failed += 1;
        else
            counts.files_pending += 1;
    }
    return counts;
}
export function toBatchView(batch, jobs) {
    return {
        batch_id: batch.id,
        status: batch.status,
        created_at: batch.created_at,
        updated_at: batch.updated_at,
        note: batch.note,
        counts: countsOf(jobs),
        jobs: jobs.map(toJobView),
    };
}
