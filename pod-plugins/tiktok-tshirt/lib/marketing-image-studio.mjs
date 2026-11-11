#!/usr/bin/env node
/**
 * POD marketing image studio
 *
 * Turns one already-saved Galaxy product into a marketing image pack:
 *   Galaxy front/back renders + production PNGs + one photography style
 *   reference -> per-shot prompts -> concurrent Magpie/imgen image calls
 *   -> local PNG files -> pixels / aspect / SHA-256 manifest.
 *
 * Boundaries:
 *   - It never reads or exports cookies, tokens or Authorization headers. The
 *     image hook it drives uses the local Codex/ChatGPT OAuth session.
 *   - It never writes to Galaxy, Slack, the seller center or any platform.
 *   - A generated file is evidence of "image produced", never "visually
 *     approved", "frozen", "listed" or "on sale". Visual review stays pending
 *     in every manifest until a reviewer records it.
 *   - It never upscales a production PNG and calls it native 4K. Marketing
 *     images are not print files and carry no 4K claim.
 *
 * CLI:
 *   node marketing-image-studio.mjs plan  --spec SPEC.json --out DIR
 *   node marketing-image-studio.mjs run   --spec SPEC.json --out DIR [--jobs H01,H03] [--concurrency 2] [--overwrite]
 *   node marketing-image-studio.mjs verify --out DIR
 *   node marketing-image-studio.mjs status --out DIR
 *   node marketing-image-studio.mjs mcp
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { decodePng } from './slack-pattern-receiver.mjs';

const SPEC_SCHEMA = 'pod-marketing-spec-v1';
const RUN_SCHEMA = 'pod-marketing-run-v1';
const MAX_REFS = 5;
const MAX_CONCURRENCY = 3;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MIN_LONG_EDGE = 1024;
const ASPECT_TOLERANCE = 0.025;
const JOB_TIMEOUT_MS = 480000;

const coded = (code, message) => Object.assign(new Error(message), { code });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nowIso = () => new Date().toISOString();

function compareVersion(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Locate the installed imgen CLI without pinning a machine-specific path. */
function resolveImgenCli() {
  if (process.env.IMGEN_CLI) {
    if (!existsSync(process.env.IMGEN_CLI)) throw coded('IMGEN_CLI_MISSING', `IMGEN_CLI does not exist: ${process.env.IMGEN_CLI}`);
    return process.env.IMGEN_CLI;
  }
  // 本机已有 Magpie：优先用兼容 imgen 调用面的本地 shim。
  const shims = [
    process.env.POD_REPO ? join(process.env.POD_REPO, 'tools', 'pod', 'imgen-magpie.mjs') : null,
    join(process.cwd(), 'tools', 'pod', 'imgen-magpie.mjs'),
    join(process.env.HOME || '', 'Documents', 'pod', 'pod-repo', 'tools', 'pod', 'imgen-magpie.mjs'),
  ].filter(Boolean);
  for (const shim of shims) if (existsSync(shim)) return shim;
  const cache = join(homedir(), '.zcode', 'cli', 'plugins', 'cache');
  const found = [];
  let vendors = [];
  try { vendors = readdirSync(cache); } catch { vendors = []; }
  for (const vendor of vendors) {
    let names = [];
    try { names = readdirSync(join(cache, vendor)); } catch { continue; }
    for (const name of names) {
      if (name !== 'imgen') continue;
      let versions = [];
      try { versions = readdirSync(join(cache, vendor, name)); } catch { continue; }
      for (const version of versions) {
        const cli = join(cache, vendor, name, version, 'dist', 'cli.js');
        if (existsSync(cli)) found.push({ version, cli });
      }
    }
  }
  if (!found.length) throw coded('IMGEN_CLI_MISSING', 'install the imgen plugin, or set IMGEN_CLI to its dist/cli.js');
  found.sort((left, right) => compareVersion(right.version, left.version));
  return found[0].cli;
}

/* ------------------------------------------------------------------ */
/* Reference roles                                                     */
/* ------------------------------------------------------------------ */

const REF_ROLE = {
  front_effect:
    'the Galaxy saved-and-reopened FRONT render of this exact product. It controls the shirt color, neckline, sleeve length, front print artwork, print position and print size.',
  back_effect:
    'the Galaxy saved-and-reopened BACK render of this exact product. It controls the back print artwork, print position and print size.',
  style_reference:
    'a photography style reference. It controls ONLY composition, model placement, framing, camera angle, lighting and background mood. Do NOT copy its shirt color, its garment or its printed artwork.',
  front_png:
    'the production FRONT print PNG. Use it only to preserve the exact artwork, line work, colors and lettering of the front print.',
  back_png:
    'the production BACK print PNG. Use it only to preserve the exact artwork, line work, colors and lettering of the back print.',
};

