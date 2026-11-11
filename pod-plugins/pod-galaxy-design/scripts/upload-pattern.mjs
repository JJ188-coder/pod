#!/usr/bin/env node
/**
 * upload-pattern.mjs — 把单张图案上传进银河设计编辑器（默认不保存）
 *
 * 实测结论（2026-11-01）：
 *   · 页面内 DataTransfer 拖放 / CDP Input.dispatchDragEvent / 文件选择器 三种方式都不会触发上传；
 *   · 唯一稳定通道是 **ClipboardEvent('paste') + DataTransfer 携带 File**，会真实发出
 *     COS PUT 与 /pod/gallery/image/add 请求，并把图落到当前印面。
 *
 * 因此本脚本只用 paste 通道，并在动作后核画布 W/H，避免「请求成功但没落板」被当成通过。
 *
 * 用法：
 *   node upload-pattern.mjs --image <png> [--name JCxxx-F.png] [--save] [--target <cdpId>]
 *
 * 默认 --save 关闭：只上传并落板，不产生银河设计对象。加 --save 才会点“保存商品”。
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const CDP_LIST = 'http://127.0.0.1:9222/json/list';
const GALAXY = 'https://tshirt.riin.com';
const DESIGN_HASH = '#/shop/goodsManagement/localDesign/index';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const fail = (error, code = 1, extra = {}) => {
  console.log(JSON.stringify({ok: false, error, ...extra}, null, 2));
  process.exit(code);
};

function repoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'tools', 'pod', 'chrome-page.mjs'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const AREA_CM = {
  S: [31.68, 49.28], M: [32.4, 50.4], L: [33.12, 51.52],
  XL: [33.84, 52.64], '2XL': [34.92, 54.32], '3XL': [36.0, 56.0],
};
const PX_PER_CM = 59.0553;

/** 只读：按 designerTaskId 读回每尺码印面尺寸，算铺满率。 */
async function checkFill(page, taskId) {
  return page.evaluate(async ({taskId, area, pxPerCm}) => {
    const ui = JSON.parse(localStorage.getItem('userInfo') || 'null');
    if (!ui?.token) return {error: 'NO_SESSION'};
    const H = {'Content-Type': 'application/json', Authorization: String(ui.token), 'X-Time-Zone': 'UTC+8', 'X-Requested-With': 'XMLHttpRequest'};
    const all = [];
    let total = null;
    for (let p = 1; p <= 6; p += 1) {
      const r = await fetch('/trade/design/page', {method: 'POST', headers: H, body: JSON.stringify({pageIndex: p, pageSize: 100})});
      const j = await r.json();
      const d = j.data || {};
      const rec = d.records || [];
      if (total === null && typeof d.total === 'number') total = d.total;
      if (!rec.length) break;
      all.push(...rec);
      if (total !== null && all.length >= total) break;
    }
    const it = all.find((x) => String(x.designerTaskId) === String(taskId));
    if (!it) return {found: false, scanned: all.length, total, error: 'DESIGN_NOT_FOUND'};
    const perSize = {};
    for (const s of it.skuList || []) {
      const face = (s.factoryImageList || [])[0];
      if (!face) continue;
      const size = s.sizeCode;
      const cm = [face.imageWidth / pxPerCm, face.imageHeight / pxPerCm];
      const a = area[size];
      perSize[size] = {
        cm: cm.map((v) => +v.toFixed(2)),
        area: a || null,
        fill_pct: a ? [+(cm[0] / a[0] * 100).toFixed(1), +(cm[1] / a[1] * 100).toFixed(1)] : null,
      };
    }
    return {
      found: true,
      design_id: String(it.id),
      group_id: String(it.groupId),
      material_codes: it.materialImageCodes,
      created_at: it.createTime,
      sku_rows: (it.skuList || []).length,
      per_size: perSize,
      all_full: Object.keys(perSize).length > 0 && Object.values(perSize).every((v) => v.fill_pct && v.fill_pct[0] >= 99 && v.fill_pct[1] >= 99),
    };
  }, {taskId, area: AREA_CM, pxPerCm: PX_PER_CM});
}

const checkOnly = arg('--check');
if (checkOnly) {
  const checkRoot = repoRoot();
  if (!checkRoot) fail('REPO_ROOT_NOT_FOUND', 2);
  const listRows = await (await fetch(CDP_LIST, {signal: AbortSignal.timeout(3000)})).json();
  const t = listRows.find((r) => r?.type === 'page' && (() => { try { const u = new URL(r.url); return u.origin === GALAXY && u.hash.split('?')[0] === DESIGN_HASH; } catch { return false; } })());
  if (!t) fail('GALAXY_DESIGN_TAB_MISSING');
  const {exactChromePage: open} = await import(pathToFileURL(path.join(checkRoot, 'tools/pod/chrome-page.mjs')).href);
  const {browser: b2, page: p2} = await open({targetId: t.id, origin: GALAXY, hashPath: DESIGN_HASH});
  try {
    const r = await checkFill(p2, checkOnly);
    console.log(JSON.stringify({ok: r.found && r.all_full, ...r}, null, 2));
    process.exit(r.found && r.all_full ? 0 : 1);
  } finally { try { await b2.close(); } catch {} }
}

const image = arg('--image');
if (!image) fail('IMAGE_REQUIRED', 2);
if (!fs.existsSync(image)) fail('IMAGE_NOT_FOUND', 2);
const name = arg('--name', path.basename(image));
if (!/\.png$/i.test(name)) fail('PNG_NAME_REQUIRED', 2);
const save = process.argv.includes('--save');

