import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, check, classify, hook, sha256, verifyReport } from './guard.mjs';

const SCRIPT = fileURLToPath(new URL('./guard.mjs', import.meta.url));
const METADATA = { streams: [{ codec_type: 'video', width: 90, height: 160, sample_aspect_ratio: '1:1' },
  { codec_type: 'audio' }], format: { duration: '10' } };
const event = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 'test-session' });
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-guard-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const roots = {};
  for (const name of ['pod-pipeline', 'pod-image-listing', 'pod-pricing', 'pod-galaxy-design', 'magpie-image', 'product-fidelity', 'minimax-video', 'pod-execution-guard']) {
    const base = name === 'pod-execution-guard' ? path.join(workspace, '.agents/skills', name) : path.join(workspace, 'plugins', name, 'skills', name);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'SKILL.md'), `# ${name}\nTest skill fixture.\n`);
    if (name !== 'pod-execution-guard') roots[name] = path.join(workspace, 'plugins', name);
  }
  const mediaDir = path.join(workspace, 'pod-repo/tools/pod/listing');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.copyFileSync(path.join(WORKSPACE, 'pod-repo/tools/pod/listing/media-check.mjs'), path.join(mediaDir, 'media-check.mjs'));
  const pricing = path.join(WORKSPACE, 'pod-plugins/pod-pricing');
  fs.mkdirSync(path.join(roots['pod-pricing'], 'lib'), { recursive: true });
  fs.mkdirSync(path.join(roots['pod-pricing'], 'config'), { recursive: true });
  fs.copyFileSync(path.join(pricing, 'lib/pricing.mjs'), path.join(roots['pod-pricing'], 'lib/pricing.mjs'));
  fs.copyFileSync(path.join(pricing, 'config/pricing.json'), path.join(roots['pod-pricing'], 'config/pricing.json'));
  const data = path.join(workspace, 'data');
  fs.mkdirSync(data);
  const source = path.join(data, 'facts.json');
  writeJson(source, { fixture: true, measurement: 'test data only', cost_cny: 32 });
  const colors = [{ en: 'Blanco', es: 'Blanco' }, { en: 'Negro', es: 'Negro' }];
  const assets = Array.from({ length: 9 }, (_, i) => {
    const file = path.join(data, `${i}.png`);
    fs.writeFileSync(file, `test image bytes ${i}; not a visual acceptance fixture`);
    return { file, sha256: sha256(file), product: 'STYLE-A', color: i === 8 ? undefined : colors[i % 2].en,
      role: i === 8 ? 'size_chart' : i < 2 ? 'color_main' : 'product', source: i === 8 ? 'local_chart' : 'generated',
      source_ref: i === 8 ? source : `test-only-receipt-${i}`, reviewed: true };
  });
  colors.forEach((c, i) => { c.image = { file: assets[i].file }; });
  const video = path.join(data, 'video.mp4');
  fs.writeFileSync(video, 'structural test only; metadata injected');
  const spec = { skuPrefix: 'STYLE-A', title: 'Camiseta ejemplo para pruebas locales',
    description: 'Descripción de prueba local, no es un producto publicado. '.repeat(15), price: 130,
    colors, sizes: ['S', 'M'], quantity: 2, parcel: { weight: 250, length: 25, width: 20, height: 3 },
    images: assets.map((a) => ({ file: a.file })), sizeChart: { file: assets[8].file },
    media: { mode: 'generated', assets, video: { file: video, sha256: sha256(video), voice_source: 'model_native',
      speech_reviewed: true, lip_sync_reviewed: true, appearance_reviewed: true } } };
  const specFile = path.join(data, 'spec.json');
  const costsFile = path.join(data, 'costs.json');
  const costs = { products: colors.map((c) => ({ product: 'STYLE-A', color: c.en, cost_cny: 32, source })) };
  writeJson(specFile, spec); writeJson(costsFile, costs);
  const options = { workspace, roots, mediaOptions: { inspectVideo: () => structuredClone(METADATA) } };
  return { workspace, options, roots, spec, specFile, costs, costsFile, source,
    input: { spec: specFile, shop: 'tk-shop-a', costs: costsFile } };
}

const decision = (result) => result.hookSpecificOutput?.permissionDecision;

