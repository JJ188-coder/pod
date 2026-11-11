#!/usr/bin/env node
// Thin stdio MCP entry. Implementation lives in lib/.
import { exportRun } from '../lib/export.mjs';
import { downloadImagesForRun } from '../lib/images.mjs';
import { fetchSkus, runAll, runRankings, status } from '../lib/run.mjs';
import { CATEGORY_PATH, parseWeek, resolveDataRoot } from '../lib/util.mjs';

const SERVER = { name: 'echotik-top100-sku', version: '0.1.0' };

const TOOLS = [
  {
    name: 'echotik_top100_status',
    description:
      '查看某周 Top100 榜单与 SKU 抓取进度：已抓/待抓/失败数量、今日已用额度、输出目录。',
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string', description: 'YYYYMMDD-YYYYMMDD，默认上一个完整周' },
        data_dir: { type: 'string', description: '数据目录，默认插件内 data/' },
      },
    },
  },
  {
    name: 'echotik_top100_rankings',
    description:
      '抓取墨西哥男士T恤周榜 Top100（5 页 × 20 条），写入 rankings.json。需要 Chrome 调试端口且已登录 EchoTik。',
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string' },
        cdp: { type: 'string', description: '默认 http://127.0.0.1:9223' },
        data_dir: { type: 'string' },
        category_path: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'echotik_top100_skus',
    description:
      '按榜单逐个抓商品页 SSR 里的全部 SKU（颜色/尺码/SKU ID/价格/库存/颜色图）。默认本次最多 20 个，可重复调用续跑。',
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string' },
        limit: { type: 'number', description: '本次最多抓多少个商品，默认 20' },
        daily_cap: { type: 'number', description: '当日详情请求上限，默认 100' },
        delay_ms: { type: 'number', description: '商品间隔毫秒，默认 1800' },
        cdp: { type: 'string' },
        data_dir: { type: 'string' },
      },
    },
  },
  {
    name: 'echotik_top100_images',
    description:
      '下载榜单里的商品主图，按 product_id 命名到 images/<product_id>.webp，并写 manifest.json。已存在且有效的图片会跳过。',
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string' },
        data_dir: { type: 'string' },
        image_delay_ms: { type: 'number', description: '图片间隔毫秒，默认 300' },
        overwrite: { type: 'boolean', description: '覆盖已存在的图片，默认 false' },
      },
    },
  },
  {
    name: 'echotik_top100_run',
    description:
      '一步完成：榜单不存在则先抓 Top100，然后抓一批 SKU，最后下载商品主图。默认每批 20 个，适合分多次调用。',
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string' },
        limit: { type: 'number', description: '本次最多抓多少个商品，默认 20' },
        daily_cap: { type: 'number' },
        delay_ms: { type: 'number' },
        skip_images: { type: 'boolean', description: '跳过主图下载' },
        cdp: { type: 'string' },
        data_dir: { type: 'string' },
      },
    },
  },
  {
    name: 'echotik_top100_export',
    description: '从本地状态生成 top100-skus.csv 与 bundle.json，不发任何网络请求。',
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string' },
        data_dir: { type: 'string' },
      },
    },
  },
];

function baseOptions(args) {
  const week = parseWeek(args.week);
  const dataDir = resolveDataRoot(args.data_dir);
  return {
    week,
    dataDir,
    cdp: args.cdp ?? 'http://127.0.0.1:9223',
    categoryPath: Array.isArray(args.category_path) && args.category_path.length
      ? args.category_path.map(String)
      : CATEGORY_PATH,
    limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 20,
    dailyCap: Number.isFinite(Number(args.daily_cap)) ? Number(args.daily_cap) : 100,
    delayMs: Number.isFinite(Number(args.delay_ms)) ? Number(args.delay_ms) : 1800,
    imageDelayMs: Number.isFinite(Number(args.image_delay_ms))
      ? Number(args.image_delay_ms)
      : 300,
    skipImages: Boolean(args.skip_images),
    overwrite: Boolean(args.overwrite),
  };
}

async function callTool(name, args) {
  const options = baseOptions(args);
  if (name === 'echotik_top100_status') {
    return status({ week: options.week, dataDir: options.dataDir });
  }
  if (name === 'echotik_top100_rankings') {
    return runRankings(options);
  }
  if (name === 'echotik_top100_skus') {
    return fetchSkus(options);
  }
  if (name === 'echotik_top100_images') {
    return downloadImagesForRun({
      week: options.week,
      dataDir: options.dataDir,
      delayMs: options.imageDelayMs,
      overwrite: options.overwrite,
    });
  }
  if (name === 'echotik_top100_run') {
    return runAll(options);
  }
  if (name === 'echotik_top100_export') {
    return exportRun(`${options.dataDir}/${options.week}`);
  }
  const error = new Error(`unknown tool ${name}`);
  error.code = 'UNKNOWN_TOOL';
  throw error;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function mcpServer() {
  let buffer = '';
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
      try {
        request = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'PARSE_ERROR' } });
        continue;
      }
      const { id, method, params } = request;
      Promise.resolve()
        .then(async () => {
          if (method === 'initialize') {
            return {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: SERVER,
            };
          }
          if (method === 'tools/list') return { tools: TOOLS };
          if (method === 'tools/call') {
            const tool = TOOLS.find((item) => item.name === params?.name);
            if (!tool) {
              const error = new Error('unknown tool');
              error.code = 'UNKNOWN_TOOL';
              throw error;
            }
            const result = await callTool(tool.name, params.arguments ?? {});
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }
          if (method === 'ping' || method === 'notifications/initialized') return {};
          const error = new Error('method not found');
          error.code = 'INVALID_REQUEST';
          throw error;
        })
        .then((result) => {
          if (id !== undefined) send({ jsonrpc: '2.0', id, result });
        })
        .catch((error) => {
          if (id !== undefined) {
            send({
              jsonrpc: '2.0',
              id,
              error: {
                code: errorCodes[error.code] ?? -32000,
                message: error.code ?? 'SERVICE_ERROR',
                data: { code: error.code ?? 'SERVICE_ERROR', detail: String(error.message).slice(0, 300) },
              },
            });
          }
        });
    }
  });
}

mcpServer();
