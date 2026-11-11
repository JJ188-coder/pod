#!/usr/bin/env node
/**
 * 批量上架插件主入口（TikTok Shop MX，站斧原浏览器 + 自有图床 URL）。
 *
 * 与旧的媒体中心路线相比只换了一处：图片列填自有域名的公网直链，不再上传媒体中心。
 * 其余环节沿用已实测通道：/excel/analysis 与 /excel/pre_check 可直连；导入必须由页面
 * 自身按钮触发（直连 publish 会被 12052588 页面版本闸门拒）。
 *
 * 阶段（默认只跑到 precheck，任何写平台的动作都要显式 --confirm-import）：
 *   plan     校验 spec + 图片 URL（HEAD/GET、类型、≤5MB、尺寸、主图 3:4~4:3）
 *   build    用官方模板生成 xlsx
 *   precheck analysis + pre_check（不建商品）
 *   import   页面注入 xlsx → 等「N 款商品准备就绪」→ 点导入 → 读回商品 ID
 *   verify   按标题片段读回商品（ID/状态/价格/SKU 数）
 *   deactivate 按下架 API 下架并回读状态（默认不下架）
 *
 * 用法：
 *   node tools/pod/listing/publish.mjs --spec spec.json --stage plan
 *   node tools/pod/listing/publish.mjs --spec spec.json --stage import --confirm-import
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { listTabs, evalInTab, serveLocalFiles, SELLER_ORIGIN } from './zhanfu-bridge.mjs';
import { analyseXlsx, preCheckXlsx } from './seller-batch-api.mjs';
import { hostImages, verifyAll } from './images.mjs';
import { validateMediaSpec } from './media-check.mjs';

const ROOT = path.resolve(new URL('../../../', import.meta.url).pathname); // 仓库根
const DEFAULT_TEMPLATE = 'project/T恤/批次/B20261026-NODE-WORKFLOW-01/官方模板/Tiktoksellercenter_男装与男士内衣_20261027_男士T恤_template.xlsx';
const BATCH_PUBLISH = 'https://seller-mx.tiktok.com/product/batch/publish?entry-from=batch&shop_region=MX&step=2';
const MANAGE = 'https://seller-mx.tiktok.com/product/manage?shop_region=MX';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function args() {
  const a = process.argv.slice(2);
  const get = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const has = (k) => a.includes('--' + k);
  return {
    spec: get('spec'), stage: get('stage', 'plan'), pid: Number(get('pid', 0)) || null,
    template: get('template') || process.env.POD_TEMPLATE || null, out: get('out'), host: get('host', 'static'),
    baseUrl: get('base-url'), prefix: get('prefix'), title: get('title'), id: get('id'),
    siteDir: get('site-dir'), project: get('project', 'pod-images'),
    confirmImport: has('confirm-import'), confirmDeactivate: has('confirm-deactivate'),
  };
}

/** 找到本站店铺实例与批量发布标签页；不猜 PID，不跨店铺。 */
export async function resolveShop(pid) {
  const pids = pid ? [pid] : await discoverShopPids();
  for (const p of pids) {
    const { windowName, tabs } = await listTabs(p);
    const seller = tabs.filter((t) => t.url.startsWith(SELLER_ORIGIN));
    if (!seller.length) continue;
    const batch = seller.find((t) => t.url.includes('/product/batch/publish')) || seller.find((t) => t.url.includes('/product/batch'));
    return { pid: p, shop: windowName, tabs: seller, batchTab: batch?.index ?? null };
  }
  throw Error('NO_SELLER_TAB_FOUND');
}