const REF_LABEL = {
  front_effect: 'Galaxy front render',
  back_effect: 'Galaxy back render',
  style_reference: 'photography style reference',
  front_png: 'production front print PNG',
  back_png: 'production back print PNG',
};

const ASPECT_TEXT = {
  '1:1': 'exact 1:1 square aspect ratio',
  '9:16': 'exact 9:16 vertical aspect ratio',
  '4:5': 'exact 4:5 vertical aspect ratio',
};

const ASPECT_VALUE = { '1:1': 1, '9:16': 9 / 16, '4:5': 4 / 5 };

/* ------------------------------------------------------------------ */
/* Spec                                                                */
/* ------------------------------------------------------------------ */

function requireAbsoluteFile(label, value) {
  if (typeof value !== 'string' || !value) throw coded('SPEC_PATH_MISSING', `${label} is required`);
  if (!isAbsolute(value)) throw coded('SPEC_PATH_NOT_ABSOLUTE', `${label} must be absolute`);
  if (!existsSync(value)) throw coded('SPEC_PATH_MISSING', `${label} does not exist: ${value}`);
  if (!statSync(value).isFile()) throw coded('SPEC_PATH_NOT_FILE', `${label} is not a regular file`);
  return value;
}

function optionalAbsoluteFile(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return requireAbsoluteFile(label, value);
}

function normalizeSpec(specPath) {
  if (!isAbsolute(specPath)) throw coded('SPEC_PATH_NOT_ABSOLUTE', 'spec path must be absolute');
  let raw;
  try { raw = JSON.parse(readFileSync(specPath, 'utf8')); } catch (error) {
    throw coded('SPEC_INVALID_JSON', `cannot parse spec: ${error.message}`);
  }
  if (raw?.schema !== SPEC_SCHEMA) throw coded('SPEC_SCHEMA_REQUIRED', `spec.schema must be ${SPEC_SCHEMA}`);

  const product = raw.product || {};
  for (const key of ['code', 'version', 'color']) {
    if (typeof product[key] !== 'string' || !product[key].trim()) throw coded('SPEC_PRODUCT_REQUIRED', `product.${key} is required`);
  }

  const galaxy = raw.galaxy || {};
  const spec = {
    path: specPath,
    raw,
    product: {
      code: product.code.trim(),
      version: product.version.trim(),
      color: product.color.trim(),
      theme: (product.theme || '').trim(),
      neck: (product.neck || 'cuello redondo').trim(),
      sleeve: (product.sleeve || 'manga corta').trim(),
      material: (product.material || '').trim(),
      sizes: Array.isArray(product.sizes) ? product.sizes.slice() : [],
    },
    galaxy: {
      design_id: galaxy.design_id || null,
      readback_at: galaxy.readback_at || null,
      front_effect: requireAbsoluteFile('galaxy.front_effect', galaxy.front_effect),
      back_effect: optionalAbsoluteFile('galaxy.back_effect', galaxy.back_effect),
      front_png: optionalAbsoluteFile('galaxy.front_png', galaxy.front_png),
      back_png: optionalAbsoluteFile('galaxy.back_png', galaxy.back_png),
      front_print_cm: Array.isArray(galaxy.front_print_cm) ? galaxy.front_print_cm : null,
      back_print_cm: Array.isArray(galaxy.back_print_cm) ? galaxy.back_print_cm : null,
    },
    style: {
      reference: optionalAbsoluteFile('style.reference', (raw.style || {}).reference),
      type: ((raw.style || {}).type || '').trim(),
      lighting: ((raw.style || {}).lighting || '').trim(),
      background: ((raw.style || {}).background || '').trim(),
    },
    generation: {
      model: ((raw.generation || {}).model || 'gpt-6-luna').trim(),
      image_model: ((raw.generation || {}).image_model || 'gpt-image-2').trim(),
      quality: ((raw.generation || {}).quality || 'medium').trim(),
      effort: ((raw.generation || {}).effort || 'xhigh').trim(),
      concurrency: Number((raw.generation || {}).concurrency || DEFAULT_CONCURRENCY),
      min_long_edge: Number((raw.generation || {}).min_long_edge || DEFAULT_MIN_LONG_EDGE),
    },
    jobs: Array.isArray(raw.jobs) ? raw.jobs.slice() : null,
  };
  return spec;
}

function assertJobId(id) {
  if (!/^[A-Z]\d{2}$/.test(id)) throw coded('JOB_ID_INVALID', `job id must look like H01 or D02, got ${id}`);
  return id;
}

/* ------------------------------------------------------------------ */
/* Shot catalogue                                                      */
/* ------------------------------------------------------------------ */

function cm(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  return `${Number(value[0]).toFixed(2)} x ${Number(value[1]).toFixed(2)} cm`;
}

