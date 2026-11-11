#!/usr/bin/env node
/**
 * Slack pattern receiver
 *
 * Reads one exact PNG attachment from the user's already logged-in Slack page
 * through the existing Chrome CDP endpoint (127.0.0.1:9222). It never reads or
 * exports cookies, tokens, localStorage or Authorization headers, and it never
 * sends a Slack message.
 *
 * The receiver binds four facts before a file may enter the POD pipeline:
 *   1. the exact Slack target page and conversation;
 *   2. the message text and original file URL found in that page;
 *   3. the exact bytes, re-read from Slack through the page's own session;
 *   4. PNG dimensions, alpha statistics, alpha bbox and SHA-256.
 *
 * Any failed gate returns status=blocked. The downloaded file and receipt are
 * kept for inspection; nothing is deleted and nothing is promoted.
 *
 * CLI:
 *   node slack-pattern-receiver.mjs targets
 *   node slack-pattern-receiver.mjs discover --target-id ID --file-name NAME
 *   node slack-pattern-receiver.mjs capture --conversation-url URL --file-name NAME --output-dir DIR
 *   node slack-pattern-receiver.mjs verify --file PATH [--min-long-edge 3840]
 *   node slack-pattern-receiver.mjs mcp
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const SLACK_ORIGIN = 'https://app.slack.com';
const FILE_ORIGIN = 'https://files.slack.com';
const MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MIN_LONG_EDGE = 3840;
const DEFAULT_MIN_TRANSPARENT = 0.01;
const DEFAULT_MAX_SEMI = 0.08;
const ALPHA_BBOX_THRESHOLD = 16;

const coded = (code, message) => Object.assign(new Error(message), { code });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function assertPlainName(name) {
  if (typeof name !== 'string' || name !== name.trim() || !name || name.length > 200) {
    throw coded('INVALID_FILE_NAME', 'file_name must be a short plain name');
  }
  if (name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) {
    throw coded('INVALID_FILE_NAME', 'file_name must not contain path separators or control characters');
  }
  if (!/\.png$/i.test(name)) throw coded('INVALID_FILE_NAME', 'this receiver accepts PNG only');
  return name;
}

function assertConversationUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw coded('INVALID_CONVERSATION_URL', 'invalid conversation URL'); }
  if (url.origin !== SLACK_ORIGIN || url.username || url.password || url.search || url.hash) {
    throw coded('INVALID_CONVERSATION_URL', 'conversation URL must be https://app.slack.com/client/<team>/<channel>');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'client' || !/^[A-Z0-9]{6,}$/.test(parts[1]) || !/^[A-Z0-9]{6,}$/.test(parts[2])) {
    throw coded('INVALID_CONVERSATION_URL', 'conversation URL must name one team and one channel');
  }
  return { url, team: parts[1], channel: parts[2] };
}

function assertFileUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw coded('INVALID_FILE_URL', 'invalid file URL'); }
  if (url.origin !== FILE_ORIGIN || url.username || url.password || url.search || url.hash) {
    throw coded('INVALID_FILE_URL', 'file URL must be an exact https://files.slack.com/files-pri/... URL');
  }
  if (!url.pathname.startsWith('/files-pri/') || !url.pathname.endsWith('.png')) {
    throw coded('INVALID_FILE_URL', 'file URL must point at an original PNG under /files-pri/');
  }
  return url.href;
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

async function listTargets() {
  const response = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw coded('CDP_HTTP_ERROR', `CDP /json/list HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw coded('CDP_SCHEMA_ERROR', 'CDP target list is not an array');
  return rows.filter((row) => row && row.type === 'page');
}

function slackTargets(targets) {
  return targets.filter((row) => {
    try {
      const url = new URL(row.url);
      return url.origin === SLACK_ORIGIN && url.pathname.startsWith('/client/');
    } catch { return false; }
  });
}

function chooseTarget(targets, { targetId, conversation } = {}) {
  const pages = slackTargets(targets);
  if (targetId) {
    const hit = pages.find((page) => page.id === targetId);
    if (!hit) throw coded('SLACK_TARGET_NOT_FOUND', 'the requested Slack target is not open');
    return hit;
  }
  const scoped = conversation ? pages.filter((page) => {
    const parts = new URL(page.url).pathname.split('/').filter(Boolean);
    return parts[0] === 'client' && parts[1] === conversation.team
      && (parts.length === 2 || parts[2] === conversation.channel || parts[2] === 'search');
  }) : pages;
  if (scoped.length === 1) return scoped[0];
  if (!scoped.length) throw coded('SLACK_TARGET_NOT_FOUND', 'no matching Slack page is open');
  throw coded('SLACK_TARGET_AMBIGUOUS', 'more than one Slack page matches; pass target_id');
}

function connect(wsUrl, timeoutMs = 8000) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(coded('CDP_CONNECT_TIMEOUT', 'CDP connection timed out')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolveConnect(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(coded('CDP_CONNECT_FAILED', 'CDP connection failed')); }, { once: true });
  });
}

function rpc(ws, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolveRpc, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(coded('CDP_CALL_TIMEOUT', `${method} timed out`)), timeoutMs);
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.error) return reject(coded('CDP_PROTOCOL_ERROR', JSON.stringify(message.error).slice(0, 300)));
      resolveRpc(message.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression, timeoutMs = 30000) {
  const result = await rpc(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: false,
  }, timeoutMs);
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page evaluation failed';
    throw coded('PAGE_EVALUATION_FAILED', String(detail).slice(0, 400));
  }
  return result?.result?.value;
}

async function clickAt(ws, point) {
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function pressEnter(ws) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  // Slack's search combobox commits on the text-input path. A bare keyDown
  // closes the dialog, so send rawKeyDown + char + keyUp like a real keyboard.
  await rpc(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await rpc(ws, 'Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' });
  await rpc(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function waitFor(ws, expression, predicate, { timeoutMs = 12000, intervalMs = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(ws, expression);
    if (predicate(value)) return value;
    await sleep(intervalMs);
  }
  throw coded('PAGE_WAIT_TIMEOUT', `timed out waiting for ${label}`);
}

/* ------------------------------------------------------------------ */
/* Page-side helpers (returned as JSON-safe values)                    */
/* ------------------------------------------------------------------ */

