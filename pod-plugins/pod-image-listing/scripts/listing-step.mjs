#!/usr/bin/env node
/**
 * listing-step.mjs — POD 上架岗位的唯一入口（TikTok Shop MX 批量表 + 自有图床）
 *
 * 设计原则（与 pod-galaxy-design 一致）：
 *   1. 不重写已验证的上架逻辑，实际动作交给 tools/pod/listing/publish.mjs；
 *   2. 默认只读/不落商品：check 只做「托管 + 校验 + 页面预检」，绝不点导入；
 *   3. publish / off 必须显式 --apply，否则只打印将要执行的命令；
 *   4. 不读取、不输出 Cookie / Token / localStorage；凭据只在浏览器内使用。
 *
 * 用法：
 *   node listing-step.mjs doctor
 *   node listing-step.mjs check    --spec <spec.json> [--out <xlsx>]
 *   node listing-step.mjs publish  --spec <spec.json> --apply
 *   node listing-step.mjs status   --title "PRUEBA"
 *   node listing-step.mjs off      --product 1738319130216138608 --apply
 *
 * 退出码：0 通过；1 被闸门拦下或缺项；2 参数/环境错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** POD 业务仓库根：显式 POD_REPO，或从 cwd 往上找 project/T恤，最后回退到插件源码位置。 */
function repoRoot() {
  if (process.env.POD_REPO) return process.env.POD_REPO;
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'project', 'T恤'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const here = path.resolve(HERE, '../../..');
  return fs.existsSync(path.join(here, 'tools/pod/listing/publish.mjs')) ? here : null;
}

const REPO = repoRoot();
const PUBLISH = REPO ? path.join(REPO, 'tools/pod/listing/publish.mjs') : null;
const SITE_DIR = REPO ? path.join(REPO, '.local/pod-images-site') : null;
const BASE_URL = process.env.POD_IMAGE_BASE_URL || 'https://img.bri-king.com';
const PROBE = process.env.POD_IMAGE_PROBE || `${BASE_URL}/img/probe-a19.jpg`;

function args() {
  const a = process.argv.slice(2);
  const cmd = a[0];
  const get = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  return { cmd, spec: get('spec'), out: get('out'), title: get('title'), product: get('product'),
    apply: a.includes('--apply'), prefix: get('prefix') };
}

function runPublish(extra, { dry = false } = {}) {
  if (!REPO || !PUBLISH || !fs.existsSync(PUBLISH)) {
    console.error('REPO_ROOT_NOT_FOUND：设 POD_REPO=<POD 仓库根>，或在 POD 仓库里运行。');
    return 2;
  }
  const argv = ['node', PUBLISH, ...extra];
  if (dry) { console.log('DRY_RUN:\n  ' + argv.join(' ')); return 0; }
  const r = spawnSync(argv[0], argv.slice(1), { cwd: REPO, stdio: 'inherit' });
  return r.status ?? 1;
}

async function doctor() {
  const checks = [];
  const push = (name, ok, detail) => { checks.push({ name, ok, detail }); };
  push('POD 仓库根', !!REPO, REPO || '未找到（设 POD_REPO）');
  push('publish.mjs 存在', !!PUBLISH && fs.existsSync(PUBLISH), PUBLISH || '-');
  push('站点目录存在', fs.existsSync(SITE_DIR), SITE_DIR);
  const cred = path.join(process.env.HOME || '', 'Library/Preferences/.wrangler/config/default.toml');
  push('wrangler 已登录', fs.existsSync(cred), cred);
  try {
    const r = await fetch(PROBE, { signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await r.arrayBuffer());
    push('图床探针可访问', r.ok && (r.headers.get('content-type') || '').startsWith('image/'),
      `${r.status} ${r.headers.get('content-type')} ${buf.length}B`);
  } catch (e) {
    push('图床探针可访问', false, String(e?.message || e).slice(0, 80));
  }
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}  ${c.detail || ''}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

const common = () => ['--host', 'pages', '--site-dir', SITE_DIR, '--base-url', BASE_URL,
  ...(a.prefix ? ['--prefix', a.prefix] : [])];
const a = args();

if (!a.cmd) { console.error('USAGE: listing-step.mjs doctor|check|publish|status|off [...]'); process.exit(2); }

if (a.cmd === 'doctor') process.exit(await doctor());

if (a.cmd === 'check') {
  if (!a.spec) { console.error('MISSING --spec'); process.exit(2); }
  process.exit(runPublish(['--spec', a.spec, '--stage', 'pagecheck', ...common(), ...(a.out ? ['--out', a.out] : [])]));
}

if (a.cmd === 'publish') {
  if (!a.spec) { console.error('MISSING --spec'); process.exit(2); }
  if (!a.apply) {
    console.error('闸门：真实导入会在店铺建商品并占用当日发品额度。确认无误后加 --apply。');
    process.exit(runPublish(['--spec', a.spec, '--stage', 'import', ...common()], { dry: true }));
  }
  process.exit(runPublish(['--spec', a.spec, '--stage', 'import', '--confirm-import', ...common()]));
}

if (a.cmd === 'status') {
  if (!a.spec && !a.title) { console.error('MISSING --spec 或 --title'); process.exit(2); }
  const extra = a.spec ? ['--spec', a.spec] : ['--spec', '/dev/null'];
  const argv = ['--stage', 'verify', ...(a.title ? ['--title', a.title] : [])];
  if (!a.spec) { console.error('status 需要 --spec（只用于取默认标题）；或用 publish 后的回执。'); process.exit(2); }
  process.exit(runPublish([...extra, ...argv]));
}

if (a.cmd === 'off') {
  if (!a.product) { console.error('MISSING --product'); process.exit(2); }
  if (!a.spec) { console.error('MISSING --spec（下架阶段需要店铺解析，沿用同一 spec）'); process.exit(2); }
  if (!a.apply) {
    console.error('闸门：下架会改店铺状态。确认后加 --apply。');
    process.exit(runPublish(['--spec', a.spec, '--stage', 'deactivate', '--id', a.product], { dry: true }) || 1);
  }
  process.exit(runPublish(['--spec', a.spec, '--stage', 'deactivate', '--id', a.product, '--confirm-deactivate']));
}

console.error('UNKNOWN COMMAND ' + a.cmd);
process.exit(2);
