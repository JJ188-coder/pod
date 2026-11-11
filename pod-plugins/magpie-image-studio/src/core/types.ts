export type GenerationState = "submitting" | "pending" | "succeeded" | "failed" | "submission_unknown";

export type FileState = "pending" | "saving" | "ready" | "failed";

export type ArtifactSource = "inline" | "url" | "file";

export interface TaskRow {
  id: string;
  request_id: string;
  request_hash: string;
  prompt: string;
  params_json: string;
  n: number;
  output_dir: string;
  generation_state: GenerationState;
  remote_id: string | null;
  images_received: number;
  attempts_submit: number;
  error: string | null;
  raw_response: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  finished_at: string | null;
}

export interface ArtifactRow {
  task_id: string;
  ordinal: number;
  source: ArtifactSource;
  source_value: string | null;
  mime_type: string | null;
  file_state: FileState;
  local_path: string | null;
  bytes: number | null;
  sha256: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface GenerateParams {
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  model?: string;
  reference_images?: string[];
}
