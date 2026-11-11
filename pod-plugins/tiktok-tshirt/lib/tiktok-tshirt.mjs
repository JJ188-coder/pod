#!/usr/bin/env node
/**
 * tiktok-tshirt — one entry point for a TikTok Shop T-shirt marketing pack.
 *
 * It composes three already-separated pieces instead of duplicating them:
 *   1. marketing shots  -> marketing-image-studio.mjs (concurrent Magpie/imgen)
 *   2. detail page      -> tshirt-detail-composer.mjs (local headless-Chrome layout)
 *   3. pack manifest    -> upload selection + gates for the listing station
 *
 * Boundaries:
 *   - Local files only. No Galaxy, Slack, seller-center or platform write.
 *   - Producing a pack is not freezing it and not listing it. Gate stays
 *     "visual_review_required" / "frozen: false" until a reviewer records it.
 *   - Size numbers and Spanish copy come from the specs; this tool never
 *     invents measurements, colors or material claims.
 *
 * CLI:
 *   node tiktok-tshirt.mjs marketing --spec SPEC.json --out DIR [--jobs H01,H03] [--concurrency 2]
 *   node tiktok-tshirt.mjs detail    --spec DETAIL.json --out DIR
 *   node tiktok-tshirt.mjs pack      --marketing-spec SPEC.json --detail-spec DETAIL.json --out DIR [--jobs ...]
 *   node tiktok-tshirt.mjs status    --out DIR
 *   node tiktok-tshirt.mjs mcp
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeSpec, runJobs } from './marketing-image-studio.mjs';
import { render as renderDetail } from './tshirt-detail-composer.mjs';

const PACK_SCHEMA = 'pod-tshirt-pack-v1';
const coded = (code, message) => Object.assign(new Error(message), { code });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nowIso = () => new Date().toISOString();

function readJson(path, label) {
  if (!isAbsolute(path)) throw coded('PACK_PATH_NOT_ABSOLUTE', `${label} must be absolute`);
  if (!existsSync(path)) throw coded('PACK_PATH_MISSING', `${label} does not exist: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function marketingRun({ specPath, outDir, jobs, concurrency }) {
  const spec = normalizeSpec(specPath);
  return runJobs({
    spec,
    outDir,
    only: jobs && jobs.length ? jobs : null,
    concurrency: concurrency || spec.generation.concurrency,
    overwrite: false,
  });
}

function detailRun({ specPath, outDir }) {
  return renderDetail(specPath, outDir);
}

function uploadSelection(marketingManifest, limit = 9) {
  const available = marketingManifest.jobs
    .filter((job) => job.status === 'generated' || job.status === 'reused')
    .filter((job) => job.id.startsWith('H'))
    .sort((left, right) => left.id.localeCompare(right.id));
  const chosen = available.slice(0, limit).map((job, index) => ({ order: index + 1, id: job.id, file: job.output, sha256: job.sha256 }));
  return {
    main_images: chosen,
    limit,
    note: chosen.length > limit
      ? 'TikTok 主图上限 9 张，已按 H01 起顺序取前 9 张；其余保留在包内备用。'
      : '按 H01 起顺序上传；未达 9 张时保留现有顺序。',
    extras: available.slice(limit).map((job) => job.id),
  };
}

async function buildPack({ marketingSpecPath, detailSpecPath, outDir, jobs, concurrency }) {
  const marketing = await marketingRun({ specPath: marketingSpecPath, outDir, jobs, concurrency });
  const detail = await detailRun({ specPath: detailSpecPath, outDir: join(outDir, '详情页') });
  const marketingManifest = marketing.manifest;
  const detailManifest = detail.manifest;
  const pack = {
    schema: PACK_SCHEMA,
    product: marketingManifest.product,
    created_at: nowIso(),
    marketing: {
      manifest: marketing.manifestPath,
      totals: marketingManifest.totals,
      gate: marketingManifest.gate,
    },
    detail: {
      manifest: detail.manifestPath,
      sections: detailManifest.sections.length,
      full: detailManifest.full,
      gate: detailManifest.gate,
      text_check: detailManifest.text_check,
    },
    upload_selection: uploadSelection(marketingManifest),
    gate: {
      status: 'visual_review_required',
      frozen: false,
      note: 'Pack produced locally. Visual review, freeze, field review, supply/cost proof and the platform readback still decide whether it may be listed.',
    },
  };
  const packPath = join(outDir, 'pack.json');
  writeFileSync(packPath, JSON.stringify(pack, null, 2));
  return { packPath, pack };
}

function packStatus(outDir) {
  const packPath = join(outDir, 'pack.json');
  if (!existsSync(packPath)) throw coded('PACK_MISSING', `no pack.json at ${packPath}`);
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  const marketingManifest = JSON.parse(readFileSync(pack.marketing.manifest, 'utf8'));
  return {
    pack: packPath,
    product: pack.product,
    marketing: {
      totals: pack.marketing.totals,
      gate: marketingManifest.gate,
      jobs: marketingManifest.jobs.map((job) => ({ id: job.id, status: job.status, review: job.visual_review?.status || 'pending' })),
    },
    detail: pack.detail,
    upload_selection: pack.upload_selection,
    gate: pack.gate,
  };
}

/* ------------------------------- MCP ------------------------------- */

