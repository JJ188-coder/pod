#!/usr/bin/env node
/**
 * EchoTik Top100 SKU 导出 CLI
 *
 * 用法：
 *   node cli.mjs rankings --week 20261026-20261101
 *   node cli.mjs skus     --week 20261026-20261101 --limit 50
 *   node cli.mjs run      --week 20261026-20261101
 *   node cli.mjs export   --week 20261026-20261101
 *   node cli.mjs status   --week 20261026-20261101
 *
 * 默认数据目录：<plugin>/data
 * 默认调试地址：http://127.0.0.1:9223
 */

import { exportRun } from './lib/export.mjs';
import { downloadImagesForRun } from './lib/images.mjs';
import { fetchSkus, runAll, runRankings, status } from './lib/run.mjs';
import { CATEGORY_PATH, parseWeek, resolveDataRoot } from './lib/util.mjs';

const HELP = `EchoTik 墨西哥男装T恤周榜 Top100 SKU 导出

命令：
  rankings   抓取 Top100 榜单（5 页 × 20）
  skus       按榜单逐个抓商品页 SSR 里的 SKU
  images     下载榜单里的商品主图，按 product_id 命名
  run        rankings + skus + images（榜单已存在则复用）
  export     从本地状态生成 CSV 与 bundle.json
  status     查看覆盖率、今日额度、失败列表

参数：
  --week YYYYMMDD-YYYYMMDD   周榜区间，默认上一个完整周
  --category-path A,B,C      默认 824328,839944,601226（墨西哥男士T恤）
  --cdp URL                  Chrome 调试地址，默认 http://127.0.0.1:9223
  --data-dir DIR             数据目录，默认 <plugin>/data
  --limit N                  skus/run 本次最多抓多少个（默认不限制，受日额度约束）
  --daily-cap N              每日详情请求上限，默认 100（标准版）
  --delay MS                 商品间隔毫秒，默认 1800
  --image-delay MS           图片下载间隔毫秒，默认 300
  --overwrite                覆盖已存在的图片
  --skip-images              run 时不下载图片
  --pages N                  rankings 抓几页，默认 5
  --per-page N               rankings 每页条数，默认 20
  --help                     显示本说明

示例：
  node cli.mjs run --week 20261026-20261101 --limit 50
  node cli.mjs status --week 20261026-20261101
  node cli.mjs export --week 20261026-20261101
`;

function parseArgs(argv) {
  const options = {
    command: null,
    week: undefined,
    categoryPath: CATEGORY_PATH,
    cdp: 'http://127.0.0.1:9223',
    dataDir: undefined,
    limit: null,
    dailyCap: 100,
    delayMs: 1800,
    imageDelayMs: 300,
    overwrite: false,
    skipImages: false,
    pages: 5,
    perPage: 20,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--overwrite') {
      options.overwrite = true;
      continue;
    }
    if (token === '--skip-images') {
      options.skipImages = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) {
      positional.push(token);
      continue;
    }
    const name = match[1];
    const value =
      match[2] !== undefined
        ? match[2]
        : (() => {
            if (index + 1 >= argv.length) throw new Error(`--${name} 缺少参数值`);
            index += 1;
            return argv[index];
          })();
    if (name === 'week') options.week = value;
    else if (name === 'category-path') {
      options.categoryPath = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (name === 'cdp') options.cdp = value;
    else if (name === 'data-dir') options.dataDir = value;
    else if (name === 'limit') options.limit = Number(value);
    else if (name === 'daily-cap') options.dailyCap = Number(value);
    else if (name === 'delay') options.delayMs = Number(value);
    else if (name === 'image-delay') options.imageDelayMs = Number(value);
    else if (name === 'pages') options.pages = Number(value);
    else if (name === 'per-page') options.perPage = Number(value);
    else throw new Error(`未知参数：--${name}`);
  }
  options.command = positional[0] ?? null;
  if (!options.command) throw new Error('缺少命令：rankings | skus | run | export | status');
  if (!Number.isFinite(options.dailyCap) || options.dailyCap < 1) {
    throw new Error('--daily-cap 必须是正整数');
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error('--delay 必须是非负整数');
  }
  if (!Number.isFinite(options.imageDelayMs) || options.imageDelayMs < 0) {
    throw new Error('--image-delay 必须是非负整数');
  }
  return options;
}

function progress(event) {
  if (event.page) {
    process.stderr.write(`榜单第 ${event.page} 页：${event.rows} 条\n`);
    return;
  }
  if (event.productId) {
    const suffix = event.ok ? `${event.skuCount} 个 SKU` : `失败 ${event.error}`;
    process.stderr.write(`[${event.index}/${event.total}] ${event.productId} ${suffix}\n`);
  }
}

function imageProgress(event) {
  if (!event.productId) return;
  const suffix = event.ok
    ? event.skipped
      ? '已存在'
      : `${event.bytes} bytes`
    : `失败 ${event.error}`;
  process.stderr.write(`[image ${event.index}/${event.total}] ${event.productId} ${suffix}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const week = parseWeek(options.week);
  const dataDir = resolveDataRoot(options.dataDir);
  const common = {
    cdp: options.cdp,
    week,
    dataDir,
    categoryPath: options.categoryPath,
    pages: options.pages,
    perPage: options.perPage,
    limit: options.limit,
    dailyCap: options.dailyCap,
    delayMs: options.delayMs,
    imageDelayMs: options.imageDelayMs,
    skipImages: options.skipImages,
    onProgress: progress,
    onImageProgress: imageProgress,
  };

  let result;
  if (options.command === 'rankings') {
    result = await runRankings(common);
  } else if (options.command === 'skus') {
    result = await fetchSkus(common);
  } else if (options.command === 'images') {
    result = await downloadImagesForRun({
      week,
      dataDir,
      delayMs: options.imageDelayMs,
      overwrite: options.overwrite,
      onProgress: imageProgress,
    });
  } else if (options.command === 'run') {
    result = await runAll(common);
  } else if (options.command === 'export') {
    result = await exportRun(`${dataDir}/${week}`);
  } else if (options.command === 'status') {
    result = await status({ week, dataDir });
  } else {
    throw new Error(`未知命令：${options.command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code ?? 'CLI_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});
