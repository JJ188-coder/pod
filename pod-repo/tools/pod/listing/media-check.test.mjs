import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateMediaSpec, descriptionLength } from './media-check.mjs';

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const metadata = { streams: [{ codec_type: 'video', width: 1080, height: 1920, sample_aspect_ratio: '1:1' },
  { codec_type: 'audio' }], format: { duration: '10.125' } };
const options = { inspectVideo: () => metadata };

function fixture(root, count = 1, key = 'STYLE-A') {
  const dir = path.join(root, key);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'supplier-facts.json');
  fs.writeFileSync(source, '{"measurement_source":"test fixture"}');
  const colors = Array.from({ length: count }, (_, i) => ({ en: `Color${i}`, es: `Color ${i}` }));
  const assets = Array.from({ length: Math.max(8, count) }, (_, i) => {
    const file = path.join(dir, `${i + 1}.png`);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(file, Buffer.concat([png, Buffer.from(`${key}-${i}`)]));
    return { file, sha256: digest(file), product: key, color: colors[i % count].en,
      role: i < count ? 'color_main' : 'product', source: 'generated', source_ref: `fake-task-${key}-${i}`, reviewed: true };
  });
  const chartFile = path.join(dir, 'size-chart.png');
  fs.copyFileSync(assets[0].file, chartFile);
  fs.appendFileSync(chartFile, 'chart');
  const chart = { file: chartFile, sha256: digest(chartFile), product: key, role: 'size_chart', source: 'local_chart',
    source_ref: source, reviewed: true };
  colors.forEach((c, i) => { c.image = { file: assets[i].file }; });
  const videoFile = path.join(dir, 'video.mp4');
  fs.writeFileSync(videoFile, 'video fixture, metadata injected for structural tests');
  return { skuPrefix: key, description: 'Descripción real del producto. '.repeat(24), sizes: ['S', 'M'], colors,
    images: [...assets.slice(0, 8), chart].map((a) => ({ file: a.file })), sizeChart: { file: chartFile },
    media: { mode: 'generated', assets: [...assets, chart], video: { file: videoFile, sha256: digest(videoFile),
      voice_source: 'model_native', speech_reviewed: true, lip_sync_reviewed: true, appearance_reviewed: true } } };
}

