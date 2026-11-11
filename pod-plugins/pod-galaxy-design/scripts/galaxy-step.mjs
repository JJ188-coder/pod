#!/usr/bin/env node
/**
 * galaxy-step.mjs — POD 银河设计岗位的唯一入口（只做有界动作，不导出任何凭据）
 *
 * 设计原则：
 *   1. 不重写已验证的上传/保存逻辑，实际写平台动作交给仓库既有工具；
 *   2. 默认只读：`status` / `check` / `verify` 不发任何平台写请求；
 *   3. `upload` 必须显式 `--apply`，且先过「银河已登录」和「该款号无已验交接」两道闸；
 *   4. 不读取、不输出 Cookie / Token / localStorage 值。
 *
 * 用法：
 *   node galaxy-step.mjs status
 *   node galaxy-step.mjs check  --batch <批次目录> --product JC124
 *   node galaxy-step.mjs verify --handoff <银河交接.json>
 *   node galaxy-step.mjs upload --spec <商品包配置.json> [--apply]
 *
 * 退出码：0 通过/可用；1 缺项或被闸门拦下；2 参数或环境错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const CDP = 'http://127.0.0.1:9222';
const GALAXY_ORIGIN = 'https://tshirt.riin.com';
const DESIGN_HASH = '#/shop/goodsManagement/localDesign/index';
const PY_CANDIDATES = [
  path.join(process.env.HOME || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
  'python3.12',
  'python3',
];

const out = (value, code = 0) => {
  console.log(JSON.stringify(value, null, 2));
  process.exit(code);
};

function repoRoot() {
  if (process.env.POD_REPO) return process.env.POD_REPO;
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'project', 'T恤'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pythonWithPillow() {
  for (const candidate of PY_CANDIDATES) {
    if (candidate.includes('/') && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import PIL'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

async function galaxyState() {
  let rows;
  try {
    const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!res.ok) return { ok: false, error: `CDP_HTTP_${res.status}` };
    rows = await res.json();
  } catch (error) {
    return { ok: false, error: 'CDP_UNAVAILABLE', detail: String(error.message || error).slice(0, 120) };
  }
  const galaxy = [];
  for (const row of rows) {
    if (row?.type !== 'page') continue;
    let url;
    try { url = new URL(row.url); } catch { continue; }
    if (url.origin !== GALAXY_ORIGIN) continue;
    galaxy.push({ id: row.id, hashPath: url.hash.split('?')[0], title: String(row.title || '').slice(0, 40) });
  }
  const designTargets = galaxy.filter((t) => t.hashPath === DESIGN_HASH);
  const loginTargets = galaxy.filter((t) => t.hashPath.startsWith('#/login'));
  // 只要还有可用设计页就算可用：残留的登录标签是其他标签的状态，不能反过来否定已登录会话。
  const ready = designTargets.length > 0;
  return { ok: ready, galaxyTabs: galaxy.length, designTargets, loginTargets: loginTargets.length, loginTabs: loginTargets, loginRequired: !ready };
}

const KEYCHAIN_SERVICE = process.env.POD_GALAXY_SERVICE || 'pod-galaxy-tshirt-riin';
const KEYCHAIN_ACCOUNT = process.env.POD_GALAXY_ACCOUNT || 'BRK';

/** 从 macOS 钥匙串取密码：只进内存，不打印、不写文件。 */
function keychainPassword() {
  if (process.platform !== 'darwin') return null;
  const run = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { encoding: 'utf8' });
  if (run.status !== 0) return null;
  return (run.stdout || '').replace(/\n$/, '');
}

