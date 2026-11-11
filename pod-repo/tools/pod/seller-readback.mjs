#!/usr/bin/env node
/**
 * seller-readback.mjs — 从战斧里的 Seller Center 商品管理页读回商品 ID 与状态。
 * 只读，不点击导入/编辑/下架。
 *
 * 用法：node tools/pod/seller-readback.mjs --code CLOWN01 [--pid 13562] [--json]
 */
import { listTabs, evalInTab } from './listing/zhanfu-bridge.mjs';

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const code = arg('--code');
const pid = Number(arg('--pid', '13562'));
if (!code) { console.log(JSON.stringify({ ok: false, error: 'CODE_REQUIRED' })); process.exit(2); }

const tabs = await listTabs(pid);
const tab = tabs.tabs.find((t) => t.url.includes('seller-mx.tiktok.com'));
if (!tab) { console.log(JSON.stringify({ ok: false, error: 'NO_SELLER_TAB' })); process.exit(1); }

await evalInTab(pid, tab.index, 'location.assign("https://seller-mx.tiktok.com/product/manage?shop_region=MX");"nav"');
await new Promise((r) => setTimeout(r, 7000));

const statuses = ['在售', '审核中', '草稿'];
const found = [];
for (const status of statuses) {
  const click = `(()=>{const el=[...document.querySelectorAll(".core-tabs-header-title")].find(e=>(e.textContent||"").trim().startsWith(${JSON.stringify(status)}));if(!el)return "NO";el.click();return "OK"})()`;
  try { await evalInTab(pid, tab.index, click); } catch { continue; }
  await new Promise((r) => setTimeout(r, 3500));
  const expr = `(()=>{const lines=document.body.innerText.split("\\n").map(x=>x.trim()).filter(Boolean);const out=[];for(let i=0;i<lines.length;i++){if(/^ID:\\d+/.test(lines[i])){out.push({id:lines[i].slice(3),title:lines[i-1]||"",status:${JSON.stringify(status)}})}}return JSON.stringify(out)})()`;
  let rows = [];
  try { rows = JSON.parse(await evalInTab(pid, tab.index, expr)); } catch { rows = []; }
  // 用「款号前后不接字母数字」的边界匹配，避免 UKIYOE3 误命中 UKIYOE3B/UKIYOE3C。
  const codeRe = new RegExp(`(?<![A-Za-z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`);
  for (const row of rows) if (codeRe.test(row.title)) found.push(row);
}

const unique = [...new Map(found.map((r) => [r.id, r])).values()];
console.log(JSON.stringify({
  ok: unique.length > 0,
  code,
  found: unique.length,
  products: unique,
  note: unique.length > 1 ? '同款号出现多个商品，需人工确认哪个是本次导入' : '读自商品管理页 DOM',
}, null, 2));
process.exit(unique.length > 0 ? 0 : 1);