const root = repoRoot();
if (!root) fail('REPO_ROOT_NOT_FOUND', 2);

const rows = await (await fetch(CDP_LIST, {signal: AbortSignal.timeout(3000)})).json();
const targets = rows.filter((r) => {
  if (r?.type !== 'page') return false;
  try {
    const u = new URL(r.url);
    return u.origin === GALAXY && u.hash.split('?')[0] === DESIGN_HASH;
  } catch { return false; }
});
if (!targets.length) fail('GALAXY_DESIGN_TAB_MISSING');
const targetId = arg('--target', targets[0].id);
if (!targets.some((t) => t.id === targetId)) fail('TARGET_NOT_A_DESIGN_TAB');

const {exactChromePage} = await import(pathToFileURL(path.join(root, 'tools/pod/chrome-page.mjs')).href);
const b64 = fs.readFileSync(image).toString('base64');
const {browser, page} = await exactChromePage({targetId, origin: GALAXY, hashPath: DESIGN_HASH});

try {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button,a,span,div')]
      .filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '设计')[0];
    if (el) el.click();
  });
  await page.waitForTimeout(3000);
  const dlg = page.locator('.el-dialog').filter({has: page.locator('input[placeholder="请输入款号"]')}).first();
  const input = dlg.locator('input[placeholder="请输入款号"]');
  if ((await input.count()) !== 1) fail('STYLE_DIALOG_MISSING');
  await input.fill('MXTMC001');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2800);
  await dlg.getByText('MXTMC001', {exact: true}).last().click();
  await page.waitForTimeout(10000);

  const frame = page.frames().find((f) => f.url().startsWith('https://design.riin.com/editor'));
  if (!frame) fail('EDITOR_MISSING');

  const taskId = await frame.evaluate(() => {
    try {
      const p = document.querySelector('#app').__vue_app__._context.config.globalProperties.$pinia;
      for (const k of p._s.keys()) {
        const s = p._s.get(k);
        if (s?.currentGoods?.taskId) return String(s.currentGoods.taskId);
      }
    } catch {}
    return null;
  });

  const uploads = [];
  page.on('request', (r) => {
    if (/gallery\/image\/add/.test(r.url())) uploads.push(r.url());
  });

  const pasted = await frame.evaluate(async ({b64, name}) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], name, {type: 'image/png'});
    const dt = new DataTransfer();
    dt.items.add(file);
    const box = document.querySelector('.upload-box');
    if (!box) return {ok: false, reason: 'NO_UPLOAD_BOX'};
    box.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: dt}));
    return {ok: true, bytes: file.size};
  }, {b64, name});
  if (!pasted.ok) fail(pasted.reason);

  const readGeometry = () => frame.evaluate(() => {
    const nums = [...document.querySelectorAll('input.arco-input')].map((i) => i.value);
    const labels = [...document.querySelectorAll('*')]
      .filter((e) => e.childElementCount === 0 && /\.png/.test((e.textContent || '').trim()))
      .map((e) => e.textContent.trim());
    return {inputs: nums.slice(0, 4), layerLabels: labels.slice(0, 4)};
  });

  // 大图解码慢：最多等 60s，画布没落板就不保存，避免生成 0 SKU 的空设计对象。
  let geometry = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(5000);
    geometry = await readGeometry();
    const w = Number(String(geometry.inputs[2] ?? '0'));
    const h = Number(String(geometry.inputs[3] ?? '0'));
    if (w > 0 && h > 0) break;
  }
  if (!(Number(String(geometry?.inputs[2] ?? '0')) > 0 && Number(String(geometry?.inputs[3] ?? '0')) > 0)) {
    fail('CANVAS_NOT_LANDED', 1, { canvas: geometry, note: '画布未落板，已停止且未保存' });
  }

  let saved = null;
  if (save) {
    const respP = page.waitForResponse((q) => {
      try {
        const u = new URL(q.url());
        return u.origin === 'https://design.riin.com' && u.pathname.endsWith('/designer/task/result/save');
      } catch { return false; }
    }, {timeout: 60000});
    await frame.locator('button:has-text("保存商品")').first().click();
    const resp = await respP;
    saved = {status: resp.status(), body: (await resp.json().catch(() => ({})))};
  } else {
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('.el-dialog__headerbtn')) {
        const ov = b.closest('.el-overlay');
        if (ov && ov.getClientRects().length) b.click();
      }
    });
    await page.waitForTimeout(2500);
  }

  const landed = Number(String(geometry.inputs[2] ?? '0')) > 0 && Number(String(geometry.inputs[3] ?? '0')) > 0;
  // 用户要求：图案要铺满印区，不能出小图。保存后按尺码核实际覆盖。
  const fill = save ? await checkFill(page, taskId) : null;
  console.log(JSON.stringify({
    ok: landed && (uploads.length > 0 || saved?.body?.success === true) && (fill ? fill.all_full === true : true),
    target: targetId,
    task_id: taskId,
    image: {name, bytes: Buffer.byteLength(b64, 'base64')},
    upload_requests: uploads.length,
    paste: pasted,
    canvas: geometry,
    saved,
    saved_object_created: Boolean(saved?.body?.success),
    fill,
  }, null, 2));
  if (fill && !fill.all_full) {
    console.error('FILL_CHECK_FAILED: 有尺码未铺满印区，见 fill.per_size');
    process.exitCode = 1;
  }
} catch (error) {
  fail('UPLOAD_FAILED', 1, {detail: String(error.message || error).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 180)});
} finally {
  try { await browser.close(); } catch {}
}
