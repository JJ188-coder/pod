#!/usr/bin/env node
/**
 * costing.mjs — 单 SKU 条件利润测算。缺任一项就返回 null，不把未知当 0。
 *
 * 用法：
 *   node costing.mjs --price 123 --component 15 --rate 0.276 \
 *     [--commission 0.15] [--service 6] [--shipping 0] [--tax 0] [--json]
 *
 * 输出为「条件余量」，不是平台结算后的实收利润；平台费率/税费未确认时不得对外称利润。
 */
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const num = (v) => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const price = num(arg('--price'));
const component = num(arg('--component'));
const rate = num(arg('--rate'));
const commission = num(arg('--commission', '0.15'));
const service = num(arg('--service', '6'));
const shipping = num(arg('--shipping', '0'));
const tax = num(arg('--tax', '0'));

const missing = [];
for (const [key, value] of Object.entries({ price, component, rate, commission, service })) {
  if (value === null) missing.push(key);
}

let out;
if (missing.length) {
  out = { ok: false, error: 'MISSING_INPUTS', missing, note: '缺项保持 null，不按 0 计算。' };
} else {
  const commissionMxn = price * commission;
  const netMxn = price - commissionMxn - service - tax;
  const netCny = netMxn * rate;
  const costCny = component + shipping;
  const contributionCny = netCny - costCny;
  out = {
    ok: true,
    inputs: { price_mxn: price, component_cny: component, rate_cny_per_mxn: rate, commission_rate: commission, service_fee_mxn: service, shipping_cny: shipping, tax_mxn: tax },
    steps: {
      commission_mxn: +commissionMxn.toFixed(4),
      net_mxn: +netMxn.toFixed(4),
      net_cny: +netCny.toFixed(4),
      cost_cny: +costCny.toFixed(4),
    },
    contribution_cny: +contributionCny.toFixed(4),
    contribution_margin: +(contributionCny / netCny).toFixed(4),
    note: '条件余量；平台费率、税费与实际物流未确认前，不得称为实收利润。',
  };
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
