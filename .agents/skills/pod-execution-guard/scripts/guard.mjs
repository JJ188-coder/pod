#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHOP = 'tk-xjcx4623';
const SCHEMA = 'pod-guard-check-v1';
const NAMES = {
  'pod-pipeline': 'pod-pipeline',
  'pod-image-listing': 'pod-image-listing',
  'pod-pricing': 'pod-pricing',
};
const LIMITS = [
  '只核本地结构、字节绑定和显式成本报价；不是发布授权或远端成功证明。',
  'reviewed/authorization字段只是声明，不能证明人眼识色、口型或用户授权。',
  '店铺实际身份、官方模板、逐SKU价格数量、总量、物流、查重和最终状态仍需页面读回。',
  '钩子只覆盖已识别入口，不是任意解释器/浏览器/子进程的安全沙箱或全局幂等锁。',
];
const assert = (value, code) => { if (!value) throw Error(code); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function realFile(file) {
  assert(typeof file === 'string' && path.isAbsolute(file), 'ABSOLUTE_FILE_REQUIRED');
  assert(fs.statSync(file).isFile(), 'REGULAR_FILE_REQUIRED');
  return fs.realpathSync(file);
}

function outputPath(file) {
  assert(typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0'), 'ABSOLUTE_OUTPUT_REQUIRED');
  const parts = [];
  let ancestor = path.resolve(file);
  while (!fs.existsSync(ancestor)) {
    assert(!fs.lstatSync(ancestor, { throwIfNoEntry: false }), 'OUTPUT_SYMLINK_NOT_ALLOWED');
    parts.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const stat = fs.lstatSync(ancestor);
  if (!parts.length) assert(stat.isFile() && !stat.isSymbolicLink(), 'OUTPUT_REGULAR_FILE_REQUIRED');
  else assert(fs.statSync(ancestor).isDirectory(), 'OUTPUT_PARENT_REQUIRED');
  return path.join(fs.realpathSync(ancestor), ...parts).toLowerCase();
}

export function installedRoots(home = os.homedir()) {
  const registry = readJson(path.join(home, '.zcode/cli/plugins/installed_plugins.json'));
  const roots = {};
  for (const [skill, plugin] of Object.entries(NAMES)) {
    const matches = registry.plugins.filter((p) => p.id === `${plugin}@pod-toolkit`);
    assert(matches.length === 1, `PLUGIN_IDENTITY_UNCLEAR: ${plugin}`);
    roots[skill] = fs.realpathSync(matches[0].installPath);
  }
  return roots;
}

function skillFile(name, options) {
  if (name === 'pod-execution-guard') return path.join(options.workspace, '.agents/skills/pod-execution-guard/SKILL.md');
  assert(options.roots[name], `PLUGIN_MISSING: ${name}`);
  return path.join(options.roots[name], 'skills', name, 'SKILL.md');
}

function binding(file, role) {
  const canonical = realFile(file);
  return { file: canonical, sha256: sha256(canonical), role };
}

function validateFees(fees) {
  assert(fees && Number.isFinite(fees.fx) && fees.fx > 0, 'INVALID_FX');
  for (const key of ['commission', 'sfp', 'iva', 'isr', 'shipping']) {
    assert(Number.isFinite(fees[key]) && fees[key] >= 0 && fees[key] < 1, `INVALID_FEE: ${key}`);
  }
  for (const key of ['fixed', 'sfpCap']) assert(Number.isFinite(fees[key]) && fees[key] >= 0, `INVALID_FEE: ${key}`);
  assert(['item', 'order'].includes(fees.fixedScope), 'FIXED_FEE_SCOPE_REQUIRED');
}

function remoteNext(evidence) {
  if (evidence?.product_ids?.length || ['submitted_unknown', 'readback'].includes(evidence?.stage)) return 'readback_only';
  if (evidence?.stage === 'upload_history') return 'recover_history';
  return 'check_remote_duplicates';
}

// 本地报告不是通行证；重新核对所有绑定，不能靠旧的 pass 或 status=ok 续跑。
export function verifyReport(report, current) {
  assert(report?.schema === SCHEMA && Array.isArray(report.bindings) && report.bindings.length > 0, 'REPORT_INVALID');
  const bindings = current && new Map(current.bindings.map((item) => [item.file, item]));
  if (bindings) {
    assert(report.bindings.length === bindings.size
      && new Set(report.bindings.map((item) => item.file)).size === bindings.size, 'REPORT_BINDINGS_MISMATCH');
  }
  for (const item of report.bindings) {
    assert(/^[a-f0-9]{64}$/.test(item.sha256), 'BINDING_SHA_REQUIRED');
    // 入口已有本轮检查指纹；独立verify才需要重新读取文件。
    if (bindings) {
      const fresh = bindings.get(item.file);
      assert(fresh && fresh.sha256 === item.sha256 && fresh.role === item.role, `STALE_BINDING: ${item.file}`);
    } else {
      assert(realFile(item.file) === item.file && sha256(item.file) === item.sha256, `STALE_BINDING: ${item.file}`);
    }
  }
  return { bindings_match: true, limits: LIMITS };
}

export async function check(input, options = {}) {
  const opts = { workspace: WORKSPACE, ...options };
  opts.roots ??= installedRoots();
  assert(input.shop === SHOP, 'SHOP_NOT_SUPPORTED: 原上架技能仅支持tk-xjcx4623，手机壳店铺不可混用');
  assert(Boolean(input.spec) !== Boolean(input.xlsx), 'SELECT_SPEC_OR_EXISTING_XLSX');
  const report = {
    schema: SCHEMA, checked_at: new Date().toISOString(), route: input.spec ? 'spec' : 'existing_xlsx',
    scope: { workspace: fs.realpathSync(opts.workspace), shop: input.shop, products: [] },
    inputs: { ...input }, bindings: [], checks: {}, mechanical_pass: false, limits: LIMITS,
  };
  const add = (file, role) => {
    const item = binding(file, role);
    if (!report.bindings.some((b) => b.file === item.file)) report.bindings.push(item);
    return item.file;
  };
  let evidence = null;
  if (input.evidence) {
    evidence = readJson(add(input.evidence, 'existing_evidence'));
    assert(evidence.shop === input.shop, 'EVIDENCE_SHOP_MISMATCH');
    assert(Array.isArray(evidence.products) && evidence.products.length > 0
      && evidence.products.every((p) => typeof p === 'string' && p.trim()), 'EVIDENCE_PRODUCTS_REQUIRED');
    assert(Array.isArray(evidence.files) && evidence.files.length > 0, 'EVIDENCE_BINDINGS_REQUIRED');
    for (const item of evidence.files) {
      const file = add(item.file, 'evidence_attachment');
      assert(/^[a-f0-9]{64}$/.test(item.sha256) && sha256(file) === item.sha256, `EVIDENCE_STALE: ${file}`);
    }
  }
  report.next_action = remoteNext(evidence);
  if (evidence) {
    assert(['new', 'upload_history', 'submitted_unknown', 'readback'].includes(evidence.stage), 'EVIDENCE_STAGE_REQUIRED');
    assert(Array.isArray(evidence.product_ids) && evidence.product_ids.every((id) => typeof id === 'string' && /^\d+$/.test(id)), 'PRODUCT_IDS_INVALID');
  }
  report.checks.remote = { status: 'unknown', note: '只采用现有回执声明选择恢复方向，未访问店铺核真。' };
  for (const name of ['pod-execution-guard', 'pod-pipeline', 'pod-image-listing']) add(skillFile(name, opts), 'skill');
  if (input.xlsx) {
    const file = add(input.xlsx, 'existing_xlsx');
    assert(evidence && evidence.files.some((item) => realFile(item.file) === file), 'EXACT_XLSX_EVIDENCE_REQUIRED');
    assert(input.template, 'OFFICIAL_TEMPLATE_REQUIRED');
    add(input.template, 'official_template');
    report.scope.input = file;
    report.scope.products = evidence.products;
    report.checks.existing_xlsx = { status: 'evidence_only', note: '仅绑定原表、模板和回执；未解析表格或验证网页值，不生成替身spec。' };
    report.checks.pricing = { status: 'unknown', note: '须按原表逐码核售价与本款成本，不能用未核对的声明替代。' };
    report.status = 'evidence_only';
    return report;
  }
  const specFile = add(input.spec, 'current_spec');
  const spec = readJson(specFile);
  const products = spec.products === undefined ? [spec] : spec.products;
  assert(Array.isArray(products) && products.length > 0, 'PRODUCTS_REQUIRED');
  const merged = products.map((p) => ({ ...spec.defaults, ...p }));
  report.scope.input = specFile;
  report.scope.products = merged.map((p) => p.skuPrefix);
  if (evidence) assert(JSON.stringify([...evidence.products].sort()) === JSON.stringify([...report.scope.products].sort()), 'EVIDENCE_PRODUCTS_MISMATCH');
  const validator = add(path.join(opts.workspace, 'pod-repo/tools/pod/listing/media-check.mjs'), 'media_validator');
  const { validateMediaSpec } = await import(pathToFileURL(validator).href);
  const media = validateMediaSpec(spec, opts.mediaOptions);
  for (const p of merged) {
    for (const asset of p.media?.assets || []) {
      add(asset.file, 'media');
      if (asset.source === 'local_chart') add(asset.source_ref, 'measurement_source');
    }
    if (p.media?.video?.file) add(p.media.video.file, 'video');
  }
  report.checks.media = { status: media.every((p) => p.mode === 'generated') ? 'pass' : 'user_exception_required', results: media };
  assert(input.costs, 'EXPLICIT_COSTS_REQUIRED: 使用本款逐色成本文件，不使用T恤默认档');
  const costs = readJson(add(input.costs, 'explicit_costs'));
  assert(Array.isArray(costs.products) && costs.products.length > 0, 'COST_ROWS_REQUIRED');
  const pricingRoot = opts.roots['pod-pricing'];
  const policy = readJson(add(path.join(pricingRoot, 'config/pricing.json'), 'pricing_policy'));
  validateFees(policy.fees);
  const pricingModule = add(path.join(pricingRoot, 'lib/pricing.mjs'), 'pricing_implementation');
  add(skillFile('pod-pricing', opts), 'skill');
  const { quote } = await import(pathToFileURL(pricingModule).href);
  const used = new Set();
  const quotes = [];
  for (const p of merged) {
    assert(p.parcel && ['weight', 'length', 'width', 'height'].every((k) => Number.isFinite(p.parcel[k]) && p.parcel[k] > 0), 'EXPLICIT_PARCEL_REQUIRED');
    for (const color of p.colors || []) {
      const rows = costs.products.filter((c) => c.product === p.skuPrefix && c.color === color.en);
      assert(rows.length === 1, `EXACT_COLOR_COST_REQUIRED: ${p.skuPrefix}/${color.en}`);
      const row = rows[0];
      assert(Number.isFinite(row.cost_cny) && row.cost_cny > 0, 'POSITIVE_COST_REQUIRED');
      add(row.source, 'cost_source');
      used.add(row);
      const price = typeof p.price === 'number' ? p.price : p.price?.[color.en] ?? p.price?.default;
      assert(Number.isFinite(price) && price > 0, 'POSITIVE_PRICE_REQUIRED');
      const current = quote(price, row.cost_cny, policy.fees, 1);
      assert(Number.isFinite(current.contribution_cny), 'QUOTE_INVALID');
      const extra = quote(price, row.cost_cny, { ...policy.fees, commission: policy.fees.commission + 0.05 }, 1);
      const discount = quote(price * 0.9, row.cost_cny, policy.fees, 1);
      quotes.push({ product: p.skuPrefix, color: color.en, ...current,
        extra_commission_5pct_cny: extra.contribution_cny, seller_discount_10pct_cny: discount.contribution_cny });
    }
  }
  assert(quotes.length > 0 && used.size === costs.products.length, 'UNUSED_OR_MISSING_COST_ROWS');
  report.checks.parcel = { status: 'pass', note: '仅确认显式正数；是否实测/获准估算仍需真实依据。' };
  report.checks.pricing = { status: quotes.every((q) => q.contribution_cny >= 0) ? 'pass' : 'below_breakeven',
    policy_version: policy.version, fees: policy.fees, qty: 1, results: quotes };
  report.mechanical_pass = report.checks.media.status === 'pass' && report.checks.pricing.status === 'pass';
  report.status = report.mechanical_pass ? 'local_checks_passed_page_review_required' : 'blocked';
  return report;
}

// ponytail: 仅识别普通shell调用；不尝试解析任意内联程序、动态拼接或浏览器脚本。
export function classify(event) {
  const tool = event.tool_name || '';
  if (tool.startsWith('mcp__')) {
    if (/(?:image2_generate|image_generate|generate_image|tshirt_marketing_run|tshirt_pack_run|generate_video)$/.test(tool)) return { effect: 'external' };
    if (tool.endsWith('video_prepare_batch')) return { effect: 'local' };
    return null;
  }
  if (tool !== 'Bash') return null;
  const command = event.tool_input?.command || '';
  const tokens = (command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()]+|[;&|()]/g) || [])
    .map((t) => /^['"]/.test(t) ? t.slice(1, -1) : t);
  const calls = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!/^(?:node|nodejs|python3?|bun)$/.test(path.basename(tokens[i]))) continue;
    let j = i + 1;
    if (['-e', '--eval', '-c', '--test', '--check', '-m'].includes(tokens[j])) continue;
    while (tokens[j]?.startsWith('-')) j++;
    if (!/\.(?:mjs|js|py)$/.test(tokens[j] || '')) continue;
    let end = j + 1;
    while (end < tokens.length && ![';', '&&', '||', '|', '(', ')', '&'].includes(tokens[end])) end++;
    calls.push({ script: path.basename(tokens[j]), file: tokens[j], args: tokens.slice(j + 1, end) });
  }
  const rules = calls.map(({ script, file, args }) => {
    const has = (arg) => args.includes(arg);
    const singletons = script === 'batch-images.mjs'
      ? ['--manifest', '--provider', '--concurrency', '--max-wait-min', '--poll-seconds', '--run']
      : ['listing-step.mjs', 'publish.mjs'].includes(script) ? ['--spec', '--stage', '--shop', '--xlsx'] : [];
    if (singletons.some((flag) => args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length > 1)) {
      return { effect: 'deny', reason: '同一单值参数不能重复，避免检查清单与实际执行清单不一致。' };
    }
    const absolute = path.resolve(event.cwd || WORKSPACE, file);
    const oldEntry = path.join(WORKSPACE, 'pod-repo/tools/pod', script);
    if (['run-product.mjs', 'run-batch.mjs'].includes(script)) {
      let known = absolute === oldEntry;
      try { known ||= fs.realpathSync(absolute) === oldEntry; } catch { /* 不存在的同名文件不冒充本项目入口。 */ }
      // tools/pod 是原仓库文档的相对调用形式；跨目录同名文件不按basename拒绝。
      const cwd = path.resolve(event.cwd || WORKSPACE);
      known ||= !path.isAbsolute(file) && /^(?:\.\/)?tools\/pod\//.test(file)
        && (cwd === WORKSPACE || cwd.startsWith(WORKSPACE + path.sep));
      return known ? { effect: 'deny', reason: '旧总入口含隐式收费/上传、旧状态跳过和不可靠查重；请按原技能分步执行，已有表走恢复。' } : null;
    }
    if (['xmas_import.mjs', 'import_batch.mjs'].includes(script)) return { effect: 'external', reason: '历史批量入口会上传现有表格甚至直接导入；先按原恢复链核精确文件、店铺、查重与授权。' };
    if (script === 'riin-openapi.mjs') {
      if (has('--dry-run')) return { effect: 'deny', reason: '此旧客户端的dry-run会打印含secretKey/sign的headers；不要运行以免泄露凭证，改为本地审阅不含认证的报文。' };
      const readonly = !args.length || ['--help', '-h'].includes(args[0]) || /^query[A-Z]/.test(args[0]) || args[0] === 'orderFundsPageList';
      return { effect: readonly ? 'local' : 'external' };
    }
    if (script === 'galaxy-run-batch.mjs') return { effect: 'external' };
    if (script === 'imgen-magpie.mjs') return { effect: 'external' };
    if (script === 'insert-detail-images.mjs') return { effect: has('--apply') || has('--save') ? 'external' : 'local' };
    if (script === 'listing-step.mjs') return { effect: args[0] === 'check' || ['publish', 'off'].includes(args[0]) && has('--apply') ? 'external' : 'local', listing: true, args };
    if (script === 'publish.mjs' && has('--spec')) return { effect: args[args.indexOf('--stage') + 1] === 'verify' ? 'local' : 'external', listing: true, args };
    if (script === 'media-check.mjs') return { effect: 'local' };
    if (script === 'image-host.mjs') return { effect: args[0] === 'deploy' ? 'external' : 'local' };
    if (script === 'product-fidelity.mjs') return { effect: 'local' };
    if (script === 'batch-images.mjs') return { effect: has('--run') ? 'external' : 'local', imageBatch: true, args };
    if (['marketing-pack.mjs', 'sample-variant.mjs', 'grsai-image.mjs'].includes(script)) return { effect: 'external' };
    if (script === 'image2_mcp.py') return { effect: args[0] === 'generate' || has('--run') ? 'external' : 'local' };
    if (script === 'upload-pattern.mjs') return { effect: has('--check') ? 'local' : 'external' };
    if (script === 'galaxy-step.mjs') return { effect: has('--apply') ? 'external' : 'local' };
    if (script === 'riin-design-batch.mjs' || script === 'riin-map.mjs' && has('--sync')) return { effect: 'external' };
    if (script === 'cli.mjs' && /pod-pricing/.test(file)) return { effect: has('--apply') || has('--save') || has('--refresh-costs') ? 'external' : 'local' };
    if (script === 'cli.js' && /minimax-video/.test(file)) return { effect: ['run', 'resume', 'generate'].includes(args[0]) ? 'external' : 'local' };
    return null;
  }).filter(Boolean);
  if (!rules.length) return null;
  const effect = rules.some((r) => r.effect === 'deny') ? 'deny' : rules.some((r) => r.effect === 'external') ? 'external' : 'local';
  return { effect, reason: rules.find((r) => r.effect === 'deny')?.reason, rules, command };
}

function hookOutput(event, context, decision) {
  return { hookSpecificOutput: { hookEventName: event, ...(context ? { additionalContext: context } : {}),
    ...(decision ? { permissionDecision: decision, permissionDecisionReason: context } : {}) } };
}

export async function hook(event, options = {}) {
  const kind = event.hook_event_name;
  if (kind !== 'PreToolUse') return {};
  const action = classify(event);
  if (!action || action.effect === 'local') return {};
  if (action.effect === 'deny') return hookOutput(kind, action.reason, 'deny');
  const opts = { workspace: WORKSPACE, ...options };
  for (const rule of action.rules || []) {
    if (rule.imageBatch && rule.effect === 'external') {
      try {
        const at = rule.args.indexOf('--manifest');
        assert(at >= 0, 'IMAGE_MANIFEST_REQUIRED');
        const file = realFile(rule.args[at + 1]);
        const doc = readJson(file);
        if (doc._product_fidelity || doc.jobs?.some((job) => job.product_lock)) {
          assert(doc._product_fidelity?.policy_version === 1 && Array.isArray(doc.jobs) && doc.jobs.length > 0,
            'COMPILED_PRODUCT_MANIFEST_REQUIRED');
          const normalized = { ...doc }; delete normalized._product_fidelity;
          assert(crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex') === doc._product_fidelity.manifest_sha256,
            'PRODUCT_MANIFEST_CHANGED');
          const sourceSpec = realFile(doc._product_fidelity.source_spec);
          assert(sha256(sourceSpec) === doc._product_fidelity.source_spec_sha256, 'PRODUCT_SOURCE_CHANGED');
          assert(doc.local_files === undefined || Array.isArray(doc.local_files) && doc.local_files.length === 0,
            'PRODUCT_LOCAL_FILES_NOT_SUPPORTED');
          const inputs = new Set([file, sourceSpec].map((input) => input.toLowerCase()));
          const outputs = new Set();
          for (const job of doc.jobs) {
            const lock = job.product_lock;
            assert(lock && lock.policy_version === 1 && lock.review_status === 'pending' && Array.isArray(lock.refs)
              && lock.refs.some((ref) => ref.role === 'product'), 'PRODUCT_REFERENCE_REQUIRED');
            assert(JSON.stringify(job.reference_images) === JSON.stringify(lock.refs.map((ref) => ref.file)), 'PRODUCT_REFERENCE_ORDER_CHANGED');
            for (const ref of lock.refs) {
              const reference = realFile(ref.file);
              assert(sha256(reference) === ref.sha256, 'PRODUCT_REFERENCE_CHANGED');
              inputs.add(reference.toLowerCase());
            }
            const facts = realFile(job.facts_source);
            assert(sha256(facts) === lock.facts_sha256, 'PRODUCT_FACTS_CHANGED');
            inputs.add(facts.toLowerCase());
            const output = outputPath(job.output_file);
            assert(!outputs.has(output), 'PRODUCT_OUTPUT_DUPLICATE');
            outputs.add(output);
          }
          for (const output of outputs) assert(!inputs.has(output), 'PRODUCT_OUTPUT_INPUT_CONFLICT');
        }
      } catch (error) {
        return hookOutput(kind, `POD护栏：商品参考清单缺失或过期，先重新编译保真任务：${error.message}`, 'deny');
      }
    }
    if (!rule.listing || rule.effect !== 'external') continue;
    const specAt = rule.args.indexOf('--spec');
    if (specAt < 0 || rule.args[0] === 'off' || rule.args.includes('--confirm-deactivate')) continue;
    const reportPath = /(?:^|\s)POD_GUARD_REPORT=(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(action.command);
    if (!reportPath) return hookOutput(kind, 'POD护栏：先运行guard check --spec ... --shop tk-xjcx4623 --costs ...，将JSON留作报告；用POD_GUARD_REPORT=绝对路径绑定本次命令。check也可能公开图床并上传。已有xlsx/历史不要重建。', 'deny');
    try {
      const report = readJson(realFile(reportPath[1] || reportPath[2] || reportPath[3]));
      assert(report.scope?.workspace === fs.realpathSync(opts.workspace) && report.scope.shop === SHOP, 'REPORT_SCOPE_MISMATCH');
      assert(report.route === 'spec' && report.scope.input === realFile(rule.args[specAt + 1])
        && report.inputs?.spec && realFile(report.inputs.spec) === report.scope.input && !report.inputs.xlsx, 'REPORT_INPUT_MISMATCH');
      const current = await check(report.inputs, opts);
      verifyReport(report, current);
      assert(current.mechanical_pass === true, 'LOCAL_CHECKS_NOT_PASSED');
      assert(current.next_action === 'check_remote_duplicates', 'RECOVER_OR_READBACK_ONLY');
    } catch (error) {
      return hookOutput(kind, `POD护栏：报告过期/不匹配/需恢复，停止重建或导入：${error.message}`, 'deny');
    }
  }
  if (action.effect === 'external') return hookOutput(kind, 'POD护栏：此已识别入口包含收费生成、公开托管、平台写入或资料写入。仅在真实用户请求涵盖本款/数量/动作且当前页面已核店铺与查重后确认；本地报告和approved字段不是授权。', 'ask');
  return {};
}

function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(/^--(?:spec|xlsx|shop|costs|evidence|template|report)$/.test(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'INVALID_ARGUMENTS');
    const key = args[i].slice(2);
    assert(!Object.hasOwn(values, key), 'DUPLICATE_ARGUMENT');
    values[key] = args[i + 1];
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === 'hook') {
      let raw = '';
      for await (const chunk of process.stdin) { raw += chunk; assert(raw.length <= 2 * 1024 * 1024, 'HOOK_INPUT_TOO_LARGE'); }
      console.log(JSON.stringify(await hook(JSON.parse(raw))));
    } else {
      const input = parseArgs(process.argv.slice(3));
      const result = command === 'check' ? await check(input) : command === 'verify' ? verifyReport(readJson(realFile(input.report))) : null;
      assert(result, 'USAGE: guard.mjs check --spec FILE --shop tk-xjcx4623 --costs FILE | check --xlsx FILE --template FILE --evidence FILE --shop tk-xjcx4623 | verify --report FILE | hook');
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'blocked') process.exitCode = 1;
    }
  } catch (error) {
    if (command === 'hook') { console.error(`POD护栏运行失败，未授予任何权限：${error.message}`); process.exitCode = 2; }
    else { console.log(JSON.stringify({ schema: SCHEMA, status: 'blocked', mechanical_pass: false, error: error.message, limits: LIMITS }, null, 2)); process.exitCode = 1; }
  }
}