const MCP_TOOLS = [
  {
    name: 'tshirt_marketing_run',
    description: 'Run the marketing shots for one T-shirt spec concurrently through the local Magpie/imgen hook.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_path: { type: 'string' }, out_dir: { type: 'string' },
        jobs: { type: 'array', items: { type: 'string' } }, concurrency: { type: 'number' },
      },
      required: ['spec_path', 'out_dir'],
    },
  },
  {
    name: 'tshirt_detail_render',
    description: 'Render the vertical Spanish detail page locally from confirmed facts and approved images.',
    inputSchema: {
      type: 'object',
      properties: { spec_path: { type: 'string' }, out_dir: { type: 'string' } },
      required: ['spec_path', 'out_dir'],
    },
  },
  {
    name: 'tshirt_pack_run',
    description: 'Build a full marketing pack: concurrent shots + vertical detail page + upload selection + gates.',
    inputSchema: {
      type: 'object',
      properties: {
        marketing_spec: { type: 'string' }, detail_spec: { type: 'string' }, out_dir: { type: 'string' },
        jobs: { type: 'array', items: { type: 'string' } }, concurrency: { type: 'number' },
      },
      required: ['marketing_spec', 'detail_spec', 'out_dir'],
    },
  },
  {
    name: 'tshirt_pack_status',
    description: 'Read the pack, shot reviews, detail sections and upload selection.',
    inputSchema: { type: 'object', properties: { out_dir: { type: 'string' } }, required: ['out_dir'] },
  },
];

async function callTool(name, args) {
  if (name === 'tshirt_marketing_run') return marketingRun({ specPath: args.spec_path, outDir: args.out_dir, jobs: args.jobs, concurrency: args.concurrency });
  if (name === 'tshirt_detail_render') return detailRun({ specPath: args.spec_path, outDir: args.out_dir });
  if (name === 'tshirt_pack_run') return buildPack({ marketingSpecPath: args.marketing_spec, detailSpecPath: args.detail_spec, outDir: args.out_dir, jobs: args.jobs, concurrency: args.concurrency });
  if (name === 'tshirt_pack_status') return packStatus(args.out_dir);
  throw coded('UNKNOWN_TOOL', `unknown tool ${name}`);
}

function mcpServer() {
  let buffer = '';
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const errorCodes = { INVALID_PARAMS: -32602, INVALID_REQUEST: -32600, UNKNOWN_TOOL: -32601 };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'PARSE_ERROR' } }); continue; }
      const { id, method, params } = request;
      Promise.resolve().then(async () => {
        if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tiktok-tshirt', version: '0.1.0' } };
        if (method === 'tools/list') return { tools: MCP_TOOLS };
        if (method === 'tools/call') {
          const tool = MCP_TOOLS.find((item) => item.name === params?.name);
          if (!tool) throw coded('UNKNOWN_TOOL', 'unknown tool');
          return { content: [{ type: 'text', text: JSON.stringify(await callTool(tool.name, params.arguments || {})) }] };
        }
        if (method === 'ping' || method === 'notifications/initialized') return {};
        throw coded('METHOD_NOT_FOUND', 'method not found');
      }).then((result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); })
        .catch((error) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: errorCodes[error.code] || -32000, message: error.code || 'SERVICE_ERROR', data: { code: error.code || 'SERVICE_ERROR', detail: String(error.message).slice(0, 300) } } }); });
    }
  });
}

/* ------------------------------- CLI ------------------------------- */

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
  const jobs = args.jobs ? String(args.jobs).split(',').filter(Boolean) : null;
  if (args.command === 'mcp') return mcpServer();
  if (args.command === 'marketing') {
    if (!args.spec || !args.out) throw coded('INVALID_PARAMS', 'marketing requires --spec and --out');
    const result = await marketingRun({ specPath: args.spec, outDir: args.out, jobs, concurrency: args.concurrency ? Number(args.concurrency) : null });
    console.log(JSON.stringify({ manifest: result.manifestPath, totals: result.manifest.totals, gate: result.manifest.gate }, null, 2));
    process.exitCode = result.manifest.totals.failed === 0 ? 0 : 1;
    return;
  }
  if (args.command === 'detail') {
    if (!args.spec || !args.out) throw coded('INVALID_PARAMS', 'detail requires --spec and --out');
    const result = await detailRun({ specPath: args.spec, outDir: args.out });
    console.log(JSON.stringify({ manifest: result.manifestPath, full: result.manifest.full, text_check: result.manifest.text_check, gate: result.manifest.gate }, null, 2));
    process.exitCode = result.manifest.text_check.passed ? 0 : 1;
    return;
  }
  if (args.command === 'pack') {
    if (!args['marketing-spec'] || !args['detail-spec'] || !args.out) throw coded('INVALID_PARAMS', 'pack requires --marketing-spec, --detail-spec and --out');
    const result = await buildPack({
      marketingSpecPath: args['marketing-spec'],
      detailSpecPath: args['detail-spec'],
      outDir: args.out,
      jobs,
      concurrency: args.concurrency ? Number(args.concurrency) : null,
    });
    console.log(JSON.stringify({ pack: result.packPath, ...result.pack }, null, 2));
    process.exitCode = result.pack.marketing.totals.failed === 0 && result.pack.detail.text_check.passed ? 0 : 1;
    return;
  }
  if (args.command === 'status') {
    if (!args.out) throw coded('INVALID_PARAMS', 'status requires --out');
    console.log(JSON.stringify(packStatus(args.out), null, 2));
    return;
  }
  throw coded('UNKNOWN_COMMAND', 'commands: marketing | detail | pack | status | mcp');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', error: String(error.message).slice(0, 400) }));
    process.exitCode = 1;
  });
}

export { buildPack, packStatus, marketingRun, detailRun, MCP_TOOLS, callTool, mcpServer, sha256 };
