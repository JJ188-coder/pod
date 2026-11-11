#!/usr/bin/env node
/**
 * supply-card.mjs — 供货证据卡与可售额度。缺依据就 unknown / null，不编数量。
 *
 * 用法：
 *   node supply-card.mjs --style MXTMC001 --color Negro --size M \
 *     --capacity 200 --buffer 20 --source "工厂书面回复 2026-11-03" \
 *     --observed-at 2026-11-03 --valid-until 2026-11-30 [--out card.json]
 *   node supply-card.mjs --verify card.json
 */
import fs from 'node:fs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const fail = (data) => { console.log(JSON.stringify(data, null, 2)); process.exit(1); };

const verifyPath = arg('--verify');
if (verifyPath) {
  if (!fs.existsSync(verifyPath)) fail({ ok: false, error: 'CARD_NOT_FOUND' });
  const card = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
  const problems = [];
  for (const key of ['style_code', 'color', 'size', 'blank_supply', 'observed_at', 'valid_until']) {
    if (!card[key]) problems.push(`MISSING_${key.toUpperCase()}`);
  }
  if (card.valid_until && new Date(card.valid_until) < new Date()) problems.push('EXPIRED');
  if (card.seller_quota === null || card.seller_quota === undefined) problems.push('QUOTA_NULL');
  console.log(JSON.stringify({ ok: problems.length === 0, problems, card }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

const capacity = arg('--capacity');
const buffer = Number(arg('--buffer', '0'));
const quota = capacity === null ? null : Math.max(0, Number(capacity) - (Number.isFinite(buffer) ? buffer : 0));

const card = {
  schema: 'pod-supply-card-v1',
  style_code: arg('--style'),
  color: arg('--color'),
  size: arg('--size'),
  blank_supply: arg('--supply', quota === null ? 'unknown' : 'available'),
  order_capacity: capacity === null ? null : Number(capacity),
  capacity_unit: arg('--unit', 'per_window'),
  safety_buffer: Number.isFinite(buffer) ? buffer : 0,
  seller_quota: quota,
  shortage_note: arg('--shortage', ''),
  restock_eta: arg('--restock', null),
  cutoff_time: arg('--cutoff', null),
  production_lead_time: arg('--lead', null),
  handoff_sla: arg('--sla', null),
  route_key: arg('--route', null),
  evidence_source: arg('--source', null),
  observed_at: arg('--observed-at', null),
  valid_until: arg('--valid-until', null),
  physical_stock_qty: arg('--stock', null),
  note: 'seller_quota 是履约额度，不是仓库现货；capacity 缺失时保持 null。',
};

const out = arg('--out');
if (out) fs.writeFileSync(out, JSON.stringify(card, null, 2));
console.log(JSON.stringify({ ok: true, card }, null, 2));
