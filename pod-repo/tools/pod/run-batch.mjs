#!/usr/bin/env node
/**
 * run-batch.mjs — 多款串行编排：逐个调用 run-product.mjs，失败停住，写批次报告。
 *
 * 用法：
 *   node tools/pod/run-batch.mjs --manifest batch.json [--steps spec,check,import,readback,mapping] \
 *     [--galaxy-apply] [--import] [--finish] [--continue-on-error]
 *
 * manifest：
 *   { "steps": "mapping",
 *     "products": [ { "pack": "...", "code": "UKIYOE1", "title": "...", "description": "..." } ] }
 *
 * 单款字段会原样传给 run-product.mjs：pack/code/title/description/pattern/reference/theme/
 * color/sizes/price/skuPrefix/version/style。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, 'run-product.mjs');
const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(n);

const manifestPath = path.resolve(arg('--manifest'));
if (!fs.existsSync(manifestPath)) { console.log(JSON.stringify({ ok: false, error: 'MANIFEST_NOT_FOUND', manifestPath })); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const products = Array.isArray(manifest.products) ? manifest.products : [];
if (!products.length) { console.log(JSON.stringify({ ok: false, error: 'NO_PRODUCTS' })); process.exit(2); }

const steps = arg('--steps', manifest.steps || '');
const passFlags = [];
if (has('--galaxy-apply')) passFlags.push('--galaxy-apply');
if (has('--import')) passFlags.push('--import');
if (has('--finish')) passFlags.push('--finish');
if (has('--force')) passFlags.push('--force');
const continueOnError = has('--continue-on-error');

const results = [];
let failed = 0;
for (const product of products) {
  const argv = [RUN, '--pack', product.pack, '--code', product.code];
  if (steps) argv.push('--steps', steps);
  for (const key of ['title', 'description', 'pattern', 'reference', 'theme', 'color', 'sizes', 'price', 'sku-prefix', 'version', 'style', 'base-url']) {
    const v = product[key] ?? product[key.replace('-', '')];
    if (v) argv.push(`--${key}`, String(v));
  }
  argv.push(...passFlags);

  const started = Date.now();
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 1800000, cwd: path.dirname(HERE) + '/..' });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* keep null */ }
  const ok = r.status === 0 && parsed?.ok === true;
  results.push({
    code: product.code,
    ok,
    exit: r.status,
    duration_ms: Date.now() - started,
    steps: parsed?.steps || null,
    error: ok ? null : (parsed?.error || (r.stderr || '').slice(-300) || `EXIT_${r.status}`),
  });
  if (!ok) {
    failed += 1;
    if (!continueOnError) break;
  }
}

const report = {
  schema: 'pod-batch-report-v1',
  manifest: manifestPath,
  steps: steps || 'default',
  total: products.length,
  ran: results.length,
  failed,
  ok: failed === 0 && results.length === products.length,
  results,
  generated_at: new Date().toISOString(),
};
const out = path.join(path.dirname(manifestPath), `batch-report-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, report: out }, null, 2));
process.exit(report.ok ? 0 : 1);
