import { join } from 'node:path';
import { downloadImagesForRun } from './images.mjs';
import { DailyLedger } from './ledger.mjs';
import { collectRankings } from './rankings.mjs';
import { connect, withSession } from './session.mjs';
import { fetchSkuDocument } from './ssr.mjs';
import { RunState } from './state.mjs';
import {
  CATEGORY_PATH,
  ensureDir,
  isoNow,
  readJsonIfExists,
  runDir,
  sleep,
  writeJson,
} from './util.mjs';

export async function runRankings({
  cdp,
  week,
  dataDir,
  categoryPath = CATEGORY_PATH,
  pages = 5,
  perPage = 20,
  onProgress = null,
}) {
  const dir = runDir(dataDir, week);
  await ensureDir(dir);
  const ledger = await DailyLedger.open(dataDir);

  const connection = await connect({ cdp });
  let result;
  try {
    result = await collectRankings(connection, {
      week,
      categoryPath,
      pages,
      perPage,
      onProgress,
    });
  } finally {
    connection.close();
  }

  await ledger.recordRanking(result.pages_fetched);
  await writeJson(join(dir, 'rankings.json'), result);

  const productIds = result.products.map((product) => String(product.product_id));
  const state = await RunState.open(dir, week, productIds);
  await state.save();

  return {
    ...result,
    run_dir: dir,
    state: state.counts(),
    ledger: ledger.snapshot(),
  };
}

export async function fetchSkus({
  cdp,
  week,
  dataDir,
  limit = null,
  dailyCap = 100,
  delayMs = 1800,
  onProgress = null,
}) {
  const dir = runDir(dataDir, week);
  const rankings = await readJsonIfExists(join(dir, 'rankings.json'));
  if (!rankings) {
    throw new Error(`缺少 rankings.json，请先运行 rankings：${dir}`);
  }

  const state = await RunState.open(
    dir,
    week,
    rankings.products.map((product) => String(product.product_id)),
  );
  const ledger = await DailyLedger.open(dataDir);

  let pending = state.pendingIds();
  if (limit !== null) pending = pending.slice(0, limit);
  const remaining = ledger.remaining(dailyCap);
  if (pending.length > remaining) pending = pending.slice(0, remaining);

  if (pending.length === 0) {
    return {
      run_dir: dir,
      requested: 0,
      fetched: 0,
      failed: 0,
      skipped_by_daily_cap: Math.max(0, remaining === 0 ? 1 : 0),
      state: state.counts(),
      ledger: ledger.snapshot(),
      message:
        remaining === 0
          ? `今日详情额度已用满（${ledger.ssrFetches}/${dailyCap}），明日再跑`
          : '没有待抓商品',
    };
  }

  const connection = await connect({ cdp });
  let fetched = 0;
  let failed = 0;
  let aborted = null;

  try {
    await withSession(connection, async (sessionId) => {
      for (let index = 0; index < pending.length; index += 1) {
        if (ledger.ssrFetches >= dailyCap) break;
        const productId = pending[index];
        await ledger.recordSsr(productId);

        let result;
        try {
          result = await fetchSkuDocument(connection, sessionId, productId);
        } catch (error) {
          if (error.code === 'EDGE_CDP_CLOSED' || /CDP/.test(String(error.message))) {
            aborted = 'CDP_CLOSED';
            break;
          }
          result = { ok: false, error: error.code ?? 'FETCH_FAILED', message: error.message };
        }

        if (!result.ok && ['HTTP_401', 'HTTP_403', 'HTTP_429'].includes(result.error)) {
          aborted = result.error;
          break;
        }

        if (!result.ok) {
          await state.markFailed(productId, result.error ?? 'UNKNOWN');
          failed += 1;
          onProgress?.({ productId, ok: false, error: result.error, index: index + 1, total: pending.length });
        } else {
          const document = {
            schema: 'echotik-product-sku-v1',
            fetched_at: result.fetched_at ?? isoNow(),
            source: {
              method: 'ssr_html',
              path: `/products/${productId}`,
              country: 'MX',
              currency: 'MXN',
              quota_headers: result.quota_headers ?? {},
            },
            coverage: result.coverage,
            problems: result.problems,
            ...result.detail,
          };
          await writeJson(join(dir, 'skus', `${productId}.json`), document);
          await state.markOk(productId, {
            skuCount: document.sku_count,
            coverage: result.coverage,
          });
          fetched += 1;
          onProgress?.({
            productId,
            ok: true,
            skuCount: document.sku_count,
            index: index + 1,
            total: pending.length,
          });
        }

        if (index < pending.length - 1 && ledger.ssrFetches < dailyCap) {
          await sleep(delayMs);
        }
      }
    });
  } finally {
    connection.close();
  }

  return {
    run_dir: dir,
    requested: pending.length,
    fetched,
    failed,
    aborted,
    state: state.counts(),
    ledger: ledger.snapshot(),
    daily_cap: dailyCap,
  };
}

export async function runAll(options) {
  const dir = runDir(options.dataDir, options.week);
  const existing = await readJsonIfExists(join(dir, 'rankings.json'));
  const rankings = existing
    ? {
        cached: true,
        products: existing.products,
        pages_fetched: existing.pages_fetched,
        warnings: existing.warnings,
        error: existing.error,
      }
    : await runRankings(options);
  const skus = await fetchSkus(options);
  const images = options.skipImages
    ? null
    : await downloadImagesForRun({
        week: options.week,
        dataDir: options.dataDir,
        delayMs: options.imageDelayMs ?? 300,
        overwrite: false,
        onProgress: options.onImageProgress ?? null,
      });
  return { rankings, skus, images };
}

export async function status({ week, dataDir }) {
  const dir = runDir(dataDir, week);
  const rankings = await readJsonIfExists(join(dir, 'rankings.json'));
  const state = await RunState.open(
    dir,
    week,
    rankings?.products?.map((product) => String(product.product_id)) ?? [],
  );
  const ledger = await DailyLedger.open(dataDir);
  return {
    week,
    run_dir: dir,
    rankings: rankings
      ? {
          fetched_at: rankings.fetched_at,
          products: rankings.products.length,
          pages_fetched: rankings.pages_fetched,
          warnings: rankings.warnings,
          error: rankings.error,
        }
      : null,
    state: state.counts(),
    ledger: ledger.snapshot(),
  };
}
