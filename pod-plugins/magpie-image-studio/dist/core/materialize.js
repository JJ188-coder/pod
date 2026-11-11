import { saveArtifact } from "./artifacts.js";
import { getArtifacts, patchArtifact, upsertArtifacts } from "./db.js";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 把已拿到的图片逐张落盘；已完成的行跳过，失败只影响对应图片。 */
export async function materialize(db, task, items, config) {
    const upserts = items.map(({ ordinal, image }) => ({
        ordinal,
        source: image.source,
        sourceValue: image.source === "inline" ? null : image.value,
        mimeType: image.mimeType,
    }));
    upsertArtifacts(db, task.id, upserts);
    const existing = new Map(getArtifacts(db, task.id).map((row) => [row.ordinal, row]));
    const failures = [];
    let saved = 0;
    for (const { ordinal, image } of items) {
        const row = existing.get(ordinal);
        if (row?.file_state === "ready" && row.local_path) {
            saved += 1;
            continue;
        }
        if (image.source === "inline" && !image.value) {
            failures.push({ ordinal, error: "原始图片数据未缓存，需要重新查询 Magpie 结果。" });
            continue;
        }
        patchArtifact(db, task.id, ordinal, { fileState: "saving" });
        try {
            const result = await saveArtifact(image, ordinal, task.output_dir, config);
            patchArtifact(db, task.id, ordinal, {
                fileState: "ready",
                localPath: result.localPath,
                bytes: result.bytes,
                sha256: result.digest,
                error: null,
            });
            saved += 1;
        }
        catch (error) {
            const message = errorMessage(error);
            patchArtifact(db, task.id, ordinal, { fileState: "failed", error: message });
            failures.push({ ordinal, error: message });
        }
    }
    return { received: items.length, saved, failures };
}