async function discoverShopPids() {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return out.split('\n')
    .filter((l) => l.includes('zhanfubrowser.app/Contents/MacOS/zhanfubrowser'))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** 复用已有 seller 标签；没有就用本店的批量页标签导航过去，绝不新开会碰别的店铺的窗口。 */
async function ensureTab(pid, url, match) {
  const { tabs } = await listTabs(pid);
  const seller = tabs.filter((t) => t.url.startsWith(SELLER_ORIGIN));
  const hit = seller.find((t) => t.url.includes(match));
  if (hit && hit.url.startsWith(url.split('?')[0])) return hit.index;
  const target = hit || seller.find((t) => t.url.includes('/product/batch')) || seller[0];
  if (!target) throw Error('NO_TAB_FOR_' + match);
  await evalInTab(pid, target.index, `location.assign(${JSON.stringify(url)});'nav'`);
  await sleep(6000);
  return target.index;
}

function loadSpec(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse);
}

function productsOf(spec) {
  return Array.isArray(spec.products) && spec.products.length ? spec.products : [spec];
}

/** 只要还有本地文件形式的图片，就必须先走托管，不能直接建表。 */
function needsHosting(spec) {
  return productsOf(spec).some((p) =>
    (p.images || []).some((x) => typeof x !== 'string') ||
    (p.colors || []).some((c) => c.image && typeof c.image !== 'string'));
}

/**
 * plan：把本地文件托管理一遍，再逐张校验，任何一张不合格就停。
 * 多款 spec 时所有图片合成一次部署（Pages 部署是整站替换，逐款部署会互相覆盖）。
 */
async function stagePlan(a, spec) {
  const products = productsOf(spec);
  const base = { mode: a.host, baseUrl: a.baseUrl, siteDir: a.siteDir, project: a.project };
  const queued = [];
  for (const p of products) {
    const sub = (a.prefix ? a.prefix.replace(/^\/+|\/+$/g, '') + '/' : '') + String(p.slug || p.skuPrefix).toLowerCase();
    p.images = (p.images || []).map((x) => (typeof x === 'string' ? { url: x } : { ...x, key: (x.key || `${sub}/${path.basename(x.file)}`) }));
    for (const c of p.colors || []) {
      if (!c.image || typeof c.image === 'string') continue;
      c.image = { ...c.image, key: (c.image.key || `${sub}/variant/${path.basename(c.image.file)}`) };
    }
    // 尺码表同样是平台要抓取的 URL，必须一起托管；漏掉会让建表炸在 openpyxl。
    if (p.sizeChart && typeof p.sizeChart === 'object' && p.sizeChart.file) {
      p.sizeChart = { ...p.sizeChart, key: (p.sizeChart.key || `${sub}/sizechart/${path.basename(p.sizeChart.file)}`) };
    }
  }
  for (const p of products) {
    for (const img of p.images) queued.push(img);
    for (const c of p.colors || []) if (c.image && typeof c.image !== 'string') queued.push(c.image);
    if (p.sizeChart && typeof p.sizeChart !== 'string') queued.push(p.sizeChart);
  }
  const hosted = await hostImages(queued, base);
  const urlOf = new Map(hosted.map((h) => [h.file ?? h.url, h.url]));
  for (const p of products) {
    p.images = p.images.map((x) => (x.url ? x.url : urlOf.get(x.file)));
    for (const c of p.colors || []) if (c.image && typeof c.image !== 'string') c.image = urlOf.get(c.image.file);
    if (p.sizeChart && typeof p.sizeChart !== 'string') p.sizeChart = urlOf.get(p.sizeChart.file);
    for (const asset of p.media?.assets || []) {
      if (urlOf.has(asset.file)) asset.url = urlOf.get(asset.file);
    }
  }

  const report = { stage: 'plan', products: [], allImagesOk: true };
  for (const p of products) {
    const uploadImages = [...new Set([...p.images, ...(p.colors || []).map((c) => c.image).filter(Boolean),
      ...(p.sizeChart ? [p.sizeChart] : [])])];
    const check = await verifyAll(uploadImages, { mainFirst: true });
    report.products.push({
      skuPrefix: p.skuPrefix,
      images: check.results.map(({ url, ok, reason, bytes, width, height, contentType, aspect }) =>
        ({ url, ok, reason, bytes, width, height, contentType, aspect })),
      ok: check.ok,
    });
    if (!check.ok) report.allImagesOk = false;
  }
  if (!report.allImagesOk) { console.error(JSON.stringify(report, null, 1)); throw Error('IMAGE_VERIFY_FAILED'); }
  return report;
}

