import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, isoNow, readJsonIfExists, sleep, writeJson } from './util.mjs';

const EXT_BY_TYPE = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
};

export function detectImageType(buffer) {
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))
  ) {
    return 'image/gif';
  }
  return null;
}

async function fileHasBytes(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function relativeImagePath(ext) {
  return `images/PRODUCT_ID.${ext}`;
}

export async function downloadImages(
  runDir,
  rankings,
  { delayMs = 300, overwrite = false, onProgress = null } = {},
) {
  const imageDir = join(runDir, 'images');
  await ensureDir(imageDir);
  const manifestPath = join(imageDir, 'manifest.json');
  const existing = await readJsonIfExists(manifestPath);
  const previous = new Map(
    (existing?.items ?? []).map((item) => [String(item.product_id), item]),
  );

  const items = [];
  const total = rankings.products.length;

  for (const product of rankings.products) {
    const productId = String(product.product_id);
    const url = product.cover_url;

    if (!url) {
      items.push({
        product_id: productId,
        rank: product.rank,
        url: null,
        file: null,
        status: 'failed',
        error: 'NO_COVER_URL',
        downloaded_at: isoNow(),
      });
      onProgress?.({ productId, ok: false, error: 'NO_COVER_URL', index: items.length, total });
      continue;
    }

    const previousItem = previous.get(productId);
    if (
      !overwrite &&
      previousItem?.status === 'ok' &&
      previousItem.file &&
      (await fileHasBytes(join(runDir, previousItem.file)))
    ) {
      items.push(previousItem);
      onProgress?.({
        productId,
        ok: true,
        skipped: true,
        bytes: previousItem.bytes,
        index: items.length,
        total,
      });
      continue;
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error('EMPTY_BODY');

      const contentType = detectImageType(buffer);
      if (!contentType) throw new Error('NOT_AN_IMAGE');
      const ext = EXT_BY_TYPE[contentType] ?? 'bin';
      const relativePath = relativeImagePath(ext).replace('PRODUCT_ID', productId);
      const absolutePath = join(runDir, relativePath);
      const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;

      await writeFile(temporaryPath, buffer, { mode: 0o600 });
      await rename(temporaryPath, absolutePath);

      const item = {
        product_id: productId,
        rank: product.rank,
        url,
        file: relativePath,
        content_type: contentType,
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        status: 'ok',
        downloaded_at: isoNow(),
      };
      items.push(item);
      onProgress?.({ productId, ok: true, bytes: buffer.length, index: items.length, total });
    } catch (error) {
      const item = {
        product_id: productId,
        rank: product.rank,
        url,
        file: null,
        status: 'failed',
        error: String(error?.message ?? error),
        downloaded_at: isoNow(),
      };
      items.push(item);
      onProgress?.({
        productId,
        ok: false,
        error: item.error,
        index: items.length,
        total,
      });
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  const manifest = {
    schema: 'echotik-top100-images-v1',
    generated_at: isoNow(),
    week: rankings.range,
    source: 'rankings.cover_url',
    items,
  };
  await writeJson(manifestPath, manifest);

  const ok = items.filter((item) => item.status === 'ok').length;
  return {
    manifest_path: manifestPath,
    image_dir: imageDir,
    total: items.length,
    ok,
    failed: items.length - ok,
  };
}

export async function downloadImagesForRun({ week, dataDir, delayMs = 300, overwrite = false, onProgress = null }) {
  const runPath = join(dataDir, week);
  const rankingsPath = join(runPath, 'rankings.json');
  let rankings;
  try {
    rankings = JSON.parse(await readFile(rankingsPath, 'utf8'));
  } catch (error) {
    throw new Error(`缺少 rankings.json，请先运行 rankings：${runPath}`);
  }
  return downloadImages(runPath, rankings, { delayMs, overwrite, onProgress });
}
