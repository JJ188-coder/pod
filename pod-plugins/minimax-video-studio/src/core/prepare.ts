import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stageAssets } from "./assets.js";
import { loadConfig } from "./config.js";
import {
  findBatchByClientRequestId,
  findRecentBatchByHash,
  getJobs,
  insertBatch,
} from "./db.js";
import { ConflictError, UserError } from "./errors.js";
import { safeName, isHttpUrl, newId, nowIso, sha256, stableStringify } from "./util.js";
import { assertAssetCount, normalizeAspectRatio, normalizeDuration, normalizePrompt, normalizeResolution, normalizeSeed } from "./validate.js";
import type { JobRow, NormalizedJob, ProviderSpec } from "./types.js";

export interface PrepareJobInput {
  prompt: unknown;
  aspectRatio?: unknown;
  resolution?: unknown;
  duration?: unknown;
  images?: unknown;
  audios?: unknown;
  seed?: unknown;
  promptSkill?: unknown;
  outputName?: unknown;
}

export interface PrepareBatchInput {
  clientRequestId?: string;
  jobs: PrepareJobInput[];
}

export interface PrepareResult {
  batchId: string;
  deduped: boolean;
  jobs: JobRow[];
}

export function parsePrepareInput(raw: unknown): PrepareBatchInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UserError("批次清单必须是 JSON 对象。", "invalid_batch");
  }
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["client_request_id", "jobs"].includes(key)) ||
    (input.client_request_id !== undefined && typeof input.client_request_id !== "string")) {
    throw new UserError("批次清单只支持 client_request_id 字符串和 jobs 数组。", "invalid_batch");
  }
  if (!Array.isArray(input.jobs) || !input.jobs.length) {
    throw new UserError("至少需要一个视频任务。", "invalid_jobs");
  }
  const fields = ["prompt", "aspect_ratio", "resolution", "duration", "images", "audios", "seed", "prompt_skill", "output_name"];
  return {
    clientRequestId: input.client_request_id as string | undefined,
    jobs: input.jobs.map((rawJob) => {
      if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) {
        throw new UserError("每个任务必须是对象。", "invalid_job");
      }
      const job = rawJob as Record<string, unknown>;
      if (Object.keys(job).some((key) => !fields.includes(key))) {
        throw new UserError("任务包含未知字段；请使用 aspect_ratio、prompt_skill、output_name 等工具字段名。", "invalid_job");
      }
      if ((job.prompt_skill !== undefined && typeof job.prompt_skill !== "boolean") ||
        (job.output_name !== undefined && typeof job.output_name !== "string")) {
        throw new UserError("prompt_skill 必须是布尔值，output_name 必须是字符串。", "invalid_job");
      }
      return {
        prompt: job.prompt,
        aspectRatio: job.aspect_ratio,
        resolution: job.resolution,
        duration: job.duration,
        images: job.images,
        audios: job.audios,
        seed: job.seed,
        promptSkill: job.prompt_skill,
        outputName: job.output_name,
      };
    }),
  };
}

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

