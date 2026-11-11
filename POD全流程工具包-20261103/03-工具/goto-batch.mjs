#!/usr/bin/env node
/**
 * 重载批量发布页（清掉上一份表残留的错误横幅）。
 * 用法：node goto-batch.mjs <PID>
 * 退出码 0 = 页面已就绪；1 = 找不到卖家标签页。
 */
import { listTabs, evalInTab } from './zhanfu-bridge.mjs';

const PID = Number(process.argv[2]);
if (!Number.isInteger(PID) || PID <= 0) {
  console.error('用法: node goto-batch.mjs <站斧主进程PID>');
  process.exit(2);
}
const URL = 'https://seller-mx.tiktok.com/product/batch/publish?shop_region=MX';
const { tabs } = await listTabs(PID);
const t = tabs.find((x) => x.url.includes('/product/batch'))
  || tabs.find((x) => x.url.includes('/product/manage'));
if (!t) { console.error('NO_SELLER_TAB'); process.exit(1); }
await evalInTab(PID, t.index, `location.assign(${JSON.stringify(URL)});'nav'`);
await new Promise((r) => setTimeout(r, 9000));
const after = await listTabs(PID);
const cur = after.tabs.find((x) => x.index === t.index);
console.log(JSON.stringify({ tab: t.index, url: cur ? cur.url.slice(0, 100) : null }));