test('普通直接旧总入口一律拒绝，读取与node --check不误拦', async () => {
  for (const command of [`node ${WORKSPACE}/pod-repo/tools/pod/run-product.mjs --pack /tmp/a`,
    `node ${WORKSPACE}/pod-repo/tools/pod/run-batch.mjs --import`,
    `node --no-warnings "${WORKSPACE}/pod-repo/tools/pod/run-product.mjs" --steps readback`]) {
    assert.equal(decision(await hook(event(command))), 'deny');
  }
  for (const command of ['rg status /tmp/run-product.mjs', 'node --check /tmp/run-product.mjs',
    'node --test /tmp/guard.test.mjs', 'node /other-project/scripts/run-batch.mjs --help',
    'node /tmp/run-product.mjs', 'npm test', 'python3 -I -c "print(1)"']) assert.equal(classify(event(command)), null);
  assert.equal(classify({ ...event('node tools/pod/run-batch.mjs --import'), cwd: `${WORKSPACE}/pod-repo` }).effect, 'deny');
  assert.equal(classify({ ...event('cd pod-repo && node tools/pod/run-product.mjs --pack /tmp/a'), cwd: WORKSPACE }).effect, 'deny');
});

test('重复单值参数直接拒绝，不能检查第一份清单却执行第二份', async () => {
  for (const command of [
    'node /tmp/batch-images.mjs --manifest /tmp/a.json --manifest /tmp/b.json --run',
    'node /tmp/batch-images.mjs --manifest /tmp/a.json --provider magpie --provider image2 --run',
    'node /tmp/listing-step.mjs check --spec /tmp/a.json --spec /tmp/b.json',
    'node /tmp/publish.mjs --spec /tmp/a.json --stage verify --stage import',
  ]) assert.equal(decision(await hook(event(command))), 'deny', command);
});

test('所有已识别生成/写入不被当成本地检查；参数不跨命令借用', () => {
  for (const command of ['node /tmp/batch-images.mjs --run', 'python3 -I /tmp/image2_mcp.py generate --spec /tmp/a',
    'node /tmp/upload-pattern.mjs --image /tmp/a.png', 'node /tmp/minimax-video-studio/dist/cli.js run --batch-id A',
    'node /tmp/image-host.mjs deploy', 'node /tmp/listing-step.mjs check --spec /tmp/a']) {
    assert.equal(classify(event(command))?.effect, 'external', command);
  }
  assert.equal(classify(event('node /tmp/upload-pattern.mjs --check 123'))?.effect, 'local');
  assert.equal(classify(event('node /tmp/batch-images.mjs --manifest /tmp/a; printf --run'))?.effect, 'local');
  const mcp = { ...event(''), tool_name: 'mcp__plugin_magpie-image-studio_image2__image2_generate' };
  assert.equal(classify(mcp)?.effect, 'external');
});

test('历史导入、银河批次、直接生图和订单写入纳入确认，认证dry-run不泄露', async () => {
  const commands = [
    `node ${WORKSPACE}/圣诞首批/scripts/xmas_import.mjs --pid 123 --xlsx /tmp/a.xlsx`,
    `node ${WORKSPACE}/手机壳供应商资料-20261108/scripts/import_batch.mjs --stage import --confirm-import`,
    'node tools/pod/riin-openapi.mjs placeOrder --file /tmp/payload.json',
    'node tools/pod/riin-openapi.mjs pushOrder --file /tmp/payload.json',
    'node tools/pod/riin-openapi.mjs closeOrder --file /tmp/payload.json',
    'node tools/pod/galaxy-run-batch.mjs /tmp/pack.json',
    'node tools/pod/imgen-magpie.mjs prompt --out /tmp/a.png',
    'node tools/pod/listing/insert-detail-images.mjs --apply',
  ];
  for (const command of commands) assert.equal(classify(event(command)).effect, 'external', command);
  assert.equal(classify(event('node tools/pod/riin-openapi.mjs queryProduct')).effect, 'local');
  const blocked = await hook(event('node tools/pod/riin-openapi.mjs placeOrder --dry-run'));
  assert.equal(decision(blocked), 'deny');
  assert.match(blocked.hookSpecificOutput.additionalContext, /secretKey/);
});

