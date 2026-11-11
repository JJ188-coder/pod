import { isoNow, isDigits } from './util.mjs';

/**
 * 这段函数会被序列化后注入页面执行，不能引用模块作用域变量。
 * 输入是 __NEXT_DATA__.props.pageProps.productDetailFromSSR。
 */
function normalizeDetail(detail) {
  const props = (detail.sale_props || []).map((prop) => ({
    name: prop.prop_name || prop.name || '',
    values: (prop.sale_prop_values || []).map((value) => ({
      id: String(value.prop_value_id ?? ''),
      name: String(value.prop_value ?? value.property_value_name ?? '').trim(),
      image: value.image || null,
    })),
  }));

  const byId = new Map();
  for (const prop of props) {
    for (const value of prop.values) {
      byId.set(value.id, { prop: prop.name, ...value });
    }
  }

  const skus = Object.entries(detail.skus || {}).map(([key, sku]) => {
    const ids = String(sku.sale_prop_value_ids || key).split('_');
    const attributes = ids.map((id) => byId.get(id)).filter(Boolean);
    const color =
      attributes.find((item) => /color|colour|颜色/i.test(item.prop)) || null;
    const size =
      attributes.find((item) => /talla|size|尺码/i.test(item.prop)) || null;
    return {
      key,
      sku_id: sku.sku_id ?? null,
      attributes: attributes.map((item) => ({ name: item.prop, value: item.name })),
      color: color ? color.name : null,
      color_image_url: color ? color.image : null,
      size: size ? size.name : null,
      price_val: sku.real_price?.price_val ?? null,
      price_display: sku.real_price?.price_format ?? null,
      currency: sku.real_price?.currency ?? detail.currency ?? null,
      origin_price_val: sku.real_price?.origin_price_decimal ?? null,
      discount: sku.real_price?.discount_format ?? null,
      stock: typeof sku.stock === 'number' ? sku.stock : null,
    };
  });

  return {
    product_id: detail.product_id ?? null,
    product_name: detail.product_name ?? null,
    product_url: detail.product_url ?? null,
    region: detail.region?.id ?? detail.region ?? null,
    currency: detail.currency ?? null,
    category: detail.category ?? null,
    categories: detail.categories ?? null,
    category_ids: detail.category_ids ?? null,
    total_stock: detail.total_stock_cnt ?? null,
    sku_count: skus.length,
    props,
    skus,
  };
}

const NORMALIZE_SOURCE = normalizeDetail.toString();

export function buildSsrExpression(productId) {
  if (!isDigits(productId)) {
    throw new Error(`非法 product_id：${productId}`);
  }
  return `(async () => {
    const normalize = ${NORMALIZE_SOURCE};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let quotaHeaders = {};
    try {
      const response = await fetch('/products/${productId}', {
        credentials: 'include',
        headers: { accept: 'text/html' },
        signal: controller.signal,
      });
      quotaHeaders = {};
      response.headers.forEach((value, key) => {
        if (/rate|quota|limit|remain|usage|count/i.test(key)) quotaHeaders[key] = value;
      });
      const html = await response.text();
      if (!response.ok) {
        return JSON.stringify({
          ok: false,
          error: 'HTTP_' + response.status,
          http_status: response.status,
          html_len: html.length,
          quota_headers: quotaHeaders,
        });
      }
      const match = html.match(
        /<script id="__NEXT_DATA__" type="application\\/json">([\\s\\S]*?)<\\/script>/,
      );
      if (!match) {
        return JSON.stringify({
          ok: false,
          error: 'NO_NEXT_DATA',
          http_status: response.status,
          html_len: html.length,
          quota_headers: quotaHeaders,
        });
      }
      const data = JSON.parse(match[1]);
      const detail =
        data && data.props && data.props.pageProps
          ? data.props.pageProps.productDetailFromSSR
          : null;
      if (!detail) {
        return JSON.stringify({
          ok: false,
          error: 'NO_PRODUCT_DETAIL',
          http_status: response.status,
          quota_headers: quotaHeaders,
        });
      }
      return JSON.stringify({
        ok: true,
        http_status: response.status,
        quota_headers: quotaHeaders,
        detail: normalize(detail),
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error && error.name === 'AbortError' ? 'TIMEOUT' : String((error && error.message) || error),
      });
    } finally {
      clearTimeout(timer);
    }
  })()`;
}

export function validateSkuDocument(detail, expectedProductId) {
  const problems = [];
  if (String(detail.product_id ?? '') !== String(expectedProductId)) {
    problems.push(`product_id 不匹配：${detail.product_id}`);
  }
  if (!Array.isArray(detail.skus)) {
    problems.push('skus 不是数组');
    return problems;
  }
  if (detail.sku_count !== detail.skus.length) {
    problems.push(`sku_count=${detail.sku_count} 与数组长度=${detail.skus.length} 不一致`);
  }
  if (detail.region !== 'MX') {
    problems.push(`地区不是 MX：${detail.region}`);
  }
  if (detail.currency !== 'MXN') {
    problems.push(`币种不是 MXN：${detail.currency}`);
  }
  for (const sku of detail.skus) {
    if (!sku.sku_id) problems.push(`SKU 缺少 sku_id：${sku.key}`);
    if (!sku.price_val) problems.push(`SKU 缺少价格：${sku.sku_id}`);
  }
  return problems;
}

export async function fetchSkuDocument(connection, sessionId, productId) {
  const raw = await connection.evaluate(sessionId, buildSsrExpression(productId));
  if (typeof raw !== 'string') {
    return { ok: false, error: 'INVALID_BRIDGE_RESULT' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'INVALID_JSON_RESULT' };
  }
  if (!parsed.ok) return parsed;

  const problems = validateSkuDocument(parsed.detail, productId);
  return {
    ...parsed,
    fetched_at: isoNow(),
    coverage: problems.length === 0 ? 'exact' : 'partial',
    problems,
  };
}
