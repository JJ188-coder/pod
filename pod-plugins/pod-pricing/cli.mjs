#!/usr/bin/env node
/**
 * POD 定价助手 CLI。
 *
 *   node cli.mjs riin     [--style MXTMC001] [--craft 1] [--save]
 *   node cli.mjs market   [--market <rankings.json>] [--json]
 *   node cli.mjs quote    [--cost 15] [--price 70] [--qty 1] [--target 2] [--side single] [--color bw]
 *   node cli.mjs recommend --spec <listing-spec.json> [--target 2] [--round 1] [--json]
 *   node cli.mjs apply    --spec <listing-spec.json> [--apply] [--target 2]
 *   node cli.mjs audit    --batch <批次目录> [--target 2] [--json]
 *   node cli.mjs flow     --batch <批次目录> [--refresh-costs] [--save]
 *
 * 口径锁定在 config/pricing.json：固定费 6 MXN 按单、运费售价 6%、
 * 每单目标余量 1–3 元（落点 2 元）、售价向上取整到 1 MXN。
 * 所有输出都是「条件余量」；平台费/税/汇率假设会在报告里列明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { arg, has, num, fmt, pct } from './lib/util.mjs';
import { analyze, loadMarket, percentileRank, resolveMarket } from './lib/market.mjs';
import {
  parseTarget,
  quote,
  recommendCost,
  variableRate,
} from './lib/pricing.mjs';
import {
  buildPriceMap,
  colorClass,
  colorsOf,
  costOf,
  currentPrice,
  loadSpec,
  patchSpec,
  productsOf,
  scanBatch,
  sideOf,
} from './lib/spec.mjs';
import { fetchRiinQuote, loadCosts, saveCosts } from './lib/riin.mjs';
import { loadConfig } from './lib/config.mjs';

const CONFIG = loadConfig();
const FEES = {
  fx: num(arg('fx'), CONFIG.fees.fx),
  commission: num(arg('commission'), CONFIG.fees.commission),
  sfp: num(arg('sfp'), CONFIG.fees.sfp),
  sfpCap: num(arg('sfp-cap'), CONFIG.fees.sfpCap),
  iva: num(arg('iva'), CONFIG.fees.iva),
  isr: num(arg('isr'), CONFIG.fees.isr),
  fixed: num(arg('fixed'), CONFIG.fees.fixed),
  fixedScope: arg('fixed-scope', CONFIG.fees.fixedScope) === 'item' ? 'item' : 'order',
  shipping: num(arg('shipping'), CONFIG.fees.shipping),
};

const BASE_COSTS = loadCosts();
const COSTS = {
  bw_single: num(arg('cost-bw-single'), BASE_COSTS.bw_single),
  bw_double: num(arg('cost-bw-double'), BASE_COSTS.bw_double),
  color_single: num(arg('cost-color-single'), BASE_COSTS.color_single),
  color_double: num(arg('cost-color-double'), BASE_COSTS.color_double),
};

const TARGET = parseTarget((name, fallback) => num(arg(name), fallback), CONFIG.target);
const ROUND = arg('round', CONFIG.round);

function marketBundle() {
  const file = resolveMarket(arg('market'));
  const market = loadMarket(file);
  const stats = analyze(market, { basicMax: num(arg('basic-max'), 200) });
  return { file, market, stats };
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** 读银河当前报价；--save 写入 data/costs/latest.json，后续 recommend/apply 自动用它。 */
async function cmdRiin() {
  const style = arg('style', 'MXTMC001');
  const craft = num(arg('craft'), 1);
  const quote = await fetchRiinQuote({ styleCode: style, craftType: craft, cdp: arg('cdp') });
  const saved = has('save') ? saveCosts(quote) : null;
  if (has('json')) return printJson({ ...quote, saved });

  console.log(`银河报价 ${quote.style_code} ${quote.style_name}（工艺 ${quote.craft_type}，${quote.currency}）`);
  for (const c of quote.colors) {
    console.log(
      `  ${c.color.padEnd(8)} ${c.class === 'bw' ? '黑白' : '彩色'}  原衣 ${fmt(c.original, 2)} + 单面 ${fmt(c.print_single, 2)} / 双面 ${fmt(c.print_double, 2)} → 单面 ${fmt(c.total_single, 2)} / 双面 ${fmt(c.total_double, 2)}`,
    );
  }
  const k = quote.costs;
  console.log(`汇总成本：黑白 ${fmt(k.bw_single, 2)}/${fmt(k.bw_double, 2)}，四色 ${fmt(k.color_single, 2)}/${fmt(k.color_double, 2)}（单面/双面，CNY）`);
  console.log(saved ? `已保存：${saved}` : '未保存；加 --save 后 recommend/apply 会自动使用这份报价。');
}