/** 用钥匙串凭据完成一次银河登录；凭据只在进程内存里，用完即弃。 */
async function login() {
  const state = await galaxyState();
  if (state.error) return out({ ok: false, error: state.error, detail: state.detail }, 2);
  if (state.ok) return out({ ok: true, alreadyLoggedIn: true, designTargets: state.designTargets });
  const loginTabs = state.loginTabs || [];
  if (!loginTabs.length) {
    return out({ ok: false, error: 'NO_LOGIN_TAB', hint: '9222 里没有银河登录页；请先打开 https://tshirt.riin.com/#/login' }, 1);
  }
  const password = keychainPassword();
  if (!password) {
    return out({ ok: false, error: 'KEYCHAIN_ENTRY_MISSING', service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT }, 1);
  }
  const root = repoRoot();
  if (!root) return out({ ok: false, error: 'REPO_ROOT_NOT_FOUND' }, 2);
  const { exactChromePage } = await import(pathToFileURL(path.join(root, 'tools/pod/chrome-page.mjs')).href);
  const target = loginTabs[0];
  let client;
  try {
    client = await exactChromePage({ targetId: target.id, origin: GALAXY_ORIGIN, hashPath: '#/login' });
    const { page } = client;
    const user = page.getByPlaceholder('账号', { exact: true });
    const pass = page.getByPlaceholder('密码', { exact: true });
    if ((await user.count()) !== 1 || (await pass.count()) !== 1) return out({ ok: false, error: 'LOGIN_FIELDS_NOT_UNIQUE' }, 1);
    await user.fill(KEYCHAIN_ACCOUNT);
    await pass.fill(password);
    const boxes = page.locator('input[type=checkbox]');
    if ((await boxes.count()) === 1 && !(await boxes.isChecked())) await boxes.check();
    const button = page.getByRole('button', { name: '登录', exact: true });
    if ((await button.count()) !== 1) return out({ ok: false, error: 'LOGIN_BUTTON_NOT_UNIQUE' }, 1);
    await button.click({ timeout: 3000 });
    await page.waitForTimeout(3500);
    const after = page.url();
    const settled = await galaxyState();
    return out({
      ok: Boolean(settled.ok),
      account: KEYCHAIN_ACCOUNT,
      afterUrl: after.replace(/\?.*$/, ''),
      designTargets: settled.designTargets || [],
      hint: settled.ok ? '登录成功；可继续 check / upload' : '仍未进入本地设计页：可能有验证码或二次验证，请本人处理',
    }, settled.ok ? 0 : 1);
  } catch (error) {
    return out({ ok: false, error: 'LOGIN_FAILED', detail: String(error.message || error).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 160) }, 1);
  } finally {
    try { await client?.browser?.close(); } catch { /* 只断本进程的 CDP 连接，不影响页面 */ }
  }
}

async function status() {
  const state = await galaxyState();
  if (state.error) return out({ ok: false, ...state }, 2);
  return out({
    ...state,
    hint: state.ok
      ? '银河可用；可继续 check / upload'
      : '银河会话已过期：请本人在该 Chrome 里手动登录 tshirt.riin.com，脚本不代填账号密码',
  }, state.ok ? 0 : 1);
}

function findAll(dir, needle, depth = 0, acc = []) {
  if (depth > 4 || !fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findAll(full, needle, depth + 1, acc);
    else if (entry.name.includes(needle) && entry.name.endsWith('.json')) acc.push(full);
  }
  return acc;
}

function gate(root, handoff) {
  const script = path.join(root, 'project/T恤/批次/B20261027-MX-BOT-DEV-01/工具/校验银河交接.py');
  if (!fs.existsSync(script)) return { passed: false, error: 'GATE_SCRIPT_MISSING' };
  const python = pythonWithPillow();
  if (!python) return { passed: false, error: 'PIL_PYTHON_UNAVAILABLE' };
  const run = spawnSync(python, [script, handoff], { cwd: path.dirname(path.dirname(script)), encoding: 'utf8', timeout: 120000 });
  const text = `${run.stdout || ''}${run.stderr || ''}`;
  return {
    passed: run.status === 0,
    exitCode: run.status,
    summary: text.split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400),
  };
}

function check(batch, product) {
  const root = repoRoot();
  if (!root) return out({ ok: false, error: 'REPO_ROOT_NOT_FOUND' }, 2);
  if (!batch || !product) return out({ ok: false, error: 'BATCH_AND_PRODUCT_REQUIRED' }, 2);
  const target = path.resolve(root, batch);
  if (!target.startsWith(path.join(root, 'project'))) return out({ ok: false, error: 'BATCH_OUTSIDE_PROJECT' }, 2);

  const handoffs = findAll(target, `银河交接-${product}-`).sort();
  if (!handoffs.length) {
    return out({ ok: true, product, existing: false, decision: 'NO_EXISTING_HANDOFF', handoffs: [] });
  }
  const details = handoffs.map((file) => {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
    return {
      file: path.relative(root, file),
      task: data.galaxy_task_id ?? null,
      design: data.galaxy_design_id ?? null,
      group: data.galaxy_group_id ?? null,
      sku: data.sku_built ?? null,
      savedAt: data.saved_at ?? null,
      gate: gate(root, file),
    };
  });
  const verified = details.filter((d) => d.gate.passed && d.task && d.design);
  return out({
    ok: verified.length > 0,
    product,
    existing: verified.length > 0,
    decision: verified.length > 0 ? 'ALREADY_SAVED_DO_NOT_UPLOAD_AGAIN' : 'EXISTING_HANDOFF_FAILED_GATE_REQUIRES_RECONCILIATION',
    verifiedCount: verified.length,
    handoffs: details,
    hint: verified.length > 0
      ? '该款银河已建款保存并通过交接闸门：禁止重复上传/建款；需要改版请显式升级版本号'
      : '已有交接件但未通过闸门：按只读读回定位差异，不要重传掩盖',
  });
}

