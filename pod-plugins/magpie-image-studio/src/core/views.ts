import type { DatabaseSync } from "node:sqlite";
import { readImageDimensions } from "./artifacts.js";
import { countSaved, getArtifacts } from "./db.js";
import type { TaskRow } from "./types.js";

function requestedSize(task: TaskRow): { width: number; height: number } | null {
  try {
    const params = JSON.parse(task.params_json) as { size?: unknown };
    if (typeof params.size !== "string") return null;
    const match = /^(\d{2,5})x(\d{2,5})$/i.exec(params.size.trim());
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return null;
  }
}

function sizeWarning(task: TaskRow, files: Array<{ width: number | null; height: number | null }>): string | null {
  const requested = requestedSize(task);
  if (!requested) return null;
  const mismatched = files.filter(
    (file) =>
      file.width !== null &&
      file.height !== null &&
      (file.width !== requested.width || file.height !== requested.height),
  );
  if (!mismatched.length) return null;
  const actual = mismatched[0];
  return `请求 ${requested.width}x${requested.height}，实际输出 ${actual.width}x${actual.height}；模型可能不支持该尺寸，本插件不做裁切。`;
}

export function toTaskView(db: DatabaseSync, task: TaskRow) {
  const artifacts = getArtifacts(db, task.id);
  const saved = countSaved(db, task.id);
  const failedSaves = artifacts.filter((row) => row.file_state === "failed");

  const files = artifacts.map((row) => {
    const dimensions = row.file_state === "ready" && row.local_path ? readImageDimensions(row.local_path) : null;
    return {
      ordinal: row.ordinal + 1,
      file_state: row.file_state,
      path: row.local_path,
      bytes: row.bytes,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      error: row.error,
    };
  });

  return {
    task_id: task.id,
    request_id: task.request_id,
    state: task.generation_state,
    remote_id: task.remote_id,
    requested: task.n,
    received: task.images_received,
    saved,
    output_dir: task.output_dir,
    files,
    size_warning: sizeWarning(task, files),
    error: task.error,
    failed_saves: failedSaves.length,
    created_at: task.created_at,
    updated_at: task.updated_at,
    last_checked_at: task.last_checked_at,
    next_step: nextStep(task, saved, artifacts.length),
  };
}

function nextStep(task: TaskRow, saved: number, artifactCount: number): string {
  switch (task.generation_state) {
    case "submitting":
      return "上次调用在取得 Magpie 任务 ID 前中断。不要再次提交同一 request_id；如 Magpie 中能看到任务 ID，用 image_result 补填 remote_id。";
    case "submission_unknown":
      return "提交结果未知，可能已生成并计费。不要自动重发；如 Magpie 中能看到任务 ID，用 image_result 补填 remote_id。";
    case "pending":
      return "生成尚未完成。用 image_result 继续查询；不要重复调用 image_generate。";
    case "succeeded":
      if (saved < task.n) {
        return artifactCount > 0
          ? `已生成但只落盘 ${saved}/${task.n} 张。用 image_result 重试保存，不会重新生成。`
          : `已生成但尚未落盘。用 image_result 重试保存，不会重新生成。`;
      }
      return "已完成，图片已保存。需要新的结果请使用新的 request_id。";
    case "failed":
      return "生成失败。需要重试请使用新的 request_id；同一 request_id 不会被再次提交。";
    default:
      return "";
  }
}
