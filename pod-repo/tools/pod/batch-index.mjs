#!/usr/bin/env node
/**
 * batch-index.mjs — 批次索引：扫本地批次目录，汇总冻结状态、商品包与最近改动。
 * 只读，不修改任何批次文件。
 *
 * 用法：node batch-index.mjs [--root project/T恤/批次] [--out index.json]
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const rootDir = path.resolve(arg('--root', 'project/T恤/批次'));
if (!fs.existsSync(rootDir)) {
  console.log(JSON.stringify({ ok: false, error: 'BATCH_ROOT_NOT_FOUND', root: rootDir }, null, 2));
  process.exit(2);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function countPacks(batchDir) {
  const packsDir = path.join(batchDir, '商品包');
  if (!fs.existsSync(packsDir)) return { packs: [], count: 0 };
  const packs = fs.readdirSync(packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(packsDir, e.name);
      const freeze = readJson(path.join(dir, 'freeze.json'));
      const config = readJson(path.join(dir, '商品包配置.json'));
      return {
        pack: e.name,
        frozen: Boolean(freeze),
        materials_ready: freeze?.materials_ready ?? null,
        freeze_at: freeze?.created_at ?? null,
        files: Object.values(freeze?.counts || {}).reduce((a, b) => a + b, 0),
        candidate_id: config?.candidate_id ?? config?.款号 ?? null,
      };
    });
  return { packs, count: packs.length };
}

const batches = fs.readdirSync(rootDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const dir = path.join(rootDir, e.name);
    const manifest = readJson(path.join(dir, 'manifest.json'));
    const freeze = readJson(path.join(dir, 'freeze.json'));
    const packs = countPacks(dir);
    const stat = fs.statSync(dir);
    return {
      batch: e.name,
      manifest: Boolean(manifest),
      freeze: Boolean(freeze),
      materials_ready: freeze?.materials_ready ?? manifest?.materials_ready ?? null,
      products: packs.count,
      packs: packs.packs,
      updated_at: stat.mtime.toISOString(),
    };
  })
  .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

const index = {
  ok: true,
  generated_at: new Date().toISOString(),
  root: rootDir,
  batch_count: batches.length,
  batch_with_freeze: batches.filter((b) => b.freeze).length,
  batches,
};

const out = arg('--out');
if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(index, null, 2));
console.log(JSON.stringify(index, null, 2));
