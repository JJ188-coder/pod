#!/usr/bin/env node
/**
 * riin-design-batch.mjs — 在 RIIN 商品管理里逐款走「设计」流程：
 * 选款号 MXTMC001 → 解析编码 → 设计器粘贴生产图 → 保存商品 → 读回 SKU 映射。
 *
 * 用法：node tools/pod/riin-design-batch.mjs <manifest.json>
 * manifest: [{ code, productId, pattern }]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const manifestPath = path.resolve(process.argv[2] || '');
if (!fs.existsSync(manifestPath)) { console.log(JSON.stringify({ ok: false, error: 'MANIFEST_REQUIRED' })); process.exit(2); }
const items = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().includes('tshirt.riin.com'));
if (!page) { console.log(JSON.stringify({ ok: false, error: 'RIIN_TAB_MISSING' })); process.exit(1); }

const results = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openGoodsAndDesign(productId) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { for (const b of document.querySelectorAll('.el-dialog__headerbtn')) b.click(); }).catch(() => {});
  await wait(600);
  await page.goto('https://tshirt.riin.com/#/shop/goodsManagement/goods/index', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(4000);
  const casc = page.locator('.re-search-v2-cascader .el-cascader').first();
  await casc.click();
  await wait(500);
  await page.locator('.el-cascader-node').filter({ hasText: /^TIKTOK$/ }).first().click();
  await wait(400);
  await page.locator('.el-cascader-node').filter({ hasText: /shop-a/ }).first().click();
  await wait(400);
  await page.getByRole('button', { name: '搜索', exact: true }).first().click();
  await wait(5000);
  const row = page.locator('tr').filter({ hasText: productId }).first();
  if (!(await row.count())) throw new Error('GOODS_ROW_NOT_FOUND');
  await row.getByText('设计', { exact: true }).first().click();
  await wait(1800);
  // 已设计过的 SPU 会弹「重新设计将覆盖」确认框
  const confirmed = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.el-message-box button, .el-message-box__btns button')];
    const ok = btns.find((b) => (b.textContent || '').trim() === '确定');
    if (ok) { ok.click(); return true; }
    return false;
  });
  if (confirmed) await wait(2500);
  await wait(1200);
  const dlg = page.locator('.el-dialog').filter({ hasText: '选择款号' }).first();
  const input = dlg.locator('input[placeholder="请输入款号"]').first();
  await input.fill('MXTMC001');
  await input.press('Enter');
  await wait(1500);
  const item = dlg.locator('.product-item').filter({ hasText: 'MXTMC001' }).first();
  if (await item.count()) await item.click();
  await wait(800);
  for (let i = 0; i < 2; i += 1) {
    const btn = dlg.getByRole('button', { name: '下一步', exact: true });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ force: true });
    await wait(3000);
  }
}

async function findEditor() {
  for (let i = 0; i < 25; i += 1) {
    const frames = page.frames().filter((f) => f.url().startsWith('https://design.riin.com/editor'));
    if (frames.length) return frames[frames.length - 1];
    await wait(1000);
  }
  return null;
}

for (const item of items) {
  const started = Date.now();
  try {
    await openGoodsAndDesign(item.productId);
    const frame = await findEditor();
    if (!frame) throw new Error('EDITOR_MISSING');
    const b64 = fs.readFileSync(item.pattern).toString('base64');
    const pasted = await frame.evaluate(async ({ b64, name }) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
      const file = new File([u8], name, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const box = document.querySelector('.upload-box');
      if (!box) return { ok: false, reason: 'NO_UPLOAD_BOX' };
      box.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      return { ok: true, bytes: file.size };
    }, { b64, name: `${item.code}-F.png` });
    if (!pasted.ok) throw new Error(pasted.reason || 'PASTE_FAILED');

    let geometry = null;
    for (let i = 0; i < 15; i += 1) {
      await wait(4000);
      geometry = await frame.evaluate(() => {
        const nums = [...document.querySelectorAll('input.arco-input')].map((x) => x.value);
        return { inputs: nums.slice(0, 4) };
      });
      if (Number(geometry.inputs[2] || 0) > 0 && Number(geometry.inputs[3] || 0) > 0) break;
    }
    if (!(Number(geometry?.inputs[2] || 0) > 0 && Number(geometry?.inputs[3] || 0) > 0)) throw new Error('CANVAS_NOT_LANDED');

    const saveP = page.waitForResponse((r) => r.url().includes('/designer/task/result/save'), { timeout: 90000 }).catch(() => null);
    await frame.locator('button:has-text("保存商品")').first().click();
    const saveResp = await saveP;
    if (!saveResp || saveResp.status() !== 200) throw new Error(`SAVE_FAILED_${saveResp ? saveResp.status() : 'NO_RESPONSE'}`);
    await wait(5000);

    const rows = await page.evaluate(async ({ productId }) => {
      const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
      const H = { 'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest' };
      const r = await fetch('/trade/goods/detail/spuId/factoryId/v2', { method: 'POST', headers: H, body: JSON.stringify({ spuId: productId, factoryId: '10001' }) });
      const j = await r.json();
      return (j.data || []).map((s) => ({ skuCode: s.skuCode, styleCode: s.styleCode, colorCode: s.colorCode, sizeCode: s.sizeCode, imageCode: s.imageCode, productCode: s.productCode, mappingState: s.mappingState, mappingCode: s.mappingCode }));
    }, { productId: item.productId });

    const mapped = rows.length > 0 && rows.every((r) => r.mappingState === true);
    results.push({ code: item.code, ok: mapped, rows: rows.length, mapped, duration_ms: Date.now() - started, sample: rows[0] || null });
  } catch (error) {
    results.push({ code: item.code, ok: false, error: String(error.message || error).slice(0, 200), duration_ms: Date.now() - started });
  }
}

const reportPath = path.join(path.dirname(manifestPath), `riin-design-report-${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
console.log(JSON.stringify({ ok: results.every((r) => r.ok), report: reportPath, results }, null, 2));
await browser.close();
