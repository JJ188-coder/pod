/**
 * 银河（tshirt.riin.com）只读报价读取。
 *
 * 走本机 Chrome CDP，不新开浏览器、不读 Cookie 文件：
 *   1. /json/list 找到已登录的银河标签；
 *   2. Runtime.evaluate 在页面内用 localStorage.userInfo.token 调
 *      POST /trade/orderFunds/product/price（craftType=1 白墨烫画）；
 *   3. 过滤 styleCode，按颜色汇总原衣 + 单面/双面印花。
 *
 * 只读，不下单、不改价、不写平台。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const COST_DIR = path.join(PLUGIN_ROOT, 'data/costs');

const BW_RE = /^(black|white|negro|blanco)$/i;

function cdpBase(cdp) {
  return String(cdp || process.env.POD_CDP || 'http://127.0.0.1:9222').replace(/\/$/, '');
}

async function findRiinTarget(cdp) {
  let rows;
  try {
    rows = await (await fetch(`${cdpBase(cdp)}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
  } catch (error) {
    throw new Error(`CDP_UNAVAILABLE: ${cdpBase(cdp)}（先让 Chrome 以 --remote-debugging-port 启动）`);
  }
  const target = rows.find((r) => r.type === 'page' && r.url.includes('tshirt.riin.com'));
  if (!target) throw new Error('RIIN_TAB_MISSING：先打开并登录 https://tshirt.riin.com');
  return target;
}

function evaluate(wsUrl, expression, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP_TIMEOUT')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(msg.error.message || 'CDP_ERROR'));
      const result = msg.result?.result;
      if (result?.subtype === 'error') return reject(new Error(result.description || 'EVAL_ERROR'));
      resolve(result?.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP_WS_ERROR')); };
  });
}

/** 从接口返回的原始行里聚合每个颜色的成本；多尺码取最大值，避免低估。 */
export function normalizeQuote(payload, styleCode) {
  if (!payload || payload.error) throw new Error(payload?.error || 'RIIN_EMPTY');
  const list = Array.isArray(payload.list) ? payload.list : [];
  const rows = list.filter((x) => String(x.styleCode || '').toUpperCase() === styleCode.toUpperCase());
  if (!rows.length) throw new Error(`RIIN_STYLE_NOT_FOUND: ${styleCode}`);

  const byColor = new Map();
  for (const x of rows) {
    const color = String(x.colorCode || '').trim();
    if (!color) continue;
    const item = {
      color,
      size: x.sizeCode || null,
      original: Number(x.originalPrice),
      print_single: Number(x.printOnePrice),
      print_double: Number(x.printTwoPrice),
    };
    if (![item.original, item.print_single, item.print_double].every(Number.isFinite)) continue;
    const prev = byColor.get(color);
    if (!prev) byColor.set(color, { ...item });
    else {
      prev.original = Math.max(prev.original, item.original);
      prev.print_single = Math.max(prev.print_single, item.print_single);
      prev.print_double = Math.max(prev.print_double, item.print_double);
      if (item.size && !(prev.sizes || []).includes(item.size)) prev.sizes = [...(prev.sizes || []), item.size];
    }
  }
  const colors = [...byColor.values()].map((x) => ({
    ...x,
    class: BW_RE.test(x.color) ? 'bw' : 'color',
    total_single: +(x.original + x.print_single).toFixed(2),
    total_double: +(x.original + x.print_double).toFixed(2),
  }));
  if (!colors.length) throw new Error(`RIIN_PRICE_INVALID: ${styleCode}`);

  const bw = colors.filter((c) => c.class === 'bw');
  const colored = colors.filter((c) => c.class === 'color');
  const pick = (arr, key, fallback) => (arr.length ? Math.max(...arr.map((x) => x[key])) : fallback);
  const fallbackSingle = pick(colors, 'total_single');
  const fallbackDouble = pick(colors, 'total_double');
  return {
    style_code: rows[0].styleCode,
    style_name: rows[0].styleName || '',
    craft_type: rows[0].craftType ?? null,
    currency: rows[0].currencyType || 'CNY',
    colors,
    costs: {
      bw_single: pick(bw, 'total_single', fallbackSingle),
      bw_double: pick(bw, 'total_double', fallbackDouble),
      color_single: pick(colored, 'total_single', fallbackSingle),
      color_double: pick(colored, 'total_double', fallbackDouble),
    },
  };
}

export async function fetchRiinQuote({ styleCode = 'MXTMC001', craftType = 1, cdp } = {}) {
  const target = await findRiinTarget(cdp);
  const expression = `(async () => {
    const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
    if (!ui || !ui.token) return { error: 'NO_SESSION' };
    const H = { 'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest' };
    const r = await fetch('/trade/orderFunds/product/price', {
      method: 'POST', headers: H,
      body: JSON.stringify({ craftType: ${Number(craftType) || 1}, pageIndex: 1, pageSize: 2000 }),
    });
    const j = await r.json();
    return { code: j.code, msg: j.msg, total: j.data && j.data.total, list: (j.data && (j.data.list || j.data.records)) || [] };
  })()`;
  const payload = await evaluate(target.webSocketDebuggerUrl, expression);
  const quote = normalizeQuote(payload, styleCode);
  return { ...quote, source: `${cdpBase(cdp)} → /trade/orderFunds/product/price`, fetched_at: new Date().toISOString() };
}

/** 最新一次银河报价；没有就回退到代码默认值。 */
export function loadCosts() {
  const file = path.join(COST_DIR, 'latest.json');
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.costs) return { ...raw.costs, source: raw.source || file, fetched_at: raw.fetched_at || null };
    } catch { /* 损坏就回退默认值 */ }
  }
  return { bw_single: 15, bw_double: 17, color_single: 18.5, color_double: 21, source: '内置默认（2026-10-24 账户口径）', fetched_at: null };
}

export function saveCosts(quote) {
  fs.mkdirSync(COST_DIR, { recursive: true });
  const stamp = (quote.fetched_at || new Date().toISOString()).slice(0, 10);
  const file = path.join(COST_DIR, `${stamp}-${quote.style_code}.json`);
  const body = JSON.stringify(quote, null, 2) + '\n';
  fs.writeFileSync(file, body);
  fs.writeFileSync(path.join(COST_DIR, 'latest.json'), body);
  return file;
}