async function stageBuild(a, spec) {
  const { execFileSync } = await import('node:child_process');
  let py = process.env.POD_PYTHON || 'python3';
  if (!process.env.POD_PYTHON) {
    const venv = path.join(ROOT, '.venv-kb/bin/python');
    try { await fs.access(venv); py = venv; } catch { /* 回退到系统 python3 */ }
  }
  const template = path.resolve(ROOT, a.template || DEFAULT_TEMPLATE);
  const out = a.out || path.join(os.tmpdir(), `pod-listing-${Date.now()}.xlsx`);
  const specFile = out + '.spec.json';
  await fs.writeFile(specFile, JSON.stringify(spec, null, 1), 'utf8');
  const raw = execFileSync(py, [path.join(ROOT, 'tools/pod/listing/build-workbook.py'),
    '--spec', specFile, '--template', template, '--out', out], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { ...JSON.parse(raw), template, specFile };
}

async function stagePrecheck(a, shop, built) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podlc-'));
  const name = path.basename(built.out);
  await fs.copyFile(built.out, path.join(dir, name));
  const srv = await serveLocalFiles(dir);
  try {
    const fileUrl = `http://127.0.0.1:${srv.port}/${encodeURIComponent(name)}`;
    const analysis = await analyseXlsx(shop.pid, shop.batchTab, { fileUrl, fileName: name });
    if (analysis.code !== 0) throw Error('ANALYSIS_FAILED ' + JSON.stringify(analysis).slice(0, 300));
    const wass = analysis.data?.wass_oid;
    const pre = await preCheckXlsx(shop.pid, shop.batchTab, { fileUrl, fileName: name, wassOid: wass });
    return {
      stage: 'precheck', wass_oid: wass,
      product_count: analysis.data?.product_count, sku_count: analysis.data?.sku_count,
      is_valid_version: analysis.data?.is_valid_version,
      echoedImages: analysis.data?.product?.images?.[0]?.url_list ?? analysis.data?.product?.images?.[0]?.thumb_url_list ?? null,
      precheck_code: pre.code, precheck_message: pre.message,
      note: 'pre_check 只校验表格字段，不校验图片可抓取；图片证据看 plan 阶段逐张结果与导入后商品页读回',
    };
  } finally { await srv.close(); await fs.rm(dir, { recursive: true, force: true }); }
}

/**
 * 页面注入 xlsx 并等页面级预检结果。页面在线编辑器会真的去抓图片 URL，
 * 抓不到就报「无法处理该图片 URL」，这是比 /excel/pre_check 更硬的图片门。
 * 本函数不点导入，不建商品。
 */
