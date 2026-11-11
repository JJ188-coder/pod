#!/usr/bin/env node
/**
 * riin-audit.mjs — RIIN 商品侧只读审计：分页拉商品，统计设计状态；可选逐款读 SKU 映射。
 *
 * 用法：
 *   node tools/pod/riin-audit.mjs [--shop-pk 2112903609325871106] [--factory-id 15235]
 *     [--max-pages 20] [--detail --max-detail 50] [--out audit.json]
 *
 * 只读：只调 /trade/goods/page/v2 与 /trade/goods/detail/spuId/factoryId/v2。
 * designStatus=3 是已实测过的「已设计」值；其它值原样统计，不做猜测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { exactChromePage } from './chrome-page.mjs';

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const shopPk = arg('--shop-pk', '2112903609325871106');
const factoryId = arg('--factory-id', '15235');
const maxPages = Number(arg('--max-pages', '20'));
const withDetail = process.argv.includes('--detail');
const maxDetail = Number(arg('--max-detail', '50'));
const outPath = arg('--out');

const rows = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(4000) })).json();
const target = rows.find((r) => r.type === 'page' && r.url.includes('tshirt.riin.com'));
if (!target) { console.log(JSON.stringify({ ok: false, error: 'RIIN_TAB_MISSING' })); process.exit(1); }

const { browser, page } = await exactChromePage({ targetId: target.id, origin: 'https://tshirt.riin.com' });

const listPage = (cursor) => page.evaluate(async ({ shopPk, factoryId, cursor }) => {
  const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
  if (!ui?.token) return { error: 'NO_SESSION' };
  const H = { 'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest' };
  const body = { factoryId, shopIds: [shopPk], pageIndex: 1, pageSize: 100 };
  if (cursor) body.searchAfter = cursor;
  const r = await fetch('/trade/goods/page/v2', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  return { total: j.data?.total ?? 0, list: j.data?.list || [], hasMore: j.data?.hasMore === true, next: j.data?.nextSearchAfter || null };
}, { shopPk, factoryId, cursor });

const detail = (spuId) => page.evaluate(async ({ spuId, factoryId }) => {
  const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
  const H = { 'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest' };
  const r = await fetch('/trade/goods/detail/spuId/factoryId/v2', { method: 'POST', headers: H, body: JSON.stringify({ spuId, factoryId }) });
  const j = await r.json();
  const d = j.data || [];
  return { skus: d.length, mapped: d.filter((s) => s.mappingState === true).length };
}, { spuId, factoryId });

const seen = new Map();
let total = null;
let cursor = null;
for (let p = 1; p <= maxPages; p += 1) {
  const res = await listPage(cursor);
  if (res.error) { console.log(JSON.stringify({ ok: false, error: res.error })); await browser.close().catch(() => {}); process.exit(1); }
  total = res.total;
  for (const g of res.list) if (!seen.has(g.spuId)) seen.set(g.spuId, g);
  if (!res.hasMore || res.list.length === 0 || !res.next) break;
  cursor = res.next;
  if (seen.size >= total) break;
}
const all = [...seen.values()];

const status = {};
for (const g of all) {
  const k = String(g.designStatus);
  status[k] = (status[k] || 0) + 1;
}

let details = null;
if (withDetail) {
  details = [];
  for (const g of all.slice(0, maxDetail)) {
    const d = await detail(g.spuId);
    details.push({ spuId: g.spuId, title: String(g.spuTitle || '').slice(0, 40), designStatus: g.designStatus, ...d });
  }
}

const report = {
  schema: 'riin-goods-audit-v1',
  shop_pk: shopPk,
  factory_id: factoryId,
  total,
  fetched: all.length,
  unique: true,
  design_status_counts: status,
  note: 'designStatus=3 为已实测的「已设计」；其它值原样统计。mappingState 只在 --detail 时逐款读。',
  ...(details ? { details } : {}),
};
if (outPath) { fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ ...report, out: outPath || null }, null, 2));
await browser.close().catch(() => {});
