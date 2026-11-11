import { join } from 'node:path';
import { isoNow, readJsonIfExists, writeJson } from './util.mjs';

export class RunState {
  #path;
  #state;

  constructor(path, state) {
    this.#path = path;
    this.#state = state;
  }

  static async open(runDir, week, productIds = []) {
    const path = join(runDir, 'state.json');
    const existing = await readJsonIfExists(path);
    const state = existing ?? {
      schema: 'echotik-sku-state-v1',
      week,
      created_at: isoNow(),
      updated_at: isoNow(),
      products: {},
    };
    for (const productId of productIds) {
      if (!state.products[productId]) {
        state.products[productId] = {
          status: 'pending',
          attempts: 0,
          error: null,
          sku_count: null,
          fetched_at: null,
        };
      }
    }
    const instance = new RunState(path, state);
    await instance.save();
    return instance;
  }

  get products() {
    return this.#state.products;
  }

  status(productId) {
    return this.#state.products[productId]?.status ?? 'missing';
  }

  pendingIds() {
    // 失败两次后不再自动重试，避免每天把额度耗在同一批商品上。
    return Object.entries(this.#state.products)
      .filter(([, value]) => value.status !== 'ok' && (value.attempts ?? 0) < 2)
      .map(([productId]) => productId);
  }

  counts() {
    const result = { pending: 0, ok: 0, partial: 0, failed: 0, missing: 0 };
    for (const value of Object.values(this.#state.products)) {
      const status = value.status ?? 'pending';
      result[status] = (result[status] ?? 0) + 1;
    }
    return result;
  }

  async markOk(productId, { skuCount, coverage = 'exact' } = {}) {
    const entry = this.#entry(productId);
    entry.status = 'ok';
    entry.attempts += 1;
    entry.error = null;
    entry.sku_count = skuCount;
    entry.coverage = coverage;
    entry.fetched_at = isoNow();
    await this.save();
  }

  async markPartial(productId, { skuCount, reason } = {}) {
    const entry = this.#entry(productId);
    entry.status = 'partial';
    entry.attempts += 1;
    entry.error = reason ?? null;
    entry.sku_count = skuCount ?? null;
    entry.fetched_at = isoNow();
    await this.save();
  }

  async markFailed(productId, error) {
    const entry = this.#entry(productId);
    entry.status = 'failed';
    entry.attempts += 1;
    entry.error = String(error ?? 'UNKNOWN');
    entry.fetched_at = isoNow();
    await this.save();
  }

  async save() {
    this.#state.updated_at = isoNow();
    await writeJson(this.#path, this.#state);
  }

  snapshot() {
    return {
      week: this.#state.week,
      updated_at: this.#state.updated_at,
      counts: this.counts(),
      products: this.#state.products,
    };
  }

  #entry(productId) {
    if (!this.#state.products[productId]) {
      this.#state.products[productId] = {
        status: 'pending',
        attempts: 0,
        error: null,
        sku_count: null,
        fetched_at: null,
      };
    }
    return this.#state.products[productId];
  }
}
