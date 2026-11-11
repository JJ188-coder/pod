#!/usr/bin/env node
/**
 * riin-orders.mjs — 银河订单只读查询：列表 / 状态汇总 / 商品明细。
 *
 * 走本机已登录 Chrome（CDP 9222）的内部接口，不碰 Cookie 文件、不下单、不推厂：
 *   POST /trade/order/page      订单分页（timeType=1 按下单时间）
 *   POST /trade/order/count     各状态数量
 *   POST /trade/order/goods/list 订单商品明细（按订单 id）
 *
 * 用法：
 *   node tools/pod/riin-orders.mjs                       # 近 7 天，表格
 *   node tools/pod/riin-orders.mjs --days 30 --status 2  # 只看待推送
 *   node tools/pod/riin-orders.mjs --goods --json        # 带商品明细，输出 JSON
 */
import { exactChromePage } from './chrome-page.mjs';

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(n);

const days = Number(arg('--days', '7'));
const statusFilter = arg('--status', '');
const withGoods = flag('--goods');
const asJson = flag('--json');
const pageSize = Number(arg('--page-size', '100'));

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const end = new Date();
const start = new Date(end.getTime() - days * 86400_000);

const STATUS = {
  1: '店铺审核中', 2: '待推送', 3: '反审回电商', 4: '工厂审核',
  5: '生产中', 12: '已发货', 13: '已关闭', 14: '退款中', 15: '已退款',
};

const rows = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(4000) })).json();
const target = rows.find((r) => r.type === 'page' && r.url.includes('tshirt.riin.com') && !r.url.includes('login'));
if (!target) {
  console.log(JSON.stringify({ ok: false, error: 'RIIN_TAB_MISSING：先打开并登录 https://tshirt.riin.com' }));
  process.exit(1);
}
const { browser, page } = await exactChromePage({ targetId: target.id, origin: 'https://tshirt.riin.com' });

const post = (path, body) => page.evaluate(async ({ path, body }) => {
  const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
  if (!ui?.token) return { error: 'NO_SESSION' };
  const H = { 'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest' };
  const r = await fetch(path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return r.json();
}, { path, body });

const list = await post('/trade/order/page', {
  timeType: 1, lessMore: 1, startTime: fmt(start), endTime: fmt(end),
  pageIndex: 1, pageSize,
});
if (list?.error) {
  console.log(JSON.stringify({ ok: false, error: list.error }));
  await browser.close().catch(() => {});
  process.exit(1);
}

let orders = list?.data?.records || [];
if (statusFilter) orders = orders.filter((o) => String(o.orderStatus) === String(statusFilter));

const brief = orders.map((o) => ({
  platformOid: o.platformOid,
  orderId: o.id,
  status: STATUS[o.orderStatus] || String(o.orderStatus),
  orderStatus: o.orderStatus,
  shop: o.platformShopName || o.systemShopName || '',
  qty: o.goodsTotalQty,
  amount: o.totalPrice ?? o.payment,
  currency: o.currencyType || o.currency || '',
  pushed: Boolean(o.pushTime),
  pushTime: o.pushTime || null,
  factory: o.productionFactoryAlias || null,
  tracking: o.courierNumber || null,
  courier: o.deliveryCourier || null,
  receiver: `${o.consigneeName || ''} ${o.receiverCountry || ''}${o.receiverProvince || ''}${o.receiverCity || ''}`.trim(),
  orderTime: o.orderTime || o.orderCreateTime || null,
}));

if (withGoods && orders.length) {
  const g = await post('/trade/order/goods/list', { ids: orders.map((o) => o.id) });
  const byOrder = new Map();
  for (const item of g?.data || []) {
    const key = item.orderId ?? item.orderid ?? item.id;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(item);
  }
  for (const b of brief) b.goods = (byOrder.get(b.orderId) || []).length;
}

const byStatus = {};
for (const b of brief) byStatus[b.status] = (byStatus[b.status] || 0) + 1;

const report = {
  ok: true,
  range: { days, start: fmt(start), end: fmt(end) },
  total_in_range: list?.data?.total ?? null,
  fetched: brief.length,
  by_status: byStatus,
  orders: brief,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`区间 ${fmt(start)} ~ ${fmt(end)} ｜ 区间总数 ${report.total_in_range} ｜ 本次 ${brief.length}`);
  console.log(`状态分布：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join('，') || '无'}`);
  console.log('');
  for (const b of brief) {
    console.log([
      b.status.padEnd(6),
      String(b.platformOid).slice(-12).padEnd(12),
      `${b.qty || 0}件`.padEnd(5),
      `${b.amount ?? ''} ${b.currency}`.padEnd(10),
      b.pushed ? '已推厂' : '未推厂',
      b.tracking || '-',
      b.receiver.slice(0, 24),
    ].join(' | '));
  }
}

await browser.close().catch(() => {});
