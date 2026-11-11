#!/usr/bin/env node
/**
 * 离线契约自检：只用 samples/ 里的真实响应校验接口契约。
 * 不联网、不需要登录、不读任何凭据。CI 可直接跑。
 *
 * 校验项：
 *   1) 榜单响应结构（data[] / meta 分页字段）
 *   2) 行内 16 个字段齐全
 *   3) product_id 是 17–20 位数字字符串
 *   4) 价格是展示字符串（带币种），不是裸数字
 *   5) sale_cnt 可转数字
 *   6) 类目元数据含 824328 → 839944 → 601226 三级链
 *
 * 退出码：0 全通过；1 有失败项。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMetric } from "./client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "samples");

const ROW_FIELDS = [
  "product_id", "product_name", "category", "categories", "region",
  "avg_price", "min_price", "max_price", "sale_cnt", "total_sale_cnt",
  "total_gmv_amt", "influencers_count", "total_video_cnt", "total_live_cnt",
  "product_rating", "review_count",
];
const META_FIELDS = ["current_page", "per_page", "total", "last_page", "from", "to"];

const failures = [];
const notes = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

function checkLeaderboard(file, doc) {
  const rows = doc.data;
  if (!Array.isArray(rows) || rows.length === 0) return fail(file, "data 不是非空数组");
  const meta = doc.meta || {};
  for (const k of META_FIELDS) if (!(k in meta)) fail(file, `meta 缺 ${k}`);
  const row = rows[0];
  for (const k of ROW_FIELDS) if (!(k in row)) fail(file, `行缺字段 ${k}`);
  if (!/^\d{17,20}$/.test(String(row.product_id))) fail(file, `product_id 不是 17–20 位数字串（实际 ${row.product_id}）`);
  for (const k of ["avg_price", "min_price", "max_price"]) {
    const v = String(row[k] ?? "");
    if (/^\d+(\.\d+)?$/.test(v)) fail(file, `${k} 是裸数字，契约里应为展示字符串`);
    if (!/[A-Z]{2}\$|[$€¥]/.test(v)) fail(file, `${k} 缺币种符号（实际 ${v}）`);
  }
  // 契约真相：数值字段是展示字符串，可能带「万」，必须先 parseMetric
  for (const k of ["sale_cnt", "total_sale_cnt", "total_gmv_amt"]) {
    if (parseMetric(row[k]) === null) fail(file, `${k} 用 parseMetric 无法解析（实际 ${JSON.stringify(row[k])}）`);
  }
  if (typeof row.sale_cnt === "string" && /万|亿/.test(row.sale_cnt)) {
    notes.push(`${file}: sale_cnt 含「万」展示值（${row.sale_cnt}），必须用 parseMetric，直接 Number() 会失败`);
  }
  if (parseMetric(row.sale_cnt) === parseMetric(row.total_sale_cnt)) {
    notes.push(`${file}: sale_cnt 与 total_sale_cnt 相等，确认不是把累计值当周期值`);
  }
  if (rows.length > 20) fail(file, `per_page 超过 20（实际 ${rows.length}）`);
}

function checkCategories(file, doc) {
  const cats = doc.categories;
  if (!Array.isArray(cats) || cats.length === 0) return fail(file, "categories 不是非空数组");
  for (const c of cats) for (const k of ["id", "label", "slug", "parents"]) if (!(k in c)) fail(file, `类目缺 ${k}`);
  const ids = new Set(cats.map((c) => String(c.id)));
  const chain = ["824328", "839944", "601226"];
  const missing = chain.filter((id) => !ids.has(id));
  if (missing.length) fail(file, `类目链缺 ${missing.join(",")}`);
  const leaf = cats.find((c) => String(c.id) === "601226");
  if (leaf && (leaf.parents || []).length < 2) fail(file, "叶子类目 parents 不足两级（会导致只传叶 ID 时零结果）");
}

if (!existsSync(SAMPLES)) {
  console.log("SKIP 本仓库未包含 samples/；请放入自己的响应 JSON 后重跑离线自检。");
  process.exit(0);
}

const files = readdirSync(SAMPLES).filter((f) => f.endsWith(".json")).sort();
for (const f of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(SAMPLES, f), "utf8"));
  } catch (e) {
    fail(f, `JSON 解析失败：${e.message}`);
    continue;
  }
  if (Array.isArray(doc.data)) checkLeaderboard(f, doc);
  else if (Array.isArray(doc.categories)) checkCategories(f, doc);
  else notes.push(`${f}: 非榜单/类目结构，跳过（可能是定价页快照）`);
}

const bars = files.filter((f) => !/pricing|taxonomy/.test(f)).length;
console.log(`样本 ${files.length} 份，其中榜单 ${bars} 份，类目/定价 ${files.length - bars} 份`);
for (const n of notes) console.log("  ·", n);
if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：`);
  for (const f of failures) console.error("  ✗", f);
  process.exit(1);
}
console.log("\nPASS 契约自检通过（字段齐全、ID 字符串、价格为展示值、类目三级链完整）");