function productFacts(spec) {
  const { product, galaxy } = spec;
  const lines = [
    `- Garment: ${product.color} ${product.neck} T-shirt with ${product.sleeve}, adult unisex fit.`,
  ];
  if (product.theme) lines.push(`- Print theme: ${product.theme}.`);
  if (cm(galaxy.front_print_cm)) lines.push(`- Front print size on garment: about ${cm(galaxy.front_print_cm)}.`);
  if (cm(galaxy.back_print_cm)) lines.push(`- Back print size on garment: about ${cm(galaxy.back_print_cm)}.`);
  if (product.material) lines.push(`- Confirmed material copy (for later typography, not a visual claim): ${product.material}.`);
  return lines.join('\n');
}

function styleFacts(spec) {
  const { style } = spec;
  const lines = [];
  if (style.type) lines.push(`- Photography form: ${style.type}.`);
  if (style.lighting) lines.push(`- Lighting: ${style.lighting}.`);
  if (style.background) lines.push(`- Background: ${style.background}.`);
  return lines.length ? lines.join('\n') : '- Follow the supplied style reference exactly for photography form and mood.';
}

function joinRefs(refs) {
  return refs.map((key, index) => `Image ${index + 1} — ${REF_ROLE[key]}`).join('\n');
}

function frontIndex(refs) { const i = refs.indexOf('front_effect'); return i < 0 ? null : i + 1; }
function backIndex(refs) { const i = refs.indexOf('back_effect'); return i < 0 ? null : i + 1; }

function fidelityRules(spec, refs) {
  const f = frontIndex(refs);
  const b = backIndex(refs);
  const lines = [];
  if (f) lines.push(`- The FRONT print must match Image ${f} exactly: artwork, lettering, colors, orientation and relative size.`);
  if (b) lines.push(`- The BACK print must match Image ${b} exactly: artwork, lettering, colors, orientation and relative size.`);
  lines.push('- Do not redraw, translate, mirror, crop, enlarge or shrink the print beyond what the Galaxy render shows.');
  lines.push('- Do not copy any print, logo or text from the style reference.');
  return lines.join('\n');
}