function cmdMarket() {
  const { stats } = marketBundle();
  if (has('json')) return printJson(stats);
  const b = stats.basic;
  console.log(`市场价带  ${stats.week}  ${stats.currency}`);
  if (!b) {
    console.log('没有可用的基础单件 T 恤样本；换一周或调 --basic-max。');
    return;
  }
  console.log(`基础单件 T 恤  ${b.count} 款 / ${b.units} 件`);
  console.log(`  分位      p10 ${fmt(b.p10, 0)} | p25 ${fmt(b.p25, 0)} | 中位 ${fmt(b.median, 0)} | p75 ${fmt(b.p75, 0)} | p90 ${fmt(b.p90, 0)}`);
  console.log(`  销量加权均价 ${fmt(b.unit_weighted_avg, 1)}`);
  if (stats.packs) {
    console.log(`  多件套按件价  p25 ${fmt(stats.packs.p25, 1)} | 中位 ${fmt(stats.packs.median, 1)} | p75 ${fmt(stats.packs.p75, 1)}（${stats.packs.count} 款）`);
  }
  if (stats.anchors) {
    console.log(`  锚点      冲量 ${fmt(stats.anchors.volume, 0)} | 平衡 ${fmt(stats.anchors.balanced, 0)} | 利润 ${fmt(stats.anchors.margin, 0)}`);
  }
  console.log('  销量分布');
  for (const band of stats.bands) {
    console.log(`    ${String(band.lo).padStart(3)}–${String(band.hi).padEnd(3)} ${String(band.n).padStart(3)} 款 ${String(band.units).padStart(6)} 件 ${pct(band.share, 1).padStart(6)}`);
  }
  console.log('  销量前 10 的单件基础款');
  for (const p of stats.top) {
    console.log(`    ${String(p.units).padStart(6)} 件  MX$${fmt(p.avg_price, 2).padStart(7)}  ${p.seller.slice(0, 14).padEnd(14)} ${p.name.slice(0, 46)}`);
  }
}

function cmdQuote() {
  const side = arg('side', 'single') === 'double' ? 'double' : 'single';
  const cls = arg('color', 'bw') === 'color' ? 'color' : 'bw';
  const cost = num(arg('cost'), COSTS[`${cls}_${side}`]);
  const price = num(arg('price'), null);
  const qty = Math.max(1, num(arg('qty'), 1));
  const rec = recommendCost(cost, { fees: FEES, target: TARGET, round: ROUND });

  if (price === null) {
    if (has('json')) return printJson(rec);
    console.log(`成本 ${fmt(cost, 2)} CNY → ${fmt(cost / FEES.fx, 2)} MXN（fx ${FEES.fx}）`);
    console.log(`保本价 ${fmt(rec.break_even, 2)} | ${TARGET.min}元 ${rec.min.price} | ${TARGET.value}元 ${rec.value.price} | ${TARGET.max}元 ${rec.max.price}`);
    printQuote(rec.multi.find((m) => m.qty === qty) || rec.value);
    return;
  }

  const q = quote(price, cost, FEES, qty);
  if (has('json')) return printJson({ ...q, fees: FEES });
  printQuote(q);
  console.log(`保本价 ${fmt(rec.break_even, 2)} | ${TARGET.min}元 ${rec.min.price} | ${TARGET.value}元 ${rec.value.price} | ${TARGET.max}元 ${rec.max.price}`);
}

