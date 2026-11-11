/**
 * 市场价带：读 EchoTik 周榜（rankings.json / bundle.json），分出
 * 「基础单件 T 恤」「多件套」「长袖/卫衣等非同类」，给出分位价与销量分布。
 *
 * 口径提醒：avg_price 是商品均价，不是单件价；多件套必须换算到每件再比较。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { money, count } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');

const PACK_RE = /\b(pack|paquete|juego de|set de|conjunto|unidades|piezas|pzas|combo|multipiezas)\b/i;
const SINGLE_RE = /no es conjunto|venta por pieza|por pieza|pieza individual|precio por pieza/i;
const EXCLUDE_RE = /manga larga|sudadera|hoodie|fleece|deportiv|polo\b|henley|camisa\b|chaleco|chaqueta|pijama|kimono/i;
const TEE_RE = /playera|camiseta|t-?shirt|tee\b/i;

/** 显式路径优先；否则用插件内置的最新一期快照。 */
export function resolveMarket(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) throw new Error('MARKET_NOT_FOUND: ' + p);
    if (fs.statSync(p).isDirectory()) {
      for (const rel of ['rankings.json', 'export/bundle.json', 'bundle.json']) {
        const f = path.join(p, rel);
        if (fs.existsSync(f)) return f;
      }
      throw new Error('MARKET_FILE_NOT_FOUND: ' + p);
    }
    return p;
  }
  const dir = path.join(PLUGIN_ROOT, 'data/market');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
    : [];
  if (!files.length) throw new Error('MARKET_DEFAULT_MISSING：传 --market <rankings.json>');
  return path.join(dir, files[0]);
}

export function loadMarket(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.products || [];
  const products = [];
  for (const item of list) {
    const name = item.product_name || item.name || '';
    const avg = money(item.avg_price ?? item.avg_price_raw);
    if (!name || avg === null) continue;
    products.push({
      rank: Number(item.rank) || null,
      product_id: item.product_id || null,
      name,
      avg_price: avg,
      min_price: money(item.min_price ?? item.min_price_raw),
      max_price: money(item.max_price ?? item.max_price_raw),
      units: count(item.sale_cnt ?? item.sale_cnt_raw ?? 0),
      seller: item.seller?.seller_name || item.seller || '',
    });
  }
  return {
    file,
    week: raw.week || path.basename(file, '.json'),
    currency: raw.currency || 'MXN',
    products,
  };
}

/** 件数：`Pack 3` / `3 piezas` / `3 unidades` → 3；`par` → 2；只有 pack 字样无数字 → null。
 *  标题明确写「按件卖 / 不是套装」时优先按单件处理，避免把 No es conjunto 误判成套。 */
export function packCount(name) {
  const t = String(name);
  if (SINGLE_RE.test(t)) return 1;
  const m = t.match(/(\d)\s*(?:pack|piezas|unidades|pzas)/i);
  if (m) return Number(m[1]);
  if (/\b(par|pareja)\b/i.test(t)) return 2;
  if (PACK_RE.test(t)) return null;
  return 1;
}

export function classify(name) {
  const pack = packCount(name);
  return {
    pack: pack !== 1,
    pack_count: pack,
    tee: TEE_RE.test(name),
    excluded: EXCLUDE_RE.test(name),
  };
}

export function stats(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const at = (f) => a[Math.min(Math.floor((a.length - 1) * f), a.length - 1)];
  return {
    n: a.length,
    min: a[0],
    max: a[a.length - 1],
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
  };
}

export function percentileRank(prices, price) {
  if (!prices?.length || !Number.isFinite(price)) return null;
  return prices.filter((p) => p <= price).length / prices.length;
}

/**
 * 基础单件 T 恤：标题是 T 恤、不是多件套、不是长袖/卫衣/运动服，且均价 <= basicMax。
 * 250 MXN 以上多是品牌/设计师款，混进来会把中位数抬高，默认切在 200。
 */
export function analyze(market, { basicMax = 200 } = {}) {
  const basic = [];
  const packs = [];
  let unitsTotal = 0;
  for (const p of market.products) {
    const c = classify(p.name);
    unitsTotal += p.units || 0;
    if (c.tee && !c.pack && !c.excluded && p.avg_price <= basicMax) basic.push({ ...p, ...c });
    if (c.pack && c.pack_count) packs.push({ ...p, ...c, per_piece: p.avg_price / c.pack_count });
  }

  const basicStats = stats(basic.map((p) => p.avg_price));
  const basicUnits = basic.reduce((s, p) => s + (p.units || 0), 0);
  const weighted = basicUnits
    ? basic.reduce((s, p) => s + p.avg_price * (p.units || 0), 0) / basicUnits
    : null;

  const bands = [
    [0, 70], [70, 85], [85, 100], [100, 120], [120, 150], [150, 200],
  ].map(([lo, hi]) => {
    const rows = basic.filter((p) => p.avg_price >= lo && p.avg_price < hi);
    const units = rows.reduce((s, p) => s + (p.units || 0), 0);
    return { lo, hi, n: rows.length, units, share: basicUnits ? units / basicUnits : 0 };
  });

  const packStats = stats(packs.map((p) => p.per_piece));
  return {
    week: market.week,
    source: market.file,
    currency: market.currency || 'MXN',
    products: market.products.length,
    units_total: unitsTotal,
    basic: basicStats
      ? { ...basicStats, units: basicUnits, unit_weighted_avg: weighted, count: basic.length }
      : null,
    packs: packStats
      ? { ...packStats, count: packs.length, units: packs.reduce((s, p) => s + p.units, 0) }
      : null,
    bands,
    anchors: basicStats
      ? { volume: basicStats.p25, balanced: basicStats.median, margin: basicStats.p75 }
      : null,
    top: basic.slice().sort((a, b) => b.units - a.units).slice(0, 10),
    basic_prices: basic.map((p) => p.avg_price).sort((a, b) => a - b),
  };
}