const JOBS = {
  H01: {
    subdir: '主图', role: 'listing hero image (H01)', aspect: '1:1',
    refs: ['front_effect', 'back_effect', 'style_reference'],
    request: 'A hero e-commerce photo of two adult models wearing this exact T-shirt. The man stands on the left facing the camera; the woman stands on the right turned away to show the back print, glancing over her shoulder. Keep the reference street setting and natural daylight. Both models are adults, visual age 25-35.',
    shot: 'Full-body to mid-thigh framing so both garments and both prints stay fully visible. Calm natural S-curve posture with the weight on one leg; T-shirt hem hangs down, no hands or hair covering the prints; light blue jeans. Avoid exaggerated twisting and avoid any body-part close-up.',
    extra: 'This is the first image a buyer sees: the garment and its prints are the subject, the scene only supports them.',
  },
  H02: {
    subdir: '主图', role: 'front view (H02)', aspect: '1:1',
    refs: ['front_effect', 'style_reference'],
    request: 'A front-facing photo of one adult model wearing this exact T-shirt, so the front print, neckline, shoulder and sleeve length are all clearly readable.',
    shot: 'Three-quarter body framing, straight-on camera, arms relaxed away from the print, hem down, light blue jeans.',
  },
  H03: {
    subdir: '主图', role: 'back view (H03)', aspect: '1:1',
    refs: ['back_effect', 'style_reference'],
    request: 'A back view of ONE adult model wearing this exact T-shirt, so the whole back print is visible and undistorted. This is a solo shot: no second model, no couple, no one standing beside them.',
    shot: 'The single model faces away from the camera, back naturally flat to the camera, only a slight over-shoulder glance; do not twist the torso in a way that narrows or warps the back print. Hem down, light blue jeans. Frame the one person alone.',
    extra: 'The shot overrides the style reference: even if the reference shows two models, this image has exactly one person.',
  },
  H04: {
    subdir: '主图', role: 'print detail (H04)', aspect: '1:1',
    refs: ['front_png', 'front_effect'],
    request: 'A sharp close-up of the front print as it appears on the finished shirt, filling most of the frame.',
    shot: 'Tight crop of the chest print on the black fabric, raking soft light that reveals print edges, no face, no hands. Keep every line, ornament and letter exactly as in the production PNG.',
    extra: 'This shot exists to let a buyer inspect the artwork. Do not invent metallic, glitter, embroidery or puff effects.',
  },
  H05: {
    subdir: '主图', role: 'garment structure (H05)', aspect: '1:1',
    refs: ['front_effect'],
    request: 'A medium close-up showing the real neckline, shoulder seam and sleeve of this T-shirt on a model.',
    shot: 'Collar and shoulder in focus at a normal viewing distance, soft daylight, fabric falls naturally.',
    extra: 'Do not invent knit density, stitching pattern or fabric technology that the reference does not show.',
  },
  H06: {
    subdir: '主图', role: 'three-quarter angle (H06)', aspect: '1:1',
    refs: ['front_effect', 'style_reference'],
    request: 'A three-quarter side view of one adult model wearing this exact T-shirt, showing the silhouette, length and print position.',
    shot: 'Full body, 35-45 degree turn, relaxed arms, hem down, light blue jeans.',
  },
  H07: {
    subdir: '主图', role: 'lifestyle scene (H07)', aspect: '1:1',
    refs: ['front_effect', 'back_effect', 'style_reference'],
    request: 'A candid street lifestyle photo of the same two adult models walking naturally in the reference setting, still clearly wearing this exact T-shirt.',
    shot: 'Mid-stride, natural expressions, garment and prints readable, background slightly softened, no crowds.',
  },
  H08: {
    subdir: '主图', role: 'styling (H08)', aspect: '1:1',
    refs: ['front_effect', 'style_reference'],
    request: 'A styling shot of one adult model wearing this exact T-shirt under an open light denim jacket.',
    shot: 'Full body, jacket open so the front print stays fully visible, hem down, no bag or prop covering the chest.',
    extra: 'The jacket is styling only and is not part of the product.',
  },
  H09: {
    subdir: '主图', role: 'purchase decision (H09)', aspect: '1:1',
    refs: ['front_effect', 'back_effect'],
    request: 'A clean product photo of this exact shirt laid flat on a light neutral surface, front and back shown as two separate garments side by side.',
    shot: 'Top-down flat lay, both shirts neatly smoothed, prints facing up, even soft light, generous margins.',
    extra: 'This is one informational photo of the same product, not a two-item bundle.',
  },
  H10: {
    subdir: '主图', role: 'alternate hero (H10)', aspect: '1:1',
    refs: ['front_effect', 'back_effect', 'style_reference'],
    request: 'An alternate hero photo in the same visual series as H01, with a different natural pose and expression but the same two models, garments, setting and light.',
    shot: 'Slightly closer framing than H01, woman now facing camera and man turned to show the back print, both prints still readable.',
  },
  D01: {
    subdir: '详情', role: 'detail page hero panel (D01)', aspect: '9:16',
    refs: ['front_effect', 'back_effect'],
    request: 'A vertical detail-page product panel showing this exact shirt twice: one front view and one back view, side by side, on a warm neutral studio background.',
    shot: 'No models, no people, no street: the shirts are presented on invisible mannequins, straight-on and evenly lit, prints fully visible, generous clean negative space at the top for later typography.',
    extra: 'This is a clean catalogue panel, not a lifestyle photo. Do not copy the street setting or the two models from any reference photo. No text in the image: Spanish copy is added later with a layout tool.',
  },
  D02: {
    subdir: '详情', role: 'detail page print close-up (D02)', aspect: '9:16',
    refs: ['front_png', 'front_effect'],
    request: 'A vertical detail panel with a large, sharp close-up of the front print on the fabric.',
    shot: 'Print fills the frame, shallow fabric context at the edges, even light, clean margins.',
    extra: 'Preserve every line and letter of the production PNG; no text overlay.',
  },
  D03: {
    subdir: '详情', role: 'detail page fabric and fit (D03)', aspect: '9:16',
    refs: ['front_effect'],
    request: 'A vertical detail panel showing the collar ribbing, shoulder seam and natural drape of this exact T-shirt on a model.',
    shot: 'Medium close-up, calm pose, soft daylight, clean background, room for later text.',
    extra: 'Show only structure that is actually visible; no invented fabric technology.',
  },
  D04: {
    subdir: '详情', role: 'detail page color options (D04)', aspect: '9:16',
    refs: ['front_effect', 'back_effect'],
    request: 'A vertical detail panel presenting the confirmed colorways of this exact shirt, each on its own invisible mannequin, evenly spaced.',
    shot: 'Clean studio background, one row per color, front view with a smaller back view inset below each, no text.',
    extra: 'Only show colors listed in the run spec. Never invent a colorway.',
  },
  D05: {
    subdir: '详情', role: 'detail page measurement context (D05)', aspect: '9:16',
    refs: ['front_effect'],
    request: 'A vertical detail panel of this exact shirt laid flat and smoothed, seen from above, with clean empty margins for a size table added later.',
    shot: 'Top-down, shirt centered, even light, no measuring tape, no numbers, no text.',
    extra: 'All measurements and Spanish labels are added locally; the image must not invent numbers.',
  },
};

