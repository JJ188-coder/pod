#!/usr/bin/env node
/**
 * magpie-client.mjs — 极简 Magpie MCP 客户端（Streamable HTTP / JSON-RPC）
 * 只做三件事：提交一次 generate_image、按 pending id 续查、把结果落盘。
 * 同一意图重试必须复用 request_id；本模块不做自动重发。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = process.env.MAGPIE_URL || 'http://127.0.0.1:3425/mcp/magpie/image';

function parseBody(text, contentType) {
  if ((contentType || '').includes('text/event-stream')) {
    const lines = text.split('\n').filter((l) => l.startsWith('data:'));
    if (!lines.length) throw new Error('MAGPIE_EMPTY_SSE');
    return JSON.parse(lines[lines.length - 1].slice(5).trim());
  }
  return JSON.parse(text);
}

async function rpc(method, params, { timeoutMs = 180000 } = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MAGPIE_HTTP_${res.status}: ${text.slice(0, 200)}`);
  const msg = parseBody(text, res.headers.get('content-type'));
  if (msg.error) throw new Error(`MAGPIE_RPC: ${JSON.stringify(msg.error).slice(0, 300)}`);
  return msg.result;
}

export async function generate({ prompt, referenceImages = [], n = 1, size, quality, background, model, timeoutMs = 600000 }) {
  const args = { prompt, n };
  if (referenceImages.length) args.reference_images = referenceImages;
  if (size) args.size = size;
  if (quality) args.quality = quality;
  if (background) args.background = background;
  if (model) args.model = model;

  let result = await rpc('tools/call', { name: 'generate_image', arguments: args });
  const started = Date.now();
  let pending = result?._meta?.['usemagpie.ai/pending'] || null;
  let polls = 0;
  while (pending && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4000));
    result = await rpc('tools/call', { name: 'generation_result', arguments: { id: pending } });
    pending = result?._meta?.['usemagpie.ai/pending'] || null;
    polls += 1;
  }
  if (pending) throw new Error(`MAGPIE_TIMEOUT pending=${pending} polls=${polls}`);
  return { result, polls };
}

/** 从 MCP result 里取图片：优先 base64 内容块，其次临时 URL。 */
export async function saveResult(result, outPath) {
  const files = result?._meta?.['usemagpie.ai/files'] || [];
  const imageBlock = (result?.content || []).find((c) => c?.type === 'image' && c?.data);
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  if (imageBlock) {
    await fs.writeFile(outPath, Buffer.from(imageBlock.data, 'base64'));
    return { saved: outPath, via: 'content', mime: imageBlock.mimeType || null };
  }
  if (files[0]?.url) {
    const res = await fetch(files[0].url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`MAGPIE_URL_${res.status}`);
    await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return { saved: outPath, via: 'url', mime: res.headers.get('content-type') };
  }
  throw new Error(`MAGPIE_NO_IMAGE content=${JSON.stringify(result?.content || []).slice(0, 200)}`);
}

export async function health() {
  const result = await rpc('tools/list', {});
  const names = (result?.tools || []).map((t) => t.name);
  return { ok: names.includes('generate_image'), tools: names };
}
