#!/usr/bin/env node
/**
 * POD T-shirt detail page composer
 *
 * Turns confirmed product facts + already-approved images into a mobile-first
 * vertical detail page (1080px wide), rendered locally with headless Chrome.
 * Text is real DOM text, never drawn by an image model, so Spanish copy and
 * size numbers stay exact and greppable.
 *
 * Order follows TikTok Shop apparel guidance and common high-converting POD
 * layouts: overall look -> front/back -> print detail -> fabric/fit -> colors
 * -> size guide.
 *
 * Boundaries:
 *   - Local rendering only. No platform write, no listing, no publish.
 *   - Size numbers must come from the spec (confirmed source). A missing table
 *     is skipped and reported, never invented.
 *   - The output is a rendered draft. It is not visually approved, frozen or
 *     publishable until a reviewer records that separately.
 *
 * CLI:
 *   node tshirt-detail-composer.mjs render --spec SPEC.json --out DIR
 *   node tshirt-detail-composer.mjs verify --out DIR
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { decodePng } from './slack-pattern-receiver.mjs';

const SPEC_SCHEMA = 'pod-detail-spec-v1';
const RUN_SCHEMA = 'pod-detail-run-v1';
const require = createRequire(import.meta.url);
const SECTION_WIDTH = 1080;
const SECTION_HEIGHT = 1350;

const coded = (code, message) => Object.assign(new Error(message), { code });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nowIso = () => new Date().toISOString();

function resolvePlaywright() {
  if (process.env.POD_PLAYWRIGHT) {
    if (!existsSync(process.env.POD_PLAYWRIGHT)) throw coded('PLAYWRIGHT_MISSING', `POD_PLAYWRIGHT does not exist: ${process.env.POD_PLAYWRIGHT}`);
    return process.env.POD_PLAYWRIGHT;
  }
  const candidates = [
    join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'),
    process.env.POD_REPO ? join(process.env.POD_REPO, 'node_modules', 'playwright') : null,
    process.env.POD_REPO ? join(process.env.POD_REPO, 'node_modules', 'playwright-core') : null,
    join(process.cwd(), 'node_modules', 'playwright'),
    join(process.cwd(), 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try { return require.resolve('playwright'); } catch { /* fall through */ }
  throw coded('PLAYWRIGHT_MISSING', 'install playwright, or set POD_PLAYWRIGHT to the module path');
}

function resolveChrome() {
  if (process.env.POD_CHROME) {
    if (!existsSync(process.env.POD_CHROME)) throw coded('CHROME_MISSING', `POD_CHROME does not exist: ${process.env.POD_CHROME}`);
    return process.env.POD_CHROME;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) throw coded('CHROME_MISSING', 'install Chrome/Chromium, or set POD_CHROME to the executable');
  return hit;
}

function assertFile(label, value) {
  if (typeof value !== 'string' || !value) throw coded('DETAIL_PATH_MISSING', `${label} is required`);
  if (!isAbsolute(value)) throw coded('DETAIL_PATH_NOT_ABSOLUTE', `${label} must be absolute`);
  if (!existsSync(value)) throw coded('DETAIL_PATH_MISSING', `${label} does not exist: ${value}`);
  return value;
}

function optionalFile(label, value) {
  if (!value) return null;
  return assertFile(label, value);
}

