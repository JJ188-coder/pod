#!/usr/bin/env node
/**
 * run-product.mjs — 单款 POD 商品固定路径编排器。
 *
 * 默认只跑本地步骤：pack → freeze → marketing → spec → check（页面预检，不建商品）。
 * 显式加 --galaxy-apply 才会写银河；显式加 --import 才会真导入。
 * 每步状态写入 <pack>/run-state.json，可续跑；已完成步骤默认跳过，--force 重跑。
 *
 * 用法：
 *   node tools/pod/run-product.mjs --pack <商品包> --code UKIYOE5 \
 *     --pattern <图案.png> --reference <白底4K.png> --theme "..." \
 *     --title "..." --description "..." [--color Blanco] [--sizes S,M,L,XL,2XL,3XL] \
 *     [--galaxy-apply] [--import] [--finish] [--steps pack,freeze,...] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'project', 'T恤'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(HERE, '../..');
})();
const GALAXY = path.join(process.env.HOME || '', '.zcode/cli/plugins/cache/pod-toolkit/pod-galaxy-design/0.2.0/scripts');
const LISTING = path.join(process.env.HOME || '', '.zcode/cli/plugins/cache/pod-toolkit/pod-image-listing/0.1.0/scripts');
const FREEZE = path.join(ROOT, 'tools/pod/freeze.py');
const MAKE_SPEC = path.join(ROOT, 'tools/pod/make-listing-spec.py');
const SKU_MAP = path.join(ROOT, 'tools/pod/sku-map.mjs');
const READBACK = path.join(ROOT, 'tools/pod/seller-readback.mjs');
const MARKETING = path.join(ROOT, 'tools/pod/marketing-pack.mjs');
const SIZE_CHART_DEFAULT = path.join(ROOT, 'project/T恤/批次/B20261027-MX-BOT-DEV-01/营销图/JC101-R01-20261102/尺码图.png');

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(n);
const pack = path.resolve(arg('--pack'));
const code = arg('--code') || path.basename(pack);
const version = arg('--version', 'R01');
const color = arg('--color', 'Blanco');
const sizes = arg('--sizes', 'S,M,L,XL,2XL,3XL');
const price = arg('--price', '123');
const baseUrl = arg('--base-url', fs.existsSync(path.join(ROOT, '.local/pod-image-base'))
  ? fs.readFileSync(path.join(ROOT, '.local/pod-image-base'), 'utf8').trim() : '');
const galaxyApply = has('--galaxy-apply');
const doImport = has('--import');
const force = has('--force');

if (!fs.existsSync(pack)) { console.log(JSON.stringify({ ok: false, error: 'PACK_NOT_FOUND', pack })); process.exit(2); }

let steps = (arg('--steps') || 'pack,freeze,marketing,spec,check').split(',').map((s) => s.trim()).filter(Boolean);
if (galaxyApply && !steps.includes('galaxy')) steps.push('galaxy');
if (doImport && !steps.includes('import')) steps.push('import');
if (has('--finish')) for (const s of ['readback', 'mapping']) if (!steps.includes(s)) steps.push(s);
if (steps.includes('import') && !steps.includes('check')) steps.unshift('check');

const statePath = path.join(pack, 'run-state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { code, steps: {} };
state.code = code;
state.updated_at = new Date().toISOString();

const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const mark = (step, status, detail = {}) => {
  state.steps[step] = { status, at: new Date().toISOString(), ...detail };
  state.updated_at = new Date().toISOString();
  saveState();
};
const done = (step) => !force && state.steps[step]?.status === 'ok';
const run = (cmd, argv, opts = {}) => {
  const { timeout = 600000, ...rest } = opts;
  return spawnSync(cmd, argv, { encoding: 'utf8', timeout, ...rest, cwd: ROOT });
};
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

function fail(step, error, detail = {}) {
  mark(step, 'failed', { error, ...detail });
  console.log(JSON.stringify({ ok: false, step, error, detail }, null, 2));
  process.exit(1);
}

function patternPath() {
  return path.join(pack, '生产图', `${code}-F.png`);
}
function specPath() { return path.join(pack, 'listing-spec.json'); }
function packSpecPath() { return path.join(pack, '商品包配置.json'); }
function handoffDir() { return path.join(pack, '证据'); }

function writeHandoff(check, taskId, imagePath) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
  const now = new Date().toISOString();
  const h = {
    schema: 'galaxy-handoff-v1', product: code,
    galaxy_task_id: taskId, galaxy_design_id: check.design_id, galaxy_group_id: check.group_id,
    galaxy_template_id: null, material_image_codes: check.material_codes ?? null,
    sku_built: check.sku_rows, per_size: check.per_size, pattern_sha256: sha,
    saved_at: check.created_at || now, readback_at: now,
    source_image: path.relative(ROOT, imagePath),
    geometry_note: '读回来自 /trade/design/page；铺满率按 59.0553 px/cm。',
    limits: ['单面、单图案；SKU 由银河编辑器生成。'],
  };
  fs.mkdirSync(handoffDir(), { recursive: true });
  const out = path.join(handoffDir(), `银河交接-${code}-${now.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(h, null, 2));
  return out;
}

const results = [];
for (const step of steps) {
  if (done(step)) { results.push({ step, status: 'cached' }); continue; }
  try {
    if (step === 'pack') {
      for (const d of ['生产图', '主图', '详情页', '尺码']) fs.mkdirSync(path.join(pack, d), { recursive: true });
      const img = patternPath();
      if (!fs.existsSync(img)) {
        const src = arg('--pattern');
        if (!src || !fs.existsSync(src)) fail(step, 'PATTERN_REQUIRED', { expected: img });
        fs.copyFileSync(src, img);
      }
      const hero = path.join(pack, '主图/H01.jpg');
      if (!fs.existsSync(hero)) {
        run('python3', ['-c', `from PIL import Image\nim=Image.open(r"${img}")\nbg=Image.new("RGB",im.size,(245,245,245));bg.paste(im,(0,0),im)\nbg.save(r"${hero}",quality=90)\nbg.save(r"${path.join(pack, '详情页/D01.png')}")`]);
      }
      const chart = path.join(pack, '尺码/tallas.png');
      if (!fs.existsSync(chart)) {
        const src = arg('--size-chart', SIZE_CHART_DEFAULT);
        if (!fs.existsSync(src)) fail(step, 'SIZE_CHART_MISSING', { src });
        fs.copyFileSync(src, chart);
      }
      const spec = { candidate_id: code, version, style: arg('--style', 'MXTMC001'), batch: path.relative(ROOT, path.dirname(path.dirname(pack))) };
      fs.writeFileSync(packSpecPath(), JSON.stringify(spec, null, 2));
      mark(step, 'ok', { pattern: path.relative(ROOT, img) });
      results.push({ step, status: 'ok' });
      continue;
    }

    if (step === 'freeze') {
      const r = run('python3', [FREEZE, pack, '--product', code, '--version', version, '--min-edge', '3000']);
      const out = parseJson(r.stdout) || {};
      if (r.status !== 0 || !out.materials_ready) fail(step, 'FREEZE_FAILED', { out, stderr: (r.stderr || '').slice(-300) });
      mark(step, 'ok', { materials_ready: true });
      results.push({ step, status: 'ok', materials_ready: true });
      continue;
    }

    if (step === 'galaxy') {
      const spec = packSpecPath();
      if (!fs.existsSync(spec)) fail(step, 'PACK_SPEC_MISSING');
      const argv = [path.join(GALAXY, 'galaxy-step.mjs'), 'upload', '--spec', spec];
      if (galaxyApply) argv.push('--apply');
      const r = run(process.execPath, argv);
      const out = parseJson(r.stdout) || {};
      if (!galaxyApply) {
        if (r.status !== 0 || !out.ok) fail(step, 'GALAXY_PREFLIGHT_FAILED', { out });
        mark(step, 'ok', { apply: false });
        results.push({ step, status: 'ok', apply: false });
        continue;
      }
      if (r.status === 0 && out.ok) { mark(step, 'ok', { apply: true }); results.push({ step, status: 'ok', apply: true }); continue; }
      // 保存成功但读回延迟：用 task_id 复盘，不重传。
      const blob = JSON.stringify(out);
      const taskId = /"task_id":\s*"(\d+)"/.exec(blob)?.[1];
      if (!taskId) fail(step, 'GALAXY_UPLOAD_FAILED', { out });
      let check = null;
      for (let i = 0; i < 6; i += 1) {
        const c = run(process.execPath, [path.join(GALAXY, 'upload-pattern.mjs'), '--check', taskId]);
        const parsed = parseJson(c.stdout);
        if (parsed?.found && parsed.sku_rows > 0 && parsed.all_full) { check = parsed; break; }
        await new Promise((res) => setTimeout(res, 5000));
      }
      if (!check) fail(step, 'GALAXY_READBACK_FAILED', { taskId });
      const handoff = writeHandoff(check, taskId, patternPath());
      const v = run(process.execPath, [path.join(GALAXY, 'galaxy-step.mjs'), 'verify', '--handoff', handoff]);
      if (v.status !== 0) fail(step, 'HANDOFF_GATE_FAILED', { handoff, stdout: (v.stdout || '').slice(-400) });
      mark(step, 'ok', { apply: true, taskId, handoff: path.relative(ROOT, handoff) });
      results.push({ step, status: 'ok', apply: true, handoff: path.relative(ROOT, handoff) });
      continue;
    }

    if (step === 'marketing') {
      const upload = path.join(pack, '营销图/upload');
      const have = fs.existsSync(upload) ? fs.readdirSync(upload).filter((f) => f.endsWith('.jpg')).length : 0;
      if (have >= 9) { mark(step, 'ok', { images: have, reused: true }); results.push({ step, status: 'ok', images: have, reused: true }); continue; }
      const ref = arg('--reference');
      const theme = arg('--theme');
      if (!ref || !fs.existsSync(ref) || !theme) fail(step, 'REFERENCE_AND_THEME_REQUIRED');
      const r = run(process.execPath, [MARKETING, '--pack', pack, '--code', code, '--reference', ref, '--theme', theme, '--color', color], { timeout: 1800000 });
      const out = parseJson(r.stdout) || {};
      if (r.status !== 0 || !out.ok) fail(step, 'MARKETING_FAILED', { out });
      mark(step, 'ok', { images: out.images });
      results.push({ step, status: 'ok', images: out.images });
      continue;
    }

    if (step === 'spec') {
      const title = arg('--title');
      const description = arg('--description');
      if (!title || !description) fail(step, 'TITLE_AND_DESCRIPTION_REQUIRED');
      const r = run('python3', [MAKE_SPEC, '--pack', pack, '--code', code, '--title', title,
        '--description', description, '--color', color, '--sizes', sizes, '--price', price,
        '--prefix', arg('--sku-prefix', `MXTMC001-${code}`)]);
      const out = parseJson(r.stdout) || {};
      if (r.status !== 0 || !out.ok) fail(step, 'SPEC_FAILED', { out, stderr: (r.stderr || '').slice(-300) });
      mark(step, 'ok', { spec: path.relative(ROOT, out.spec) });
      results.push({ step, status: 'ok', spec: path.relative(ROOT, out.spec) });
      continue;
    }

    if (step === 'check') {
      if (!baseUrl) fail(step, 'IMAGE_BASE_URL_MISSING');
      const out = path.join(handoffDir(), `${code}-页面预检.xlsx`);
      fs.mkdirSync(handoffDir(), { recursive: true });
      const r = run(process.execPath, [path.join(LISTING, 'listing-step.mjs'), 'check', '--spec', specPath(), '--out', out], { env: { ...process.env, POD_IMAGE_BASE_URL: baseUrl } });
      const parsed = parseJson(r.stdout) || {};
      if (r.status !== 0) fail(step, 'PAGE_PRECHECK_FAILED', { tail: (r.stdout || '').slice(-500) });
      mark(step, 'ok', { readyProducts: parsed.readyProducts, imported: parsed.imported });
      results.push({ step, status: 'ok', readyProducts: parsed.readyProducts });
      continue;
    }

    if (step === 'import') {
      if (!doImport) { results.push({ step, status: 'skipped', reason: 'ADD_--import' }); continue; }
      const existing = run(process.execPath, [READBACK, '--code', code]);
      const ex = parseJson(existing.stdout);
      if (ex?.ok && ex.products?.length) {
        mark(step, 'ok', { skippedExisting: ex.products[0].id });
        results.push({ step, status: 'ok', skippedExisting: ex.products[0].id });
        continue;
      }
      const r = run(process.execPath, [path.join(LISTING, 'listing-step.mjs'), 'publish', '--spec', specPath(), '--apply'], { env: { ...process.env, POD_IMAGE_BASE_URL: baseUrl } });
      const parsed = parseJson(r.stdout) || {};
      if (r.status !== 0 || parsed.imported !== 1) fail(step, 'IMPORT_FAILED', { tail: (r.stdout || '').slice(-500) });
      mark(step, 'ok', { imported: 1 });
      results.push({ step, status: 'ok', imported: 1 });
      continue;
    }

    if (step === 'readback') {
      const r = run(process.execPath, [READBACK, '--code', code]);
      const out = parseJson(r.stdout) || {};
      if (r.status !== 0 || !out.ok) fail(step, 'READBACK_FAILED', { out });
      const p = out.products[0];
      const evidence = {
        schema: 'pod-listing-readback-v1', product_code: code, product_id: p.id, title: p.title,
        status: p.status, observed_at: new Date().toISOString(), source: '战斧 seller-mx 商品管理',
      };
      fs.mkdirSync(handoffDir(), { recursive: true });
      fs.writeFileSync(path.join(handoffDir(), '商品读回-20261104.json'), JSON.stringify(evidence, null, 2));
      mark(step, 'ok', { productId: p.id, status: p.status });
      results.push({ step, status: 'ok', productId: p.id, status: p.status });
      continue;
    }

    if (step === 'mapping') {
      const r = run(process.execPath, [SKU_MAP, '--pack', pack, '--code', code]);
      const out = parseJson(r.stdout) || {};
      if (r.status !== 0 || !out.ok) fail(step, 'MAPPING_FAILED', { out });
      mark(step, 'ok', { rows: out.rows, factory_saved: false });
      results.push({ step, status: 'ok', rows: out.rows, factory_saved: false });
      continue;
    }

    fail(step, 'UNKNOWN_STEP');
  } catch (error) {
    fail(step, 'STEP_EXCEPTION', { detail: String(error.message || error).slice(0, 300) });
  }
}

console.log(JSON.stringify({ ok: true, code, steps: results, state: path.relative(ROOT, statePath) }, null, 2));