test('本地检查、准备和预览无需技能打卡，不读取注册表或写会话状态', async (t) => {
  const f = fixture(t);
  const options = { workspace: f.workspace, get roots() { throw Error('UNEXPECTED_REGISTRY_ACCESS'); } };
  for (const command of [
    'node /tmp/media-check.mjs /tmp/spec.json',
    'node /tmp/product-fidelity.mjs compile --spec /tmp/a.json',
    'node /tmp/batch-images.mjs --manifest /tmp/a.json',
    'node /tmp/pod-pricing/cli.mjs quote --price 130 --cost 32',
    'node /tmp/listing-step.mjs publish --spec /tmp/a.json',
    'node /tmp/listing-step.mjs off --spec /tmp/a.json --product 123',
    'node /tmp/listing-step.mjs status --spec /tmp/a.json',
  ]) {
    assert.equal(classify(event(command)).effect, 'local', command);
    assert.deepEqual(await hook(event(command), options), {});
  }
  assert.deepEqual(await hook({ ...event(''), tool_name: 'mcp__plugin_minimax-video-studio_minimax-video__video_prepare_batch' }, options), {});
  assert.equal(fs.existsSync(path.join(f.workspace, '.local')), false);
});

test('真实写入仍ask，listing check仍外部；apply不能跨命令借用', async () => {
  for (const command of [
    'node /tmp/listing-step.mjs check --spec /tmp/a.json',
    'node /tmp/listing-step.mjs publish --spec /tmp/a.json --apply',
    'node /tmp/listing-step.mjs off --spec /tmp/a.json --product 123 --apply',
  ]) assert.equal(classify(event(command)).effect, 'external', command);
  assert.equal(classify(event('node /tmp/listing-step.mjs publish --spec /tmp/a.json; printf --apply')).effect, 'local');
  assert.equal(decision(await hook(event('node /tmp/listing-step.mjs off --spec /tmp/a.json --product 123 --apply'))), 'ask');
  const outcome = await hook({ ...event(''), tool_name: 'mcp__plugin_magpie-image-studio_image2__image2_generate' });
  assert.equal(decision(outcome), 'ask');
  assert.equal(JSON.stringify(outcome).includes('Skill'), false);
});

test('配置只保留执行前钩子，覆盖生成但排除结果查询和无关MCP', () => {
  const config = JSON.parse(fs.readFileSync(path.join(WORKSPACE, '.zcode/config.json'), 'utf8'));
  assert.deepEqual(Object.keys(config.hooks.events), ['PreToolUse']);
  assert.equal(config.hooks.events.PreToolUse.length, 1);
  const rule = config.hooks.events.PreToolUse[0];
  const matcher = new RegExp(rule.matcher);
  assert.equal(rule.hooks[0].onError, 'deny');
  for (const name of ['Bash', 'mcp__magpie-image__generate_image', 'mcp__magpie-image__generate_video',
    'mcp__plugin_magpie-image-studio_image2__image2_generate', 'mcp__plugin_magpie-image-studio_magpie-image__image_generate',
    'mcp__plugin_tiktok-tshirt_tiktok-tshirt__tshirt_marketing_run', 'mcp__plugin_tiktok-tshirt_tiktok-tshirt__tshirt_pack_run']) {
    assert.equal(matcher.test(name), true, name);
    if (name !== 'Bash') assert.equal(classify({ tool_name: name }).effect, 'external');
  }
  for (const name of ['Skill', 'Read', 'mcp__plugin_pdf_pdf__get_view',
    'mcp__plugin_magpie-image-studio_image2__image2_result', 'mcp__plugin_magpie-image-studio_magpie-image__image_check',
    'mcp__plugin_minimax-video-studio_minimax-video__video_prepare_batch']) assert.equal(matcher.test(name), false, name);
});

test('本地复用素材检查和显式费用，单件固定费/运费不落旧默认', async (t) => {
  const f = fixture(t);
  const report = await check(f.input, f.options);
  assert.equal(report.mechanical_pass, true);
  assert.equal(report.checks.pricing.fees.fixedScope, 'item');
  assert.equal(report.checks.pricing.fees.shipping, 0);
  const result = report.checks.pricing.results[0];
  const expected = (130 * (1 - 0.06 - 0.08 - 0.105 / 1.16) - 6) * 0.36 - 32;
  assert.ok(Math.abs(result.contribution_cny - expected) < 1e-9);
  assert.equal(result.fixed, 6);
  assert.equal(result.shipping, 0);
  assert.ok(result.seller_discount_10pct_cny < 0);
  assert.ok(result.extra_commission_5pct_cny < result.contribution_cny);
  assert.equal(report.next_action, 'check_remote_duplicates');
  assert.equal(verifyReport(report).bindings_match, true);
  assert.equal(Object.hasOwn(report, 'authorized'), false);
});

