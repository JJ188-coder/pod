#!/usr/bin/env node
/**
 * 离线验收：检查榜单、SKU 文档、状态与 CSV 是否一致。
 * 用法：node tools/verify.mjs --week 20261026-20261101
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { detectImageType } from '../lib/images.mjs';
import { parseWeek, resolveDataRoot, runDir } from '../lib/util.mjs';

const args = { week: undefined, dataDir: undefined };
for (let index = 2; index < process.argv.length; index += 1) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(process.argv[index]);
  if (!match) continue;
  const value = match[2] !== undefined ? match[2] : process.argv[++index];
  if (match[1] === 'week') args.week = value;
  else if (match[1] === 'data-dir') args.dataDir = value;
}

const week = parseWeek(args.week);
const dir = runDir(resolveDataRoot(args.dataDir), week);
const problems = [];
const warnings = [];

function fail(message) {
  problems.push(message);
}

const rankings = JSON.parse(await readFile(join(dir, 'rankings.json'), 'utf8'));
if (rankings.products.length !== 100) {
  fail(`榜单应为 100 条，实际 ${rankings.products.length}`);
}
const ids = rankings.products.map((product) => String(product.product_id));
if (new Set(ids).size !== ids.length) {
  fail('榜单存在重复 product_id');
}
if (!/^\d{8}-\d{8}$/.test(rankings.range)) {
  fail(`周期格式异常：${rankings.range}`);
}

const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
const stateCounts = { pending: 0, ok: 0, partial: 0, failed: 0 };
for (const value of Object.values(state.products)) {
  stateCounts[value.status] = (stateCounts[value.status] ?? 0) + 1;
}

const skuDir = join(dir, 'skus');
let files = [];
try {
  files = (await readdir(skuDir)).filter((name) => name.endsWith('.json'));
} catch {
  warnings.push('skus 目录不存在');
}

let skuRows = 0;
let exact = 0;
let partial = 0;
const skuIdsByProduct = new Map();

for (const file of files) {
  const doc = JSON.parse(await readFile(join(skuDir, file), 'utf8'));
  const expectedId = file.replace(/\.json$/, '');
  if (String(doc.product_id) !== expectedId) {
    fail(`${file}: product_id=${doc.product_id} 与文件名不一致`);
  }
  if (!Array.isArray(doc.skus)) {
    fail(`${file}: skus 不是数组`);
    continue;
  }
  if (doc.sku_count !== doc.skus.length) {
    fail(`${file}: sku_count=${doc.sku_count} 与数组长度=${doc.skus.length} 不一致`);
  }
  if (doc.region !== 'MX') fail(`${file}: region=${doc.region}`);
  if (doc.currency !== 'MXN') fail(`${file}: currency=${doc.currency}`);
  if (doc.coverage === 'exact') exact += 1;
  else partial += 1;
  skuRows += doc.skus.length;

  const seen = new Set();
  for (const sku of doc.skus) {
    if (!sku.sku_id) fail(`${file}: 有 SKU 缺少 sku_id`);
    if (seen.has(sku.sku_id)) fail(`${file}: 重复 sku_id ${sku.sku_id}`);
    seen.add(sku.sku_id);
    if (!sku.price_val) fail(`${file}: SKU ${sku.sku_id} 缺少价格`);
  }
  skuIdsByProduct.set(expectedId, seen.size);
}

const missingProducts = rankings.products.filter(
  (product) => !skuIdsByProduct.has(String(product.product_id)),
);
const expectedCsvRows = skuRows + missingProducts.length;

const csv = await readFile(join(dir, 'export', 'top100-skus.csv'), 'utf8');
const csvRows = csv.trim().split('\n').length - 1;
if (csvRows !== expectedCsvRows) {
  fail(`CSV 行数=${csvRows}，预期=${expectedCsvRows}（SKU ${skuRows} + 缺失商品 ${missingProducts.length}）`);
}

let imageManifest = null;
try {
  imageManifest = JSON.parse(await readFile(join(dir, 'images', 'manifest.json'), 'utf8'));
} catch {
  warnings.push('images/manifest.json 不存在');
}

let imagesOk = 0;
let imagesFailed = 0;
const imageById = new Map();
if (imageManifest?.items) {
  for (const item of imageManifest.items) {
    const productId = String(item.product_id);
    imageById.set(productId, item);
    if (item.status !== 'ok') {
      imagesFailed += 1;
      continue;
    }
    try {
      const bytes = await readFile(join(dir, item.file));
      if (bytes.length === 0) {
        fail(`图片为空：${item.file}`);
        continue;
      }
      if (bytes.length !== item.bytes) {
        fail(`图片大小不一致：${item.file} ${bytes.length} != ${item.bytes}`);
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== item.sha256) fail(`图片 SHA256 不一致：${item.file}`);
      if (!detectImageType(bytes)) fail(`不是有效图片：${item.file}`);
      imagesOk += 1;
    } catch {
      fail(`图片文件缺失或不可读：${item.file}`);
    }
  }
}
const missingImages = rankings.products.filter(
  (product) => imageById.get(String(product.product_id))?.status !== 'ok',
);
if (imageManifest && missingImages.length > 0) {
  fail(`缺少商品主图：${missingImages.length} 个（如 ${missingImages[0].product_id}）`);
}

const summary = {
  week,
  run_dir: dir,
  rankings: rankings.products.length,
  state: stateCounts,
  sku_files: files.length,
  sku_rows: skuRows,
  exact_docs: exact,
  partial_docs: partial,
  missing_products: missingProducts.length,
  csv_rows: csvRows,
  images: imageManifest?.items?.length ?? 0,
  images_ok: imagesOk,
  images_failed: imagesFailed,
  images_missing: missingImages.length,
  problems,
  warnings,
};

console.log(JSON.stringify(summary, null, 2));
process.exitCode = problems.length === 0 ? 0 : 1;