function loadSpec(specPath) {
  if (!isAbsolute(specPath)) throw coded('DETAIL_SPEC_NOT_ABSOLUTE', 'spec path must be absolute');
  let raw;
  try { raw = JSON.parse(readFileSync(specPath, 'utf8')); } catch (error) {
    throw coded('DETAIL_SPEC_INVALID', `cannot parse spec: ${error.message}`);
  }
  if (raw?.schema !== SPEC_SCHEMA) throw coded('DETAIL_SPEC_SCHEMA', `spec.schema must be ${SPEC_SCHEMA}`);
  const product = raw.product || {};
  for (const key of ['code', 'version', 'title']) {
    if (typeof product[key] !== 'string' || !product[key].trim()) throw coded('DETAIL_PRODUCT_REQUIRED', `product.${key} is required`);
  }
  const images = raw.images || {};
  const spec = {
    path: specPath,
    raw,
    product: {
      code: product.code.trim(),
      version: product.version.trim(),
      title: product.title.trim(),
      subtitle: (product.subtitle || '').trim(),
      material: (product.material || '').trim(),
      sizes: Array.isArray(product.sizes) ? product.sizes.slice() : [],
      colors: Array.isArray(product.colors) ? product.colors.map((item) => ({ name: String(item.name), image: assertFile('product.colors.image', item.image) })) : [],
    },
    images: {
      cover: optionalFile('images.cover', images.cover),
      front: optionalFile('images.front', images.front),
      back: optionalFile('images.back', images.back),
      model: optionalFile('images.model', images.model),
      print: optionalFile('images.print', images.print),
    },
    copy: {
      intro: (raw.copy?.intro || '').trim(),
      print: (raw.copy?.print || '').trim(),
      fabric: (raw.copy?.fabric || '').trim(),
      colors: (raw.copy?.colors || '').trim(),
      size_note: (raw.copy?.size_note || '').trim(),
    },
    size_table: raw.size_table || null,
    theme: {
      bg: raw.theme?.bg || '#f6f3ed',
      ink: raw.theme?.ink || '#141414',
      accent: raw.theme?.accent || '#8a6b3f',
      muted: raw.theme?.muted || '#6f6a61',
    },
  };
  if (!spec.images.cover && !spec.images.front) throw coded('DETAIL_COVER_REQUIRED', 'at least images.cover or images.front is required');
  return spec;
}

function fileUrl(path) {
  return `file://${encodeURI(path)}`;
}

function section(id, name, body, extraClass = '') {
  return `<section class="section ${extraClass}" data-section="${id}" data-name="${name}">${body}</section>`;
}

