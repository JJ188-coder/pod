import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FEES,
  priceForTarget,
  quote,
  recommendCost,
  roundPrice,
  variableRate,
} from '../lib/pricing.mjs';
import { classify, packCount, percentileRank, stats } from '../lib/market.mjs';
import { normalizeQuote } from '../lib/riin.mjs';
import { loadConfig } from '../lib/config.mjs';

test('可变费率合计约 29.05%', () => {
  assert.ok(Math.abs(variableRate(DEFAULT_FEES) - 0.290517) < 1e-6);
});

test('黑白单面 15CNY 的保本价约 62.67', () => {
  assert.ok(Math.abs(priceForTarget(15, 0, DEFAULT_FEES) - 62.67) < 0.02);
});

test('目标 2 元 → 黑白单面 70 MXN', () => {
  const raw = priceForTarget(15, 2, DEFAULT_FEES);
  assert.ok(Math.abs(raw - 69.9) < 0.1);
  assert.equal(roundPrice(raw, '1'), 70);
});

test('售价 70 时余量约 2 元', () => {
  const q = quote(70, 15, DEFAULT_FEES);
  assert.ok(q.contribution_cny > 1.9 && q.contribution_cny < 2.2);
});

test('三档建议价单调且覆盖 1–3 元', () => {
  const r = recommendCost(15, { fees: DEFAULT_FEES, target: { min: 1, value: 2, max: 3 }, round: '1' });
  assert.ok(r.min.price < r.value.price);
  assert.ok(r.value.price < r.max.price);
  assert.ok(r.min.contribution_cny >= 1);
  assert.ok(r.max.contribution_cny >= 3);
});

test('取整模式', () => {
  assert.equal(roundPrice(104.9, '9'), 109);
  assert.equal(roundPrice(104.9, '5'), 105);
  assert.equal(roundPrice(104.9, '1'), 105);
  assert.equal(roundPrice(104.9, '0'), 104.9);
});

test('多件套与长袖识别', () => {
  assert.equal(packCount('Pack 3 Unidades Camisetas Para Hombre'), 3);
  assert.equal(packCount('Juego de 3 piezas Camiseta basica'), 3);
  assert.equal(packCount('Playera San Judas Tadeo'), 1);
  assert.equal(packCount('Playera | VENTA POR PIEZA, NO ES CONJUNTO | Unisex'), 1);
  assert.equal(classify('Camiseta manga larga negra').excluded, true);
  assert.equal(classify('Playera estampada').tee, true);
});

test('固定费按单：3 件时每件余量高于按件', () => {
  const order = quote(70, 15, { ...DEFAULT_FEES, fixedScope: 'order' }, 3);
  const item = quote(70, 15, { ...DEFAULT_FEES, fixedScope: 'item' }, 3);
  assert.ok(Math.abs(order.contribution_mxn - 9.2022) < 0.01);
  assert.ok(Math.abs(item.contribution_mxn - 5.2022) < 0.01);
  assert.ok(order.contribution_mxn > item.contribution_mxn);
  assert.equal(order.fixed, 6);
  assert.equal(item.fixed, 18);
});

test('锁定口径：固定费按件、运费 0（SFP 覆盖本地）', () => {
  const c = loadConfig();
  assert.equal(c.fees.fixedScope, 'item');
  assert.equal(c.fees.shipping, 0);
  assert.deepEqual(c.target, { min: 1, value: 2, max: 3 });
});

test('分位与统计', () => {
  assert.equal(stats([10, 20, 30, 40]).median, 20);
  assert.equal(percentileRank([10, 20, 30, 40], 20), 0.5);
});

test('银河报价聚合：黑白 15/17，四色 18.5/21', () => {
  const row = (color, originalPrice, printOnePrice, printTwoPrice) => ({
    styleCode: 'MXTMC001', styleName: '180GT恤成人款-墨西哥', craftType: 1, currencyType: 'CNY',
    colorCode: color, originalPrice, printOnePrice, printTwoPrice,
  });
  const q = normalizeQuote({
    list: [row('Black', 13, 2, 4), row('White', 13, 2, 4), row('Red', 16, 2.5, 5), row('Blue', 16, 2.5, 5)],
  }, 'MXTMC001');
  assert.deepEqual(q.costs, { bw_single: 15, bw_double: 17, color_single: 18.5, color_double: 21 });
  assert.equal(q.colors.find((c) => c.color === 'Red').class, 'color');
  assert.throws(() => normalizeQuote({ list: [] }, 'MXTMC001'), /RIIN_STYLE_NOT_FOUND/);
});