const pageFindVisibleFile = `(() => {
  const fileName = %NAME%;
  const visible = (el) => Boolean(el && el.getClientRects().length);
  const originals = [...document.querySelectorAll('a[href*="/files-pri/"], img[src*="/files-pri/"]')]
    .filter(visible)
    .filter((el) => {
      const url = new URL(el.href || el.src);
      const alt = (el.alt || el.textContent || '').trim();
      return alt === fileName || url.pathname.toLowerCase().endsWith('/' + fileName.toLowerCase());
    })
    .map((el) => new URL(el.href || el.src))
    .filter((u) => u.origin === '${FILE_ORIGIN}' && u.pathname.endsWith('.png'))
    .map((u) => u.pathname);
  const cards = [...document.querySelectorAll('.c-file_entity, [data-qa="file_name"]')]
    .filter(visible)
    .filter((el) => (el.innerText || '').includes(fileName))
    .map((el) => {
      const card = el.closest('.c-file_entity') || el;
      const rect = card.getBoundingClientRect();
      const message = card.closest('[data-qa="search_result"], [data-qa="message_content"], .c-message_kit__message, [data-qa="message"]');
      return {
        text: (message?.innerText || card.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 800),
        context: (message?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 800),
        point: rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } : null
      };
    });
  const thumbs = [...document.querySelectorAll('img[alt="' + fileName + '"]')]
    .filter(visible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return { src: new URL(el.src).pathname, point: rect.width > 0 ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } : null };
    });
  return { originals, cards, thumbs, path: location.pathname, hasSearchBox: Boolean(document.querySelector('[data-qa="top_nav_search"]')) };
})()`;

const pageCloseSecondaryView = `(() => {
  const panel = document.querySelector('.p-view_contents--secondary');
  if (!panel) return { present: false };
  const close = panel.querySelector('[data-qa="close_flexpane"]');
  if (!close) return { present: true, clicked: false };
  close.click();
  return { present: true, clicked: true };
})()`;

const pageSecondaryViewGone = `(() => !document.querySelector('.p-view_contents--secondary'))()`;

const pageInsertSearchText = `(() => {
  const fileName = %NAME%;
  const box = document.querySelector('[role="combobox"][aria-label="查询"]');
  if (!box) return { ok: false, error: 'SEARCH_BOX_NOT_FOUND' };
  box.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(box);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, fileName);
  return { ok: true, text: box.innerText || '' };
})()`;

