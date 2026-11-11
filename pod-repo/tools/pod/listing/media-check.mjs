import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function descriptionLength(text) {
  if (typeof text !== 'string') return 0;
  const plain = text.replace(/<[^>]*>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[ \t]*#{1,6}[ \t]+.*$/gm, '')
    .replace(/^[ \t]*(?:[-*+◆•]|\d+[.)])[ \t]+/gm, '').replace(/[*_`~]/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(plain).length;
}

function requireValue(ok, code, detail = '') {
  if (!ok) throw Error(`${code}${detail ? ': ' + detail : ''}`);
}

function localFile(file) {
  requireValue(typeof file === 'string' && path.isAbsolute(file), 'ABSOLUTE_FILE_REQUIRED');
  requireValue(fs.existsSync(file) && fs.statSync(file).isFile(), 'MEDIA_FILE_MISSING', file);
  return fs.realpathSync(file);
}

function httpsUrl(url) {
  let value;
  try { value = new URL(url); } catch { throw Error('MEDIA_HTTPS_REQUIRED'); }
  requireValue(value.protocol === 'https:' && !value.username && !value.password, 'MEDIA_HTTPS_REQUIRED');
  return value.href;
}

function imageKey(ref) {
  if (typeof ref === 'string') {
    requireValue(!path.isAbsolute(ref), 'LOCAL_IMAGE_NEEDS_FILE_OBJECT', '使用 {file: 绝对路径}，不能直接填本地字符串');
    return httpsUrl(ref);
  }
  requireValue(ref && typeof ref === 'object' && typeof ref.file === 'string' && !ref.url, 'IMAGE_REFERENCE_INVALID');
  return localFile(ref.file);
}

function checkDigest(file, expected) {
  requireValue(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), 'MEDIA_SHA256_REQUIRED');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  requireValue(actual === expected, 'MEDIA_CHANGED_SINCE_REVIEW', file);
  return actual;
}

export function probeVideo(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
}

// 只核验文件、结构和显式验收记录；不能代替人眼颜色对照或连续音画验收。
export function validateMediaSpec(spec, { inspectVideo = probeVideo } = {}) {
  requireValue(spec && typeof spec === 'object' && !Array.isArray(spec), 'SPEC_INVALID');
  const products = spec.products === undefined ? [spec] : spec.products;
  requireValue(Array.isArray(products) && products.length > 0, 'PRODUCTS_REQUIRED');
  const seenProducts = new Set();
  return products.map((raw) => {
    requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'PRODUCT_INVALID');
    const p = { ...spec.defaults, ...raw };
    requireValue(typeof p.skuPrefix === 'string' && p.skuPrefix.trim(), 'PRODUCT_KEY_REQUIRED');
    requireValue(!seenProducts.has(p.skuPrefix), 'DUPLICATE_PRODUCT_KEY', p.skuPrefix);
    seenProducts.add(p.skuPrefix);
    const media = p.media;
    requireValue(media && typeof media === 'object', 'MEDIA_MANIFEST_REQUIRED', p.skuPrefix);
    if (media.mode === 'factory_original') {
      requireValue(typeof media.authorization === 'string' && media.authorization.trim().length > 0,
        'FACTORY_ROUTE_NEEDS_EXPLICIT_AUTHORIZATION', p.skuPrefix);
      return { product: p.skuPrefix, mode: media.mode, note: '工厂图例外：仅记录明确授权，不代表生成素材标准已通过' };
    }
    requireValue(media.mode === 'generated', 'MEDIA_MODE_INVALID', p.skuPrefix);
    const characters = descriptionLength(p.description);
    requireValue(characters > 500, 'DESCRIPTION_TOO_SHORT', `${p.skuPrefix}: ${characters}，须大于500字符`);
    requireValue(Array.isArray(p.images) && p.images.length === 9, 'GALLERY_REQUIRES_8_PLUS_1', p.skuPrefix);
    requireValue(Array.isArray(p.colors) && p.colors.length > 0, 'COLORS_REQUIRED', p.skuPrefix);
    const colorKeys = p.colors.map((c) => c?.en);
    requireValue(colorKeys.every((c) => typeof c === 'string' && c.trim() === c && c.length > 0)
      && new Set(colorKeys).size === colorKeys.length, 'COLOR_KEYS_INVALID', p.skuPrefix);
    requireValue(Array.isArray(media.assets) && media.assets.length >= 9, 'MEDIA_ASSETS_REQUIRED', p.skuPrefix);
    const byRef = new Map();
    const digests = new Set();
    for (const asset of media.assets) {
      requireValue(asset && asset.product === p.skuPrefix, 'CROSS_PRODUCT_ASSET', p.skuPrefix);
      const file = localFile(asset.file);
      requireValue(!/工厂原图|factory[-_ ]?(?:original|raw|source)/i.test(file), 'FACTORY_IMAGE_FORBIDDEN', file);
      requireValue(/\.(png|jpe?g)$/i.test(file), 'PRODUCT_IMAGE_FORMAT_INVALID', file);
      requireValue(asset.reviewed === true, 'IMAGE_REVIEW_REQUIRED', file);
      const digest = checkDigest(file, asset.sha256);
      requireValue(!digests.has(digest), 'DUPLICATE_IMAGE_CONTENT', file);
      digests.add(digest);
      requireValue(['color_main', 'product', 'size_chart'].includes(asset.role), 'IMAGE_ROLE_INVALID', file);
      if (asset.role === 'size_chart') {
        requireValue(asset.source === 'local_chart' && asset.color == null, 'CHART_MUST_USE_FACTS', file);
        localFile(asset.source_ref);
      } else {
        requireValue(asset.source === 'generated', 'GENERATED_IMAGE_REQUIRED', file);
        requireValue(typeof asset.source_ref === 'string' && asset.source_ref.trim(), 'GENERATION_RECEIPT_REQUIRED', file);
        requireValue(colorKeys.includes(asset.color), 'ASSET_COLOR_NOT_FOR_SALE', file);
      }
      for (const key of [file, ...(asset.url ? [httpsUrl(asset.url)] : [])]) {
        requireValue(!byRef.has(key), 'DUPLICATE_ASSET_REFERENCE', key);
        byRef.set(key, asset);
      }
    }
    const lookup = (ref) => {
      const key = imageKey(ref);
      requireValue(byRef.has(key), 'UNREGISTERED_IMAGE', key);
      return byRef.get(key);
    };
    const gallery = p.images.map(lookup);
    requireValue(new Set(gallery).size === 9 && gallery.slice(0, 8).every((a) => a.role !== 'size_chart')
      && gallery[8].role === 'size_chart' && gallery[0].role === 'color_main', 'GALLERY_ORDER_INVALID', p.skuPrefix);
    requireValue(lookup(p.sizeChart) === gallery[8], 'SIZE_CHART_MISMATCH', p.skuPrefix);
    for (const color of p.colors) {
      const main = lookup(color.image);
      requireValue(main.role === 'color_main' && main.color === color.en && main.source === 'generated',
        'SKU_COLOR_IMAGE_MISMATCH', `${p.skuPrefix}/${color.en}`);
    }
    const video = media.video;
    requireValue(video && video.voice_source === 'model_native', 'MODEL_NATIVE_VOICE_REQUIRED', p.skuPrefix);
    requireValue(video.speech_reviewed === true && video.lip_sync_reviewed === true && video.appearance_reviewed === true,
      'VIDEO_REVIEW_REQUIRED', p.skuPrefix);
    const videoFile = localFile(video.file);
    checkDigest(videoFile, video.sha256);
    const metadata = inspectVideo(videoFile);
    const picture = metadata.streams?.find((s) => s.codec_type === 'video');
    const audio = metadata.streams?.find((s) => s.codec_type === 'audio');
    requireValue(picture && Number.isInteger(picture.width) && Number.isInteger(picture.height)
      && picture.width > 0 && picture.height > 0 && picture.width * 16 === picture.height * 9
      && (!picture.sample_aspect_ratio || picture.sample_aspect_ratio === '1:1')
      && !(picture.side_data_list || []).some((s) => Number(s.rotation || 0) % 360 !== 0)
      && Number(picture.tags?.rotate || 0) % 360 === 0, 'VIDEO_MUST_BE_9_16', p.skuPrefix);
    requireValue(audio, 'VIDEO_AUDIO_REQUIRED', p.skuPrefix);
    const duration = Number(metadata.format?.duration);
    requireValue(Number.isFinite(duration) && duration > 0 && duration <= 20, 'VIDEO_MUST_BE_WITHIN_20_SECONDS', p.skuPrefix);
    return { product: p.skuPrefix, mode: media.mode, gallery: 9, colors: colorKeys.length,
      description_characters: characters, video: { width: picture.width, height: picture.height, duration },
      note: '结构、文件哈希及验收记录通过；不是自动识色或自动口型评分' };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = process.argv[2];
    requireValue(input, 'USAGE', 'node media-check.mjs /absolute/spec.json');
    const products = validateMediaSpec(JSON.parse(fs.readFileSync(input, 'utf8')));
    console.log(JSON.stringify({ ok: true, products }, null, 2));
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
