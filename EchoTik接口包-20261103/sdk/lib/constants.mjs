export const BRIDGE_GLOBAL = "__CODEX_ECHOTIK_SDK_BRIDGE_V1__";

export const LEADERBOARD_PATH =
  "/api/v1/data/products/leaderboard/top-sold";
export const CATEGORY_PATH = "/api/v1/data/products/product-category";

export const ALLOWED_ENDPOINTS = Object.freeze([
  LEADERBOARD_PATH,
  CATEGORY_PATH,
]);

export const ALLOWED_COUNTRIES = Object.freeze({
  MX: "MXN",
  US: "USD",
});

export const ALLOWED_PERIODS = Object.freeze([
  "daily",
  "weekly",
  "monthly",
]);

export const PRODUCT_FIELDS = Object.freeze([
  "product_id",
  "product_name",
  "category",
  "categories",
  "region",
  "avg_price",
  "min_price",
  "max_price",
  "sale_cnt",
  "total_sale_cnt",
  "total_gmv_amt",
  "total_sale_gmv_amt",
  "influencers_count",
  "total_video_cnt",
  "total_live_cnt",
  "product_rating",
  "review_count",
  "cover_url",
  "seller",
]);

export const META_FIELDS = Object.freeze([
  "current_page",
  "per_page",
  "last_page",
  "total",
  "from",
  "to",
]);

export const LIMITS = Object.freeze({
  maxNewRequests: 5,
  maxExplicitRequests: 8,
  minRequestIntervalMs: 1500,
  maxPage: 5,
  maxPerPage: 20,
  maxCategoryDepth: 3,
});

export const ACTIVE_PORT_FILE = Object.freeze([
  "Library",
  "Application Support",
  "Microsoft Edge",
  "DevToolsActivePort",
]);

export function validateRequestBudget(value = LIMITS.maxNewRequests) {
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxExplicitRequests) throw new RangeError("INVALID_REQUEST_BUDGET");
  return value;
}
