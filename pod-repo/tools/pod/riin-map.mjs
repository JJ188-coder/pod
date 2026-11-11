#!/usr/bin/env node
/**
 * riin-map.mjs — RIIN 工厂端映射：同步商品、只读检查、映射计划；默认不写映射。
 *
 * 实测（2026-11-04）：
 *   - 商品列表：POST /trade/goods/page  { shopIds: [shopPk] }
 *   - 同步商品：POST /trade/goods/download/time
 *       { shopId: [shopPk], spuIds: [tiktokProductId], startTime: null, endTime: null }
 *     返回 successful=true 后为异步导入，可能几分钟到 20 分钟。
 *   - 映射写入：POST /trade/design/sku/factor/bind（2026-11-04 抓包实测）
 *       body: {designTaskId, factoryId, shopId(平台店铺ID), spuId, binds:[{skuId,styleCode,colorCode,sizeCode}]}
 *     但 designTaskId 每次「设计」都新建，单独 bind 会让商品指向空设计任务，
 *     所以本脚本仍不写映射，--apply 一律拒绝；映射只能随设计流程一起写。
 *
 * 用法：
 *   node tools/pod/riin-map.mjs --pack <商品包> --code UKIYOE1 [--sync] [--wait-seconds 180] [--apply]
 *
 * 退出码：0 商品已在 RIIN 且计划完整；1 未同步/缺项；2 参数错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { exactChromePage } from './chrome-page.mjs';

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const pack = path.resolve(arg('--pack'));
const code = arg('--code');
const shopPk = arg('--shop-pk', '2000000000000000001');
const factoryId = arg('--factory-id', '10001');
const apply = process.argv.includes('--apply');
const doSync = process.argv.includes('--sync');
const waitSeconds = Number(arg('--wait-seconds', '180'));
if (!code || !fs.existsSync(pack)) { console.log(JSON.stringify({ ok: false, error: 'PACK_AND_CODE_REQUIRED' })); process.exit(2); }

const mappingPath = path.join(pack, 'mapping.json');
const mapping = fs.existsSync(mappingPath) ? JSON.parse(fs.readFileSync(mappingPath, 'utf8')) : null;
if (!mapping) { console.log(JSON.stringify({ ok: false, error: 'MAPPING_MISSING', mappingPath })); process.exit(1); }
const productId = String(mapping.product_id || '');
if (!productId) { console.log(JSON.stringify({ ok: false, error: 'PRODUCT_ID_MISSING' })); process.exit(1); }

const rows = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(4000) })).json();
const target = rows.find((r) => r.type === 'page' && r.url.includes('tshirt.riin.com'));
if (!target) { console.log(JSON.stringify({ ok: false, error: 'RIIN_TAB_MISSING' })); process.exit(1); }

const { browser, page } = await exactChromePage({ targetId: target.id, origin: 'https://tshirt.riin.com' });

const queryGoods = () => page.evaluate(async ({ shopPk, productId, factoryId }) => {
  const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
  if (!ui?.token) return { error: 'NO_SESSION' };
  const H = { 'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest' };
  const r = await fetch('/trade/goods/page/v2', { method: 'POST', headers: H, body: JSON.stringify({ factoryId, shopIds: [shopPk], spuIds: [productId], pageIndex: 1, pageSize: 10 }) });
  const j = await r.json();
  const list = j.data?.list || [];
  const hit = list.filter((x) => String(x.spuId || '').includes(productId));
  return { total: j.data?.total ?? null, code: j.code, count: list.length, hit, firstKeys: list[0] ? Object.keys(list[0]) : [] };
}, { shopPk, productId, factoryId });

let goods = await queryGoods();
let syncResponse = null;

if (!goods.error && (!goods.total || !goods.hit?.length) && doSync) {
  syncResponse = await page.evaluate(async ({ shopPk, productId }) => {
    const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
    const H = { 'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest' };
    const body = { shopId: [shopPk], spuIds: [productId], startTime: null, endTime: null };
    const r = await fetch('/trade/goods/download/time', { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, { shopPk, productId });

  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    goods = await queryGoods();
    if (goods.total && goods.hit?.length) break;
  }
}

await browser.close().catch(() => {});

if (goods.error) { console.log(JSON.stringify({ ok: false, error: goods.error })); process.exit(1); }

if (!goods.total || !goods.hit?.length) {
  console.log(JSON.stringify({
    ok: false,
    error: 'FACTORY_GOODS_NOT_SYNCED',
    riin_shop_pk: shopPk,
    product_id: productId,
    goods_total: goods.total,
    sync_response: syncResponse,
    waited_seconds: doSync ? waitSeconds : 0,
    next: [
      '同步请求已成功时，RIIN 侧仍是异步导入，可能几分钟到 20 分钟；稍后重跑本命令',
      '也可在 RIIN 商品管理点「同步商品」：TIKTOK → 勾选 shop-a → SpuIds 填商品 ID → 确认',
      '若长时间不出现，检查该店铺在 RIIN 的授权是否过期',
    ],
    note: '商品未进 RIIN 前无法建立工厂映射；本地 mapping.json 已生成，不代表工厂已收到。',
  }, null, 2));
  process.exit(1);
}

const plan = {
  schema: 'riin-map-plan-v1',
  code,
  riin_shop_pk: shopPk,
  product_id: productId,
  goods: goods.hit[0],
  rows: mapping.rows,
  apply_requested: apply,
  factory_write: apply ? 'REFUSED_NOT_STANDALONE' : 'DRY_RUN',
  note: apply
    ? 'POST /trade/design/sku/factor/bind 需要新建的 designTaskId；脱离设计流程单独写会让商品指向空设计任务，因此拒绝。'
    : '只读计划；加 --apply 也不会写，映射只能随设计流程（riin-design-batch.mjs）一起写。',
};
console.log(JSON.stringify({ ok: false, error: 'FACTORY_BIND_NOT_STANDALONE', ...plan }, null, 2));
process.exit(1);