async function pageUpload(shop, xlsxPath) {
  const tab = await ensureTab(shop.pid, BATCH_PUBLISH, '/product/batch/publish');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podxi-'));
  const name = path.basename(xlsxPath);
  await fs.copyFile(xlsxPath, path.join(dir, name));
  const srv = await serveLocalFiles(dir);
  try {
    await evalInTab(shop.pid, tab, `
      window.__podX={phase:'start'};
      (async()=>{try{
        const r=await fetch('http://127.0.0.1:${srv.port}/${encodeURIComponent(name)}');
        if(!r.ok)throw new Error('LOCAL_'+r.status);
        const buf=await r.arrayBuffer();
        const input=document.querySelector('input[type=file][accept=".xlsx"]')||document.querySelector('input[type=file]');
        if(!input)throw new Error('NO_XLSX_INPUT');
        const dt=new DataTransfer();
        dt.items.add(new File([buf],${JSON.stringify(name)},{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
        input.files=dt.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
        input.dispatchEvent(new Event('input',{bubbles:true}));
        window.__podX={phase:'injected',bytes:buf.byteLength};
      }catch(e){window.__podX={phase:'error',err:String(e&&e.message||e)};}})(); 'fired';`);

    let ready = null;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const s = JSON.parse(await evalInTab(shop.pid, tab, `JSON.stringify((()=>{
        const t=document.body.innerText||'';
        // 页面会保留上一份表的错误横幅，所以先认文件名：只信当前这份表的结果
        const shown=(t.match(/([A-Za-z0-9._-]+\\.xlsx)/)||[])[1]||null;
        const bad=(t.match(/存在错误|修复 (\\d+) 件出错的商品/)||[])[0]||null;
        const dup=/此文件已存在/.test(t)?'此文件已存在':'';
        const ok=(t.match(/(\\d+) 款商品准备就绪/)||[])[1]||null;
        const imgErrs=(t.match(/无法处理该图片 URL：\\S+/g)||[]).slice(0,5);
        const errs=(t.match(/不支持[^\\n]*|请修改[^\\n]*/g)||[]).slice(0,3);
        return {shown,ok,bad,dup,errs,imgErrs};})())`));
      if (s.shown && s.shown !== name) continue;   // 还没切到本次文件
      if (s.dup) throw Error('DUPLICATE_FILE_ALREADY_UPLOADED (同 sha 被上传过；改内容重试，不要靠改文件名)');
      if (s.bad) throw Error('PRECHECK_FAILED: ' + [s.bad, ...(s.errs || []), ...(s.imgErrs || [])].join(' | '));
      if (s.ok) { ready = Number(s.ok); break; }
    }
    if (ready === null) throw Error('PRECHECK_TIMEOUT');
    return { tab, ready, cleanup: async () => { await srv.close(); await fs.rm(dir, { recursive: true, force: true }); } };
  } catch (e) {
    await srv.close(); await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

async function stageImport(shop, xlsxPath) {
  const up = await pageUpload(shop, xlsxPath);
  try {
    const { tab } = up;
    const clicked = await evalInTab(shop.pid, tab, `(()=>{
      const b=[...document.querySelectorAll('button')].filter(x=>!x.disabled&&x.offsetParent!==null)
        .find(x=>(x.innerText||'').trim()==='导入');
      if(!b)return 'NO_IMPORT_BTN'; b.click(); return 'clicked';})()`);
    if (clicked !== 'clicked') throw Error('IMPORT_' + clicked);

    let imported = null;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const s = JSON.parse(await evalInTab(shop.pid, tab, `JSON.stringify((()=>{
        const t=document.body.innerText||'';
        return {done:(t.match(/(\\d+) 件商品导入成功/)||[])[1]||null};})())`));
      if (s.done) { imported = Number(s.done); break; }
    }
    if (imported === null) throw Error('IMPORT_RESULT_UNKNOWN');
    return { stage: 'import', readyProducts: up.ready, imported };
  } finally { await up.cleanup(); }
}

async function stagePageCheck(shop, xlsxPath) {
  const up = await pageUpload(shop, xlsxPath);
  try { return { stage: 'pagecheck', readyProducts: up.ready, imported: 0, note: '页面预检通过且未点导入（页面已真抓过图片）' }; }
  finally { await up.cleanup(); }
}

