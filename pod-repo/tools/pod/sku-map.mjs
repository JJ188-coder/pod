#!/usr/bin/env node
/**
 * sku-map.mjs — 把「商品 SKU ↔ 银河设计」写成可校验的本地映射。
 *
 * 只写本地 mapping.json，不写 RIIN 工厂端；factory_saved 始终 false，
 * 只有 RIIN 设计流程写回 mappingState=true 才可置真。
 *
 * 用法：
 *   node tools/pod/sku-map.mjs --pack <商品包> --code UKIYOE1 [--readback <json>]
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const pack = path.resolve(arg('--pack'));
const code = arg('--code');
if (!code) { console.log(JSON.stringify({ ok: false, error: 'CODE_REQUIRED' })); process.exit(2); }
if (!fs.existsSync(pack)) { console.log(JSON.stringify({ ok: false, error: 'PACK_NOT_FOUND', pack })); process.exit(2); }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function latest(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

const handoffPath = arg('--handoff') || latest(path.join(pack, '证据'), `银河交接-${code}-`);
const readbackPath = arg('--readback') || latest(path.join(pack, '证据'), '商品读回-');
const specPath = arg('--spec') || path.join(pack, 'listing-spec.json');

const handoff = handoffPath ? readJson(handoffPath) : null;
const readback = readbackPath ? readJson(readbackPath) : null;
const spec = readJson(specPath);
if (!handoff) { console.log(JSON.stringify({ ok: false, error: 'HANDOFF_MISSING', code })); process.exit(1); }
if (!spec?.products?.[0]) { console.log(JSON.stringify({ ok: false, error: 'SPEC_MISSING', specPath })); process.exit(1); }

const product = spec.products[0];
const sizes = product.sizes || [];
const color = product.colors?.[0]?.es || product.colors?.[0]?.en || 'Blanco';
const prefix = product.skuPrefix || `MXTMC001-${code}`;
const perSize = handoff.per_size || {};

const rows = sizes.map((size) => ({
  merchant_sku: `${prefix}-${String(color).toUpperCase()}-${size}`,
  color,
  size,
  galaxy_task_id: handoff.galaxy_task_id || null,
  galaxy_design_id: handoff.galaxy_design_id || null,
  galaxy_group_id: handoff.galaxy_group_id || null,
  product_id: readback?.product_id || null,
  fill_pct: perSize[size]?.fill_pct ?? null,
}));

const problems = [];
if (!handoff.galaxy_design_id) problems.push('DESIGN_ID_MISSING');
for (const s of sizes) if (!perSize[s]) problems.push(`DESIGN_SIZE_MISSING_${s}`);
if (!readback?.product_id) problems.push('PRODUCT_ID_MISSING');
for (const r of rows) if (!r.fill_pct || r.fill_pct[0] < 99 || r.fill_pct[1] < 99) problems.push(`FILL_UNDER_99_${r.size}`);
if (new Set(rows.map((r) => r.merchant_sku)).size !== rows.length) problems.push('DUPLICATE_MERCHANT_SKU');

const mapping = {
  schema: 'pod-sku-map-v1',
  code,
  product_id: readback?.product_id || null,
  listing_status: readback?.status || null,
  galaxy_design_id: handoff.galaxy_design_id || null,
  galaxy_group_id: handoff.galaxy_group_id || null,
  galaxy_task_id: handoff.galaxy_task_id || null,
  factory_style: 'MXTMC001',
  factory_saved: false,
  factory_mapping_note: '本地映射已生成；RIIN 工厂端 SKU 映射接口未在本机验证，未写入。',
  rows,
  problems,
  generated_at: new Date().toISOString(),
};
const out = path.join(pack, 'mapping.json');
fs.writeFileSync(out, JSON.stringify(mapping, null, 2));
console.log(JSON.stringify({ ok: problems.length === 0, out, rows: rows.length, problems, factory_saved: false }, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