const pageEnsureSearchBox = `(() => {
  const existing = document.querySelector('[role="combobox"][aria-label="查询"]');
  if (existing) {
    existing.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(existing);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);
    return { ok: true, existing: true, text: existing.innerText || '' };
  }
  const button = document.querySelector('[data-qa="top_nav_search"]');
  if (!button) return { ok: false, error: 'SEARCH_BUTTON_NOT_FOUND' };
  const rect = button.getBoundingClientRect();
  if (!rect.width || !rect.height) return { ok: false, error: 'SEARCH_BUTTON_NOT_VISIBLE' };
  // Slack's search toggle needs a trusted pointer event. Return its geometry so
  // the caller can click through CDP Input instead of a synthetic .click().
  return { ok: true, existing: false, point: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } };
})()`;

const pageSearchBoxReady = `(() => {
  const box = document.querySelector('[role="combobox"][aria-label="查询"]');
  if (!box) return { ready: false };
  box.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(box);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('delete', false, null);
  return { ready: true, text: box.innerText || '' };
})()`;

const pageReadSearchState = `(() => {
  const box = document.querySelector('[role="combobox"][aria-label="查询"]');
  const body = document.body?.innerText || '';
  return { hasBox: Boolean(box), text: box?.innerText || '', body: body.slice(0, 2500) };
})()`;

const pageMessageContextForFile = `(() => {
  const fileName = %NAME%;
  const nodes = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim() === fileName);
  for (const node of nodes) {
    const message = node.closest('[data-qa="message_content"], .c-message_kit__message, [data-qa="message"]');
    if (message) return (message.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 800);
  }
  return '';
})()`;

/* ------------------------------------------------------------------ */
/* Download through the page session                                   */
/* ------------------------------------------------------------------ */

async function downloadViaPage(ws, fileUrl) {
  const first = await evaluate(ws, `(async () => {
    try {
      const r = await fetch(${JSON.stringify(fileUrl)}, { credentials: 'include', headers: { Range: 'bytes=0-1023' } });
      const b = await r.arrayBuffer();
      const range = r.headers.get('content-range') || '';
      const m = /bytes \\d+-\\d+\\/(\\d+)/.exec(range);
      return { ok: r.ok, status: r.status, type: r.headers.get('content-type'), total: m ? Number(m[1]) : null, bytes: b.byteLength };
    } catch (error) { return { ok: false, error: String(error).slice(0, 200) }; }
  })()`);
  if (!first?.ok) throw coded('SLACK_FILE_FETCH_FAILED', first?.error || `HTTP ${first?.status}`);
  if (!first.total || first.total < 1) throw coded('SLACK_FILE_SIZE_UNKNOWN', 'Slack did not return a Content-Range total');
  if (first.total > MAX_BYTES) throw coded('SLACK_FILE_TOO_LARGE', `file is ${first.total} bytes; limit ${MAX_BYTES}`);

  const chunks = [];
  for (let start = 0; start < first.total; start += CHUNK_BYTES) {
    const end = Math.min(first.total - 1, start + CHUNK_BYTES - 1);
    const part = await evaluate(ws, `(async () => {
      try {
        const r = await fetch(${JSON.stringify(fileUrl)}, { credentials: 'include', headers: { Range: 'bytes=${start}-${end}' } });
        if (!r.ok) return { ok: false, status: r.status };
        const b = await r.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(b);
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { ok: true, status: r.status, bytes: bytes.length, base64: btoa(binary) };
      } catch (error) { return { ok: false, error: String(error).slice(0, 200) }; }
    })()`, 60000);
    if (!part?.ok) throw coded('SLACK_FILE_FETCH_FAILED', part?.error || `HTTP ${part?.status} at byte ${start}`);
    const data = Buffer.from(part.base64, 'base64');
    if (data.length !== part.bytes || data.length !== end - start + 1) {
      throw coded('SLACK_FILE_RANGE_MISMATCH', `range ${start}-${end} returned ${data.length} bytes`);
    }
    chunks.push(data);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== first.total) throw coded('SLACK_FILE_SIZE_MISMATCH', `expected ${first.total}, got ${bytes.length}`);
  return { bytes, contentType: first.type, total: first.total };
}

/* ------------------------------------------------------------------ */
/* PNG verification                                                    */
/* ------------------------------------------------------------------ */

function decodePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) throw coded('NOT_PNG', 'missing PNG signature');
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let transparency = null;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw coded('PNG_TRUNCATED', `chunk ${type} exceeds file size`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (length !== 13) throw coded('PNG_BAD_IHDR', 'IHDR must be 13 bytes');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  if (!ihdr) throw coded('PNG_NO_IHDR', 'missing IHDR');
  if (ihdr.interlace !== 0) throw coded('PNG_INTERLACED_UNSUPPORTED', 'interlaced PNG is not supported by this verifier');
  if (ihdr.compression !== 0 || ihdr.filter !== 0) throw coded('PNG_UNSUPPORTED', 'unsupported PNG compression/filter method');
  if (!idat.length) throw coded('PNG_NO_IDAT', 'missing image data');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw coded('PNG_COLOR_TYPE_UNSUPPORTED', `color type ${ihdr.colorType}`);
  if (ihdr.bitDepth !== 8) throw coded('PNG_BIT_DEPTH_UNSUPPORTED', `bit depth ${ihdr.bitDepth}; only 8-bit is verified here`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = ihdr.width * bpp;
  if (raw.length < (stride + 1) * ihdr.height) throw coded('PNG_PIXEL_DATA_SHORT', 'inflated pixel data is shorter than expected');

  const out = Buffer.alloc(stride * ihdr.height);
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const previous = y ? out.subarray((y - 1) * stride, y * stride) : null;
    const target = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? target[x - bpp] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= bpp ? previous[x - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = row[x]; break;
        case 1: value = row[x] + left; break;
        case 2: value = row[x] + up; break;
        case 3: value = row[x] + Math.floor((left + up) / 2); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = row[x] + predictor;
          break;
        }
        default: throw coded('PNG_FILTER_UNSUPPORTED', `filter ${filter}`);
      }
      target[x] = value & 0xff;
    }
  }

  const hasAlpha = ihdr.colorType === 6 || ihdr.colorType === 4 || (ihdr.colorType === 3 && Boolean(transparency));
  const alphaAt = (x, y) => {
    const index = (y * ihdr.width + x) * bpp;
    if (ihdr.colorType === 6) return out[index + 3];
    if (ihdr.colorType === 4) return out[index + 1];
    if (ihdr.colorType === 3) {
      const paletteIndex = out[index];
      return transparency && paletteIndex < transparency.length ? transparency[paletteIndex] : 255;
    }
    return 255;
  };
  const rgbAt = (x, y) => {
    const index = (y * ihdr.width + x) * bpp;
    if (ihdr.colorType === 0 || ihdr.colorType === 4) {
      const gray = out[index];
      return [gray, gray, gray];
    }
    if (ihdr.colorType === 3) {
      const paletteIndex = out[index] * 3;
      if (!palette || paletteIndex + 2 >= palette.length) return [0, 0, 0];
      return [palette[paletteIndex], palette[paletteIndex + 1], palette[paletteIndex + 2]];
    }
    return [out[index], out[index + 1], out[index + 2]];
  };

  let zero = 0, opaque = 0, semi = 0, nearWhite = 0;
  let left = ihdr.width, top = ihdr.height, right = -1, bottom = -1;
  for (let y = 0; y < ihdr.height; y += 1) {
    for (let x = 0; x < ihdr.width; x += 1) {
      const alpha = alphaAt(x, y);
      if (alpha === 0) zero += 1;
      else if (alpha === 255) opaque += 1;
      else semi += 1;
      if (alpha >= ALPHA_BBOX_THRESHOLD) {
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
      if (alpha === 255) {
        const [r, g, b] = rgbAt(x, y);
        if (r >= 245 && g >= 245 && b >= 245) nearWhite += 1;
      }
    }
  }
  const total = ihdr.width * ihdr.height;
  return {
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.bitDepth,
    colorType: ihdr.colorType,
    hasAlphaChannel: hasAlpha,
    pixels: total,
    alpha: {
      transparentPixels: zero,
      opaquePixels: opaque,
      semiTransparentPixels: semi,
      transparentRatio: zero / total,
      opaqueRatio: opaque / total,
      semiRatio: semi / total,
      nearWhiteOpaquePixels: nearWhite,
      bbox: right >= 0 ? [left, top, right + 1, bottom + 1] : null,
      bboxThreshold: ALPHA_BBOX_THRESHOLD,
    },
  };
}