async function describeRef(ref: string): Promise<unknown> {
  if (/^data:/i.test(ref)) {
    return { kind: "data", hash: sha256(ref) };
  }
  if (isHttpUrl(ref)) {
    return { kind: "url", value: ref };
  }
  const absolute = path.resolve(ref);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new UserError(`找不到素材文件：${absolute}`, "asset_not_found");
  }
  if (!stat.isFile()) {
    throw new UserError(`素材路径不是文件：${absolute}`, "asset_not_file");
  }
  return { kind: "file", path: absolute, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

async function describeRefs(refs: unknown): Promise<unknown[]> {
  if (refs === undefined) return [];
  if (!Array.isArray(refs)) throw new UserError("素材必须是数组。", "invalid_assets");
  const described: unknown[] = [];
  for (const ref of refs) {
    described.push(await describeRef(String(ref).trim()));
  }
  return described;
}

interface ValidatedJob {
  prompt: string;
  aspectRatio: ReturnType<typeof normalizeAspectRatio>;
  resolution: ReturnType<typeof normalizeResolution>;
  duration: number;
  seed: number | undefined;
  promptSkill: boolean;
  outputName: string | undefined;
  images: string[];
  audios: string[];
}

function validateJob(raw: PrepareJobInput): ValidatedJob {
  if (!raw || typeof raw !== "object") {
    throw new UserError("每个任务必须是对象。", "invalid_job");
  }
  const prompt = normalizePrompt(raw.prompt);
  const aspectRatio = normalizeAspectRatio(raw.aspectRatio);
  const resolution = normalizeResolution(raw.resolution);
  const duration = normalizeDuration(raw.duration, resolution);
  const seed = normalizeSeed(raw.seed);
  assertAssetCount("images", raw.images);
  assertAssetCount("audios", raw.audios);
  const images = Array.isArray(raw.images) ? raw.images.map((item) => String(item).trim()) : [];
  const audios = Array.isArray(raw.audios) ? raw.audios.map((item) => String(item).trim()) : [];
  const outputName = typeof raw.outputName === "string" && raw.outputName.trim()
    ? safeName(raw.outputName, 48)
    : undefined;
  return {
    prompt,
    aspectRatio,
    resolution,
    duration,
    seed,
    promptSkill: raw.promptSkill !== false,
    outputName,
    images,
    audios,
  };
}

export async function prepareBatch(db: DatabaseSync, input: PrepareBatchInput): Promise<PrepareResult> {
  if (!input || !Array.isArray(input.jobs) || input.jobs.length === 0) {
    throw new UserError("至少需要一个视频任务。", "invalid_jobs");
  }

  const validated = input.jobs.map(validateJob);
  const descriptions = [];
  for (const job of validated) {
    descriptions.push({
      prompt: job.prompt,
      aspectRatio: job.aspectRatio,
      resolution: job.resolution,
      duration: job.duration,
      seed: job.seed ?? null,
      promptSkill: job.promptSkill,
      outputName: job.outputName ?? null,
      images: await describeRefs(job.images),
      audios: await describeRefs(job.audios),
    });
  }
  const requestHash = sha256(stableStringify(descriptions));

  const clientRequestId = input.clientRequestId?.trim();
  if (clientRequestId) {
    if (clientRequestId.length > 120) {
      throw new UserError("client_request_id 不能超过 120 字符。", "invalid_client_request_id");
    }
    const existing = findBatchByClientRequestId(db, clientRequestId);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ConflictError(
          "同一个 client_request_id 已用于不同内容。请换一个新的 client_request_id，或先查询原批次。",
        );
      }
      return { batchId: existing.id, deduped: true, jobs: getJobs(db, existing.id) };
    }
  } else {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const existing = findRecentBatchByHash(db, requestHash, since);
    if (existing) {
      return { batchId: existing.id, deduped: true, jobs: getJobs(db, existing.id) };
    }
  }

  const config = loadConfig();
  const batchId = newId("b");
  const normalized: NormalizedJob[] = [];
  for (const job of validated) {
    const images = await stageAssets(job.images, {
      batchId,
      kind: "image",
      allowPrivateNetwork: config.allowPrivateNetwork,
    });
    const audios = await stageAssets(job.audios, {
      batchId,
      kind: "audio",
      allowPrivateNetwork: config.allowPrivateNetwork,
    });
    const spec: ProviderSpec = {
      model: "minimax-h3",
      prompt: job.prompt,
      aspectRatio: job.aspectRatio,
      resolution: job.resolution,
      duration: job.duration,
      seed: job.seed,
      promptSkill: job.promptSkill,
      replyType: "async",
    };
    if (images.length) spec.images = images;
    if (audios.length) spec.audios = audios;
    normalized.push({ prompt: job.prompt, outputName: job.outputName, spec });
  }

  const timestamp = nowIso();
  const jobRows: JobRow[] = normalized.map((job, index) => ({
    id: newId("j"),
    batch_id: batchId,
    ordinal: index + 1,
    spec_json: JSON.stringify(job.spec),
    prompt: job.prompt,
    output_name: job.outputName ?? null,
    status: "queued",
    file_status: "not_started",
    provider_id: null,
    progress: null,
    remote_url: null,
    local_path: null,
    error: null,
    attempts_submit: 0,
    created_at: timestamp,
    updated_at: timestamp,
    finished_at: null,
  }));

  try {
    insertBatch(
      db,
      {
        id: batchId,
        client_request_id: clientRequestId || newId("auto"),
        request_hash: requestHash,
        status: "queued",
        created_at: timestamp,
        updated_at: timestamp,
        note: null,
      },
      jobRows,
    );
  } catch (error) {
    const existing = clientRequestId
      ? findBatchByClientRequestId(db, clientRequestId)
      : findRecentBatchByHash(db, requestHash, new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString());
    if (existing && existing.request_hash === requestHash) {
      return { batchId: existing.id, deduped: true, jobs: getJobs(db, existing.id) };
    }
    throw error;
  }

  return { batchId, deduped: false, jobs: getJobs(db, batchId) };
}
