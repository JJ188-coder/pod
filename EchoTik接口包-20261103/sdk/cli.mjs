#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EchoTikSDK } from "./index.mjs";
import { sdkError } from "./lib/errors.mjs";
import {
  validateCategoriesOptions,
  validateRankingsOptions,
} from "./lib/validation.mjs";

const HELP = `EchoTik 现有浏览器会话 SDK

用法：
  node cli.mjs --period weekly --range 20261012-20261018 \
    --category-path 824328,839944,601226 --country MX --out result.json

参数：
  --period daily|weekly|monthly  榜单周期，默认 weekly
  --range YYYYMMDD|START-END    daily 用单日，weekly/monthly 用范围
  --category-path A,B,C         类目完整路径；重复键顺序保留
  --category ID                 单类目；可重复，也可写 --category601226
  --country MX|US               默认 MX
  --page 1..5                   默认 1
  --per-page 1..20              默认 20
  --categories                  读取 /product-category，而非商品榜
  --out FILE                    写入 JSON；省略时打印到标准输出
  --help                        显示本说明

安全边界：
  - 只复用现有 echotik.live 页面，刷新一次以捕获正常 UI 登录请求
  - 凭据只在页面 closure 中复用，不出页面、不打印、不落盘
  - 每次运行最多 5 次新业务请求，间隔至少 1500ms，不重试
`;

function argumentValue(argv, index, inlineValue, name) {
  if (inlineValue !== undefined) return { value: inlineValue, next: index };
  if (index + 1 >= argv.length) {
    throw sdkError("INVALID_ARGUMENT", `${name} 缺少参数值`);
  }
  return { value: argv[index + 1], next: index + 1 };
}

export function parseCliArgs(argv) {
  const result = {
    period: "weekly",
    range: undefined,
    country: "MX",
    page: 1,
    perPage: 20,
    categoryIds: [],
    categoryPath: undefined,
    categories: false,
    out: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      result.help = true;
      continue;
    }
    if (token === "--categories") {
      result.categories = true;
      continue;
    }

    const gluedCategory = /^--category(\d+)$/.exec(token);
    if (gluedCategory) {
      result.categoryIds.push(gluedCategory[1]);
      continue;
    }
    const gluedCountry = /^--country([A-Za-z]{2})$/.exec(token);
    if (gluedCountry) {
      result.country = gluedCountry[1];
      continue;
    }

    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) {
      throw sdkError("INVALID_ARGUMENT", `未知参数：${token}`);
    }
    const name = match[1];
    const inlineValue = match[2];

    if (name === "category-path") {
      const parsed = argumentValue(argv, index, inlineValue, "--category-path");
      result.categoryPath = parsed.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index = parsed.next;
      continue;
    }
    if (name === "category") {
      const parsed = argumentValue(argv, index, inlineValue, "--category");
      result.categoryIds.push(parsed.value);
      index = parsed.next;
      continue;
    }

    const names = new Set([
      "period",
      "range",
      "country",
      "page",
      "per-page",
      "out",
    ]);
    if (!names.has(name)) {
      throw sdkError("INVALID_ARGUMENT", `未知参数：--${name}`);
    }
    const parsed = argumentValue(argv, index, inlineValue, `--${name}`);
    if (name === "period") result.period = parsed.value;
    if (name === "range") result.range = parsed.value;
    if (name === "country") result.country = parsed.value;
    if (name === "page") result.page = parsed.value;
    if (name === "per-page") result.perPage = parsed.value;
    if (name === "out") result.out = parsed.value;
    index = parsed.next;
  }

  if (result.categoryPath !== undefined && result.categoryIds.length > 0) {
    throw sdkError(
      "INVALID_ARGUMENT",
      "--category-path 与 --category 不能同时使用",
    );
  }

  result.categoryPath =
    result.categoryPath ?? (result.categoryIds.length > 0 ? result.categoryIds : []);
  delete result.categoryIds;
  return result;
}

async function writeOutput(value, out) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (!out || out === "-") {
    process.stdout.write(json);
    return;
  }
  const absolute = resolve(out);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, json, { encoding: "utf8", mode: 0o600 });
  process.stderr.write(`已写入：${absolute}\n`);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.categories) {
    validateCategoriesOptions({ country: options.country });
  } else {
    validateRankingsOptions({
      period: options.period,
      range: options.range,
      categoryPath: options.categoryPath,
      country: options.country,
      page: options.page,
      perPage: options.perPage,
    });
  }

  let sdk;
  try {
    sdk = await EchoTikSDK.open({
      onProgress({ stage }) {
        const labels = {
          connecting: "连接已有 Edge CDP…",
          "selecting-target": "定位现有 EchoTik 页面…",
          "reloading-market-page": "刷新现有市场页一次…",
          "waiting-normal-request": "等待正常 UI 请求捕获登录态…",
          ready: "初始化完成。",
        };
        process.stderr.write(`${labels[stage] ?? stage}\n`);
      },
    });

    let document;
    if (options.categories) {
      document = await sdk.categories({ country: options.country });
    } else {
      document = await sdk.rankings({
        period: options.period,
        range: options.range,
        categoryPath: options.categoryPath,
        country: options.country,
        page: options.page,
        perPage: options.perPage,
      });
    }
    await writeOutput(document, options.out);
  } finally {
    await sdk?.close();
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    const code = error?.code ?? "CLI_FAILED";
    process.stderr.write(`${code}: ${error?.message ?? "未知错误"}\n`);
    process.exitCode = 1;
  });
}
