export type AspectRatio = "portrait" | "landscape";
export type Resolution = "480p" | "768p" | "1080p";

export type JobStatus =
  | "queued"
  | "submitting"
  | "accepted"
  | "submission_unknown"
  | "running"
  | "succeeded"
  | "failed"
  | "violation";

export type FileStatus = "not_started" | "downloading" | "ready" | "download_failed";

export type BatchStatus = "queued" | "running" | "done" | "partial" | "failed" | "stopped";

export interface ProviderSpec {
  model: "minimax-h3";
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  duration: number;
  images?: string[];
  audios?: string[];
  seed?: number;
  promptSkill: boolean;
  replyType: "async";
}

export interface NormalizedJob {
  prompt: string;
  outputName?: string;
  spec: ProviderSpec;
}

export interface BatchRow {
  id: string;
  client_request_id: string;
  request_hash: string;
  status: BatchStatus;
  created_at: string;
  updated_at: string;
  note: string | null;
}

export interface JobRow {
  id: string;
  batch_id: string;
  ordinal: number;
  spec_json: string;
  prompt: string;
  output_name: string | null;
  status: JobStatus;
  file_status: FileStatus;
  provider_id: string | null;
  progress: number | null;
  remote_url: string | null;
  local_path: string | null;
  error: string | null;
  attempts_submit: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface JobView {
  job_id: string;
  ordinal: number;
  status: JobStatus;
  file_status: FileStatus;
  progress: number | null;
  prompt: string;
  params: {
    aspect_ratio: AspectRatio;
    resolution: Resolution;
    duration: number;
    seed: number | null;
    prompt_skill: boolean;
    images: number;
    audios: number;
  };
  provider_id: string | null;
  remote_url: string | null;
  local_path: string | null;
  error: string | null;
  attempts_submit: number;
}

export interface BatchView {
  batch_id: string;
  status: BatchStatus;
  created_at: string;
  updated_at: string;
  note: string | null;
  counts: Record<string, number>;
  jobs: JobView[];
}
