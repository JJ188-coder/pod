#!/usr/bin/env node
/**
 * marketing-pack.mjs — 生成一款的营销图包：1 张模特主图 + 8 张变体 + 3:4 上传图。
 *
 * 用法：
 *   node tools/pod/marketing-pack.mjs --pack <商品包> --code UKIYOE1 \
 *     --reference <白底图案 4K> --theme "ola japonesa estilo ukiyo-e" [--color Blanco]
 *
 * 输出：<pack>/营销图/upload/H01..H09.jpg 与 marketing-manifest.json。
 * 失败不自动重试；已存在的输出保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { generate, saveResult } from './magpie-client.mjs';

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const pack = path.resolve(arg('--pack'));
const code = arg('--code');
const reference = path.resolve(arg('--reference'));
const theme = arg('--theme');
const color = arg('--color', 'Blanco');
if (!code || !theme) { console.log(JSON.stringify({ ok: false, error: 'CODE_AND_THEME_REQUIRED' })); process.exit(2); }
if (!fs.existsSync(pack)) { console.log(JSON.stringify({ ok: false, error: 'PACK_NOT_FOUND', pack })); process.exit(2); }
if (!fs.existsSync(reference)) { console.log(JSON.stringify({ ok: false, error: 'REFERENCE_MISSING', reference })); process.exit(2); }

const dir = path.join(pack, '营销图');
const variants = path.join(dir, 'variants');
const upload = path.join(dir, 'upload');
fs.mkdirSync(variants, { recursive: true });
fs.mkdirSync(upload, { recursive: true });

const prompt = `Realistic e-commerce product photo: a young male model wearing a plain ${color.toLowerCase()} crew-neck cotton T-shirt, front view, centered, chest facing camera. Print this exact artwork large on the chest: ${theme}, identical proportions and details. Screen-printed on cotton, following the fabric folds slightly. Clean light-gray studio background, soft even light, sharp focus, no text, no watermark, no border.`;

let saved;
try {
  const r = await generate({ prompt, referenceImages: [reference], n: 1, size: '1024x1536', quality: 'high' });
  saved = await saveResult(r.result, path.join(dir, 'mockup.png'));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: 'MOCKUP_FAILED', detail: String(error.message || error).slice(0, 300) }));
  process.exit(1);
}

const py = (script, env = {}) => spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });

py(`from PIL import Image; Image.open(r"${path.join(dir, 'mockup.png')}").convert("RGB").save(r"${path.join(variants, 'H01.jpg')}", quality=92)`);

const jobs = [
  ['scene', 'H02-street.png', 'clean urban street at golden hour'],
  ['scene', 'H03-studio.png', 'minimal warm studio backdrop'],
  ['angle', 'H04-angle-left.png', 'camera moved 25 degrees to the left'],
  ['angle', 'H05-angle-right.png', 'camera moved 25 degrees to the right'],
  ['detail', 'H06-print.png', 'tight close-up of the printed artwork'],
  ['detail', 'H07-fabric.png', 'macro detail of cotton fabric and ink texture'],
  ['flat', 'H08-flat.png', 'flat lay on light oak wood'],
  ['scene', 'H09-lifestyle.png', 'rooftop at sunset, city skyline'],
];
const failures = [];
for (const [mode, name, note] of jobs) {
  const r = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), 'sample-variant.mjs'),
    '--image', path.join(dir, 'mockup.png'), '--mode', mode,
    '--out', path.join(variants, name), '--note', note,
  ], { encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) failures.push({ name, error: `VARIANT_EXIT_${r.status}`, stderr: (r.stderr || '').slice(-200) });
}

const conv = py(`
import os
from PIL import Image, ImageFilter
pack = os.environ['PACK']; src = os.path.join(pack,'营销图/variants'); out = os.path.join(pack,'营销图/upload')
names = ['H01.jpg','H02-street.png','H03-studio.png','H04-angle-left.png','H05-angle-right.png','H06-print.png','H07-fabric.png','H08-flat.png','H09-lifestyle.png']
for i,n in enumerate(names,1):
    p = os.path.join(src,n)
    if not os.path.exists(p): print('MISSING',n); continue
    im = Image.open(p).convert('RGB'); W,H = im.size; tw = int(H*0.75)+1
    if tw <= W:
        left = (W-tw)//2; im2 = im.crop((left,0,left+tw,H))
    else:
        bg = im.resize((tw,H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(24)); bg.paste(im,((tw-W)//2,0)); im2 = bg
    im2.save(os.path.join(out,f'H{i:02d}.jpg'), quality=92, optimize=True)
print('converted')
`, { PACK: pack });

const images = fs.existsSync(upload) ? fs.readdirSync(upload).filter((f) => f.endsWith('.jpg')).sort() : [];
const manifest = {
  schema: 'pod-marketing-manifest-v1', code, theme, color,
  reference: { path: reference, sha256: crypto.createHash('sha256').update(fs.readFileSync(reference)).digest('hex') },
  mockup: { path: saved.saved, sha256: crypto.createHash('sha256').update(fs.readFileSync(saved.saved)).digest('hex') },
  prompt, prompt_sha256: crypto.createHash('sha256').update(prompt).digest('hex'),
  images, failures, converted: conv.status === 0,
  visual_review: 'required',
  note: '图案保真是提示词约束，不是像素级证明；上架前人工对比印花。',
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(dir, 'marketing-manifest.json'), JSON.stringify(manifest, null, 2));
const ok = images.length === 9 && failures.length === 0 && conv.status === 0;
console.log(JSON.stringify({ ok, images: images.length, failures, manifest: path.join(dir, 'marketing-manifest.json') }, null, 2));
process.exit(ok ? 0 : 1);
