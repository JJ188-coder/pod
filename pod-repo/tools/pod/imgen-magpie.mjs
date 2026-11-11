#!/usr/bin/env node
/**
 * imgen-magpie.mjs — 让 tiktok-tshirt 的 imgen 调用面直接走本机 Magpie。
 *
 * tiktok-tshirt 的 CLI 契约：
 *   node <cli> <prompt> -o <out> -s auto -q <quality> -m <model> -e <effort> \
 *     --image-model <image_model> [-i <ref> ...]
 *
 * 用法：设置 IMGEN_CLI=/绝对路径/imgen-magpie.mjs 后照常调用。
 */
import fs from 'node:fs/promises';
import { generate, saveResult } from './magpie-client.mjs';

const argv = process.argv.slice(2);
const args = [...argv];
const take = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, 2);
  return v;
};
const out = take('-o');
const quality = take('-q');
const size = take('-s');
const imageModel = take('--image-model');
take('-m');
take('-e');
const refs = [];
for (;;) {
  const i = args.indexOf('-i');
  if (i < 0) break;
  refs.push(args[i + 1]);
  args.splice(i, 2);
}
const prompt = args.join(' ').trim();

if (!prompt) { console.error('PROMPT_REQUIRED'); process.exit(2); }
if (!out) { console.error('OUTPUT_REQUIRED'); process.exit(2); }

try {
  const { result, polls } = await generate({
    prompt,
    referenceImages: refs.filter(Boolean),
    n: 1,
    size: size && size !== 'auto' ? size : undefined,
    quality: quality || undefined,
    model: imageModel || undefined,
  });
  const saved = await saveResult(result, out);
  console.log(JSON.stringify({ ok: true, out, via: saved.via, polls }));
} catch (error) {
  console.error(`IMGEN_MAGPIE_FAILED: ${String(error.message || error).slice(0, 300)}`);
  process.exit(1);
}
