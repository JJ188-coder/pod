#!/usr/bin/env node
/**
 * EchoTik 轻量客户端。
 *
 * 两种模式：
 *   session（默认）  调用 sdk/cli.mjs，复用已登录页面（已验收路径）
 *   headers          用你自己提供的会话头直连（本包未验收；缺变量直接报错，不静默降级）
 *
 * 另外导出 parseMetric：把 EchoTik 的展示字符串转成数字。
 *   '3645'        -> 3645
 *   '1.18万'      -> 11800
 *   'MX$217.89万' -> 2178900
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://echotik.live";
const PATHS = {
  rankings: "/api/v1/data/products/leaderboard/top-sold",
  categories: "/api/v1/data/products/product-category",
};

/** 展示字符串 → 数字。无法解析返回 null，绝不返回 0 假装成功。 */
export function parseMetric(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s]/g, "");
  const m = s.match(/(-?\d+(?:\.\d+)?)(亿|万|k|K|M)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = { 亿: 1e8, 万: 1e4, k: 1e3, K: 1e3, M: 1e6 }[m[2]] ?? 1;
  return Math.round(n * unit);
}

function parseArgs(argv) {
  const out = { mode: "session", period: "weekly", country: "MX", page: 1, perPage: 20 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--mode") out.mode = next();
    else if (a === "--period") out.period = next();
    else if (a === "--range") out.range = next();
    else if (a === "--category") out.category = next();
    else if (a === "--country") out.country = next();
    else if (a === "--page") out.page = Number(next());
    else if (a === "--per-page") out.perPage = Number(next());
    else if (a === "--categories") out.categories = true;
    else if (a === "--out") out.out = next();
    else throw new Error(`UNKNOWN_ARG ${a}`);
  }
  return out;
}

function runSession(opts) {
  const args = ["sdk/cli.mjs", "--period", opts.period, "--country", opts.country,
    "--page", String(opts.page), "--per-page", String(opts.perPage)];
  if (opts.range) args.push("--range", opts.range);
  if (opts.category) args.push("--category-path", opts.category);
  if (opts.categories) args.push("--categories");
  if (opts.out) args.push("--out", opts.out);
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, [join(HERE, args[0]), ...args.slice(1)], { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? ok() : no(new Error(`SDK_EXIT_${code}`))));
  });
}

async function runHeaders(opts) {
  const auth = process.env.ECHOTIK_AUTH;
  const uid = process.env.ECHOTIK_USER_ID;
  if (!auth || !uid) throw new Error("AUTH_ENV_MISSING（headers 模式需要 ECHOTIK_AUTH 与 ECHOTIK_USER_ID）");
  const currency = opts.country === "US" ? "USD" : "MXN";
  let url;
  if (opts.categories) {
    url = `${BASE}${PATHS.categories}`;
  } else {
    if (!opts.range || !opts.category) throw new Error("RANGE_AND_CATEGORY_REQUIRED");
    const q = new URLSearchParams({
      time_type: opts.period, time_range: opts.range, order: "sale_cnt",
      page: String(opts.page), per_page: String(opts.perPage),
    });
    for (const id of opts.category.split(",")) q.append("product_categories[]", id.trim());
    url = `${BASE}${PATHS.rankings}?${q}`;
  }
  const res = await fetch(url, {
    headers: {
      authorization: auth, "x-user-id": uid,
      "x-region": opts.country, "x-currency": currency,
      accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const doc = JSON.parse(text);
  if (doc.code !== undefined && doc.code !== 0) throw new Error(`BUSINESS_CODE_${doc.code}`);
  if (opts.out) await writeFile(opts.out, JSON.stringify(doc, null, 1));
  else console.log(JSON.stringify(doc, null, 1));
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.mode === "session") return runSession(opts);
  if (opts.mode === "headers") return runHeaders(opts);
  throw new Error(`UNKNOWN_MODE ${opts.mode}`);
}

if (process.argv[1] && process.argv[1].endsWith("client.mjs")) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