async function stageVerify(shop, term) {
  const tab = await ensureTab(shop.pid, MANAGE, '/product/manage');
  const typed = await evalInTab(shop.pid, tab, `(()=>{
    const inp=[...document.querySelectorAll('input')].find(i=>/商品名称/.test(i.placeholder||''));
    if(!inp)return 'NO_SEARCH_INPUT';
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp, ${JSON.stringify(String(term).slice(0, 48))});
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true}));
    return 'typed';})()`);
  if (typed !== 'typed') throw Error('SEARCH_' + typed);
  let text = '';
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    text = await evalInTab(shop.pid, tab, `String((document.body.innerText||'').slice(0,8000))`);
    if (/ID:\d{16,20}/.test(text)) break;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const ids = [...new Set([...text.matchAll(/ID:(\d{16,20})/g)].map((m) => m[1]))];
  const titleIdx = lines.findIndex((l) => /^(Playera|Camiseta|Blusa|T-shirt|PRUEBA)/i.test(l));
  const seg = titleIdx >= 0 ? lines.slice(titleIdx, titleIdx + 9) : [];
  return {
    stage: 'verify', term, ids,
    title: titleIdx >= 0 ? lines[titleIdx] : null,
    status: seg.find((l) => /^(在售|审核中|需要关注|已下架|草稿|已删除)$/.test(l)) || null,
    price: (text.match(/\$[\d.]+ - \$[\d.]+/) || [])[0] || null,
    skuCount: (text.match(/(\d+)\s*个 SKU/) || [])[1] || null,
    total: (text.match(/总行数:\s*(\d+)/) || [])[1] || null,
  };
}

/** 下架：接口对空 body 也回 code 0，所以必须回读状态，不能凭返回码宣告成功。 */
async function stageDeactivate(shop, id) {
  if (!id) throw Error('PRODUCT_ID_REQUIRED');
  const tab = await ensureTab(shop.pid, MANAGE, '/product/manage');
  const res = await evalInTab(shop.pid, tab, `
    window.__podD=null;
    (async()=>{try{
      const r=await fetch('/api/v1/product/products/deactivate',{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({product_ids:[${JSON.stringify(String(id))}]})});
      const j=await r.json().catch(()=>null);
      window.__podD={http:r.status,code:j&&j.code,message:j&&(j.message||j.msg)};
    }catch(e){window.__podD={error:String(e&&e.message||e)};}})(); 'fired';`);
  let raw = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    raw = await evalInTab(shop.pid, tab, `JSON.stringify(window.__podD)`);
    if (raw && raw !== 'null') break;
  }
  return { stage: 'deactivate', id, response: JSON.parse(raw || 'null'),
    next: '必须再用 verify 读回状态=已下架，返回码不能当成功' };
}

async function main() {
  const a = args();
  if (!a.spec) { console.error('USAGE: publish.mjs --spec spec.json --stage plan|build|precheck|import|verify|deactivate'); process.exit(2); }
  const spec = await loadSpec(path.resolve(a.spec));
  if (['plan', 'build', 'precheck', 'pagecheck', 'import'].includes(a.stage)) validateMediaSpec(spec);
  const shop = await resolveShop(a.pid);
  const base = { shop: shop.shop, pid: shop.pid, batchTab: shop.batchTab };
  const out = { ...base };

  if (a.stage === 'plan') Object.assign(out, await stagePlan(a, spec));
  if (a.stage === 'build' || a.stage === 'precheck' || a.stage === 'import' || a.stage === 'pagecheck') {
    if (a.host !== 'static' || needsHosting(spec)) Object.assign(out, await stagePlan(a, spec));
    const built = await stageBuild(a, spec);
    Object.assign(out, { built });
    if (a.stage === 'precheck') Object.assign(out, await stagePrecheck(a, shop, built));
    if (a.stage === 'pagecheck') Object.assign(out, await stagePageCheck(shop, built.out));
    if (a.stage === 'import') {
      if (!a.confirmImport) throw Error('IMPORT_NEEDS_CONFIRM_FLAG (这一步会真的建商品)');
      Object.assign(out, await stageImport(shop, built.out));
      Object.assign(out, await stageVerify(shop, spec.title));
    }
  }
  if (a.stage === 'verify') Object.assign(out, await stageVerify(shop, a.title || spec.title));
  if (a.stage === 'deactivate') {
    if (!a.confirmDeactivate) throw Error('DEACTIVATE_NEEDS_CONFIRM_FLAG');
    Object.assign(out, await stageDeactivate(shop, a.id));
  }
  console.log(JSON.stringify(out, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('FAILED:', String(e?.message || e)); process.exit(1); });
}