function scope(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-media-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('单色、多色及超过8色可通过，颜色图不必全部进入9张相册', (t) => {
  const root = scope(t);
  for (const count of [1, 3, 10]) {
    const p = fixture(root, count, `STYLE-${count}`);
    assert.equal(validateMediaSpec(p, options)[0].colors, count);
  }
  const products = Array.from({ length: 10 }, (_, i) => fixture(root, 1, `BATCH-${i}`));
  assert.equal(validateMediaSpec({ products }, options).length, 10);
});

test('真实正文字符数严格大于500，不靠内部标题、标记或空白凑数', (t) => {
  const p = fixture(scope(t));
  assert.equal(descriptionLength('# 内部编号\n\n**hola**\n◆ mundo'), 10);
  assert.equal(descriptionLength('a' + ' '.repeat(600)), 1);
  p.description = 'a'.repeat(500);
  assert.throws(() => validateMediaSpec(p, options), /DESCRIPTION_TOO_SHORT/);
  p.description += 'a';
  assert.equal(validateMediaSpec(p, options)[0].description_characters, 501);
});

test('错色、缺图、工厂图、跨款、未验收、图数及文件被改全部拦截', (t) => {
  const root = scope(t);
  const base = fixture(root, 2);
  const check = (mutate, code) => {
    const p = structuredClone(base); mutate(p);
    assert.throws(() => validateMediaSpec(p, options), new RegExp(code));
  };
  check((p) => { p.colors[1].image = p.colors[0].image; }, 'SKU_COLOR_IMAGE_MISMATCH');
  check((p) => { delete p.colors[1].image; }, 'IMAGE_REFERENCE_INVALID');
  check((p) => { p.media.assets[0].source = 'factory_original'; }, 'GENERATED_IMAGE_REQUIRED');
  check((p) => { p.media.assets[0].product = 'OTHER'; }, 'CROSS_PRODUCT_ASSET');
  check((p) => { p.media.assets[0].reviewed = false; }, 'IMAGE_REVIEW_REQUIRED');
  check((p) => { p.images.pop(); }, 'GALLERY_REQUIRES_8_PLUS_1');
  check((p) => { p.images[0] = p.images[0].file; }, 'LOCAL_IMAGE_NEEDS_FILE_OBJECT');
  check((p) => { p.sizeChart = p.images[0]; }, 'SIZE_CHART_MISMATCH');
  check((p) => { p.colors[0].image = p.sizeChart; }, 'SKU_COLOR_IMAGE_MISMATCH');
  check((p) => { p.images[1] = p.images[0]; }, 'GALLERY_ORDER_INVALID');
  check((p) => { p.media.assets.at(-1).source_ref = '/missing/size-data.json'; }, 'MEDIA_FILE_MISSING');
  check((p) => { p.colors.push({ en: 'Unknown', image: p.images[0] }); }, 'SKU_COLOR_IMAGE_MISMATCH');
  check((p) => { delete p.media; }, 'MEDIA_MANIFEST_REQUIRED');
  check((p) => { p.media.assets[1].sha256 = p.media.assets[0].sha256; }, 'MEDIA_CHANGED_SINCE_REVIEW');
  fs.appendFileSync(base.media.assets[0].file, 'changed');
  assert.throws(() => validateMediaSpec(base, options), /MEDIA_CHANGED_SINCE_REVIEW/);
});

test('原生声音、人工口型验收、实际9:16和音轨均为必要条件', (t) => {
  const base = fixture(scope(t));
  for (const field of ['speech_reviewed', 'lip_sync_reviewed', 'appearance_reviewed']) {
    const p = structuredClone(base); p.media.video[field] = false;
    assert.throws(() => validateMediaSpec(p, options), /VIDEO_REVIEW_REQUIRED/);
  }
  const p = structuredClone(base); p.media.video.voice_source = 'local_tts';
  assert.throws(() => validateMediaSpec(p, options), /MODEL_NATIVE_VOICE_REQUIRED/);
  const bad = structuredClone(metadata); bad.streams[0].width = 1056;
  assert.throws(() => validateMediaSpec(base, { inspectVideo: () => bad }), /VIDEO_MUST_BE_9_16/);
  const silent = structuredClone(metadata); silent.streams.pop();
  assert.throws(() => validateMediaSpec(base, { inspectVideo: () => silent }), /VIDEO_AUDIO_REQUIRED/);
});

test('视频时长必须大于0且不超过20秒', (t) => {
  const base = fixture(scope(t));
  const checkDuration = (duration) => {
    const result = structuredClone(metadata); result.format.duration = duration;
    return () => validateMediaSpec(base, { inspectVideo: () => result });
  };
  for (const duration of ['0.001', '6', '10', '15', '20']) {
    assert.equal(checkDuration(duration)()[0].video.duration, Number(duration));
  }
  for (const duration of ['0', '-1', '20.001', '', 'not-a-number', null, undefined]) {
    assert.throws(checkDuration(duration), /VIDEO_MUST_BE_WITHIN_20_SECONDS/);
  }
});

test('托管URL必须对应同一本地已验收文件；工厂例外必须明确记录授权', (t) => {
  const p = fixture(scope(t));
  for (const asset of p.media.assets) asset.url = `https://example.test/${path.basename(asset.file)}`;
  const hosted = (ref) => p.media.assets.find((a) => a.file === ref.file).url;
  p.images = p.images.map(hosted);
  p.sizeChart = hosted(p.sizeChart);
  p.colors.forEach((c) => { c.image = hosted(c.image); });
  assert.equal(validateMediaSpec(p, options)[0].gallery, 9);
  p.media = { mode: 'factory_original' };
  assert.throws(() => validateMediaSpec(p, options), /FACTORY_ROUTE_NEEDS_EXPLICIT_AUTHORIZATION/);
  p.media.authorization = 'test: user explicitly selected factory originals';
  assert.equal(validateMediaSpec(p, options)[0].mode, 'factory_original');
});

test('默认ffprobe检查本地合成10秒和15秒视频，不访问生成服务', (t) => {
  const p = fixture(scope(t));
  for (const duration of [10, 15]) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=black:s=90x160:r=1:d=${duration}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(duration), '-c:v', 'libx264', '-c:a', 'aac', p.media.video.file]);
    p.media.video.sha256 = digest(p.media.video.file);
    assert.equal(validateMediaSpec(p)[0].video.duration, duration);
  }
});

test('静态确认发布入口先验素材再访问浏览器，不执行平台入口', () => {
  assert.throws(() => validateMediaSpec({ skuPrefix: 'OLD' }), /MEDIA_MANIFEST_REQUIRED/);
  const source = fs.readFileSync(fileURLToPath(new URL('./publish.mjs', import.meta.url)), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  const guard = "if (['plan', 'build', 'precheck', 'pagecheck', 'import'].includes(a.stage)) validateMediaSpec(spec);";
  assert.ok(main.includes(guard));
  assert.ok(main.indexOf(guard) < main.indexOf('await resolveShop('));
});