function verify(handoffArg) {
  const root = repoRoot();
  if (!root) return out({ ok: false, error: 'REPO_ROOT_NOT_FOUND' }, 2);
  if (!handoffArg) return out({ ok: false, error: 'HANDOFF_REQUIRED' }, 2);
  const file = path.resolve(root, handoffArg);
  if (!fs.existsSync(file)) return out({ ok: false, error: 'HANDOFF_NOT_FOUND' }, 2);
  const result = gate(root, file);
  return out({ ok: result.passed, handoff: path.relative(root, file), ...result }, result.passed ? 0 : 1);
}

async function upload(specArg) {
  const root = repoRoot();
  if (!root) return out({ ok: false, error: 'REPO_ROOT_NOT_FOUND' }, 2);

  // 第一道闸：银河登录。未登录时连预检都不做，避免误以为「冻结件齐了就能写」。
  const state = await galaxyState();
  if (state.error) return out({ ok: false, error: state.error, detail: state.detail }, 2);
  if (state.loginRequired) {
    return out({
      ok: false,
      apply: false,
      blockers: ['GALAXY_LOGIN_REQUIRED'],
      designTargets: state.designTargets,
      loginTargets: state.loginTargets,
      hint: '银河会话已过期：请本人在该 Chrome 手动登录 tshirt.riin.com 后再执行；脚本不代填账号密码，也不会在未登录时发起写入',
    }, 1);
  }

  if (!specArg) return out({ ok: false, error: 'SPEC_REQUIRED' }, 2);
  const apply = process.argv.includes('--apply');
  const spec = path.resolve(root, specArg);
  if (!fs.existsSync(spec)) return out({ ok: false, error: 'SPEC_NOT_FOUND' }, 2);

  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(spec, 'utf8')); } catch { return out({ ok: false, error: 'SPEC_JSON_INVALID' }, 1); }
  const product = parsed.candidate_id || parsed.款号 || '';
  const pack = spec.replace(/\/[^/]+$/, '');
  const freeze = path.join(pack, 'freeze.json');
  const manifest = path.join(pack, 'manifest.json');

  const blockers = [];
  if (!product) blockers.push('SPEC_CANDIDATE_ID_MISSING');
  if (!fs.existsSync(freeze)) blockers.push('FROZEN_PACK_MISSING_freeze.json（批次未冻结不得写银河）');
  if (!fs.existsSync(manifest)) blockers.push('PACK_MANIFEST_MISSING_manifest.json');
  if (blockers.length) {
    return out({ ok: false, product, apply, blockers, hint: '补齐冻结件与 manifest 后再执行；占位或未冻素材不得上传' }, 1);
  }

  const dedupe = [];
  const batch = parsed.batch || argOf('--batch');
  if (batch) {
    const target = path.resolve(root, batch);
    for (const file of findAll(target, `银河交接-${product}-`)) {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
      if (data.galaxy_task_id && data.galaxy_design_id && gate(root, file).passed) {
        dedupe.push({ file: path.relative(root, file), task: data.galaxy_task_id, design: data.galaxy_design_id });
      }
    }
  }
  if (dedupe.length) {
    return out({ ok: false, product, apply, blockers: ['ALREADY_SAVED_DO_NOT_UPLOAD_AGAIN'], dedupe, hint: '该款已有通过闸门的银河对象，重复上传等于重复建款' }, 1);
  }

  if (!apply) {
    return out({
      ok: true,
      product,
      apply: false,
      wouldRun: 'tools/pod/galaxy-run-batch.mjs',
      checksPassed: ['freeze', 'manifest', 'candidate', 'no_duplicate'],
      hint: '预检通过；加 --apply 才真正上传并保存',
    });
  }

  const runner = path.join(root, 'tools/pod/galaxy-run-batch.mjs');
  if (!fs.existsSync(runner)) return out({ ok: false, error: 'GALAXY_RUNNER_MISSING' }, 2);
  const run = spawnSync(process.execPath, [runner, spec], { cwd: root, encoding: 'utf8', timeout: 600000 });
  return out({
    ok: run.status === 0,
    product,
    apply: true,
    exitCode: run.status,
    stdout: (run.stdout || '').trim().slice(-1200),
    stderr: (run.stderr || '').trim().slice(-600),
  }, run.status === 0 ? 0 : 1);
}

const command = process.argv[2];
if (command === 'status') await status();
else if (command === 'login') await login();
else if (command === 'check') check(argOf('--batch'), argOf('--product'));
else if (command === 'verify') verify(argOf('--handoff'));
else if (command === 'upload') await upload(argOf('--spec'));
else out({ ok: false, error: 'UNKNOWN_COMMAND', usage: ['status', 'check --batch <dir> --product <JCxxx>', 'verify --handoff <json>', 'upload --spec <json> [--apply]'] }, 2);
