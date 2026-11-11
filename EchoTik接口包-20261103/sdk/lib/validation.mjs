import {
  ALLOWED_COUNTRIES,
  ALLOWED_PERIODS,
  LIMITS,
} from "./constants.mjs";
import { sdkError } from "./errors.mjs";

const RANGE_PATTERN = /^(\d{8})-(\d{8})$/;
const DAILY_PATTERN = /^(\d{8})$/;
const DIGITS_PATTERN = /^\d{1,30}$/;

function integer(value, name, min, max) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw sdkError(
      "INVALID_PARAMETER",
      `${name} 必须是 ${min}-${max} 之间的整数`,
    );
  }
  return parsed;
}

function validCalendarDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function validateCountry(country = "MX") {
  const normalized = String(country).trim().toUpperCase();
  if (!Object.hasOwn(ALLOWED_COUNTRIES, normalized)) {
    throw sdkError("INVALID_COUNTRY", "country 只允许 MX 或 US");
  }
  return normalized;
}

export function validateRange(range, period = undefined) {
  if (typeof range !== "string") {
    throw sdkError(
      "INVALID_RANGE",
      "range 格式无效；daily 用 YYYYMMDD，weekly/monthly 用 YYYYMMDD-YYYYMMDD",
    );
  }

  const normalized = range.trim();
  if (period === "daily") {
    const daily = DAILY_PATTERN.exec(normalized);
    if (!daily || !validCalendarDate(daily[1])) {
      throw sdkError("INVALID_RANGE", "daily range 必须是单个有效 YYYYMMDD");
    }
    return daily[1];
  }

  const match = RANGE_PATTERN.exec(normalized);
  if (!match || !validCalendarDate(match[1]) || !validCalendarDate(match[2])) {
    throw sdkError(
      "INVALID_RANGE",
      "range 必须为有效的 YYYYMMDD-YYYYMMDD",
    );
  }
  if (match[1] > match[2]) {
    throw sdkError("INVALID_RANGE", "range 的起始日期不能晚于结束日期");
  }
  return `${match[1]}-${match[2]}`;
}

export function validateCategoryPath(categoryPath = []) {
  if (!Array.isArray(categoryPath)) {
    throw sdkError(
      "INVALID_CATEGORY_PATH",
      "categoryPath 必须是类目 ID 数组；空数组表示 All",
    );
  }
  if (categoryPath.length > LIMITS.maxCategoryDepth) {
    throw sdkError(
      "INVALID_CATEGORY_PATH",
      `categoryPath 最多 ${LIMITS.maxCategoryDepth} 级`,
    );
  }

  const normalized = categoryPath.map((value) => String(value).trim());
  if (normalized.some((value) => !DIGITS_PATTERN.test(value))) {
    throw sdkError(
      "INVALID_CATEGORY_PATH",
      "categoryPath 的每一级都必须是数字 ID",
    );
  }
  if (new Set(normalized).size !== normalized.length) {
    throw sdkError("INVALID_CATEGORY_PATH", "categoryPath 不能包含重复 ID");
  }
  return normalized;
}

export function validateRankingsOptions(options = {}) {
  const country = validateCountry(options.country ?? "MX");
  const period = String(options.period ?? "weekly").trim().toLowerCase();
  if (!ALLOWED_PERIODS.includes(period)) {
    throw sdkError(
      "INVALID_PERIOD",
      "period 只允许 daily、weekly 或 monthly",
    );
  }

  return Object.freeze({
    country,
    currency: ALLOWED_COUNTRIES[country],
    period,
    range: validateRange(options.range, period),
    page: integer(options.page ?? 1, "page", 1, LIMITS.maxPage),
    perPage: integer(
      options.perPage ?? 20,
      "perPage",
      1,
      LIMITS.maxPerPage,
    ),
    categoryPath: validateCategoryPath(options.categoryPath ?? []),
  });
}

export function validateCategoriesOptions(options = {}) {
  const country = validateCountry(options.country ?? "MX");
  return Object.freeze({ country, currency: ALLOWED_COUNTRIES[country] });
}

export function buildLeaderboardParams(options) {
  const params = [
    ["time_type", options.period],
    ["time_range", options.range],
    ["page", String(options.page)],
  ];

  if (options.categoryPath.length === 0) {
    params.push(["product_categories[]", ""]);
  } else {
    for (const categoryId of options.categoryPath) {
      params.push(["product_categories[]", categoryId]);
    }
  }

  params.push(["order", "sale_cnt"]);
  params.push(["per_page", String(options.perPage)]);
  return params;
}

export function leaderboardRequest(options) {
  return Object.freeze({
    country: options.country,
    params: buildLeaderboardParams(options),
  });
}

export function categoriesRequest(options) {
  return Object.freeze({ country: options.country, params: [] });
}
