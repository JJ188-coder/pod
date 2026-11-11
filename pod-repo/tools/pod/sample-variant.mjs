#!/usr/bin/env node
/**
 * sample-variant.mjs — 用 EchoTik 商品样图做「保留衣服与图案」的展示图微调。
 *
 * 用法：
 *   node sample-variant.mjs --image <样图> --mode scene|angle|detail|flat \
 *     [--out <输出.png>] [--size 1024x1024] [--note "海边日落"] [--json]
 *
 * 边界：只改背景/光线/机位；不承诺图案逐像素一致，产物必须人工过目。
 * 不做自动重试；失败就停，避免重复计费。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { generate, saveResult, health } from './magpie-client.mjs';

const MODES = {
  scene: 'Keep the person, the T-shirt, its color and every pixel of the printed artwork exactly as in the reference. Replace only the background with a clean outdoor lifestyle scene. Keep the same pose, framing and camera angle. Natural light, realistic shadows. Do not redraw, restyle, translate or alter the print in any way.',
  angle: 'Keep the person, the T-shirt, its color and every pixel of the printed artwork exactly as in the reference. Change the camera to a three-quarter view about 20 degrees to the side, same clothing and print, same body shape. Realistic studio light. Do not modify the artwork, its proportions or text.',
  detail: 'Keep the T-shirt and the printed artwork exactly as in the reference. Move closer into a chest close-up so the print fills most of the frame, no distortion, sharp fabric texture. Do not redraw or restyle the artwork.',
  flat: 'Keep the T-shirt shape, color and the printed artwork exactly as in the reference. Turn it into a clean flat-lay on a neutral light background, top-down, soft shadow, no person. Do not alter the print.',
};

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const fail = (error, detail = '') => { console.log(JSON.stringify({ ok: false, error, detail }, null, 2)); process.exit(1); };

const image = arg('--image');
const mode = arg('--mode', 'scene');
const note = arg('--note', '');
const size = arg('--size', '');
if (!image) fail('IMAGE_REQUIRED');
if (!MODES[mode]) fail('MODE_INVALID', Object.keys(MODES).join('|'));

const src = path.resolve(image);
try { await fs.access(src); } catch { fail('IMAGE_NOT_FOUND', src); }

const buf = await fs.readFile(src);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const ext = path.extname(src) || '.png';
const out = path.resolve(arg('--out', path.join(path.dirname(src), `${path.basename(src, ext)}-${mode}.png`)));

const h = await health();
if (!h.ok) fail('MAGPIE_UNAVAILABLE', h.tools.join(','));

const prompt = `${MODES[mode]}${note ? ` Scene note: ${note}.` : ''} The reference image is the product sample: preserve the garment and its printed design, only adjust the requested presentation.`;

const started = Date.now();
let res;
try {
  res = await generate({ prompt, referenceImages: [src], n: 1, size: size || undefined });
} catch (e) {
  fail('GENERATE_FAILED', String(e.message || e).slice(0, 300));
}
let saved;
try {
  saved = await saveResult(res.result, out);
} catch (e) {
  fail('SAVE_FAILED', String(e.message || e).slice(0, 300));
}

const outBuf = await fs.readFile(out);
const manifest = {
  ok: true,
  mode,
  source: { path: src, sha256: sha, bytes: buf.length },
  output: { path: out, via: saved.via, bytes: outBuf.length, sha256: crypto.createHash('sha256').update(outBuf).digest('hex') },
  prompt,
  prompt_sha256: crypto.createHash('sha256').update(prompt).digest('hex'),
  polls: res.polls,
  duration_ms: Date.now() - started,
  visual_review: 'required',
  note: '保留图案是提示词约束，不是像素级证明；上架前必须人工对比印花。',
};
await fs.writeFile(`${out}.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