test('原技能旧数值示例不覆盖真实配置，32元成本/122比索实际亏损', async (t) => {
  const f = fixture(t); f.spec.price = 122; writeJson(f.specFile, f.spec);
  const report = await check(f.input, f.options);
  assert.equal(report.mechanical_pass, false);
  assert.ok(Math.abs(report.checks.pricing.results[0].contribution_cny - (-0.364317241379307)) < 1e-9);
});

test('成本缺项/0/错色、缺显式物流、素材错色和假工厂例外不能放行', async (t) => {
  const f = fixture(t);
  await assert.rejects(check({ ...f.input, costs: undefined }, f.options), /EXPLICIT_COSTS_REQUIRED/);
  f.costs.products[0].cost_cny = 0; writeJson(f.costsFile, f.costs);
  await assert.rejects(check(f.input, f.options), /POSITIVE_COST_REQUIRED/);
  f.costs.products[0].cost_cny = 32; f.costs.products[0].color = 'Azul'; writeJson(f.costsFile, f.costs);
  await assert.rejects(check(f.input, f.options), /EXACT_COLOR_COST_REQUIRED/);
  f.costs.products[0].color = 'Blanco'; writeJson(f.costsFile, f.costs);
  const wrong = structuredClone(f.spec); wrong.colors[1].image = wrong.colors[0].image; writeJson(f.specFile, wrong);
  await assert.rejects(check(f.input, f.options), /SKU_COLOR_IMAGE_MISMATCH/);
  const parcel = structuredClone(f.spec); delete parcel.parcel; writeJson(f.specFile, parcel);
  await assert.rejects(check(f.input, f.options), /EXPLICIT_PARCEL_REQUIRED/);
  const factory = structuredClone(f.spec); factory.media = { mode: 'factory_original', authorization: 'AI wrote approved=true' }; writeJson(f.specFile, factory);
  assert.equal((await check(f.input, f.options)).mechanical_pass, false);
});

test('图片、费用或spec任一字节改变使报告过期，亏损不是pass', async (t) => {
  const f = fixture(t);
  const report = await check(f.input, f.options);
  fs.appendFileSync(f.spec.media.assets[0].file, 'changed');
  assert.throws(() => verifyReport(report), /STALE_BINDING/);
  const f2 = fixture(t);
  const r2 = await check(f2.input, f2.options);
  fs.appendFileSync(path.join(f2.roots['pod-pricing'], 'config/pricing.json'), '\n');
  assert.throws(() => verifyReport(r2), /STALE_BINDING/);
  f2.spec.price = 1; writeJson(f2.specFile, f2.spec);
  const low = await check(f2.input, f2.options);
  assert.equal(low.mechanical_pass, false);
  assert.equal(low.checks.pricing.status, 'below_breakeven');
});

test('复用当前指纹无需二次读文件，缺项/重复/增项/角色或SHA变化拒绝', async (t) => {
  const f = fixture(t);
  const report = await check(f.input, f.options);
  const current = await check(f.input, f.options);
  const reordered = structuredClone(report); reordered.bindings.reverse();
  const original = fs.readFileSync;
  fs.readFileSync = () => { throw Error('DUPLICATE_FILE_SCAN'); };
  try { assert.equal(verifyReport(reordered, current).bindings_match, true); }
  finally { fs.readFileSync = original; }
  for (const change of [
    (r) => r.bindings.pop(),
    (r) => { r.bindings[0] = r.bindings[1]; },
    (r) => r.bindings.push({ ...r.bindings[0], file: '/extra.json' }),
    (r) => { r.bindings[0].role = 'wrong'; },
    (r) => { r.bindings[0].sha256 = '0'.repeat(64); },
    (r) => { r.bindings[0].file += '.other'; },
  ]) {
    const forged = structuredClone(report); change(forged);
    assert.throws(() => verifyReport(forged, current), /REPORT_BINDINGS_MISMATCH|STALE_BINDING/);
  }
});

