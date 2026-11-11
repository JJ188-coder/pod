#!/usr/bin/env node
/**
 * image-host.mjs — 图床本地站点体检、部署与公开直链探针。
 *
 * 站点约定：<site>/<prefix>/<款号>/<file> → <base>/<prefix>/<款号>/<file>
 *
 * 用法：
 *   node image-host.mjs doctor [--site .local/pod-images-site] [--base https://img.example.com]
 *   node image-host.mjs deploy [--site ...] [--project pod-images] [--base ...]
 *   node image-host.mjs probe --base https://... <相对路径...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const cmd = process.argv[2] || 'doctor';
const site = path.resolve(arg('--site', '.local/pod-images-site'));
const project = arg('--project', 'pod-images');
function savedBase() {
  try { return fs.readFileSync(path.resolve('.local/pod-image-base'), 'utf8').trim(); } catch { return ''; }
}
const base = arg('--base', process.env.POD_IMAGE_BASE || savedBase()).replace(/\/$/, '');
const out = (data, code = 0) => { console.log(JSON.stringify(data, null, 2)); process.exit(code); };

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else acc.push(path.relative(site, full));
  }
  return acc;
}

async function probe(url) {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000), redirect: 'follow' });
    const buf = await res.arrayBuffer();
    return { url, status: res.status, type: res.headers.get('content-type'), bytes: buf.byteLength };
  } catch (e) {
    return { url, status: 0, error: String(e.message || e).slice(0, 120) };
  }
}

if (cmd === 'doctor') {
  const files = walk(site);
  const bad = files.filter((f) => !/\.(jpe?g|png|webp)$/i.test(f));
  const who = spawnSync('npx', ['wrangler', 'whoami'], { encoding: 'utf8', timeout: 40000 });
  const authed = /You are logged in|Account Name|associated with/i.test(`${who.stdout}${who.stderr}`) && !/not authenticated/i.test(`${who.stdout}${who.stderr}`);
  const baseProbe = base ? await probe(`${base}/`) : null;
  out({
    ok: fs.existsSync(site) && authed,
    site,
    site_exists: fs.existsSync(site),
    files: files.length,
    non_image_files: bad.slice(0, 10),
    wrangler_authenticated: authed,
    wrangler_hint: authed ? null : '运行 npx wrangler login',
    base: base || null,
    base_probe: baseProbe,
    next: !authed
      ? '先 npx wrangler login，再 deploy'
      : files.length === 0
        ? '站点目录为空：先把图片按 <prefix>/<款号>/ 放进去'
        : '可 deploy',
  });
} else if (cmd === 'deploy') {
  if (!fs.existsSync(site)) out({ ok: false, error: 'SITE_NOT_FOUND', site }, 2);
  const files = walk(site);
  if (!files.length) out({ ok: false, error: 'SITE_EMPTY', site }, 1);

  const env = { ...process.env, CI: 'true' };
  const create = spawnSync('npx', ['wrangler', 'pages', 'project', 'create', project, '--production-branch', 'main'], { encoding: 'utf8', timeout: 120000, env });
  const deploy = spawnSync('npx', ['wrangler', 'pages', 'deploy', site, '--project-name', project, '--branch', 'main', '--commit-dirty=true'], { encoding: 'utf8', timeout: 300000, env });
  const text = `${deploy.stdout || ''}\n${deploy.stderr || ''}`;
  const url = /(https:\/\/[a-z0-9.-]+\.pages\.dev)/i.exec(text)?.[1] || null;
  const projectUrl = url ? url.replace(/^https:\/\/[a-z0-9]+\./, 'https://') : null;
  const ok = deploy.status === 0 && Boolean(url);
  let probes = null;
  if (ok && base) probes = await Promise.all(files.slice(0, 5).map((f) => probe(`${base}/${f.split(path.sep).join('/')}`)));
  out({
    ok,
    project,
    site,
    file_count: files.length,
    deploy_url: url,
    base: base || projectUrl,
    project_create: { status: create.status, note: /already exists/i.test(`${create.stdout}${create.stderr}`) ? 'EXISTS' : undefined },
    probes,
    log_tail: text.split('\n').filter(Boolean).slice(-6),
  }, ok ? 0 : 1);
} else if (cmd === 'probe') {
  if (!base) out({ ok: false, error: 'BASE_REQUIRED' }, 2);
  const rest = process.argv.slice(3);
  const rels = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--base') { i += 1; continue; }
    if (rest[i].startsWith('--')) continue;
    rels.push(rest[i]);
  }
  if (!rels.length) out({ ok: false, error: 'PATHS_REQUIRED' }, 2);
  const results = await Promise.all(rels.map(async (rel) => probe(`${base}/${rel.replace(/^\/+/, '')}`)));
  out({ ok: results.every((r) => r.status === 200), base, results }, results.every((r) => r.status === 200) ? 0 : 1);
} else {
  out({ ok: false, error: 'UNKNOWN_COMMAND', usage: ['doctor', 'deploy', 'probe'] }, 2);
}
