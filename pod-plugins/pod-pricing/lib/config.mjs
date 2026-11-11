/**
 * 锁定口径：config/pricing.json 是唯一政策源。
 * 优先级：命令行参数 > config/pricing.json > 代码默认值。
 * 成本不在这里锁，仍由 data/costs/latest.json（银河报价）提供。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FEES, DEFAULT_TARGET } from './pricing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '../config/pricing.json');

export function loadConfig() {
  const exists = fs.existsSync(FILE);
  const raw = exists ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
  return {
    file: exists ? FILE : null,
    version: raw.version || '0',
    locked_at: raw.locked_at || null,
    note: raw.note || '',
    fees: { ...DEFAULT_FEES, ...(raw.fees || {}) },
    target: { ...DEFAULT_TARGET, ...(raw.target_cny || {}) },
    round: raw.round || '1',
    market: raw.market || null,
  };
}