test('写入入口仍拒绝过期输入、媒体、成本、费率和遗漏绑定', async (t) => {
  const f = fixture(t);
  const reportFile = path.join(f.workspace, 'report.json');
  const report = await check(f.input, f.options); writeJson(reportFile, report);
  const bound = event(`POD_GUARD_REPORT=${reportFile} node /tmp/listing-step.mjs check --spec ${f.specFile}`);
  for (const file of [f.specFile, f.costsFile, f.source, path.join(f.roots['pod-pricing'], 'config/pricing.json')]) {
    const before = fs.readFileSync(file);
    fs.appendFileSync(file, '\n');
    assert.equal(decision(await hook(bound, f.options)), 'deny', file);
    fs.writeFileSync(file, before);
  }
  const partial = structuredClone(report); partial.bindings.pop(); writeJson(reportFile, partial);
  assert.equal(decision(await hook(bound, f.options)), 'deny');
  writeJson(reportFile, report);
  fs.appendFileSync(f.spec.media.assets[0].file, 'changed');
  assert.equal(decision(await hook(bound, f.options)), 'deny');
});

test('恢复态即使本地检查通过且报告自填new也只能读回，不重提', async (t) => {
  const f = fixture(t);
  const evidence = path.join(f.workspace, 'evidence.json');
  const reportFile = path.join(f.workspace, 'report.json');
  const bound = event(`POD_GUARD_REPORT=${reportFile} node /tmp/listing-step.mjs publish --spec ${f.specFile} --apply`);
  for (const [stage, product_ids] of [['upload_history', []], ['submitted_unknown', []], ['new', ['123456789']]]) {
    writeJson(evidence, { shop: 'tk-shop-a', products: ['STYLE-A'], stage, product_ids,
      files: [{ file: f.specFile, sha256: sha256(f.specFile) }] });
    const report = await check({ ...f.input, evidence }, f.options);
    assert.equal(report.mechanical_pass, true);
    report.next_action = 'check_remote_duplicates'; writeJson(reportFile, report);
    assert.equal(decision(await hook(bound, f.options)), 'deny');
  }
});

test('已有xlsx只绑原表和模板，不生成spec；未知提交/已有ID下一步只有读回', async (t) => {
  const f = fixture(t);
  const xlsx = path.join(f.workspace, 'existing.xlsx');
  const template = path.join(f.workspace, 'template.xlsx');
  fs.writeFileSync(xlsx, 'existing workbook fixture, not parsed'); fs.writeFileSync(template, 'template fixture');
  const evidence = path.join(f.workspace, 'evidence.json');
  const facts = { shop: 'tk-shop-a', products: ['STYLE-A'], stage: 'upload_history', product_ids: [],
    files: [{ file: xlsx, sha256: sha256(xlsx) }] };
  writeJson(evidence, facts);
  const input = { xlsx, template, evidence, shop: 'tk-shop-a' };
  const before = fs.readdirSync(f.workspace).sort();
  const report = await check(input, f.options);
  assert.equal(report.status, 'evidence_only'); assert.equal(report.mechanical_pass, false);
  assert.equal(report.next_action, 'recover_history');
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), before);
  facts.stage = 'submitted_unknown'; writeJson(evidence, facts);
  assert.equal((await check(input, f.options)).next_action, 'readback_only');
  facts.stage = 'new'; facts.product_ids = ['2000000000000000000']; writeJson(evidence, facts);
  assert.equal((await check(input, f.options)).next_action, 'readback_only');
  facts.files[0].sha256 = '0'.repeat(64); writeJson(evidence, facts);
  await assert.rejects(check(input, f.options), /EVIDENCE_STALE/);
});

test('已知发布入口缺报告拒绝，报告通过也只ask；伪造通过或换spec不能绕过复算', async (t) => {
  const f = fixture(t);
  const command = `node /tmp/listing-step.mjs check --spec ${f.specFile}`;
  assert.equal(decision(await hook(event(command), f.options)), 'deny');
  const reportFile = path.join(f.workspace, 'report.json');
  const report = await check(f.input, f.options); writeJson(reportFile, report);
  const bound = `POD_GUARD_REPORT=${reportFile} ${command}`;
  const outcome = await hook(event(bound), f.options);
  assert.equal(decision(outcome), 'ask', JSON.stringify(outcome));
  report.mechanical_pass = true;
  f.spec.price = 1; writeJson(f.specFile, f.spec);
  const forged = await check(f.input, f.options); forged.mechanical_pass = true; writeJson(reportFile, forged);
  assert.equal(decision(await hook(event(bound), f.options)), 'deny');
  writeJson(reportFile, report);
  assert.equal(decision(await hook(event(bound.replace(f.specFile, '/tmp/other.json')), f.options)), 'deny');
});