function printQuote(q) {
  console.log(`${q.qty > 1 ? `一单 ${q.qty} 件，` : ''}售价 ${fmt(q.price, 2)} MXN/件`);
  console.log(`  佣金 ${pct(FEES.commission, 1)}  ${fmt(-q.commission, 2).padStart(10)}`);
  console.log(`  SFP ${pct(FEES.sfp, 1)}   ${fmt(-q.sfp, 2).padStart(10)}`);
  console.log(`  IVA ${pct(FEES.iva, 1)}   ${fmt(-q.iva, 2).padStart(10)}`);
  console.log(`  ISR ${pct(FEES.isr, 2)}  ${fmt(-q.isr, 2).padStart(10)}`);
  console.log(`  运费 ${pct(FEES.shipping, 1)}  ${fmt(-q.shipping, 2).padStart(10)}`);
  console.log(`  ${q.fixed_scope === 'order' ? '整单固定费' : '每件固定费'}  ${fmt(-q.fixed, 2).padStart(10)}`);
  console.log(`  货品成本    ${fmt(-q.goods_total_mxn, 2).padStart(10)}`);
  if (q.qty > 1) {
    console.log(`  条件余量合计 ${fmt(q.contribution_total_mxn, 2).padStart(8)} MXN = ${fmt(q.contribution_total_cny, 2)} CNY（${pct(q.margin_rate, 1)}）`);
    console.log(`  每件         ${fmt(q.contribution_mxn, 2).padStart(8)} MXN = ${fmt(q.contribution_cny, 2)} CNY`);
  } else {
    console.log(`  条件余量    ${fmt(q.contribution_total_mxn, 2).padStart(10)} MXN = ${fmt(q.contribution_total_cny, 2)} CNY（${pct(q.margin_rate, 1)}）`);
  }
  if (q.sfp_capped) console.log('  注意：SFP 已触发每件封顶。');
}

function planForProduct(product, stats) {
  const side = sideOf(product, arg('side', 'single'));
  const colors = colorsOf(product);
  const names = colors.length ? colors : ['(default)'];
  const rows = names.map((color) => {
    const cls = color === '(default)' ? 'bw' : colorClass(color);
    const explicit = has('cost') ? num('cost', 0) : costOf(product);
    const cost = explicit != null ? explicit : COSTS[`${cls}_${side}`];
    const rec = recommendCost(cost, { fees: FEES, target: TARGET, round: ROUND });
    const before = currentPrice(product, color === '(default)' ? null : color);
    return {
      color,
      class: cls,
      cost_mode: explicit != null ? 'explicit' : 'color-class',
      cost_cny: cost,
      before,
      ...rec,
      position: percentileRank(stats.basic_prices, rec.value.price),
    };
  });
  const hasBw = rows.some((r) => r.class === 'bw');
  const bw = rows.find((r) => r.class === 'bw');
  const color = rows.find((r) => r.class === 'color');
  const bwPrice = bw ? bw.value.price : color.value.price;
  const colorPrice = color ? color.value.price : bwPrice;
  return {
    product,
    key: product.slug || product.style || product.skuPrefix,
    side,
    rows,
    priceMap: buildPriceMap(product, bwPrice, colorPrice, hasBw ? bwPrice : colorPrice),
  };
}

function cmdRecommend() {
  const specPath = arg('spec');
  if (!specPath) throw new Error('缺少 --spec <listing-spec.json>');
  const { stats } = marketBundle();
  const { spec } = loadSpec(specPath);
  const plans = productsOf(spec).map((p) => planForProduct(p, stats));

  const report = buildReport(specPath, plans, stats);
  const out = arg('out');
  if (out) {
    fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + '\n');
    console.error(`报告已写入 ${path.resolve(out)}`);
  }
  if (has('json')) return printJson(report);

  console.log(`市场基准 ${stats.week}：基础单件 ${fmt(stats.basic.p25, 0)} / ${fmt(stats.basic.median, 0)} / ${fmt(stats.basic.p75, 0)}（p25/中位/p75）`);
  console.log(`口径：固定费 ${fmt(FEES.fixed, 2)} MXN ${FEES.fixedScope === 'order' ? '按单' : '按件'} | 运费 售价×${pct(FEES.shipping, 0)} | 目标 ${TARGET.min}–${TARGET.max} 元，落点 ${TARGET.value} 元；取整 ${ROUND}`);
  for (const plan of plans) {
    console.log(`\n${plan.key}（${plan.side === 'double' ? '双面' : '单面'}）`);
    for (const r of plan.rows) {
      console.log(
        `  ${r.color}（${r.cost_mode === 'explicit' ? '按款成本' : r.class === 'bw' ? '黑白' : '彩色'}）成本 ${fmt(r.cost_cny, 1)} → 建议 ${r.value.price}` +
          `（${TARGET.min}元档 ${r.min.price} / ${TARGET.max}元档 ${r.max.price}）` +
          `，余量 ${fmt(r.value.contribution_cny, 2)} CNY，现价 ${fmt(r.before, 0)}，市场分位 ${pct(r.position, 0)}`,
      );
    }
    if (FEES.fixedScope === 'order') {
      const head = plan.rows[0];
      const two = head.multi.find((m) => m.qty === 2);
      const three = head.multi.find((m) => m.qty === 3);
      console.log(`  同价一单 2 件每件 ${fmt(two.contribution_cny, 2)} 元、3 件 ${fmt(three.contribution_cny, 2)} 元（固定费按单摊薄）`);
    }
    console.log(`  price → ${JSON.stringify(plan.priceMap)}`);
  }
}

