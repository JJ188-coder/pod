import {
  META_FIELDS,
  PRODUCT_FIELDS,
} from "./constants.mjs";
import { sdkError } from "./errors.mjs";

const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|csrf|api[_-]?key|session[_-]?id|billing|payment|credit[_-]?card|bank[_-]?account|email|e-mail|phone|mobile|telephone|whatsapp|contact|mailing[_-]?address|street[_-]?address)/i;
const INTERNAL_LINK_KEY_PATTERN = /(?:^|_)(?:url|uri|link|href|path)$/i;
const SENSITIVE_STRING_PATTERN =
  /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]{12,}|cookie\s*[:=]|x-user-id\s*[:=]|access[_-]?token\s*[:=])/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 64;
const MAX_OBJECT_KEYS = 40;
const MAX_NESTED_STRING_LENGTH = 800;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeString(value, maxLength = MAX_STRING_LENGTH) {
  const redacted = value
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, maxLength);
  return SENSITIVE_STRING_PATTERN.test(redacted) ? "[redacted]" : redacted;
}

function sanitizeScalar(value, key = "") {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return null;
    return sanitizeString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") return value;
  return null;
}

function sanitizeNested(value, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return sanitizeScalar(value);
  }
  if (typeof value === "string") {
    return sanitizeString(value, MAX_NESTED_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeNested(item, depth + 1))
      .filter((item) => item !== null);
  }
  if (!isRecord(value)) return null;

  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (
      SENSITIVE_KEY_PATTERN.test(key) ||
      INTERNAL_LINK_KEY_PATTERN.test(key)
    ) {
      continue;
    }
    const sanitized = sanitizeNested(item, depth + 1);
    if (sanitized !== null) result[key] = sanitized;
  }
  return result;
}

function sanitizeCoverUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeProductRow(row) {
  if (!isRecord(row)) {
    throw sdkError("INVALID_RESPONSE", "榜单 data 行不是对象，已停止");
  }

  const result = {};
  for (const field of PRODUCT_FIELDS) {
    const value = row[field];
    if (field === "cover_url") {
      result[field] = sanitizeCoverUrl(value);
    } else if (field === "seller") {
      result[field] = isRecord(value) ? sanitizeNested(value) : null;
    } else if (field === "categories") {
      result[field] = sanitizeNested(value);
    } else {
      result[field] = sanitizeScalar(value, field);
    }
  }
  return result;
}

function sanitizeMeta(meta) {
  const source = isRecord(meta) ? meta : {};
  const result = {};
  for (const field of META_FIELDS) {
    const value = source[field];
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      result[field] = value;
    } else if (typeof value === "string" && /^\d{1,15}$/.test(value)) {
      result[field] = Number(value);
    } else {
      result[field] = null;
    }
  }
  return result;
}

export function assertBusinessResponse(body) {
  if (!isRecord(body)) {
    throw sdkError("INVALID_RESPONSE", "EchoTik 返回不是业务对象，已停止");
  }
  if (!(body.code === 0 || body.code === "0")) {
    throw sdkError("API_CODE", "EchoTik 返回非 0 code，已停止且不重试");
  }
  return body;
}

export function makeRankingsDocument(body, request, observedAt = new Date()) {
  const response = assertBusinessResponse(body);
  if (!Array.isArray(response.data)) {
    throw sdkError("INVALID_RESPONSE", "榜单 data 不是数组，已停止");
  }

  return {
    schema_version: 1,
    observed_at: observedAt.toISOString(),
    source: "echotik.live",
    country: request.country,
    currency: request.currency,
    period: request.period,
    range: request.range,
    category_path: [...request.categoryPath],
    page: request.page,
    per_page: request.perPage,
    data: response.data.map(sanitizeProductRow),
    meta: sanitizeMeta(response.meta),
  };
}

export function makeCategoriesDocument(body, request, observedAt = new Date()) {
  const response = assertBusinessResponse(body);
  if (!(response.data === null || response.data === undefined || isRecord(response.data) || Array.isArray(response.data))) {
    throw sdkError("INVALID_RESPONSE", "类目 data 结构无法安全输出，已停止");
  }

  return {
    schema_version: 1,
    observed_at: observedAt.toISOString(),
    source: "echotik.live",
    country: request.country,
    currency: request.currency,
    data: sanitizeNested(response.data),
  };
}