test('纯分析/维护、消息和Skill返回不注入提示、不写记录、不返回allow', async (t) => {
  const f = fixture(t);
  for (const command of ['node --test /tmp/guard.test.mjs', 'ls /tmp', 'rg foo /tmp', 'git status']) {
    assert.deepEqual(await hook(event(command), f.options), {});
  }
  assert.deepEqual(await hook({ hook_event_name: 'UserPromptSubmit', prompt: '看看POD技能，不要生成不要上架' }, f.options), {});
  assert.deepEqual(await hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'pod-pipeline' }, tool_response: 'success' }, f.options), {});
  assert.equal(fs.existsSync(path.join(f.workspace, '.local')), false);
});

test('商品批次免技能打卡，但引用SHA/角色/顺序和输出冲突仍校验', async (t) => {
  const f = fixture(t);
  const ref = f.spec.media.assets[0].file;
  const doc = { batch_id: 'test-product', jobs: [{ request_id: 'product-front', prompt: 'locked',
    reference_images: [ref], output_file: path.join(f.workspace, 'result.png'), facts_source: f.source,
    product_lock: { product_id: 'STYLE-A', color: 'Blanco', model: null,
      refs: [{ role: 'product', file: ref, sha256: sha256(ref) }], facts_sha256: sha256(f.source), review_status: 'pending', policy_version: 1 } }] };
  doc._product_fidelity = { policy_version: 1, manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
    source_spec: f.specFile, source_spec_sha256: sha256(f.specFile) };
  const manifest = path.join(f.workspace, 'product-manifest.json'); writeJson(manifest, doc);
  const input = event(`node /tmp/batch-images.mjs --manifest ${manifest} --run`);
  assert.equal(decision(await hook(input, f.options)), 'ask');
  const output = doc.jobs[0].output_file;
  const rebind = () => {
    const body = { ...doc }; delete body._product_fidelity;
    doc._product_fidelity.manifest_sha256 = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    writeJson(manifest, doc);
  };
  for (const target of [ref, f.source, f.specFile, manifest, f.source.toUpperCase()]) {
    doc.jobs[0].output_file = target; rebind();
    assert.equal(decision(await hook(input, f.options)), 'deny', target);
  }
  const otherRef = f.spec.media.assets[1].file;
  const other = structuredClone(doc.jobs[0]);
  other.request_id = 'product-other'; other.reference_images = [otherRef];
  other.output_file = path.join(f.workspace, 'other-result.png');
  other.product_lock.refs = [{ role: 'product', file: otherRef, sha256: sha256(otherRef) }];
  doc.jobs.push(other); doc.jobs[0].output_file = otherRef; rebind();
  assert.equal(decision(await hook(input, f.options)), 'deny', '跨任务输出也不能覆盖另一任务的参考图');
  doc.jobs.pop(); doc.jobs[0].output_file = output; rebind();
  assert.equal(decision(await hook(input, f.options)), 'ask');
  fs.appendFileSync(f.specFile, '\n');
  assert.equal(decision(await hook(input, f.options)), 'deny');
  doc._product_fidelity.source_spec_sha256 = sha256(f.specFile); writeJson(manifest, doc);
  assert.equal(decision(await hook(input, f.options)), 'ask');
  fs.appendFileSync(ref, 'changed');
  assert.equal(decision(await hook(input, f.options)), 'deny');
});

test('命令行错误和hook输入错误显式失败，不启动生成/浏览器', () => {
  const local = spawnSync(process.execPath, [SCRIPT, 'check', '--spec', '/missing'], { encoding: 'utf8' });
  assert.equal(local.status, 1); assert.equal(JSON.parse(local.stdout).mechanical_pass, false);
  const badHook = spawnSync(process.execPath, [SCRIPT, 'hook'], { input: 'not-json', encoding: 'utf8' });
  assert.equal(badHook.status, 2); assert.equal(badHook.stdout, '');
});
