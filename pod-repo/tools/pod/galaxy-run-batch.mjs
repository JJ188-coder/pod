#!/usr/bin/env node
/**
 * galaxy-run-batch.mjs — 银河逐款上传/保存/读回编排器（单面前片）。
 *
 * 复用已验证的唯一上传通道（upload-pattern.mjs 的 ClipboardEvent paste），
 * 本文件只负责：解析冻结包 → 逐款调用 → 写交接件；不复制第二套页面动作。
 *
 * 用法：
 *   node tools/pod/galaxy-run-batch.mjs <商品包配置.json>
 *
 * 退出码：0 全部通过；1 有款失败；2 环境/输入错误。
 *
 * 已知边界：只做单张图案、前片、当前款式；36 色码组合的几何构造仍依赖
 * 银河编辑器原生行为，本脚本以读回的 per_size 铺满率作为验收，不伪造组合。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CDP = process.env.POD_CDP || 'http://127.0.0.1:9222';
const GALAXY = 'https://tshirt.riin.com';
const DESIGN_HASH = '#/shop/goodsManagement/localDesign/index';

const root = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'project', 'T恤'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
})();
if (!root) { console.log(JSON.stringify({ ok: false, error: 'REPO_ROOT_NOT_FOUND' })); process.exit(2); }

const specArg = process.argv[2];
if (!specArg) { console.log(JSON.stringify({ ok: false, error: 'SPEC_REQUIRED' })); process.exit(2); }

function uploadScript() {
  const candidates = [
    process.env.POD_UPLOAD_PATTERN,
    path.join(root, 'pod-plugins/pod-galaxy-design/scripts/upload-pattern.mjs'),
    path.join(process.env.HOME || '', '.zcode/cli/plugins/cache/pod-toolkit/pod-galaxy-design/0.2.0/scripts/upload-pattern.mjs'),
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) { console.log(JSON.stringify({ ok: false, error: 'UPLOAD_PATTERN_NOT_FOUND', candidates })); process.exit(2); }
  return hit;
}
const UPLOAD = uploadScript();

const specPath = path.resolve(root, specArg);
if (!fs.existsSync(specPath)) { console.log(JSON.stringify({ ok: false, error: 'SPEC_NOT_FOUND' })); process.exit(2); }

let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch { console.log(JSON.stringify({ ok: false, error: 'SPEC_JSON_INVALID' })); process.exit(2); }

const products = Array.isArray(spec.products) ? spec.products : [spec];
const pack = path.dirname(specPath);
const freezePath = path.join(pack, 'freeze.json');
if (!fs.existsSync(freezePath)) { console.log(JSON.stringify({ ok: false, error: 'FROZEN_PACK_MISSING' })); process.exit(2); }
const freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8'));
if (!freeze.materials_ready) { console.log(JSON.stringify({ ok: false, error: 'MATERIALS_NOT_READY', gates: freeze.gates })); process.exit(2); }

const patterns = (freeze.files || []).filter((f) => f.role === 'pattern');
if (!patterns.length) { console.log(JSON.stringify({ ok: false, error: 'PATTERN_MISSING_IN_FREEZE' })); process.exit(2); }

function findExisting(product, sha) {
  const dir = path.join(pack, '证据');
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`银河交接-${product}-`) || !name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (data.pattern_sha256 === sha && data.galaxy_task_id) {
        return { file: path.join(dir, name), data };
      }
    } catch { /* 跳过坏文件，不当作已保存 */ }
  }
  return null;
}

const rows = [];
let exit = 0;
for (const product of products) {
  const code = product.candidate_id || product.款号 || product.style || '';
  if (!code) { rows.push({ product: null, ok: false, error: 'CANDIDATE_ID_MISSING' }); exit = 1; continue; }
  const pattern = patterns.find((f) => f.path.includes(code)) || patterns[0];
  const image = path.join(pack, pattern.path);
  if (!fs.existsSync(image)) { rows.push({ product: code, ok: false, error: 'PATTERN_FILE_MISSING', image }); exit = 1; continue; }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  if (sha !== pattern.sha256) { rows.push({ product: code, ok: false, error: 'PATTERN_SHA_MISMATCH' }); exit = 1; continue; }

  const existing = findExisting(code, sha);
  if (existing) {
    rows.push({ product: code, ok: true, skipped: 'ALREADY_SAVED', handoff: path.relative(root, existing.file) });
    continue;
  }

  const startedAt = new Date().toISOString();
  const run = spawnSync(process.execPath, [
    UPLOAD,
    '--image', image,
    '--name', `${code}-F.png`,
    '--save',
  ], { cwd: root, encoding: 'utf8', timeout: 600000 });

  let result = null;
  try { result = JSON.parse((run.stdout || '').trim().split('\n').slice(-200).join('\n')); } catch { /* 保持 null */ }

  // 保存成功后设计列表有短延迟：读到 DESIGN_NOT_FOUND 时轮询，不重新上传。
  if (result?.fill?.error === 'DESIGN_NOT_FOUND' && result?.task_id) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const chk = spawnSync(process.execPath, [UPLOAD, '--check', String(result.task_id)], { cwd: root, encoding: 'utf8', timeout: 120000 });
      try {
        const parsed = JSON.parse((chk.stdout || '').trim());
        if (parsed.found) { result.fill = parsed; break; }
      } catch { /* 继续等 */ }
    }
  }

  const ok = run.status === 0 && result?.ok === true && result?.saved_object_created === true
    && Number(result?.fill?.sku_rows) > 0 && result?.fill?.all_full === true;
  const finishedAt = new Date().toISOString();

  if (!ok) {
    rows.push({
      product: code, ok: false,
      error: result?.error || `UPLOAD_EXIT_${run.status}`,
      stdout: (run.stdout || '').slice(-800),
      stderr: (run.stderr || '').slice(-400),
    });
    exit = 1;
    continue;
  }

  const evidenceDir = path.join(pack, '证据');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const handoffPath = path.join(evidenceDir, `银河交接-${code}-${finishedAt.replace(/[:.]/g, '-')}.json`);
  const handoff = {
    schema: 'galaxy-handoff-v1',
    product: code,
    galaxy_task_id: result.task_id || null,
    galaxy_design_id: result.fill?.design_id || null,
    galaxy_group_id: result.fill?.group_id || null,
    galaxy_template_id: product.galaxy_template_id || null,
    material_image_codes: result.fill?.material_codes ?? null,
    sku_built: result.fill?.sku_rows ?? Object.keys(result.fill?.per_size || {}).length,
    per_size: result.fill?.per_size || null,
    pattern_sha256: sha,
    saved_at: finishedAt,
    readback_at: finishedAt,
    source_image: path.relative(root, image),
    started_at: startedAt,
    geometry_note: '读回来自 /trade/design/page 的 factoryImageList；铺满率按 59.0553 px/cm 计算。',
    limits: [
      '单面、单图案；多色多码组合的真实构造由银河编辑器完成，本交接件只记录读回值。',
      '无效果图文件；效果图需另跑印面渲染并登记 SHA。',
    ],
  };
  fs.writeFileSync(handoffPath, JSON.stringify(handoff, null, 2));
  rows.push({ product: code, ok: true, handoff: path.relative(root, handoffPath), fill: result.fill });
}

console.log(JSON.stringify({ ok: exit === 0, products: rows }, null, 2));
process.exit(exit);
