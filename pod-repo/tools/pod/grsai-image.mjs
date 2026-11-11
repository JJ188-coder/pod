#!/usr/bin/env node
/**
 * grsai-image.mjs — Grsai 图片生成（nano-banana 系列），支持 4K 与异步轮询。
 *
 * 用法：
 *   node tools/pod/grsai-image.mjs --prompt "..." --model nano-banana-2.1 \
 *     --aspect 2:3 --size 4K --out <输出.png>
 *
 * 密钥从 ~/.zcode/minimax-video-studio/credentials.json 读取，不打印、不写日志。
 * 失败或 violation 不自动重试，避免重复计费。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const fail = (error, detail = '') => { console.log(JSON.stringify({ ok: false, error, detail }, null, 2)); process.exit(1); };

const credPath = path.join(os.homedir(), '.zcode/minimax-video-studio/credentials.json');
if (!fs.existsSync(credPath)) fail('CREDENTIALS_MISSING', credPath);
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
const apiKey = String(cred.apiKey || '').trim();
const base = String(cred.baseUrl || 'https://grsaiapi.com').replace(/\/$/, '');
if (!apiKey) fail('API_KEY_MISSING');

const prompt = arg('--prompt');
if (!prompt) fail('PROMPT_REQUIRED');
const model = arg('--model', 'nano-banana-2.1');
const aspectRatio = arg('--aspect', '2:3');
const imageSize = arg('--size', '4K');
const out = path.resolve(arg('--out', 'generated-images/jesus-4k.png'));
const refs = [];
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--ref' && process.argv[i + 1]) refs.push(process.argv[i + 1]);
}

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

async function post(body) {
  const res = await fetch(`${base}/v1/api/generate`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { fail('BAD_RESPONSE', text.slice(0, 300)); }
  if (!res.ok) fail(`HTTP_${res.status}`, JSON.stringify(data).slice(0, 400));
  return data;
}

async function getResult(id) {
  const res = await fetch(`${base}/v1/api/result?id=${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: 'unknown', raw: text.slice(0, 200) }; }
}

function pngSize(buf) {
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

console.error(`[grsai] submit model=${model} size=${imageSize} aspect=${aspectRatio}`);
const submitted = await post({ model, prompt, aspectRatio, imageSize, replyType: 'async', ...(refs.length ? { images: refs } : {}) });
const id = submitted.id;
if (!id) fail('NO_TASK_ID', JSON.stringify(submitted).slice(0, 300));
console.error(`[grsai] task=${id} status=${submitted.status || 'running'}`);

const started = Date.now();
let last = submitted;
let result = null;
while (Date.now() - started < 15 * 60 * 1000) {
  if (last.status === 'succeeded' && Array.isArray(last.results) && last.results[0]?.url) { result = last; break; }
  if (last.status === 'failed' || last.status === 'violation') fail(`TASK_${String(last.status).toUpperCase()}`, JSON.stringify(last).slice(0, 400));
  await new Promise((r) => setTimeout(r, 5000));
  last = await getResult(id);
  console.error(`[grsai] progress=${last.progress ?? '?'} status=${last.status}`);
}
if (!result) fail('TASK_TIMEOUT', id);

const url = result.results[0].url;
const dl = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!dl.ok) fail(`DOWNLOAD_${dl.status}`);
const buf = Buffer.from(await dl.arrayBuffer());
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
const dims = pngSize(buf);
const meta = {
  ok: true, provider: 'grsai', task_id: id, model, prompt, aspectRatio, imageSize,
  url, out, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  dimensions: dims, duration_ms: Date.now() - started,
};
fs.writeFileSync(`${out}.json`, JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
