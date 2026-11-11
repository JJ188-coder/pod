/** 共享小工具：参数、数字、格式化。保持无依赖，Node 22+。 */

export function has(name) {
  return process.argv.includes('--' + name);
}

export function arg(name, fallback = null) {
  const argv = process.argv;
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return fallback;
  return v;
}

export function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 "MX$85.07" / 85.07 / "1,234.5" 为数字；解析不了返回 null，不当 0。 */
export function money(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 解析 EchoTik 展示销量："2541" / "2.7万" / "1.2万+"。 */
export function count(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const s = String(value).trim();
  if (s.includes('万')) return Number(s.replace(/[^\d.]/g, '')) * 10000;
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toFixed(digits);
}

export function pct(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return (n * 100).toFixed(digits) + '%';
}

export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
