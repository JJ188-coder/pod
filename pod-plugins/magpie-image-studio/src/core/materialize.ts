import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { saveArtifact } from "./artifacts.js";
import { getArtifacts, patchArtifact, upsertArtifacts, type ArtifactUpsert } from "./db.js";
import type { ParsedImage } from "./magpie.js";
import type { TaskRow } from "./types.js";

export interface MaterializeResult {
  received: number;
  saved: number;
  failures: Array<{ ordinal: number; error: string }>;
}

/** 一张待落盘的图片及其固定序号；序号决定文件名，重试不会串位。 */
export interface SlottedImage {
  ordinal: number;
  image: ParsedImage;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把已拿到的图片逐张落盘；已完成的行跳过，失败只影响对应图片。 */
export async function materialize(
  db: DatabaseSync,
  task: TaskRow,
  items: SlottedImage[],
  config: AppConfig,
): Promise<MaterializeResult> {
  const upserts: ArtifactUpsert[] = items.map(({ ordinal, image }) => ({
    ordinal,
    source: image.source,
    sourceValue: image.source === "inline" ? null : image.value,
    mimeType: image.mimeType,
  }));
  upsertArtifacts(db, task.id, upserts);

  const existing = new Map(getArtifacts(db, task.id).map((row) => [row.ordinal, row]));
  const failures: Array<{ ordinal: number; error: string }> = [];
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
    } catch (error) {
      const message = errorMessage(error);
      patchArtifact(db, task.id, ordinal, { fileState: "failed", error: message });
      failures.push({ ordinal, error: message });
    }
  }

  return { received: items.length, saved, failures };
}
