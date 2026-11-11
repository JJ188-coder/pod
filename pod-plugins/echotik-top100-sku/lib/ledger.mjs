import { join } from 'node:path';
import { dateKey, ensureDir, readJsonIfExists, writeJson } from './util.mjs';

/**
 * 按自然日记录请求用量。
 * 详情抓取按“可能计入会员额度”保守记账：每次尝试（含失败）都 +1。
 */
export class DailyLedger {
  #path;
  #state;

  constructor(path, state) {
    this.#path = path;
    this.#state = state;
  }

  static async open(dataRoot, date = new Date()) {
    const key = dateKey(date);
    const dir = join(dataRoot, 'ledger');
    await ensureDir(dir);
    const path = join(dir, `${key}.json`);
    const existing = await readJsonIfExists(path);
    const state = existing ?? {
      schema: 'echotik-sku-ledger-v1',
      date: key,
      ranking_requests: 0,
      ssr_fetches: 0,
      products: [],
      updated_at: new Date().toISOString(),
    };
    return new DailyLedger(path, state);
  }

  get date() {
    return this.#state.date;
  }

  get ssrFetches() {
    return this.#state.ssr_fetches;
  }

  get rankingRequests() {
    return this.#state.ranking_requests;
  }

  remaining(cap) {
    return Math.max(0, cap - this.#state.ssr_fetches);
  }

  async recordRanking(count = 1) {
    this.#state.ranking_requests += count;
    await this.#save();
  }

  async recordSsr(productId) {
    this.#state.ssr_fetches += 1;
    this.#state.products.push({ product_id: String(productId), at: new Date().toISOString() });
    await this.#save();
  }

  snapshot() {
    return {
      date: this.#state.date,
      ranking_requests: this.#state.ranking_requests,
      ssr_fetches: this.#state.ssr_fetches,
      products: this.#state.products.length,
    };
  }

  async #save() {
    this.#state.updated_at = new Date().toISOString();
    await writeJson(this.#path, this.#state);
  }
}