/* ------------------------------------------------------------------ */
/* Prompt builder                                                      */
/* ------------------------------------------------------------------ */

function buildPrompt(spec, jobId) {
  const job = JOBS[jobId];
  if (!job) throw coded('JOB_UNKNOWN', `unknown job ${jobId}`);
  const refs = job.refs.filter((key) => {
    if (key === 'front_effect') return true;
    if (key === 'back_effect') return Boolean(spec.galaxy.back_effect);
    if (key === 'front_png') return Boolean(spec.galaxy.front_png);
    if (key === 'back_png') return Boolean(spec.galaxy.back_png);
    if (key === 'style_reference') return Boolean(spec.style.reference);
    return false;
  });
  if (!refs.length) throw coded('SPEC_REFS_REQUIRED', `${jobId} has no available reference image`);
  if (refs.length > MAX_REFS) throw coded('JOB_TOO_MANY_REFS', `${jobId} needs ${refs.length} references; the image hook accepts ${MAX_REFS}`);

  const lines = [
    'Use case: photorealistic-natural',
    `Asset type: TikTok Shop Mexico ${job.role}`,
    `Primary request: ${job.request}`,
    '',
    'Attachments:',
    joinRefs(refs),
    '',
    'Fixed product facts:',
    productFacts(spec),
    '',
    'Photography:',
    styleFacts(spec),
    '- Precedence: the Shot line below overrides the style reference whenever they conflict, especially the number of people, the framing and the location.',
    `- Shot: ${job.shot}`,
  ];
  if (job.extra) lines.push(`- Intent: ${job.extra}`);
  lines.push('', 'Print fidelity (critical):', fidelityRules(spec, refs));
  lines.push(
    '',
    'Must avoid:',
    '- extra people, extra garments, brand logos, watermarks, price tags, promo badges or UI overlays;',
    '- distorted hands, fingers, limbs or shoulders, warped garment, print hidden by hair, hands or props;',
    '- changing the shirt color, neckline, sleeve length or shirt style;',
    '- turning this into a collage, a multi-panel ad or an infographic.',
    '',
    `Output: exactly one photograph, ${ASPECT_TEXT[job.aspect]}, full resolution, no text overlay.`,
  );
  return { prompt: lines.join('\n'), refs, job };
}

/* ------------------------------------------------------------------ */
/* Run helpers                                                         */
/* ------------------------------------------------------------------ */

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function safeReadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function fileRecord(path, role) {
  const bytes = readFileSync(path);
  return { path, role, sha256: sha256(bytes), bytes: bytes.length };
}

function aspectCheck(width, height, expected) {
  const target = ASPECT_VALUE[expected];
  if (!target) throw coded('ASPECT_UNKNOWN', `unsupported aspect ${JSON.stringify(expected)}`);
  const ratio = width / height;
  return { expected, target, ratio, passed: Math.abs(ratio - target) <= ASPECT_TOLERANCE };
}

function inspectOutput(path, expectedAspect, minLongEdge) {
  const bytes = readFileSync(path);
  const png = decodePng(bytes);
  const longEdge = Math.max(png.width, png.height);
  const aspect = aspectCheck(png.width, png.height, expectedAspect);
  const gates = [
    { name: 'png_decodes', passed: true, detail: `${png.width}x${png.height}, colorType ${png.colorType}` },
    { name: 'min_long_edge', passed: longEdge >= minLongEdge, detail: `${longEdge}px >= ${minLongEdge}px` },
    { name: 'expected_aspect', passed: aspect.passed, detail: `${aspect.ratio.toFixed(4)} vs ${aspect.target.toFixed(4)}` },
  ];
  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    width: png.width,
    height: png.height,
    longEdge,
    aspect_check: aspect,
    gates,
    status: gates.every((item) => item.passed) ? 'generated' : 'blocked',
    visual_review: 'pending',
  };
}

