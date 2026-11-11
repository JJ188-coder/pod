import { EchoTikSDK } from './echotik-sdk/index.mjs';
import { attach, navigateToBoard } from './session.mjs';
import { CATEGORY_PATH, isoNow } from './util.mjs';

const PRODUCT_ID = /^\d{15,20}$/;

function assertPage(document, { page, week, categoryPath, perPage }) {
  if (document.country !== 'MX') {
    throw new Error(`第 ${page} 页国家不是 MX：${document.country}`);
  }
  if (document.period !== 'weekly' || document.range !== week) {
    throw new Error(`第 ${page} 页周期不匹配：${document.period} ${document.range}`);
  }
  if (document.page !== page || document.per_page !== perPage) {
    throw new Error(
      `第 ${page} 页分页不匹配：page=${document.page} per_page=${document.per_page}`,
    );
  }
  if (document.category_path.join(',') !== categoryPath.join(',')) {
    throw new Error(`第 ${page} 页类目路径不匹配：${document.category_path.join(',')}`);
  }
  if (!Array.isArray(document.data)) {
    throw new Error(`第 ${page} 页 data 不是数组`);
  }
  for (const row of document.data) {
    if (!PRODUCT_ID.test(String(row.product_id ?? ''))) {
      throw new Error(`第 ${page} 页出现非法 product_id：${row.product_id}`);
    }
    if (row.region && row.region !== 'MX') {
      throw new Error(`第 ${page} 页出现非 MX 商品：${row.product_id}`);
    }
  }
}

export async function collectRankings(connection, options) {
  const {
    week,
    categoryPath = CATEGORY_PATH,
    pages = 5,
    perPage = 20,
    onProgress = null,
  } = options;

  const attached = await attach(connection);
  try {
    await navigateToBoard(connection, attached.sessionId);
  } finally {
    await connection.detach(attached.sessionId);
  }

  const documents = [];
  let error = null;

  try {
    const sdk = await EchoTikSDK.open({ connection });
    try {
      for (let page = 1; page <= pages; page += 1) {
        const document = await sdk.rankings({
          country: 'MX',
          period: 'weekly',
          range: week,
          categoryPath,
          page,
          perPage,
        });
        assertPage(document, { page, week, categoryPath, perPage });
        documents.push(document);
        onProgress?.({
          page,
          rows: document.data.length,
          total: document.meta?.total ?? null,
        });
      }
    } finally {
      await sdk.close();
    }
  } catch (cause) {
    error = cause;
  }

  const warnings = [];
  const seen = new Set();
  const products = [];
  for (const document of documents) {
    for (const row of document.data) {
      const productId = String(row.product_id);
      if (seen.has(productId)) {
        warnings.push(`重复商品已跳过：${productId}`);
        continue;
      }
      seen.add(productId);
      products.push({ rank: products.length + 1, ...row });
    }
  }

  if (products.length !== pages * perPage) {
    warnings.push(
      `预期 ${pages * perPage} 条，实际 ${products.length} 条（已取到的页：${documents.length}）`,
    );
  }

  return {
    schema: 'echotik-top100-rankings-v1',
    fetched_at: isoNow(),
    country: 'MX',
    currency: 'MXN',
    period: 'weekly',
    range: week,
    category_path: [...categoryPath],
    per_page: perPage,
    pages_requested: pages,
    pages_fetched: documents.length,
    products,
    meta: documents.at(-1)?.meta ?? null,
    warnings,
    error: error
      ? { code: error.code ?? 'RANKINGS_FAILED', message: error.message }
      : null,
  };
}