/**
 * 审计：逐个 spec 看现价是否落进目标区间。
 * ABOVE_TARGET 只是提示（起量阶段通常意味着还能降），BELOW_BREAKEVEN / NO_PRICE 才返回非 0。
 */
function collectAudit(batch, stats) {
  const specs = scanBatch(batch);
  if (!specs.length) throw new Error('没有找到 listing-spec.json：' + path.resolve(batch));

  const rows = [];
  for (const file of specs) {
    const { spec } = loadSpec(file);
    for (const product of productsOf(spec)) {
      const plan = planForProduct(product, stats);
      const bwPrice = plan.rows.find((r) => r.class === 'bw')?.before ?? null;
      for (const r of plan.rows) {
        const flags = [];
        if (r.before === null) flags.push('NO_PRICE');
        const q = r.before === null ? null : quote(r.before, r.cost_cny, FEES);
        if (q) {
          if (q.contribution_mxn < 0) flags.push('BELOW_BREAKEVEN');
          else if (q.contribution_cny < TARGET.min - 0.01) flags.push('BELOW_TARGET');
          else if (q.contribution_cny > TARGET.max + 1) flags.push('ABOVE_TARGET');
          if (r.class === 'color' && bwPrice !== null && r.before <= bwPrice) flags.push('COLOR_PRICE_LEAK');
          const pos = percentileRank(stats.basic_prices, r.before);
          if (pos !== null && pos > 0.9) flags.push('ABOVE_MARKET_P90');
        }
        rows.push({
          spec: path.relative(path.resolve(batch), file),
          product: plan.key,
          color: r.color,
          side: plan.side,
          price: r.before,
          cost_cny: r.cost_cny,
          contribution_cny: q ? q.contribution_cny : null,
          position: q ? percentileRank(stats.basic_prices, r.before) : null,
          suggested: r.value.price,
          flags,
        });
      }
    }
  }

  const severe = rows.some((r) => r.flags.includes('BELOW_BREAKEVEN') || r.flags.includes('NO_PRICE'));
  return { specs, rows, severe };
}

function cmdAudit() {
  const batch = arg('batch');
  if (!batch) throw new Error('缺少 --batch <批次目录>');
  const { stats } = marketBundle();
  const { rows, severe } = collectAudit(batch, stats);
  if (has('json')) {
    printJson({ market: stats.week, target: TARGET, fixed_scope: FEES.fixedScope, rows, severe });
    process.exit(severe ? 1 : 0);
  }

  console.log(`批次 ${path.resolve(batch)}`);
  console.log(`固定费 ${fmt(FEES.fixed, 2)} MXN ${FEES.fixedScope === 'order' ? '按单' : '按件'} | 运费 售价×${pct(FEES.shipping, 0)} | 目标 ${TARGET.min}–${TARGET.max} 元/单`);
  console.log(`市场 ${stats.week} 基准 ${fmt(stats.basic.p25, 0)} / ${fmt(stats.basic.median, 0)} / ${fmt(stats.basic.p75, 0)}`);
  for (const r of rows) {
    console.log(
      `  ${r.product} / ${r.color} / ${r.side === 'double' ? '双面' : '单面'}：售价 ${fmt(r.price, 0)}，` +
        `余量 ${fmt(r.contribution_cny, 2)} CNY，建议 ${r.suggested}，市场分位 ${pct(r.position, 0)}` +
        `${r.flags.length ? `  [${r.flags.join(',')}]` : ''}`,
    );
  }
  console.log(severe ? '\n存在亏损或缺价 SKU，先处理再上架。' : '\n没有亏损或缺价 SKU。');
  process.exit(severe ? 1 : 0);
}