function html(spec) {
  const t = spec.theme;
  const cover = spec.images.cover || spec.images.front;
  const sections = [];

  sections.push(section('D01', 'Portada', `
    <div class="cover" style="background-image:url('${fileUrl(cover)}')"></div>
    <div class="cover-shade"></div>
    <div class="cover-copy">
      <div class="kicker">${escapeHtml(spec.product.code)} · ${escapeHtml(spec.product.version)}</div>
      <h1>${escapeHtml(spec.product.title)}</h1>
      ${spec.product.subtitle ? `<p class="sub">${escapeHtml(spec.product.subtitle)}</p>` : ''}
      ${spec.copy.intro ? `<p class="intro">${escapeHtml(spec.copy.intro)}</p>` : ''}
      <div class="rule"></div>
    </div>
  `, 'cover-section'));

  if (spec.images.front || spec.images.back) {
    sections.push(section('D02', 'Vista frontal y posterior', `
      <header class="head"><span class="kicker">Vista del producto</span><h2>Frontal y posterior</h2></header>
      <div class="pair">
        ${spec.images.front ? `<figure><div class="photo"><img src="${fileUrl(spec.images.front)}" alt=""></div><figcaption>Vista frontal</figcaption></figure>` : ''}
        ${spec.images.back ? `<figure><div class="photo"><img src="${fileUrl(spec.images.back)}" alt=""></div><figcaption>Vista posterior</figcaption></figure>` : ''}
      </div>
      ${spec.copy.print ? `<p class="note">${escapeHtml(spec.copy.print)}</p>` : ''}
    `));
  }

  if (spec.images.print) {
    sections.push(section('D03', 'Detalle del diseño', `
      <header class="head"><span class="kicker">Detalle</span><h2>El diseño de cerca</h2></header>
      <div class="print-stage"><img src="${fileUrl(spec.images.print)}" alt=""></div>
      <div class="callouts">
        <div><b>Impresión</b><span>Diseño al frente y en la espalda</span></div>
        <div><b>Acabado</b><span>Colores intensos sobre tela oscura</span></div>
      </div>
    `, 'dark'));
  }

  if (spec.images.model) {
    const facts = [
      spec.product.material ? `<li><b>Composición</b> ${escapeHtml(spec.product.material)}</li>` : '',
      '<li><b>Cuello</b> Redondo</li>',
      '<li><b>Manga</b> Corta</li>',
      spec.product.sizes.length ? `<li><b>Tallas</b> ${escapeHtml(spec.product.sizes.join(' · '))}</li>` : '',
    ].filter(Boolean).join('');
    sections.push(section('D04', 'Calce y confección', `
      <header class="head"><span class="kicker">La prenda</span><h2>Calce y confección</h2></header>
      <div class="split">
        <div class="photo tall"><img src="${fileUrl(spec.images.model)}" alt=""></div>
        <div class="facts">
          <ul>${facts}</ul>
          ${spec.copy.fabric ? `<p class="note">${escapeHtml(spec.copy.fabric)}</p>` : ''}
        </div>
      </div>
    `));
  }

  if (spec.product.colors.length) {
    sections.push(section('D05', 'Colores disponibles', `
      <header class="head"><span class="kicker">Opciones</span><h2>Colores disponibles</h2></header>
      <div class="swatches">
        ${spec.product.colors.map((color) => `
          <figure>
            <div class="photo"><img src="${fileUrl(color.image)}" alt=""></div>
            <figcaption>${escapeHtml(color.name)}</figcaption>
          </figure>`).join('')}
      </div>
      <p class="note">${escapeHtml(spec.copy.colors || 'Los tonos pueden variar ligeramente según la pantalla.')}</p>
    `));
  }

  if (spec.size_table && Array.isArray(spec.size_table.rows) && spec.size_table.rows.length) {
    const unit = spec.size_table.unit || 'cm';
    sections.push(section('D06', 'Guía de tallas', `
      <header class="head"><span class="kicker">Medidas</span><h2>Guía de tallas</h2></header>
      <table>
        <thead><tr><th>Talla</th><th>Hombro<br><small>${unit}</small></th><th>Pecho<br><small>${unit}</small></th><th>Largo<br><small>${unit}</small></th><th>Manga<br><small>${unit}</small></th></tr></thead>
        <tbody>
          ${spec.size_table.rows.map((row) => `<tr><td>${escapeHtml(row.size)}</td><td>${row.shoulder}</td><td>${row.chest}</td><td>${row.length}</td><td>${row.sleeve}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="note">${escapeHtml(spec.copy.size_note || 'Medidas tomadas de la prenda extendida. Consulta las medidas antes de elegir tu talla.')}</p>
      ${spec.size_table.source ? `<p class="source">Fuente: ${escapeHtml(spec.size_table.source)}</p>` : ''}
    `));
  }

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{background:${t.bg};color:${t.ink};font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
    .section{position:relative;width:${SECTION_WIDTH}px;height:${SECTION_HEIGHT}px;overflow:hidden;background:${t.bg};page-break-after:always}
    .kicker{font-size:22px;letter-spacing:.18em;text-transform:uppercase;color:${t.accent};font-weight:600}
    h1{font-size:74px;line-height:1.02;letter-spacing:-.02em;font-weight:700;margin:18px 0 14px}
    h2{font-size:58px;line-height:1.05;letter-spacing:-.01em;font-weight:700;margin-top:10px}
    .sub{font-size:30px;color:${t.muted};margin-bottom:12px}
    .intro{font-size:26px;line-height:1.45;color:${t.muted};max-width:760px}
    .head{padding:86px 72px 0}
    .note{font-size:22px;line-height:1.5;color:${t.muted}}
    .source{font-size:16px;color:${t.muted};opacity:.75;margin-top:10px}
    .cover-section{color:#fff}
    .cover{position:absolute;inset:0;background-size:cover;background-position:center top}
    .cover-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05) 30%,rgba(0,0,0,.72) 100%)}
    .cover-copy{position:absolute;left:0;right:0;bottom:0;padding:0 72px 92px}
    .cover-copy .kicker{color:#e8d9bd}
    .cover-copy h1{color:#fff;font-size:82px}
    .cover-copy .sub,.cover-copy .intro{color:rgba(255,255,255,.86)}
    .rule{width:120px;height:4px;background:${t.accent};margin-top:26px}
    .pair{display:flex;gap:22px;padding:56px 72px 0}
    .pair figure{flex:1}
    .photo{background:#fff;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center}
    .pair .photo{height:940px}
    .photo img{width:100%;height:100%;object-fit:contain}
    figcaption{font-size:24px;letter-spacing:.08em;text-transform:uppercase;color:${t.muted};margin-top:18px;text-align:center}
    .pair .note{padding:14px 72px 0;text-align:center}
    .print-stage{padding:52px 72px 0;height:930px;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 40%,#232323 0%,#0c0c0c 70%)}
    .print-stage img{max-width:100%;max-height:100%;object-fit:contain}
    .callouts{display:flex;gap:28px;padding:34px 72px 0;color:#f0e8da}
    .callouts div{flex:1;border-top:2px solid ${t.accent};padding-top:18px;display:flex;flex-direction:column;gap:8px}
    .callouts b{font-size:24px;letter-spacing:.08em;text-transform:uppercase}
    .callouts span{font-size:22px;color:#c9c0b2;line-height:1.4}
    .dark{background:#0c0c0c}
    .dark h2{color:#f4eee4}
    .split{display:flex;gap:36px;padding:56px 72px 0}
    .split .photo{width:500px;height:960px;flex:none}
    .facts{flex:1;padding-top:20px}
    .facts ul{list-style:none;display:flex;flex-direction:column;gap:26px}
    .facts li{font-size:25px;line-height:1.4;color:${t.muted};border-bottom:1px solid rgba(0,0,0,.08);padding-bottom:20px}
    .facts li b{display:block;font-size:20px;letter-spacing:.12em;text-transform:uppercase;color:${t.accent};margin-bottom:6px}
    .facts .note{margin-top:30px}
    .swatches{display:flex;gap:26px;padding:60px 72px 0;justify-content:center}
    .swatches figure{width:440px}
    .swatches .photo{height:760px}
    .swatches figcaption{font-size:28px;color:${t.ink};font-weight:600}
    .swatches .note{padding:34px 72px 0;text-align:center}
    table{width:calc(100% - 144px);margin:54px 72px 0;border-collapse:collapse;font-variant-numeric:tabular-nums}
    th,td{text-align:center;padding:22px 8px;font-size:26px;border-bottom:1px solid rgba(0,0,0,.12)}
    th{font-size:22px;letter-spacing:.06em;text-transform:uppercase;color:${t.accent};font-weight:600}
    th small{font-size:15px;letter-spacing:.04em;color:${t.muted};text-transform:none}
    tbody tr:nth-child(odd){background:rgba(0,0,0,.025)}
    td:first-child,th:first-child{text-align:left;font-weight:700}
    .section table + .note{padding:34px 72px 0}
  </style></head><body>${sections.join('')}</body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function requiredTexts(spec) {
  const texts = [spec.product.title];
  if (spec.product.subtitle) texts.push(spec.product.subtitle);
  for (const key of ['intro', 'print', 'fabric', 'colors', 'size_note']) {
    if (spec.copy[key]) texts.push(spec.copy[key]);
  }
  for (const color of spec.product.colors) texts.push(color.name);
  if (spec.size_table?.rows) {
    for (const row of spec.size_table.rows) {
      texts.push(row.size, String(row.shoulder), String(row.chest), String(row.length), String(row.sleeve));
    }
  }
  return texts;
}

async function render(specPath, outDir) {
  const spec = loadSpec(specPath);
  const chrome = resolveChrome();
  const playwrightPath = resolvePlaywright();
  const { chromium } = require(playwrightPath);
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, 'detail.html');
  writeFileSync(htmlPath, html(spec), 'utf8');

  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: SECTION_WIDTH, height: SECTION_HEIGHT }, deviceScaleFactor: 1 });
  try {
    await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    await page.evaluate(async () => {
      await Promise.all([...document.images].map((img) => (img.complete ? Promise.resolve() : new Promise((done) => { img.onload = done; img.onerror = done; }))));
    });

    const sections = await page.$$('[data-section]');
    const sectionRows = [];
    for (const element of sections) {
      const id = await element.getAttribute('data-section');
      const name = await element.getAttribute('data-name');
      const path = join(outDir, `${id}_${name.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}.png`);
      await element.screenshot({ path });
      sectionRows.push({ id, name, path, ...measure(path) });
    }
    const fullPath = join(outDir, `${spec.product.code}_detail_full_${spec.product.version.toLowerCase()}.png`);
    await page.screenshot({ path: fullPath, fullPage: true });
    const full = { path: fullPath, ...measure(fullPath) };

    const bodyText = await page.evaluate(() => document.body.innerText);
    const haystack = bodyText.toLocaleLowerCase('es');
    const missing = requiredTexts(spec).filter((text) => !haystack.includes(text.toLocaleLowerCase('es')));
    await browser.close();

    const manifest = {
      schema: RUN_SCHEMA,
      spec: { path: specPath, sha256: sha256(readFileSync(specPath)) },
      html: { path: htmlPath, sha256: sha256(readFileSync(htmlPath)) },
      product: spec.product,
      rendered_at: nowIso(),
      sections: sectionRows,
      full,
      text_check: { passed: missing.length === 0, missing },
      size_source: spec.size_table?.source || null,
      gate: {
        status: missing.length === 0 ? 'visual_review_required' : 'blocked_by_text_check',
        note: 'Rendered locally from confirmed facts. Layout, print fidelity and copy still need a visual review; nothing here is frozen or publishable.',
      },
    };
    const manifestPath = join(outDir, 'detail-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { manifestPath, manifest };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

function measure(path) {
  const bytes = readFileSync(path);
  const png = decodePng(bytes);
  return { width: png.width, height: png.height, bytes: bytes.length, sha256: sha256(bytes) };
}

function verify(outDir) {
  const manifestPath = join(outDir, 'detail-manifest.json');
  if (!existsSync(manifestPath)) throw coded('DETAIL_MANIFEST_MISSING', `no manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rows = [...manifest.sections, { id: 'FULL', name: 'full', path: manifest.full.path }].map((row) => {
    if (!existsSync(row.path)) return { id: row.id, status: 'missing', path: row.path };
    try {
      const actual = measure(row.path);
      return { id: row.id, status: actual.sha256 === row.sha256 ? 'generated' : 'changed', path: row.path, ...actual };
    } catch (error) {
      return { id: row.id, status: 'invalid', path: row.path, error: String(error.message).slice(0, 200) };
    }
  });
  return { manifest: manifestPath, verified_at: nowIso(), rows, failing: rows.filter((row) => row.status !== 'generated').length };
}

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
  if (args.command === 'render') {
    if (!args.spec || !args.out) throw coded('INVALID_PARAMS', 'render requires --spec and --out');
    const result = await render(args.spec, args.out);
    console.log(JSON.stringify({
      ok: result.manifest.text_check.passed,
      manifest: result.manifestPath,
      sections: result.manifest.sections.map((row) => ({ id: row.id, name: row.name, px: `${row.width}x${row.height}` })),
      full: { px: `${result.manifest.full.width}x${result.manifest.full.height}`, sha256: result.manifest.full.sha256.slice(0, 12) },
      text_check: result.manifest.text_check,
      gate: result.manifest.gate,
    }, null, 2));
    process.exitCode = result.manifest.text_check.passed ? 0 : 1;
    return;
  }
  if (args.command === 'verify') {
    if (!args.out) throw coded('INVALID_PARAMS', 'verify requires --out');
    const result = verify(args.out);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.failing === 0 ? 0 : 1;
    return;
  }
  throw coded('UNKNOWN_COMMAND', 'commands: render | verify');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', error: String(error.message).slice(0, 400) }));
    process.exitCode = 1;
  });
}

export { loadSpec, render, verify, html, requiredTexts, SECTION_WIDTH, SECTION_HEIGHT };
