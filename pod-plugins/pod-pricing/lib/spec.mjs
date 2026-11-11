/**
 * listing-spec.json 读写。
 * 只改 `price` 字段；price 支持 number 或 {default, <颜色>: 价格} 两种写法，
 * build-workbook.py 已按颜色 en 名取值、缺失回退 default。
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadSpec(file) {
  const p = path.resolve(file);
  return { file: p, spec: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

export function productsOf(spec) {
  if (Array.isArray(spec?.products)) return spec.products;
  if (spec?.slug) return [spec];
  return [];
}

export function colorsOf(product) {
  return (product?.colors || []).map((c) => c?.en).filter(Boolean);
}

export function currentPrice(product, color) {
  const p = product?.price;
  if (typeof p === 'number') return p;
  if (p && typeof p === 'object') {
    if (color && p[color] != null) return Number(p[color]);
    if (p.default != null) return Number(p.default);
  }
  return null;
}

export function colorClass(name) {
  return /^(negro|blanco|black|white)$/i.test(String(name || '').trim()) ? 'bw' : 'color';
}

/** 单款显式成本（CNY/件）。有它就不再按 T 恤黑白/彩色档推成本，裤子、卫衣、瑜伽服同样适口。 */
export function costOf(product) {
  for (const key of ['cost_cny', 'unit_cost_cny', 'cost']) {
    const v = product?.[key];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** 全黑白只写 default；有彩色才写逐色表。defaultPrice 用于「没有黑白款」时的回退。 */
export function buildPriceMap(product, bwPrice, colorPrice, defaultPrice = bwPrice) {
  const colors = colorsOf(product);
  if (!colors.length) return { default: bwPrice };
  if (!colors.some((c) => colorClass(c) === 'color')) return { default: bwPrice };
  const map = { default: defaultPrice };
  for (const c of colors) map[c] = colorClass(c) === 'bw' ? bwPrice : colorPrice;
  return map;
}

export function sideOf(product, fallback = 'single') {
  const s = product?.print?.side;
  return s === 'double' ? 'double' : s === 'single' ? 'single' : fallback;
}

export function patchSpec(file, plan, { apply = false } = {}) {
  const { spec } = loadSpec(file);
  const changes = [];
  for (const product of productsOf(spec)) {
    const key = product.slug || product.style || product.skuPrefix;
    const next = plan.get(key) || plan.get(product.style) || plan.get(product.slug);
    if (!next) continue;
    const before = product.price;
    if (JSON.stringify(before) === JSON.stringify(next)) continue;
    changes.push({ key, before, after: next });
    product.price = next;
  }
  if (apply && changes.length) {
    fs.writeFileSync(file, JSON.stringify(spec, null, 1) + '\n');
  }
  return { changes, applied: apply && changes.length > 0 };
}

export function scanBatch(batchDir) {
  const root = path.resolve(batchDir);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name === 'listing-spec.json') out.push(p);
    }
  };
  walk(root, 0);
  return out.sort();
}