function verifyPngBytes(bytes, options = {}) {
  const minLongEdge = Number.isInteger(options.minLongEdge) ? options.minLongEdge : DEFAULT_MIN_LONG_EDGE;
  const minTransparentRatio = Number.isFinite(options.minTransparentRatio) ? options.minTransparentRatio : DEFAULT_MIN_TRANSPARENT;
  const maxSemiRatio = Number.isFinite(options.maxSemiRatio) ? options.maxSemiRatio : DEFAULT_MAX_SEMI;
  const requireTransparency = options.requireTransparency !== false;
  const digest = sha256(bytes);
  const png = decodePng(bytes);
  const longEdge = Math.max(png.width, png.height);
  const shortEdge = Math.min(png.width, png.height);
  const gates = [];
  const gate = (name, passed, detail) => gates.push({ name, passed, detail });

  if (options.expectedSha256 && digest !== options.expectedSha256) {
    gate('expected_sha256', false, `expected ${options.expectedSha256}, got ${digest}`);
  } else {
    gate('expected_sha256', true, options.expectedSha256 ? 'matches expected SHA-256' : 'no expected SHA-256 supplied');
  }
  gate('min_long_edge', longEdge >= minLongEdge, `long edge ${longEdge}px; required >= ${minLongEdge}px`);
  if (requireTransparency) {
    gate('alpha_channel', png.hasAlphaChannel, png.hasAlphaChannel ? 'PNG carries alpha' : 'PNG has no alpha channel');
    gate('transparent_background', png.alpha.transparentRatio >= minTransparentRatio,
      `transparent ${(png.alpha.transparentRatio * 100).toFixed(2)}%; required >= ${(minTransparentRatio * 100).toFixed(2)}%`);
    gate('semi_transparent_ratio', png.alpha.semiRatio <= maxSemiRatio,
      `semi-transparent ${(png.alpha.semiRatio * 100).toFixed(2)}%; allowed <= ${(maxSemiRatio * 100).toFixed(2)}%`);
  }
  const blocked = gates.filter((item) => !item.passed);
  return {
    status: blocked.length ? 'blocked' : 'pass',
    sha256: digest,
    bytes: bytes.length,
    width: png.width,
    height: png.height,
    longEdge,
    shortEdge,
    is4K: longEdge >= DEFAULT_MIN_LONG_EDGE,
    isNative4096: longEdge >= 4096,
    bitDepth: png.bitDepth,
    colorType: png.colorType,
    hasAlphaChannel: png.hasAlphaChannel,
    alpha: png.alpha,
    gates,
    blockedReasons: blocked.map((item) => item.name),
    verifiedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

async function resolveFileInPage(ws, { fileName, timeoutMs = 20000 }) {
  const debug = process.env.SLACK_RECEIVER_DEBUG === '1' ? (step, value) => console.error(JSON.stringify({ step, value })) : () => {};
  const findExpr = pageFindVisibleFile.replace('%NAME%', JSON.stringify(fileName));
  let state = await evaluate(ws, findExpr);
  debug('initial', { originals: state.originals.length, cards: state.cards.length, path: state.path });

  // A lightbox may already be open with the exact original.
  if (!state.originals.length) {
    // A previous file's secondary panel intercepts the top-nav search button.
    // Close only that read-only panel, then search for the requested file.
    const secondary = await evaluate(ws, pageCloseSecondaryView);
    if (secondary?.present) {
      if (!secondary.clicked) throw coded('SLACK_SECONDARY_VIEW_STUCK', 'a file panel is open and has no close control');
      await waitFor(ws, pageSecondaryViewGone, (value) => value === true, { timeoutMs: 5000, label: 'file panel close' });
    }
    const ensured = await evaluate(ws, pageEnsureSearchBox);
    debug('ensure', ensured);
    if (!ensured?.ok) throw coded('SLACK_SEARCH_UNAVAILABLE', ensured?.error || 'search UI not available');
    if (!ensured.existing) {
      if (!ensured.point) throw coded('SLACK_SEARCH_BUTTON_NOT_VISIBLE', 'search toggle has no clickable geometry');
      await clickAt(ws, ensured.point);
      debug('clicked-search', ensured.point);
    }
    await waitFor(ws, pageSearchBoxReady, (value) => value?.ready, { timeoutMs, label: 'Slack search box' });
    const typed = await evaluate(ws, pageInsertSearchText.replace('%NAME%', JSON.stringify(fileName)));
    debug('typed', typed);
    if (!typed?.ok) throw coded('SLACK_SEARCH_INPUT_FAILED', typed?.error || 'could not type the search query');
    await sleep(350);
    await pressEnter(ws);
    const resultText = JSON.stringify(`搜索结果：${fileName}`);
    await waitFor(ws, `(() => { const b=document.body?.innerText||''; return {done:b.includes(${resultText})&&(/个结果/.test(b)||b.includes('找不到搜索结果'))}; })()`,
      (value) => value?.done, { timeoutMs, label: 'Slack search results' });
    await sleep(300);
    state = await evaluate(ws, findExpr);
    debug('after-search', { originals: state.originals.length, cards: state.cards.length, thumbs: state.thumbs.length });
  }

  if (!state.cards.length) throw coded('SLACK_FILE_CARD_NOT_FOUND', `no result card contains ${fileName}`);
  const card = state.cards.find((item) => item.point) || state.cards[0];
  if (!card.point) throw coded('SLACK_FILE_CARD_NOT_VISIBLE', 'file card has no clickable geometry');
  await clickAt(ws, card.point);
  await sleep(900);

  state = await evaluate(ws, findExpr);
  if (!state.originals.length && state.thumbs.some((item) => item.point)) {
    const thumb = state.thumbs.find((item) => item.point);
    await clickAt(ws, thumb.point);
    await sleep(900);
    state = await evaluate(ws, findExpr);
  }
  if (!state.originals.length) throw coded('SLACK_FILE_URL_NOT_FOUND', 'could not expose the original file URL');
  // Slack exposes both /files-pri/<...>/<name>.png and the /download/ variant.
  // They are the same file; normalize before requiring a unique identity.
  const paths = [...new Set(state.originals)];
  const normalized = [...new Set(paths.map((item) => item.replace('/download/', '/')))];
  if (normalized.length !== 1) throw coded('SLACK_FILE_URL_AMBIGUOUS', `found ${normalized.length} distinct original URLs`);
  const chosen = paths.find((item) => !item.includes('/download/')) || paths[0];
  const fileUrl = assertFileUrl(`${FILE_ORIGIN}${chosen}`);
  const context = await evaluate(ws, pageMessageContextForFile.replace('%NAME%', JSON.stringify(fileName)));
  return { fileUrl, context: context || card.context || '', cardText: card.text };
}

async function capture(options) {
  const fileName = assertPlainName(options.fileName);
  if (!isAbsolute(options.outputDir)) throw coded('INVALID_OUTPUT_DIR', 'output_dir must be absolute');
  const outputDir = resolve(options.outputDir);
  if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) throw coded('OUTPUT_DIR_NOT_FOUND', 'output_dir must be an existing directory');

  const conversation = options.conversationUrl ? assertConversationUrl(options.conversationUrl) : null;
  const targets = await listTargets();
  const target = chooseTarget(targets, { targetId: options.targetId, conversation });
  const socket = new URL(target.webSocketDebuggerUrl);
  if (socket.protocol !== 'ws:' || socket.hostname !== '127.0.0.1' || socket.port !== '9222' || socket.pathname !== `/devtools/page/${target.id}`) {
    throw coded('CDP_TARGET_REJECTED', 'target WebSocket URL is not the local 9222 page socket');
  }
  const ws = await connect(socket.href);
  try {
    const resolved = options.fileUrl
      ? { fileUrl: assertFileUrl(options.fileUrl), context: '', cardText: '' }
      : await resolveFileInPage(ws, { fileName, timeoutMs: options.timeoutMs });
    if (basename(new URL(resolved.fileUrl).pathname).toLowerCase() !== fileName.toLowerCase()) {
      throw coded('SLACK_FILE_NAME_MISMATCH', `resolved URL basename does not equal ${fileName}`);
    }
    const downloaded = await downloadViaPage(ws, resolved.fileUrl);
    const receipt = verifyPngBytes(downloaded.bytes, options);
    const outputFile = join(outputDir, fileName);
    if (existsSync(outputFile) && options.overwrite !== true) {
      throw coded('OUTPUT_EXISTS', `refusing to overwrite ${outputFile}; pass overwrite=true to replace it`);
    }
    writeFileSync(outputFile, downloaded.bytes, { flag: options.overwrite === true ? 'w' : 'wx', mode: 0o644 });
    const receiptFile = join(outputDir, `${fileName}.slack-receipt.json`);
    const full = {
      schema: 'pod-slack-pattern-receipt/1',
      ...receipt,
      fileName,
      outputFile,
      source: {
        kind: 'slack-cdp-page-fetch',
        conversationUrl: conversation?.url.href || null,
        targetId: target.id,
        targetTitle: target.title || '',
        fileUrlPath: new URL(resolved.fileUrl).pathname,
        messageContext: resolved.context,
        fileCardText: resolved.cardText,
        contentType: downloaded.contentType,
      },
      policy: {
        minLongEdge: options.minLongEdge ?? DEFAULT_MIN_LONG_EDGE,
        minTransparentRatio: options.minTransparentRatio ?? DEFAULT_MIN_TRANSPARENT,
        maxSemiRatio: options.maxSemiRatio ?? DEFAULT_MAX_SEMI,
        requireTransparency: options.requireTransparency !== false,
      },
    };
    writeFileSync(receiptFile, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
    return { ...full, receiptFile };
  } finally {
    ws.close();
  }
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

const MCP_TOOLS = [
  {
    name: 'slack_receiver_targets',
    description: 'List open Slack pages from the local Chrome CDP 9222 endpoint. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'slack_receiver_discover',
    description: 'Find one exact PNG in the already logged-in Slack page and return its original files-pri URL and message context without downloading. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string' },
        conversation_url: { type: 'string' },
        file_name: { type: 'string' },
      },
      required: ['file_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_receiver_capture',
    description: 'Download one exact PNG from Slack through the logged-in page, verify pixels/alpha/SHA and stop with blocked when any gate fails. Keeps the file and receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string' },
        conversation_url: { type: 'string' },
        file_name: { type: 'string' },
        file_url: { type: 'string' },
        output_dir: { type: 'string' },
        expected_sha256: { type: 'string' },
        min_long_edge: { type: 'integer' },
        min_transparent_ratio: { type: 'number' },
        max_semi_ratio: { type: 'number' },
        require_transparency: { type: 'boolean' },
        overwrite: { type: 'boolean' },
        timeout_ms: { type: 'integer' },
      },
      required: ['file_name', 'output_dir'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_receiver_verify',
    description: 'Verify an existing local PNG with the same pixel/alpha/SHA gates. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        expected_sha256: { type: 'string' },
        min_long_edge: { type: 'integer' },
        min_transparent_ratio: { type: 'number' },
        max_semi_ratio: { type: 'number' },
        require_transparency: { type: 'boolean' },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
];

function mcpArgs(args = {}) {
  return {
    targetId: args.target_id,
    conversationUrl: args.conversation_url,
    fileName: args.file_name,
    fileUrl: args.file_url,
    outputDir: args.output_dir,
    expectedSha256: args.expected_sha256,
    minLongEdge: args.min_long_edge,
    minTransparentRatio: args.min_transparent_ratio,
    maxSemiRatio: args.max_semi_ratio,
    requireTransparency: args.require_transparency,
    overwrite: args.overwrite,
    timeoutMs: args.timeout_ms,
  };
}

async function callTool(name, args) {
  if (name === 'slack_receiver_targets') {
    const targets = slackTargets(await listTargets()).map((row) => ({ id: row.id, title: row.title || '', url: row.url }));
    return { count: targets.length, targets };
  }
  if (name === 'slack_receiver_verify') {
    if (!args.file || !isAbsolute(args.file)) throw coded('INVALID_FILE', 'file must be absolute');
    if (!existsSync(args.file) || !statSync(args.file).isFile()) throw coded('FILE_NOT_FOUND', 'file does not exist');
    const bytes = readFileSync(args.file);
    return { file: args.file, ...verifyPngBytes(bytes, mcpArgs(args)) };
  }
  if (name === 'slack_receiver_discover') {
    const fileName = assertPlainName(args.file_name);
    const conversation = args.conversation_url ? assertConversationUrl(args.conversation_url) : null;
    const target = chooseTarget(await listTargets(), { targetId: args.target_id, conversation });
    const socket = new URL(target.webSocketDebuggerUrl);
    const ws = await connect(socket.href);
    try {
      const resolved = await resolveFileInPage(ws, { fileName });
      return { targetId: target.id, targetTitle: target.title || '', fileName, ...resolved };
    } finally { ws.close(); }
  }
  if (name === 'slack_receiver_capture') {
    return capture(mcpArgs(args));
  }
  throw coded('UNKNOWN_TOOL', `unknown tool ${name}`);
}

function mcpServer() {
  let buffer = '';
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const errorCodes = { INVALID_PARAMS: -32602, INVALID_REQUEST: -32600, UNKNOWN_TOOL: -32601 };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INPUT_LIMIT' } });
      buffer = '';
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'PARSE_ERROR' } }); continue; }
      const { id, method, params } = request;
      Promise.resolve().then(async () => {
        if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slack-pattern-receiver', version: '0.1.0' } };
        if (method === 'tools/list') return { tools: MCP_TOOLS };
        if (method === 'tools/call') {
          const tool = MCP_TOOLS.find((item) => item.name === params?.name);
          if (!tool) throw coded('UNKNOWN_TOOL', 'unknown tool');
          const result = await callTool(tool.name, params.arguments || {});
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        if (method === 'ping' || method === 'notifications/initialized') return {};
        throw coded('METHOD_NOT_FOUND', 'method not found');
      }).then((result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); })
        .catch((error) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: errorCodes[error.code] || -32000, message: error.code || 'SERVICE_ERROR', data: { code: error.code || 'SERVICE_ERROR', detail: String(error.message).slice(0, 300) } } }); });
    }
  });
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) { out[name] = true; continue; }
    out[name] = value;
    index += 1;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.command === 'mcp') return mcpServer();
  if (args.command === 'targets') {
    const targets = slackTargets(await listTargets()).map((row) => ({ id: row.id, title: row.title || '', url: row.url }));
    console.log(JSON.stringify({ count: targets.length, targets }, null, 2));
    return;
  }
  if (args.command === 'verify') {
    if (!args.file || !isAbsolute(args.file)) throw coded('INVALID_FILE', '--file must be absolute');
    const result = verifyPngBytes(readFileSync(args.file), {
      expectedSha256: args['expected-sha256'],
      minLongEdge: args['min-long-edge'] ? Number(args['min-long-edge']) : undefined,
      minTransparentRatio: args['min-transparent-ratio'] ? Number(args['min-transparent-ratio']) : undefined,
      maxSemiRatio: args['max-semi-ratio'] ? Number(args['max-semi-ratio']) : undefined,
    });
    console.log(JSON.stringify({ file: args.file, ...result }, null, 2));
    process.exitCode = result.status === 'pass' ? 0 : 1;
    return;
  }
  if (args.command === 'capture') {
    if (!args['conversation-url'] || !args['file-name'] || !args['output-dir']) {
      throw coded('INVALID_PARAMS', 'capture requires --conversation-url, --file-name and --output-dir');
    }
    const result = await capture({
      conversationUrl: args['conversation-url'],
      fileName: args['file-name'],
      outputDir: args['output-dir'],
      targetId: args['target-id'],
      fileUrl: args['file-url'],
      expectedSha256: args['expected-sha256'],
      minLongEdge: args['min-long-edge'] ? Number(args['min-long-edge']) : undefined,
      minTransparentRatio: args['min-transparent-ratio'] ? Number(args['min-transparent-ratio']) : undefined,
      maxSemiRatio: args['max-semi-ratio'] ? Number(args['max-semi-ratio']) : undefined,
      overwrite: args.overwrite === true,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'pass' ? 0 : 1;
    return;
  }
  if (args.command === 'discover') {
    const fileName = assertPlainName(args['file-name']);
    const conversation = args['conversation-url'] ? assertConversationUrl(args['conversation-url']) : null;
    const target = chooseTarget(await listTargets(), { targetId: args['target-id'], conversation });
    const ws = await connect(new URL(target.webSocketDebuggerUrl).href);
    try {
      console.log(JSON.stringify({ targetId: target.id, targetTitle: target.title || '', fileName, ...(await resolveFileInPage(ws, { fileName })) }, null, 2));
    } finally { ws.close(); }
    return;
  }
  throw coded('UNKNOWN_COMMAND', 'commands: targets | discover | capture | verify | mcp');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', error: String(error.message).slice(0, 300) }));
    process.exitCode = 1;
  });
}

export { decodePng, verifyPngBytes, capture, listTargets, slackTargets, chooseTarget, assertConversationUrl, assertFileUrl, mcpServer, MCP_TOOLS, callTool };