function spawnImgen({ prompt, refs, outPath, generation, logPath, imgenCli }) {
  return new Promise((resolvePromise) => {
    const args = [
      imgenCli, prompt,
      '-o', outPath,
      '-s', 'auto',
      '-q', generation.quality,
      '-m', generation.model,
      '-e', generation.effort,
      '--image-model', generation.image_model,
    ];
    for (const ref of refs) args.push('-i', ref);
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, JOB_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: `SPAWN_FAILED: ${error.message}`, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const revised = /编排模型改写后的 prompt：\s*(.+)/.exec(stdout)?.[1]?.trim() || null;
      const log = JSON.stringify({
        job_out: outPath, exit_code: code, timed_out: timedOut,
        stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000),
        started: new Date(startedAt).toISOString(), duration_ms: Date.now() - startedAt,
      });
      appendFileSync(logPath, `${log}\n`);
      if (timedOut) return resolvePromise({ ok: false, error: 'JOB_TIMEOUT', revised, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
      if (code !== 0) return resolvePromise({ ok: false, error: `IMGEN_EXIT_${code}`, revised, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
      if (!existsSync(outPath)) return resolvePromise({ ok: false, error: 'OUTPUT_MISSING', revised, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
      return resolvePromise({ ok: true, revised, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
  });
}

function outputName(spec, jobId) {
  const job = JOBS[jobId];
  const slug = job.role
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .split('_')
    .slice(0, 2)
    .join('_');
  return `${spec.product.code}_${jobId}_${slug}_${spec.product.color.toLowerCase()}_v01.png`;
}

function planJobs(spec, outDir, only) {
  const ids = (only && only.length ? only : (spec.jobs && spec.jobs.length ? spec.jobs : Object.keys(JOBS))).map(assertJobId);
  const promptsDir = ensureDir(join(outDir, 'prompts'));
  const planned = ids.map((id) => {
    const { prompt, refs, job } = buildPrompt(spec, id);
    const promptPath = join(promptsDir, `${id}.txt`);
    writeFileSync(promptPath, prompt, 'utf8');
    return {
      id,
      role: job.role,
      subdir: job.subdir,
      aspect: job.aspect,
      prompt_path: promptPath,
      prompt_sha256: sha256(Buffer.from(prompt, 'utf8')),
      references: refs.map((key) => ({
        role: key,
        label: REF_LABEL[key],
        path: refKeyPath(spec, key),
        sha256: sha256(readFileSync(refKeyPath(spec, key))),
      })),
      output: join(outDir, job.subdir, outputName(spec, id)),
    };
  });
  const planPath = join(outDir, 'jobs.json');
  writeFileSync(planPath, JSON.stringify({
    schema: 'pod-marketing-plan-v1',
    spec: spec.path,
    spec_sha256: sha256(readFileSync(spec.path)),
    planned_at: nowIso(),
    product: spec.product,
    galaxy: spec.galaxy,
    style: spec.style,
    generation: spec.generation,
    jobs: planned,
  }, null, 2));
  return { planPath, jobs: planned };
}

function refKeyPath(spec, key) {
  const map = {
    front_effect: spec.galaxy.front_effect,
    back_effect: spec.galaxy.back_effect,
    front_png: spec.galaxy.front_png,
    back_png: spec.galaxy.back_png,
    style_reference: spec.style.reference,
  };
  const path = map[key];
  if (!path) throw coded('REF_MISSING', `no path for reference role ${key}`);
  return path;
}

async function runJobs({ spec, outDir, only, concurrency, overwrite }) {
  const imgenCli = resolveImgenCli();
  const { planPath, jobs } = planJobs(spec, outDir, only);
  const logsDir = ensureDir(join(outDir, 'logs'));
  const logPath = join(logsDir, `run-${Date.now()}.jsonl`);
  for (const job of jobs) ensureDir(dirname(job.output));

  const width = Math.min(Math.max(1, concurrency || DEFAULT_CONCURRENCY), MAX_CONCURRENCY);
  const results = new Array(jobs.length);
  let cursor = 0;

  const runOne = async (job, index) => {
    const startedAt = Date.now();
    if (overwrite && existsSync(job.output)) {
      // Keep the rejected take: a rerun must never silently destroy the image a
      // reviewer already looked at.
      const rejectedDir = ensureDir(join(outDir, 'rejected'));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      renameSync(job.output, join(rejectedDir, `${basename(job.output, '.png')}__${stamp}.png`));
    }
    if (!overwrite && existsSync(job.output)) {
      try {
        const inspected = inspectOutput(job.output, job.aspect, spec.generation.min_long_edge);
        return { ...job, ...inspected, status: inspected.status === 'generated' ? 'reused' : 'blocked', reused: true, duration_ms: 0, started_at: new Date(startedAt).toISOString() };
      } catch (error) {
        // fall through and regenerate a corrupt file
      }
    }
    const { prompt, refs } = buildPrompt(spec, job.id);
    const outcome = await spawnImgen({
      prompt,
      refs: refs.map((key) => refKeyPath(spec, key)),
      outPath: job.output,
      generation: spec.generation,
      logPath,
      imgenCli,
    });
    if (!outcome.ok) {
      return { ...job, status: 'failed', error: outcome.error, duration_ms: outcome.durationMs, started_at: new Date(startedAt).toISOString(), visual_review: 'pending' };
    }
    try {
      const inspected = inspectOutput(job.output, job.aspect, spec.generation.min_long_edge);
      return { ...job, ...inspected, revised_prompt: outcome.revised, duration_ms: outcome.durationMs, started_at: new Date(startedAt).toISOString() };
    } catch (error) {
      return { ...job, status: 'failed', error: `VERIFY_FAILED: ${error.code || error.message}`, duration_ms: outcome.durationMs, started_at: new Date(startedAt).toISOString(), visual_review: 'pending' };
    }
  };

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      results[index] = await runOne(jobs[index], index);
    }
  };
  const startedAt = nowIso();
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));

  // A partial rerun must not erase the rest of the pack: merge by job id and
  // keep the manifest a complete record of this run directory.
  const existing = safeReadJson(join(outDir, 'manifest.json'));
  let merged = results;
  if (existing?.schema === RUN_SCHEMA && Array.isArray(existing.jobs)) {
    const map = new Map(existing.jobs.map((row) => [row.id, row]));
    for (const row of results) map.set(row.id, row);
    const order = Object.keys(JOBS);
    merged = [...map.values()].sort((left, right) => {
      const li = order.indexOf(left.id);
      const ri = order.indexOf(right.id);
      return (li < 0 ? 99 : li) - (ri < 0 ? 99 : ri);
    });
  }
  const generated = merged.filter((row) => row.status === 'generated' || row.status === 'reused').length;
  const failed = merged.filter((row) => row.status === 'failed' || row.status === 'blocked').length;
  const manifest = {
    schema: RUN_SCHEMA,
    spec: { path: spec.path, sha256: sha256(readFileSync(spec.path)) },
    plan: planPath,
    product: spec.product,
    galaxy: { design_id: spec.galaxy.design_id, readback_at: spec.galaxy.readback_at },
    style: spec.style,
    generation: { ...spec.generation, concurrency: width, image_hook: imgenCli },
    started_at: startedAt,
    finished_at: nowIso(),
    jobs: merged,
    totals: { requested: merged.length, generated, failed },
    gate: {
      status: 'visual_review_required',
      note: 'Files were produced and machine-checked for decodability, pixels and aspect. Pattern fidelity, faces, hands and garment structure still need a visual review; nothing here is frozen or publishable.',
      native_4k_claim: false,
    },
  };
  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, manifest };
}

function reviewRun(outDir, jobId, status, note) {
  if (!['pass', 'fail'].includes(status)) throw coded('REVIEW_STATUS_INVALID', 'status must be pass or fail');
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = safeReadJson(manifestPath);
  if (!manifest) throw coded('MANIFEST_MISSING', `no manifest at ${manifestPath}`);
  const job = manifest.jobs.find((row) => row.id === jobId);
  if (!job) throw coded('JOB_NOT_FOUND', `job ${jobId} is not in this run`);
  if (job.status !== 'generated' && job.status !== 'reused') throw coded('JOB_NOT_GENERATED', `job ${jobId} is ${job.status}`);
  job.visual_review = { status, note: String(note || '').slice(0, 2000), reviewed_at: nowIso() };
  const reviewed = manifest.jobs.filter((row) => row.visual_review && row.visual_review.status);
  const failed = manifest.jobs.filter((row) => row.visual_review?.status === 'fail');
  manifest.gate = {
    ...manifest.gate,
    status: failed.length ? 'blocked_by_visual_review' : reviewed.length === manifest.jobs.length && manifest.jobs.length > 0 ? 'visual_pass_freeze_pending' : 'visual_review_required',
    reviewed_jobs: reviewed.length,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifest: manifestPath, job: jobId, visual_review: job.visual_review, gate: manifest.gate };
}

function verifyRun(outDir) {
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = safeReadJson(manifestPath);
  if (!manifest) throw coded('MANIFEST_MISSING', `no manifest at ${manifestPath}`);
  const rows = manifest.jobs.map((job) => {
    if (!existsSync(job.output)) return { id: job.id, status: 'missing', output: job.output };
    const expected = typeof job.aspect === 'string' ? job.aspect : job.aspect?.expected || '1:1';
    try {
      const inspected = inspectOutput(job.output, expected, manifest.generation.min_long_edge);
      return { id: job.id, output: job.output, ...inspected };
    } catch (error) {
      return { id: job.id, status: 'invalid', output: job.output, error: String(error.message).slice(0, 200) };
    }
  });
  return {
    manifest: manifestPath,
    verified_at: nowIso(),
    rows,
    totals: {
      total: rows.length,
      decodable: rows.filter((row) => row.width).length,
      failing: rows.filter((row) => row.status !== 'generated').length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

const MCP_TOOLS = [
  {
    name: 'marketing_studio_plan',
    description: 'Build per-shot prompts and reference bindings from a POD marketing spec without generating images.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_path: { type: 'string' },
        out_dir: { type: 'string' },
        jobs: { type: 'array', items: { type: 'string' } },
      },
      required: ['spec_path', 'out_dir'],
    },
  },
  {
    name: 'marketing_studio_run',
    description: 'Generate the requested marketing shots concurrently through the local Magpie/imgen hook, then verify each PNG and write a manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_path: { type: 'string' },
        out_dir: { type: 'string' },
        jobs: { type: 'array', items: { type: 'string' } },
        concurrency: { type: 'number' },
        overwrite: { type: 'boolean' },
      },
      required: ['spec_path', 'out_dir'],
    },
  },
  {
    name: 'marketing_studio_verify',
    description: 'Re-verify an existing marketing run: decode every PNG, recompute pixels, aspect and SHA-256.',
    inputSchema: {
      type: 'object',
      properties: { out_dir: { type: 'string' } },
      required: ['out_dir'],
    },
  },
  {
    name: 'marketing_studio_review',
    description: 'Record the visual verdict for one generated shot. A failed shot blocks the run gate; the run never marks itself publishable.',
    inputSchema: {
      type: 'object',
      properties: {
        out_dir: { type: 'string' },
        job: { type: 'string' },
        status: { type: 'string', enum: ['pass', 'fail'] },
        note: { type: 'string' },
      },
      required: ['out_dir', 'job', 'status'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'marketing_studio_plan') {
    const spec = normalizeSpec(args.spec_path);
    return planJobs(spec, args.out_dir, args.jobs);
  }
  if (name === 'marketing_studio_run') {
    const spec = normalizeSpec(args.spec_path);
    return runJobs({
      spec,
      outDir: args.out_dir,
      only: args.jobs,
      concurrency: args.concurrency,
      overwrite: args.overwrite === true,
    });
  }
  if (name === 'marketing_studio_verify') {
    return verifyRun(args.out_dir);
  }
  if (name === 'marketing_studio_review') {
    return reviewRun(args.out_dir, args.job, args.status, args.note);
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
        if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'marketing-image-studio', version: '0.1.0' } };
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

  if (args.command === 'plan') {
    if (!args.spec || !args.out) throw coded('INVALID_PARAMS', 'plan requires --spec and --out');
    const spec = normalizeSpec(args.spec);
    const result = planJobs(spec, args.out, args.jobs ? String(args.jobs).split(',').filter(Boolean) : null);
    console.log(JSON.stringify({ ok: true, plan: result.planPath, jobs: result.jobs.map((job) => ({ id: job.id, output: job.output })) }, null, 2));
    return;
  }
  if (args.command === 'run') {
    if (!args.spec || !args.out) throw coded('INVALID_PARAMS', 'run requires --spec and --out');
    const spec = normalizeSpec(args.spec);
    const result = await runJobs({
      spec,
      outDir: args.out,
      only: args.jobs ? String(args.jobs).split(',').filter(Boolean) : null,
      concurrency: args.concurrency ? Number(args.concurrency) : spec.generation.concurrency,
      overwrite: args.overwrite === true,
    });
    console.log(JSON.stringify({
      ok: result.manifest.totals.failed === 0,
      manifest: result.manifestPath,
      totals: result.manifest.totals,
      gate: result.manifest.gate,
      jobs: result.manifest.jobs.map((job) => ({ id: job.id, status: job.status, output: job.output, width: job.width, height: job.height, error: job.error })),
    }, null, 2));
    process.exitCode = result.manifest.totals.failed === 0 ? 0 : 1;
    return;
  }
  if (args.command === 'verify') {
    if (!args.out) throw coded('INVALID_PARAMS', 'verify requires --out');
    const result = verifyRun(args.out);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.totals.failing === 0 ? 0 : 1;
    return;
  }
  if (args.command === 'review') {
    if (!args.out || !args.job || !args.status) throw coded('INVALID_PARAMS', 'review requires --out, --job and --status');
    const result = reviewRun(args.out, args.job, args.status, args.note);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    process.exitCode = result.gate.status === 'blocked_by_visual_review' ? 1 : 0;
    return;
  }
  if (args.command === 'status') {
    if (!args.out) throw coded('INVALID_PARAMS', 'status requires --out');
    const manifest = safeReadJson(join(args.out, 'manifest.json'));
    if (!manifest) throw coded('MANIFEST_MISSING', 'no manifest');
    console.log(JSON.stringify({
      manifest: join(args.out, 'manifest.json'),
      product: manifest.product,
      totals: manifest.totals,
      gate: manifest.gate,
      jobs: manifest.jobs.map((job) => ({ id: job.id, status: job.status, visual_review: job.visual_review, output: job.output })),
    }, null, 2));
    return;
  }
  throw coded('UNKNOWN_COMMAND', 'commands: plan | run | verify | review | status | mcp');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', error: String(error.message).slice(0, 400) }));
    process.exitCode = 1;
  });
}

export { normalizeSpec, buildPrompt, planJobs, runJobs, verifyRun, reviewRun, inspectOutput, JOBS, MCP_TOOLS, callTool, mcpServer };
