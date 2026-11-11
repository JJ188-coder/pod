#!/usr/bin/env node
/**
 * riin-openapi.mjs — 银河（RIIN）OpenAPI 客户端：签名 + 23 个接口 + CLI。
 *
 * 鉴权：请求头 secretKey + sign，sign = md5(原始JSON文本 + ":" + secretKey)。
 * 签名对象必须是**实际发送的那串文本**，所以这里只 stringify 一次、算完就用同一串发出去。
 *
 * 用法：
 *   export RIIN_SECRET_KEY=xxxx            # 银河后台 自建站店铺 的密钥
 *   node tools/pod/riin-openapi.mjs placeOrder --json '{"platformType":15,...}' --dry-run
 *   node tools/pod/riin-openapi.mjs queryOrderStatus --json '{"platformOidList":["SG001"]}'
 *   node tools/pod/riin-openapi.mjs pushOrder --file payload.json
 *
 * 只读与写入都走同一套方法；写接口（placeOrder/pushOrder/closeOrder...）上线前先 --dry-run 看报文。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const BASE_URL = (process.env.RIIN_BASE_URL || 'https://tshirt.riin.com').replace(/\/$/, '');

/** 文档 23 个接口：方法名 → 路径 */
export const PATHS = {
  placeOrder: '/trade/api/interface/placeOrder',
  updateOrder: '/trade/api/interface/updateOrder',
  preShipped: '/trade/api/interface/preShipped',
  queryOrderDelivery: '/trade/api/interface/queryOrderDelivery',
  queryOrderStatus: '/trade/api/interface/queryOrderStatus',
  queryProduct: '/trade/api/interface/queryProduct',
  queryStyle: '/trade/api/interface/queryStyle',
  queryColor: '/trade/api/interface/queryColor',
  querySize: '/trade/api/interface/querySize',
  queryShipAddress: '/trade/api/interface/queryShipAddress',
  closeOrder: '/trade/api/interface/closeOrder',
  queryProductShipAddress: '/trade/api/interface/queryProductShipAddress',
  queryOrderInfo: '/trade/api/interface/queryOrderInfo',
  updatePrintImage: '/trade/api/interface/updatePrintImage',
  maskAddress: '/trade/api/interface/maskAddress',
  pushOrder: '/trade/api/interface/pushOrder',
  queryAbnormalImagePage: '/trade/api/interface/queryAbnormalImagePage',
  uploadAbnormalImage: '/trade/api/interface/uploadAbnormalImage',
  syncImageToFactory: '/trade/api/interface/syncImageToFactory',
  queryAfterSalesInfo: '/trade/api/interface/queryAfterSalesInfo',
  createAfterSales: '/trade/api/interface/createAfterSales',
  updateOrderWaybillData: '/trade/api/interface/updateOrderWaybillData',
  orderFundsPageList: '/trade/api/interface/orderFundsPageList',
};

/** 主单状态：银河 orderStatus 整数 → 枚举/中文 */
export const ORDER_STATUS = {
  1: ['STORE_AUDIT', '店铺审核中'],
  2: ['PENDING_PUSH', '店铺推送中'],
  3: ['REVERSE_AUDIT', '反审回电商'],
  4: ['FACTORY_AUDIT', '工厂审核'],
  5: ['IN_PRODUCTION', '生产中'],
  12: ['SHIPPED', '已发货'],
  13: ['CLOSE', '已关闭'],
  14: ['REFUNDING', '退款中'],
  15: ['REFUNDED', '已退款'],
};

/** 可改单/改图/推单的状态 */
export const EDITABLE_STATUS = [2, 3];

export function sign(bodyText, secretKey) {
  return crypto.createHash('md5').update(`${bodyText}:${secretKey}`, 'utf8').digest('hex');
}

function secret(explicit) {
  const key = explicit || process.env.RIIN_SECRET_KEY;
  if (!key) throw new Error('RIIN_SECRET_KEY_MISSING：先在银河后台取自建站店铺密钥，导出到环境变量');
  return key;
}

/**
 * 调一个接口。payload 为对象（内部只 stringify 一次）；dryRun 只返回报文不发送。
 * 返回 { ok, httpStatus, result } —— HTTP 200 但 successful=false 时 ok=false。
 */
export async function call(method, payload = {}, opts = {}) {
  const path = PATHS[method];
  if (!path) throw new Error(`UNKNOWN_METHOD: ${method}`);
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    secretKey: secret(opts.secretKey),
    sign: sign(body, secret(opts.secretKey)),
  };
  const url = `${opts.baseUrl || BASE_URL}${path}`;
  if (opts.dryRun) return { ok: true, dryRun: true, url, headers, body };

  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30000) });
  const text = await res.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return { ok: false, httpStatus: res.status, result: { raw: text.slice(0, 500) }, url };
  }
  return { ok: res.ok && result?.successful === true, httpStatus: res.status, result, url };
}

/** 下单：payload 按手册第 3 节传；这里只补两个空数组/默认值，不做业务猜测。 */
export function prepareOrder(payload) {
  const order = { ...payload };
  if (!order.goodsList || !Array.isArray(order.goodsList)) throw new Error('goodsList_REQUIRED');
  return order;
}

/** 子单号约定：主单号 + 3 位序号（文档样例 SG...001） */
export function subOrderId(platformOid, index) {
  return `${platformOid}${String(index + 1).padStart(3, '0')}`;
}

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

async function main() {
  const [method, ...rest] = process.argv.slice(2);
  if (!method || method === '-h' || method === '--help') {
    console.log(JSON.stringify({ methods: Object.keys(PATHS), usage: 'node tools/pod/riin-openapi.mjs <method> --json {...} [--dry-run]' }, null, 2));
    return;
  }
  const jsonArg = arg('--json');
  const file = arg('--file');
  const payload = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : jsonArg ? JSON.parse(jsonArg) : {};
  const res = await call(method, payload, {
    dryRun: rest.includes('--dry-run'),
    baseUrl: arg('--base', '') || undefined,
    timeoutMs: Number(arg('--timeout', '30000')),
  });
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  });
}
