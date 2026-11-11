import { encodeAssetRefs } from "./assets.js";
import type { AppConfig } from "./config.js";
import { UserError } from "./errors.js";
import { truncate } from "./util.js";
import type { ProviderSpec } from "./types.js";

export type SubmitResult =
  | { kind: "accepted"; providerId: string }
  | { kind: "rejected"; message: string; blocked?: boolean }
  | { kind: "unknown"; message: string; blocked?: boolean };

export type QueryResult =
  | { kind: "running"; progress: number | null }
  | { kind: "succeeded"; url: string | null; progress: number | null }
  | { kind: "failed"; message: string; violation: boolean }
  | { kind: "unknown"; message: string; blocked?: boolean };

export interface ProviderOptions {
  fetchImpl?: typeof fetch;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
}

function combinedSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "请求超时或被中断";
    }
    return error.message;
  }
  return String(error);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function apiMessage(body: Record<string, unknown> | null, text: string, fallback: string): string {
  if (body) {
    for (const key of ["error", "message", "msg"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) return truncate(value.trim(), 500);
    }
  }
  return truncate(text.trim() || fallback, 500);
}

export function isAccessOrQuotaError(message: string): boolean {
  return /\b(?:401|402|403|429)\b|unauthori[sz]ed|forbidden|rate.?limit|too many requests|quota|insufficient (?:balance|credits?|funds)|balance.*(?:low|insufficient)|余额不足|额度|限流|认证失败|鉴权失败|缺少 API Key/i.test(message);
}

export class Provider {
  constructor(
    private readonly config: AppConfig,
    private readonly options: ProviderOptions = {},
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  async submit(spec: ProviderSpec, signal?: AbortSignal): Promise<SubmitResult> {
    if (!this.config.apiKey) {
      return {
        kind: "rejected",
        blocked: true,
        message: "缺少 API Key。请先运行 node dist/cli.js setup 配置，或设置 MINIMAX_VIDEO_API_KEY。",
      };
    }

    let payload: Record<string, unknown>;
    try {
      payload = {
        model: spec.model,
        prompt: spec.prompt,
        aspectRatio: spec.aspectRatio,
        resolution: spec.resolution,
        duration: spec.duration,
        images: encodeAssetRefs(spec.images, this.config.assetEncoding),
        audios: encodeAssetRefs(spec.audios, this.config.assetEncoding),
        seed: spec.seed,
        promptSkill: spec.promptSkill,
        replyType: spec.replyType,
      };
    } catch (error) {
      return { kind: "rejected", message: errorMessage(error) };
    }

    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 60 * 1024 * 1024) {
      return { kind: "rejected", message: "请求体超过 60MB，请减少或压缩参考素材。" };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/v1/api/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: combinedSignal(this.options.submitTimeoutMs ?? 60_000, signal),
      });
    } catch (error) {
      return {
        kind: "unknown",
        message: `提交请求未得到确认（${errorMessage(error)}）。已保留名额，禁止自动重发。`,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return {
        kind: "unknown",
        blocked: [401, 402, 403, 429].includes(response.status),
        message: `提交响应读取失败（HTTP ${response.status}；${errorMessage(error)}）。已保留名额，禁止自动重发。`,
      };
    }
    const parsed = parseJson(text);

    if (response.ok) {
      const providerId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
      if (providerId) return { kind: "accepted", providerId };
      const status = typeof parsed?.status === "string" ? parsed.status : "";
      const message = apiMessage(parsed, text, "供应商拒绝了任务。");
      const blocked = isAccessOrQuotaError(message);
      if (status === "failed" || status === "violation") {
        return { kind: "rejected", message, blocked };
      }
      return {
        kind: "unknown",
        blocked,
        message: blocked ? message : "供应商返回成功，但没有任务 ID。已保留名额，禁止自动重发。",
      };
    }

    const status = response.status;
    const message = `HTTP ${status}：${apiMessage(parsed, text, "供应商拒绝请求。")}`;
    const blocked = isAccessOrQuotaError(message);
    if ([400, 401, 402, 403, 404, 409, 422, 429].includes(status)) {
      return { kind: "rejected", message, blocked };
    }
    return {
      kind: "unknown",
      blocked,
      message: `${message} 无法确认任务是否创建，禁止自动重发。`,
    };
  }

  async query(providerId: string, signal?: AbortSignal): Promise<QueryResult> {
    if (!this.config.apiKey) {
      return { kind: "unknown", message: "缺少 API Key，无法查询任务。", blocked: true };
    }
    const url = `${this.config.baseUrl}/v1/api/result?id=${encodeURIComponent(providerId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
        },
        signal: combinedSignal(this.options.pollTimeoutMs ?? 30_000, signal),
      });
    } catch (error) {
      return { kind: "unknown", message: `查询失败：${errorMessage(error)}` };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return {
        kind: "unknown",
        blocked: [401, 402, 403, 429].includes(response.status),
        message: `查询响应读取失败（HTTP ${response.status}）：${errorMessage(error)}`,
      };
    }
    const body = parseJson(text);
    const status = typeof body?.status === "string" ? body.status : "";
    const message = `HTTP ${response.status}：${apiMessage(body, text, "暂时无法确认状态。")}`;
    if ((!response.ok || status === "failed" || !status) && isAccessOrQuotaError(message)) {
      return { kind: "unknown", message, blocked: true };
    }

    if (response.ok) {
      const progressRaw = Number(body?.progress);
      const progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(100, Math.round(progressRaw))) : null;
      if (status === "running") return { kind: "running", progress };
      if (status === "succeeded") {
        const results = Array.isArray(body?.results) ? body.results : [];
        const first = results[0] as Record<string, unknown> | undefined;
        const url = typeof first?.url === "string" && first.url.trim() ? first.url.trim() : null;
        return { kind: "succeeded", url, progress: 100 };
      }
      if (status === "violation") {
        return { kind: "failed", message: apiMessage(body, text, "内容违规。"), violation: true };
      }
      if (status === "failed") {
        return { kind: "failed", message: apiMessage(body, text, "生成失败。"), violation: false };
      }
      return { kind: "unknown", message: `未知任务状态：${status || "(空)"}` };
    }

    if (response.status === 400 && (status === "failed" || status === "violation")) {
      return {
        kind: "failed",
        message: apiMessage(body, text, "任务失败。"),
        violation: status === "violation",
      };
    }
    return {
      kind: "unknown",
      message: `查询返回 HTTP ${response.status}：${apiMessage(body, text, "暂时无法确认状态。")}`,
    };
  }
}

export function readProviderSpec(raw: string): ProviderSpec {
  let parsed: ProviderSpec;
  try {
    parsed = JSON.parse(raw) as ProviderSpec;
  } catch {
    throw new UserError("任务参数损坏，无法提交。", "invalid_spec");
  }
  if (!parsed || parsed.model !== "minimax-h3") {
    throw new UserError("任务参数不是 minimax-h3 请求。", "invalid_spec");
  }
  return parsed;
}
