import { join } from 'node:path';
import { ensureDir, isoNow, readJsonIfExists, writeJson } from './util.mjs';
import { writeFile } from 'node:fs/promises';

const CSV_HEADERS = [
  'week',
  'rank',
  'product_id',
  'product_name',
  'sale_cnt_raw',
  'total_sale_cnt_raw',
  'avg_price_raw',
  'main_image_url',
  'main_image_file',
  'sku_index',
  'sku_id',
  'sku_name',
  'attr_color',
  'attr_size',
  'sku_price_val',
  'sku_price_display',
  'currency',
  'sku_origin_price_val',
  'sku_discount',
  'sku_stock',
  'sku_color_image_url',
  'sku_status',
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function skuName(sku) {
  if (!sku.attributes?.length) return '';
  return sku.attributes.map((item) => `${item.name}:${item.value}`).join(' / ');
}

export async function exportRun(runDir) {
  const rankings = await readJsonIfExists(join(runDir, 'rankings.json'));
  if (!rankings) {
    throw new Error(`缺少 rankings.json：${runDir}`);
  }
  const state = (await readJsonIfExists(join(runDir, 'state.json'))) ?? {
    products: {},
  };
  const imageManifest = await readJsonIfExists(join(runDir, 'images', 'manifest.json'));
  const imageById = new Map(
    (imageManifest?.items ?? []).map((item) => [String(item.product_id), item]),
  );

  const rows = [];
  const products = [];
  const coverage = {
    products: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    missing: 0,
    sku_rows: 0,
    images_ok: 0,
    images_failed: 0,
  };

  for (const product of rankings.products) {
    coverage.products += 1;
    const productId = String(product.product_id);
    const skuDoc = await readJsonIfExists(join(runDir, 'skus', `${productId}.json`));
    const status = state.products?.[productId]?.status ?? (skuDoc ? 'ok' : 'missing');

    if (status === 'ok') coverage.ok += 1;
    else if (status === 'partial') coverage.partial += 1;
    else if (status === 'failed') coverage.failed += 1;
    else coverage.missing += 1;

    const image = imageById.get(productId);
    if (image?.status === 'ok') coverage.images_ok += 1;
    else if (image) coverage.images_failed += 1;

    const skus = skuDoc?.skus ?? [];
    products.push({
      rank: product.rank,
      product_id: productId,
      product_name: product.product_name ?? null,
      sale_cnt_raw: product.sale_cnt ?? null,
      total_sale_cnt_raw: product.total_sale_cnt ?? null,
      avg_price_raw: product.avg_price ?? null,
      cover_url: product.cover_url ?? null,
      image_file: image?.status === 'ok' ? image.file : null,
      image_status: image?.status ?? 'missing',
      sku_status: status,
      sku_count: skus.length,
      total_stock: skuDoc?.total_stock ?? null,
      region: skuDoc?.region ?? product.region ?? null,
      currency: skuDoc?.currency ?? null,
      skus,
    });

    if (skus.length === 0) {
      rows.push({
        week: rankings.range,
        rank: product.rank,
        product_id: productId,
        product_name: product.product_name ?? '',
        sale_cnt_raw: product.sale_cnt ?? '',
        total_sale_cnt_raw: product.total_sale_cnt ?? '',
        avg_price_raw: product.avg_price ?? '',
        main_image_url: product.cover_url ?? '',
        main_image_file: image?.status === 'ok' ? image.file : '',
        sku_index: '',
        sku_id: '',
        sku_name: '',
        attr_color: '',
        attr_size: '',
        sku_price_val: '',
        sku_price_display: '',
        currency: '',
        sku_origin_price_val: '',
        sku_discount: '',
        sku_stock: '',
        sku_color_image_url: '',
        sku_status: status,
      });
      continue;
    }

    skus.forEach((sku, index) => {
      coverage.sku_rows += 1;
      rows.push({
        week: rankings.range,
        rank: product.rank,
        product_id: productId,
        product_name: product.product_name ?? '',
        sale_cnt_raw: product.sale_cnt ?? '',
        total_sale_cnt_raw: product.total_sale_cnt ?? '',
        avg_price_raw: product.avg_price ?? '',
        main_image_url: product.cover_url ?? '',
        main_image_file: image?.status === 'ok' ? image.file : '',
        sku_index: index + 1,
        sku_id: sku.sku_id ?? '',
        sku_name: skuName(sku),
        attr_color: sku.color ?? '',
        attr_size: sku.size ?? '',
        sku_price_val: sku.price_val ?? '',
        sku_price_display: sku.price_display ?? '',
        currency: sku.currency ?? '',
        sku_origin_price_val: sku.origin_price_val ?? '',
        sku_discount: sku.discount ?? '',
        sku_stock: sku.stock ?? '',
        sku_color_image_url: sku.color_image_url ?? '',
        sku_status: status,
      });
    });
  }

  const exportDir = join(runDir, 'export');
  await ensureDir(exportDir);

  const csv = [CSV_HEADERS.join(','), ...rows.map((row) => CSV_HEADERS.map((key) => csvCell(row[key])).join(','))].join('\n');
  const csvPath = join(exportDir, 'top100-skus.csv');
  await writeFile(csvPath, `\uFEFF${csv}\n`, { encoding: 'utf8', mode: 0o600 });

  const bundle = {
    schema: 'echotik-top100-sku-bundle-v1',
    generated_at: isoNow(),
    week: rankings.range,
    country: rankings.country,
    currency: rankings.currency,
    category_path: rankings.category_path,
    rankings_fetched_at: rankings.fetched_at,
    coverage,
    products,
  };
  const bundlePath = join(exportDir, 'bundle.json');
  await writeJson(bundlePath, bundle);

  return { csvPath, bundlePath, coverage, warnings: rankings.warnings ?? [] };
}