/** 固化流程：刷新成本（可选）→ 市场 → 建议价 → 审计，一条命令跑完。 */
async function cmdFlow() {
  const batch = arg('batch');
  if (!batch) throw new Error('缺少 --batch <批次目录>');

  if (has('refresh-costs')) {
    const quote = await fetchRiinQuote({
      styleCode: arg('style', 'MXTMC001'),
      craftType: num(arg('craft'), 1),
      cdp: arg('cdp'),
    });
    saveCosts(quote);
    console.log(`银河报价已刷新：${quote.style_code} ${fmt(quote.costs.bw_single, 2)}/${fmt(quote.costs.bw_double, 2)}、${fmt(quote.costs.color_single, 2)}/${fmt(quote.costs.color_double, 2)}（单面/双面，CNY）`);
  }

  const { stats } = marketBundle();
  const { specs, rows, severe } = collectAudit(batch, stats);

  console.log(`POD 定价流程  v${CONFIG.version}  锁定 ${CONFIG.locked_at || '-'}`);
  console.log(`固定费 ${fmt(FEES.fixed, 2)} MXN ${FEES.fixedScope === 'order' ? '按单' : '按件'} | 运费 售价×${pct(FEES.shipping, 0)} | 目标 ${TARGET.min}–${TARGET.max} 元/单，落点 ${TARGET.value} 元`);
  console.log(`成本 ${BASE_COSTS.source}${BASE_COSTS.fetched_at ? `（${BASE_COSTS.fetched_at.slice(0, 10)}）` : ''}`);
  console.log(`市场 ${stats.week}：基础单件 ${fmt(stats.basic.p25, 0)} / ${fmt(stats.basic.median, 0)} / ${fmt(stats.basic.p75, 0)}（p25/中位/p75）`);

  for (const file of specs) {
    const { spec } = loadSpec(file);
    for (const product of productsOf(spec)) {
      const plan = planForProduct(product, stats);
      const head = plan.rows[0];
      const two = head.multi.find((m) => m.qty === 2);
      const three = head.multi.find((m) => m.qty === 3);
      console.log(
        `  ${plan.key}（${plan.side === 'double' ? '双面' : '单面'}）：建议 ${head.value.price}，` +
          `余量 ${fmt(head.value.contribution_cny, 2)} 元/件；同价一单 2 件 ${fmt(two.contribution_cny, 2)} 元/件、3 件 ${fmt(three.contribution_cny, 2)} 元/件`,
      );
    }
  }

  const flagged = rows.filter((r) => r.flags.length);
  console.log(`审计：${rows.length} 个 SKU，${flagged.length} 个有标记，${severe ? '有亏损/缺价' : '无亏损/缺价'}`);
  for (const r of flagged.slice(0, 20)) console.log(`  ${r.product}/${r.color}: ${r.flags.join(',')}`);

  if (has('save')) {
    const out = path.join(path.resolve(batch), 'pricing-flow.json');
    fs.writeFileSync(out, JSON.stringify({
      schema: 'pod-pricing/flow@1',
      generated_at: new Date().toISOString(),
      policy: {
        config: CONFIG.file,
        version: CONFIG.version,
        locked_at: CONFIG.locked_at,
        fixed_scope: FEES.fixedScope,
        shipping_rate: FEES.shipping,
        target_cny: TARGET,
        round: ROUND,
      },
      costs: COSTS,
      cost_source: BASE_COSTS.source,
      cost_fetched_at: BASE_COSTS.fetched_at || null,
      fees: FEES,
      market: { week: stats.week, p25: stats.basic.p25, median: stats.basic.median, p75: stats.basic.p75 },
      rows,
    }, null, 2) + '\n');
    console.log(`已写入 ${out}`);
  }
  process.exit(severe ? 1 : 0);
}

