#!/usr/bin/env node
/**
 * chrome-page.mjs — 按 CDP target id 精确绑定一个已打开的 Chrome 页面。
 *
 * 只连接、不改浏览器：browser.close() 只断开本进程的 CDP 连接，不关闭用户的标签。
 * 用法（被 galaxy 脚本调用）：
 *   const { browser, page } = await exactChromePage({ targetId, origin, hashPath });
 */
import { chromium } from 'playwright-core';

const CDP = process.env.POD_CDP || 'http://127.0.0.1:9222';

export async function exactChromePage({ targetId, origin, hashPath, timeoutMs = 15000 }) {
  if (!targetId) throw new Error('TARGET_ID_REQUIRED');
  let rows;
  try {
    rows = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
  } catch (error) {
    throw new Error(`CDP_UNAVAILABLE: ${CDP} (${String(error.message || error).slice(0, 80)})`);
  }
  const row = rows.find((r) => r?.type === 'page' && r.id === targetId);
  if (!row) throw new Error(`TARGET_NOT_FOUND: ${targetId}`);

  let url;
  try { url = new URL(row.url); } catch { throw new Error('TARGET_URL_INVALID'); }
  if (origin && url.origin !== origin) throw new Error(`TARGET_ORIGIN_MISMATCH: ${url.origin}`);
  if (hashPath && url.hash.split('?')[0] !== hashPath) throw new Error(`TARGET_HASH_MISMATCH: ${url.hash.split('?')[0]}`);

  const browser = await chromium.connectOverCDP(CDP, { timeout: timeoutMs });
  const contexts = browser.contexts();
  let page = null;
  for (const context of contexts) {
    for (const candidate of context.pages()) {
      const session = await context.newCDPSession(candidate);
      try {
        const info = await session.send('Target.getTargetInfo');
        if (info?.targetInfo?.targetId === targetId) { page = candidate; break; }
      } finally {
        await session.detach().catch(() => {});
      }
    }
    if (page) break;
  }
  if (!page) {
    await browser.close().catch(() => {});
    throw new Error(`TARGET_PAGE_NOT_ATTACHED: ${targetId}`);
  }
  return { browser, page, context: page.context() };
}
