#!/usr/bin/env node
/** Offline test entry: an OS sandbox blocks external networking for every child. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'image-studio-offline-'));
const profile = path.join(temporary, 'offline.sb');
const home = path.join(temporary, 'home');
fs.mkdirSync(home);
fs.writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
`);
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  IMAGE2_BASE_URL: 'http://127.0.0.1:9', IMAGE2_API_KEY: 'offline-test-key', IMAGE2_AUTH_SCHEME: 'bearer',
  IMAGE2_MODEL: 'codex/gpt-image-2', IMAGE2_DATA_DIR: path.join(temporary, 'image2'),
  MAGPIE_IMAGE_URL: 'http://127.0.0.1:9/mcp/magpie/image', MAGPIE_IMAGE_DATA_DIR: path.join(temporary, 'magpie'),
  ZCODE_PROJECT_DIR: path.join(temporary, 'project'), PYTHONDONTWRITEBYTECODE: '1',
  IMAGE_STUDIO_OFFLINE_TEST: '1' };
for (const key of Object.keys(env)) {
  if (/^(?:https?|all|no)_proxy$/i.test(key) || /^(?:IMAGE2_CONFIG|MAGPIE_URL|MAGPIE_IMAGE_ENDPOINT|NODE_OPTIONS|NODE_PATH)$/.test(key)) delete env[key];
}
function run(program, args, label) {
  const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, program, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw Error(`${label} failed: ${result.error?.message ?? result.status}`);
}
const nodeCanary = `
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
const server=net.createServer(s=>s.end());
await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
await new Promise((r,j)=>{const s=net.connect({host:'127.0.0.1',port:server.address().port});s.once('connect',()=>{s.destroy();r();});s.once('error',j);});
const blocked=await new Promise(r=>{const s=net.connect({host:'203.0.113.1',port:443});s.setTimeout(1500);s.once('connect',()=>{s.destroy();r('UNEXPECTED_CONNECT');});s.once('timeout',()=>{s.destroy();r('UNPROVEN_TIMEOUT');});s.once('error',e=>r(e.code));});
await new Promise(r=>server.close(r));
assert.ok(['EPERM','EACCES'].includes(blocked),'External socket not demonstrably blocked: '+blocked);
const child=spawnSync('python3',['-I','-B','-c',
  'import socket,errno; s=socket.socket(); s.settimeout(1); result=s.connect_ex(("203.0.113.1",443)); assert result in (errno.EPERM,errno.EACCES), result'],{encoding:'utf8'});
assert.equal(child.status,0,child.stderr);
console.log('ISOLATION_OK: loopback works; Node and Python child external sockets denied');
`;
try {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    throw Error('OS network isolation unavailable; refusing network-capable tests. No tests started.');
  }
  run(process.execPath, ['--input-type=module', '-e', nodeCanary], 'Network isolation canary');
  if (process.argv.includes('--canary-only')) {
    console.log('Only isolation checked; no provider tests started.');
  } else {
    run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], 'Offline TypeScript build');
    run(path.join(root, 'node_modules/.bin/esbuild'), ['src/server.ts', '--bundle', '--platform=node', '--format=esm',
      '--target=node22', '--external:node:sqlite', '--outfile=dist/server.bundle.mjs'], 'Offline bundle build');
    const tests = fs.readdirSync(path.join(root, 'tests')).filter((p) => p.endsWith('.test.mjs')).sort().map((p) => `tests/${p}`);
    run(process.execPath, ['--test', '--test-concurrency=1', ...tests], 'Node offline tests');
    run('python3', ['-I', '-B', 'tests/test_image2_mcp.py'], 'Python offline tests');
    const guard = path.resolve(root, '../../.agents/skills/pod-execution-guard/scripts/guard.test.mjs');
    if (fs.existsSync(guard)) run(process.execPath, ['--test', guard], 'Project guard offline tests');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
