import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DATA_ROOT = join(PLUGIN_ROOT, 'data');
export const BOARD_URL = 'https://echotik.live/products/leaderboard/top-sold';
export const CATEGORY_PATH = Object.freeze(['824328', '839944', '601226']);
export const WEEKLY_RANGE = /^\d{8}-\d{8}$/;

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function resolveDataRoot(value) {
  return value ? resolve(value) : DEFAULT_DATA_ROOT;
}

export function runDir(dataRoot, week) {
  return join(dataRoot, week);
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeJson(path, value, { mode = 0o600 } = {}) {
  await ensureDir(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode,
  });
  await rename(temporary, path);
}

export function isoNow() {
  return new Date().toISOString();
}

export function lastCompletedWeek(now = new Date()) {
  const day = (now.getDay() + 6) % 7; // Monday = 0
  const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);
  const format = (date) =>
    `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate(),
    ).padStart(2, '0')}`;
  return `${format(lastMonday)}-${format(lastSunday)}`;
}

export function parseWeek(value) {
  if (value === undefined || value === null || value === '') {
    return lastCompletedWeek();
  }
  const week = String(value).trim();
  if (!WEEKLY_RANGE.test(week)) {
    throw new Error('week 格式必须为 YYYYMMDD-YYYYMMDD');
  }
  return week;
}

export function isDigits(value, maxLength = 30) {
  return typeof value === 'string' && new RegExp(`^\\d{1,${maxLength}}$`).test(value);
}
