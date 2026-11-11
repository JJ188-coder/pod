#!/usr/bin/env node
/** 一次性探针：拦截模板下载请求。 */
import { listTabs, evalInTab } from './listing/zhanfu-bridge.mjs';

const pid = Number(process.argv[2] || 13562);
const { tabs } = await listTabs(pid);
const seller = tabs.find((t) => t.url.startsWith('https://seller-mx.tiktok.com'));
if (!seller) { console.log('NO_SELLER_TAB'); process.exit(1); }
const idx = seller.index;

await evalInTab(pid, idx, `(() => {
  window.__reqs = [];
  if (window.__hooked) return 'RESET';
  window.__hooked = true;
  const of = window.fetch;
  window.fetch = function(...a) {
    try {
      const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url);
      const o = a[1] || {};
      window.__reqs.push({ kind: 'fetch', url: String(u), method: o.method || 'GET', body: o.body ? String(o.body).slice(0, 2000) : null });
    } catch {}
    return of.apply(this, a);
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) { this.__m = m; this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b) { try { window.__reqs.push({ kind: 'xhr', method: this.__m, url: String(this.__u), body: b ? String(b).slice(0, 2000) : null }); } catch {} return os.apply(this, arguments); };
  return 'HOOKED';
})()`);

const clicked = await evalInTab(pid, idx, `(() => {
  const row = [...document.querySelectorAll('tr')].find(r => (r.innerText||'').includes('sales_information'));
  if (!row) return 'ROW_NOT_FOUND';
  const btn = [...row.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '下载');
  if (!btn) return 'BTN_NOT_FOUND';
  btn.click();
  return 'CLICKED';
})()`);
console.log('CLICK', clicked);
await new Promise((r) => setTimeout(r, 5000));
const raw = await evalInTab(pid, idx, `JSON.stringify((window.__reqs || []).filter(r => /\\/api\\//.test(r.url)).slice(-10))`);
console.log(raw.slice(0, 8000));
