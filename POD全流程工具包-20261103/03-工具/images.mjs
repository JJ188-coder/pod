// 图片托管与校验：把本地素材变成平台可抓取的公网 HTTPS 直链。
//
// 为什么需要这一步：TikTok 官方模板主图列写的是「URL」，模板 Image 表明确写了两条路——
// 媒体中心，或「已存放在 Web 服务器上的图片」。平台在导入时才去抓图，pre_check 只校验
// 表格字段（实测：不存在的域名同样返回 code 0），所以这里必须自己把
// 可达性 / 类型 / 体积 / 尺寸 / 比例 全部验一遍，不能拿 pre_check 当图片证明。
//
// 凭据只从环境变量或显式参数读，不落仓库、不写日志。
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export const RULES = Object.freeze({
  kinds: ['image/jpeg', 'image/jpg', 'image/png'],
  maxBytes: 5 * 1024 * 1024,       // 模板原文：图片大小不得超过 5 MB
  minSide: 600,                    // Image 表：最低 600×600；主图最长边至少 600
  aspectMin: 3 / 4,                // 主图 3:4 ~ 4:3
  aspectMax: 4 / 3,
});

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 自己解析尺寸，避免为了读宽高引入依赖。返回 {width,height,format} 或 null。 */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15，排除 DHT(c4)/JPG(c8)/DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** 校验一个公网直链：200 + 图片类型 + ≤5MB + 可解码 + 尺寸达标。 */
export async function verifyUrl(url, { needAspect = false, timeoutMs = 20000 } = {}) {
  const out = { url, ok: false };
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'image/*' } });
  } catch (e) {
    return { ...out, reason: 'UNREACHABLE', detail: String(e?.message || e).slice(0, 120) };
  }
  out.status = res.status;
  if (!res.ok) return { ...out, reason: 'HTTP_' + res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const size = imageSize(buf);
  Object.assign(out, { bytes: buf.length, contentType: type, sha256: sha256(buf), ...(size || {}) });
  if (!RULES.kinds.includes(type) && !size) return { ...out, reason: 'NOT_IMAGE' };
  if (!size) return { ...out, reason: 'UNDECODABLE' };
  if (buf.length > RULES.maxBytes) return { ...out, reason: 'TOO_LARGE', limit: RULES.maxBytes };
  if (Math.min(size.width, size.height) < RULES.minSide) return { ...out, reason: 'TOO_SMALL', min: RULES.minSide };
  const aspect = size.width / size.height;
  if (needAspect && (aspect < RULES.aspectMin || aspect > RULES.aspectMax)) {
    return { ...out, reason: 'ASPECT_OUT_OF_RANGE', aspect: Number(aspect.toFixed(3)) };
  }
  return { ...out, ok: true, aspect: Number(aspect.toFixed(3)) };
}

/**
 * 托管适配器。
 * - static：图片已经在自有域名上，spec 里直接给绝对 URL（这里只校验）。
 * - http-put：把本地文件 PUT 到 `${baseUrl}/${key}`，需要 HOST_TOKEN（可选 HOST_AUTH_HEADER）。
 * - pages：把文件复制进一个本地站点目录，再用 wrangler 整体部署到 Cloudflare Pages
 *   （= 「一个文件夹就是一个网站」，绑了 img.bri-king.com 之后 URL 即自有域名）。
 */
export async function hostImages(files, opts = {}) {
  const mode = opts.mode || 'static';
  if (mode === 'static') {
    return files.map((f) => ({ file: f.file ?? null, url: f.url, hosted: false }));
  }
  if (mode === 'pages') return hostViaPages(files, opts);
  if (mode !== 'http-put') throw Error('UNKNOWN_HOST_MODE_' + mode);
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw Error('HOST_BASE_URL_HTTPS_REQUIRED');
  const token = opts.token ?? process.env.HOST_TOKEN ?? '';
  const headerName = opts.headerName ?? process.env.HOST_AUTH_HEADER ?? 'authorization';
  const out = [];
  for (const f of files) {
    if (!f.file) throw Error('LOCAL_FILE_REQUIRED_FOR_HTTP_PUT');
    const buf = await fs.readFile(f.file);
    const key = (opts.prefix ? opts.prefix.replace(/^\/+|\/+$/g, '') + '/' : '') + path.basename(f.file);
    const headers = { 'content-type': contentTypeOf(f.file) };
    if (token) headers[headerName.toLowerCase()] = headerName.toLowerCase() === 'authorization' ? `Bearer ${token}` : token;
    const res = await fetch(`${base}/${encodeURI(key)}`, { method: 'PUT', headers, body: buf, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw Error(`HOST_PUT_FAILED ${res.status} ${key}`);
    out.push({ file: f.file, key, url: `${base}/${encodeURI(key)}`, sha256: sha256(buf), hosted: true });
  }
  return out;
}

const contentTypeOf = (p) => (/\.png$/i.test(p) ? 'image/png' : 'image/jpeg');

/**
 * Pages 适配器：文件进本地站点目录 → wrangler 部署 → 返回自有域名 URL。
 * 站点目录是唯一事实来源：部署会整体替换站点，所以必须先落盘再部署，
 * 且同一次部署只跑一次，不逐文件部署。
 */
async function hostViaPages(files, opts = {}) {
  const siteDir = opts.siteDir;
  const project = opts.project || 'pod-images';
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!siteDir) throw Error('LINK_SITE_DIR_REQUIRED');
  if (!/^https:\/\//.test(base)) throw Error('LINK_BASE_URL_HTTPS_REQUIRED');
  const sub = (opts.prefix || 'img').replace(/^\/+|\/+$/g, '');
  const out = [];
  for (const f of files) {
    if (!f.file) throw Error('LOCAL_FILE_REQUIRED_FOR_PAGES');
    // 每个文件可以带自己的 key（多款批量时按款分目录），否则落在 <prefix>/<文件名>
    const key = (f.key ? String(f.key) : `${sub}/${path.basename(f.file)}`).replace(/^\/+/, '');
    const dest = path.join(siteDir, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(f.file, dest);
    out.push({ file: f.file, key, url: `${base}/${encodeURI(key)}`, sha256: sha256(await fs.readFile(dest)), hosted: true });
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('npx', ['-y', 'wrangler@4', 'pages', 'deploy', '.', '--project-name', project,
    '--branch', 'main', '--commit-dirty=true'], { cwd: siteDir, maxBuffer: 8 * 1024 * 1024, timeout: 300000 });
  return out;
}

/** 批量校验并给出可直接填表的结果；任何一张不合格就整体拒绝，不半填。 */
export async function verifyAll(urls, { mainFirst = true } = {}) {
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    results.push(await verifyUrl(urls[i], { needAspect: mainFirst && i === 0 }));
  }
  const bad = results.filter((r) => !r.ok);
  return { ok: bad.length === 0, results, bad };
}