function buildReport(specPath, plans, stats) {
  return {
    schema: 'pod-pricing/report@2',
    generated_at: new Date().toISOString(),
    spec: path.resolve(specPath),
    side_default: arg('side', 'single'),
    policy: {
      config: CONFIG.file,
      version: CONFIG.version,
      locked_at: CONFIG.locked_at,
      note: CONFIG.note,
      fixed_scope: FEES.fixedScope,
      shipping_rate: FEES.shipping,
      target_cny: TARGET,
      round: ROUND,
    },
    target_cny: TARGET,
    round: ROUND,
    costs: COSTS,
    cost_source: BASE_COSTS.source,
    cost_fetched_at: BASE_COSTS.fetched_at || null,
    fees: FEES,
    variable_rate: variableRate(FEES),
    market: {
      week: stats.week,
      source: stats.source,
      basic: {
        count: stats.basic.count,
        units: stats.basic.units,
        p25: stats.basic.p25,
        median: stats.basic.median,
        p75: stats.basic.p75,
        unit_weighted_avg: stats.basic.unit_weighted_avg,
      },
      packs: stats.packs,
    },
    products: plans.map((plan) => ({
      key: plan.key,
      side: plan.side,
      price: plan.priceMap,
      rows: plan.rows.map((r) => ({
        color: r.color,
        class: r.class,
        cost_cny: r.cost_cny,
        price_before: r.before,
        price_after: r.value.price,
        price_band: { at_target_min: r.min.price, at_target: r.value.price, at_target_max: r.max.price },
        contribution_mxn: r.value.contribution_mxn,
        contribution_cny: r.value.contribution_cny,
        margin_rate: r.value.margin_rate,
        market_percentile: r.position,
        multi: r.multi.map((m) => ({
          qty: m.qty,
          contribution_mxn_per_item: m.contribution_mxn,
          contribution_cny_per_item: m.contribution_cny,
        })),
      })),
    })),
    note: '条件余量；平台费/税/汇率/运费均为明示假设，不是结算后实收利润。',
  };
}

function cmdApply() {
  const specPath = arg('spec');
  const batch = arg('batch');
  if (!specPath && !batch) throw new Error('缺少 --spec <listing-spec.json> 或 --batch <批次目录>');
  const { stats } = marketBundle();
  const targets = batch ? scanBatch(batch) : [path.resolve(specPath)];
  if (!targets.length) throw new Error('没有找到 listing-spec.json：' + path.resolve(batch));
  const apply = has('apply');

  for (const file of targets) {
    const { spec } = loadSpec(file);
    const plans = productsOf(spec).map((p) => planForProduct(p, stats));
    const planMap = new Map(plans.map((p) => [p.key, p.priceMap]));
    const result = patchSpec(file, planMap, { apply });
    const report = buildReport(file, plans, stats);
    const reportPath = path.join(path.dirname(file), 'pricing-report.json');
    if (apply) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

    console.log(`\n${file}`);
    if (!result.changes.length) {
      console.log('  价格已是推荐值，无需改动。');
    } else {
      console.log(apply ? '  已写入：' : '  DRY_RUN（加 --apply 才写）：');
      for (const c of result.changes) {
        console.log(`    ${c.key}  price  ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
      }
    }
    console.log(apply ? `  报告：${reportPath}` : `  报告未落盘；加 --apply 后写入 ${reportPath}`);
  }
}

function help() {
  console.log(`POD 定价助手

  node cli.mjs riin      [--style MXTMC001] [--craft 1] [--save]
                          （读银河当前报价；--save 后 recommend/apply 自动使用）
  node cli.mjs market    [--market <rankings.json>] [--json]
  node cli.mjs quote     [--cost 15] [--price 70] [--target 2] [--side single] [--color bw]
  node cli.mjs recommend --spec <listing-spec.json> [--target 2] [--round 1] [--json]
  node cli.mjs apply     --spec <listing-spec.json> [--apply]
                          （或 --batch <批次目录>，一次改整批）
  node cli.mjs audit     --batch <批次目录>
  node cli.mjs flow      --batch <批次目录> [--refresh-costs] [--save]

口径锁定：config/pricing.json（固定费 6 MXN 按单、运费售价 6%、每单 1–3 元、取整 1 MXN）。
成本：优先读 data/costs/latest.json（银河报价快照），没有则黑白 15/17、四色 18.5/21 CNY。`);
}

const cmd = process.argv[2];
(async () => {
  try {
    if (cmd === 'riin') await cmdRiin();
    else if (cmd === 'market') cmdMarket();
    else if (cmd === 'quote') cmdQuote();
    else if (cmd === 'recommend') cmdRecommend();
    else if (cmd === 'apply') cmdApply();
    else if (cmd === 'audit') cmdAudit();
    else if (cmd === 'flow') await cmdFlow();
    else help();
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(2);
  }
})();
