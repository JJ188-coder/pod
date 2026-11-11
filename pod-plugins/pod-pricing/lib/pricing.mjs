/**
 * 单件条件利润模型。默认值来自项目已核口径：
 *   汇率 0.36 CNY/MXN（2026-11-10 按市场 1 CNY=2.777 MXN 校正）；佣金 6%；SFP 8%（每件封顶 40 MXN）；
 *   IVA 8% 与 ISR 2.5% 按 P/1.16 代扣；固定服务费 6 MXN；运费按售价 6%。
 *
 * 输出是「条件余量」，不是平台结算后的实收利润。未知费用不按 0。
 */

export const DEFAULT_FEES = {
  fx: 0.36,
  commission: 0.06,
  sfp: 0.08,
  sfpCap: 40,
  iva: 0.08,
  isr: 0.025,
  fixed: 6,
  /** 固定费作用域：order = 整单一次；item = 每件一次。2026-11-04 用户锁定为按单。 */
  fixedScope: 'order',
  shipping: 0.06,
};

/** 账户组件报价：黑白 13+2 / 13+4；其他四色 16+2.5 / 16+5。 */
export const DEFAULT_COSTS = {
  bw_single: 15,
  bw_double: 17,
  color_single: 18.5,
  color_double: 21,
};

/** 起量阶段默认每单目标利润 1–3 元，落点 2 元。 */
export const DEFAULT_TARGET = { min: 1, value: 2, max: 3 };

export function variableRate(fees = DEFAULT_FEES) {
  return fees.commission + fees.sfp + (fees.iva + fees.isr) / 1.16 + fees.shipping;
}

/**
 * 单件条件利润。qty 只影响固定费与分摊：
 *   fixedScope=order 时整单只扣一次 6 MXN，多件会把固定费摊薄；
 *   fixedScope=item 时每件都扣 6 MXN。
 * 返回里 contribution_mxn / contribution_cny 始终是「每件」，另给订单合计。
 */
export function quote(price, costCny, fees = DEFAULT_FEES, qty = 1) {
  const n = Math.max(1, Number(qty) || 1);
  const revenue = price * n;
  const commission = revenue * fees.commission;
  const sfp = Math.min(price * fees.sfp, fees.sfpCap) * n;
  const net = revenue / 1.16;
  const iva = net * fees.iva;
  const isr = net * fees.isr;
  const shipping = revenue * fees.shipping;
  const goodsTotal = (costCny / fees.fx) * n;
  const fixed = fees.fixedScope === 'item' ? fees.fixed * n : fees.fixed;
  const contributionTotal = revenue - commission - sfp - iva - isr - shipping - fixed - goodsTotal;
  const contributionPerItem = contributionTotal / n;
  return {
    price,
    qty: n,
    cost_cny: costCny,
    cost_mxn: costCny / fees.fx,
    goods_total_mxn: goodsTotal,
    revenue_mxn: revenue,
    commission,
    sfp,
    iva,
    isr,
    shipping,
    fixed,
    fixed_scope: fees.fixedScope === 'item' ? 'item' : 'order',
    fee_total: commission + sfp + iva + isr + shipping + fixed,
    contribution_mxn: contributionPerItem,
    contribution_cny: contributionPerItem * fees.fx,
    contribution_total_mxn: contributionTotal,
    contribution_total_cny: contributionTotal * fees.fx,
    margin_rate: revenue ? contributionTotal / revenue : null,
    sfp_capped: price * fees.sfp > fees.sfpCap,
  };
}

/** 反解：给定成本与目标余量（CNY/单），需要多少售价。 */
export function priceForTarget(costCny, targetCny, fees = DEFAULT_FEES) {
  const rate = variableRate(fees);
  return (costCny / fees.fx + fees.fixed + targetCny / fees.fx) / (1 - rate);
}

export function roundPrice(value, mode = '1') {
  if (mode === '9') return Math.ceil((value - 9) / 10) * 10 + 9;
  if (mode === '5') return Math.ceil(value / 5) * 5;
  if (mode === '0') return Math.round(value * 100) / 100;
  return Math.ceil(value);
}

/**
 * 一个成本点 → 保本价 + 1/2/3 元三档建议价。
 * 余额目标按人民币，售价按 MXN，中间用 fx 换算。
 */
export function recommendCost(costCny, opts = {}) {
  const fees = opts.fees || DEFAULT_FEES;
  const target = opts.target || DEFAULT_TARGET;
  const round = opts.round || '1';
  const at = (cny) => {
    const raw = priceForTarget(costCny, cny, fees);
    const price = roundPrice(raw, round);
    return { target_cny: cny, raw_price: raw, ...quote(price, costCny, fees, 1) };
  };
  const breakEvenRaw = priceForTarget(costCny, 0, fees);
  const value = at(target.value);
  // 按单固定费时，多件订单的每件余量会更高；这里给出同一售价下的参考。
  const multi = [2, 3].map((qty) => ({ qty, ...quote(value.price, costCny, fees, qty) }));
  return {
    cost_cny: costCny,
    break_even_raw: breakEvenRaw,
    break_even: roundPrice(breakEvenRaw, '0'),
    min: at(target.min),
    value,
    max: at(target.max),
    multi,
    variable_rate: variableRate(fees),
  };
}

export function parseTarget(argvNum, base = DEFAULT_TARGET) {
  const value = argvNum('target', base.value);
  const min = argvNum('target-min', Math.min(base.min, value));
  const max = argvNum('target-max', Math.max(base.max, value));
  return { min, value, max };
}
