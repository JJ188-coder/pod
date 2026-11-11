#!/usr/bin/env node
/** Pure-local compiler and evidence recorder for product-locked image batches. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const POLICY_VERSION = 1;
const ROLES = new Set(["product", "artwork", "person", "scene"]);
const CHANGES = new Set(["background", "lighting", "pose", "camera"]);
const CATEGORIES = new Set(["garment", "phonecase", "other"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto", "1:1", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9"]);
const QUALITIES = new Set(["low", "medium", "high", "auto", "xhigh", "max"]);
const CHECKS = ["款型", "颜色", "材质", "结构", "印花", "型号"];
const REPORT_SUCCESS = new Set(["saved", "reused", "reused_existing"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA_RE = /^[a-f0-9]{64}$/;

function demand(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  demand(value !== null && typeof value === "object" && !Array.isArray(value), `${label} 必须为对象`);
  return value;
}

function keysOnly(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  demand(extra.length === 0, `${label} 存在未支持字段：${extra.join(", ")}`);
}

function text(value, label, max = 2000) {
  demand(typeof value === "string" && value.trim().length > 0, `${label} 必须为非空文本`);
  const result = value.trim();
  demand(Array.from(result).length <= max, `${label} 超过 ${max} 字符`);
  return result;
}

function safeId(value, label) {
  const id = text(value, label, 200);
  demand(ID_RE.test(id) && !id.includes(".."), `${label} 必须为安全批次标识（1–200位字母数字、点、横线或下划线）`);
  return id;
}

function isPresent(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function canonicalInput(value, label) {
  const file = text(value, label, 4096);
  demand(path.isAbsolute(file) && file === file.trim() && !file.includes("\0"), `${label} 必须为无空白首尾的绝对路径`);
  let canonical;
  try { canonical = fs.realpathSync(file); } catch { throw new Error(`${label} 不存在或无法解析：${file}`); }
  const stat = fs.statSync(canonical);
  demand(stat.isFile(), `${label} 必须指向普通文件：${canonical}`);
  return canonical;
}

/** Canonicalize a target without creating it; missing parent directories are allowed for image jobs. */
function canonicalTarget(value, label, { mustBeNew = false } = {}) {
  const file = text(value, label, 4096);
  demand(path.isAbsolute(file) && file === file.trim() && !file.includes("\0"), `${label} 必须为无空白首尾的绝对路径`);
  const resolved = path.resolve(file);
  if (isPresent(resolved)) {
    demand(!mustBeNew, `${label} 已存在，拒绝覆盖：${resolved}`);
    const stat = fs.lstatSync(resolved);
    demand(stat.isFile() && !stat.isSymbolicLink(), `${label} 已存在但不是普通文件：${resolved}`);
    return fs.realpathSync(resolved);
  }
  const remainder = [];
  let ancestor = resolved;
  while (!isPresent(ancestor)) {
    const parent = path.dirname(ancestor);
    demand(parent !== ancestor, `${label} 无法解析：${file}`);
    remainder.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  demand(fs.statSync(ancestor).isDirectory(), `${label} 的现存父路径不是目录：${ancestor}`);
  return path.join(fs.realpathSync(ancestor), ...remainder);
}

function requireNewJsonTarget(value, label) {
  const target = canonicalTarget(value, label, { mustBeNew: true });
  const parent = path.dirname(target);
  demand(fs.existsSync(parent) && fs.statSync(parent).isDirectory(), `${label} 的父目录必须已存在：${parent}`);
  fs.accessSync(parent, fs.constants.W_OK);
  return target;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function digestJson(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function manifestDigest(manifest) {
  const { _product_fidelity: _ignored, ...base } = manifest;
  return digestJson(base);
}

function readJson(file, label) {
  const canonical = canonicalInput(file, label);
  try { return { canonical, raw: fs.readFileSync(canonical), value: JSON.parse(fs.readFileSync(canonical, "utf8")) }; }
  catch (error) { throw new Error(`${label} JSON 无法读取：${error.message}`); }
}

function isImage(bytes) {
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    || bytes.subarray(0, 3).toString("ascii") === "GIF";
}

function imageRef(ref, product, index, inputs) {
  object(ref, `products[${product.index}].refs[${index}]`);
  keysOnly(ref, ["role", "file", "sha256", "product_id", "color", "model"], `products[${product.index}].refs[${index}]`);
  demand(ROLES.has(ref.role), `products[${product.index}].refs[${index}].role 必须是 product/artwork/person/scene`);
  const file = canonicalInput(ref.file, `products[${product.index}].refs[${index}].file`);
  const bytes = fs.readFileSync(file);
  demand(isImage(bytes), `参考图不是可识别的 PNG/JPEG/WEBP/GIF：${file}`);
  const digest = sha256Bytes(bytes);
  if (ref.sha256 !== undefined) {
    demand(typeof ref.sha256 === "string" && SHA_RE.test(ref.sha256) && ref.sha256 === digest, `参考图 SHA256 不匹配：${file}`);
  }
  inputs.add(file.toLowerCase());
  if (ref.role === "product" || ref.role === "artwork") {
    demand(typeof ref.product_id === "string" && ref.product_id.trim() === product.id, `${ref.role} 参考图的 product_id 必须等于产品 id ${product.id}`);
  }
  if (ref.role === "product") {
    demand(typeof ref.color === "string" && ref.color.trim() === product.color, `product 参考图的 color 必须与商品原色精确相同：${product.color}`);
    if (product.category === "phonecase") {
      demand(typeof ref.model === "string" && ref.model.trim() === product.model, `手机壳 product 参考图必须标明并匹配型号 ${product.model}`);
    }
  }
  return { role: ref.role, file, sha256: digest };
}

function factsDigest(product) {
  return product.facts_source_sha256;
}

function promptFor(product, refs, shot) {
  const roles = refs.map((ref, index) => `${index + 1}=${ref.role}`).join(", ");
  const changeList = shot.changes.length ? shot.changes.join(", ") : "none";
  const lines = [
    "PRODUCT-LOCKED IMAGE EDIT. Make one image based on the attached references; do not create a different product.",
    `Attachment order and roles: ${roles}. Product reference(s) are the only source of product appearance; artwork reference(s) describe artwork only and never replace the product; person reference(s) describe the person only; scene reference(s) describe the setting only.`,
    `Locked product identity: ${JSON.stringify(product.id)}; category: ${product.category}; exact color: ${JSON.stringify(product.color)}; model: ${JSON.stringify(product.model ?? "not specified; do not guess or add a model")}.`,
    `Confirmed product facts only: ${JSON.stringify(product.facts)}. Preserve the referenced product's visible material, silhouette, shape, proportions, construction, artwork, text and logos. These are not creative variation options. Do not invent, remove, recolor, redraw, retype, mirror or reposition any artwork/text/logo. Do not claim unlisted facts.`,
    `Only these presentation aspects may change: ${changeList}. Keep every other presentation and all product properties unchanged.`,
    "Never invent or reveal a back side, interior, lining, hidden surface or detail that is not directly visible in a product reference. If a requested view would expose an unreferenced surface, frame it out; do not fabricate it.",
    "Scene/composition notes are context only and must not redefine the product:",
  ];
  if (shot.scene) lines.push(`Scene: ${JSON.stringify(shot.scene)}`);
  if (shot.composition) lines.push(`Composition: ${JSON.stringify(shot.composition)}`);
  lines.push("Prompt adherence does not guarantee pixel-exact artwork. If exact print pixels/placement matter, use deterministic local compositing on an approved garment flat template; never treat a generated mockup as product-truth evidence.");
  const prompt = lines.join("\n");
  demand(Array.from(prompt).length <= 8000, `生成提示词超过 image2 的 8000 字符上限：${shot.request_id}`);
  return prompt;
}

export function compileSpec(specFile) {
  const { canonical: sourceSpec, raw, value: specValue } = readJson(specFile, "--spec");
  const spec = object(specValue, "spec");
  keysOnly(spec, ["batch_id", "size", "quality", "products", "shots"], "spec");
  const batchId = safeId(spec.batch_id, "batch_id");
  if (spec.size !== undefined) demand(typeof spec.size === "string" && SIZES.has(spec.size), "spec.size 不受 image2 批次 CLI 支持");
  if (spec.quality !== undefined) demand(typeof spec.quality === "string" && QUALITIES.has(spec.quality), "spec.quality 不受 image2 批次 CLI 支持");
  demand(Array.isArray(spec.products) && spec.products.length > 0, "products 必须为非空数组");
  demand(Array.isArray(spec.shots) && spec.shots.length > 0, "shots 必须为非空数组");

  const inputs = new Set([sourceSpec.toLowerCase()]);
  const products = new Map();
  spec.products.forEach((rawProduct, index) => {
    const source = object(rawProduct, `products[${index}]`);
    keysOnly(source, ["id", "color", "category", "model", "facts", "facts_source", "refs"], `products[${index}]`);
    const id = text(source.id, `products[${index}].id`, 200);
    const color = text(source.color, `products[${index}].color`, 100);
    const category = source.category === undefined ? "other" : source.category;
    demand(CATEGORIES.has(category), `products[${index}].category 必须是 garment/phonecase/other`);
    const model = source.model === undefined || source.model === null ? null : text(source.model, `products[${index}].model`, 200);
    if (category === "phonecase") demand(model, `products[${index}] 是手机壳，必须提供真实 model`);
    demand(Array.isArray(source.facts) && source.facts.length > 0, `products[${index}].facts 必须含至少一条已确认事实`);
    const facts = source.facts.map((fact, factIndex) => text(fact, `products[${index}].facts[${factIndex}]`, 1000));
    const factsSource = canonicalInput(source.facts_source, `products[${index}].facts_source`);
    const factsSourceSha = sha256File(factsSource);
    inputs.add(factsSource.toLowerCase());
    demand(Array.isArray(source.refs) && source.refs.length > 0 && source.refs.length <= 8, `products[${index}].refs 必须为1–8张本地参考图`);
    const product = { index, id, color, category, model, facts, facts_source: factsSource, facts_source_sha256: factsSourceSha };
    const refs = source.refs.map((ref, refIndex) => imageRef(ref, product, refIndex, inputs));
    const roleOrder = new Map([["product", 0], ["artwork", 1], ["person", 2], ["scene", 3]]);
    refs.sort((a, b) => roleOrder.get(a.role) - roleOrder.get(b.role));
    const productRefs = refs.filter((ref) => ref.role === "product");
    const artworkRefs = refs.filter((ref) => ref.role === "artwork");
    demand(productRefs.length > 0, `产品 ${id}/${color} 至少需要一张同款同色真实 product 参考图`);
    demand(productRefs.every((productRef) => artworkRefs.every((artworkRef) => productRef.file !== artworkRef.file && productRef.sha256 !== artworkRef.sha256)), `产品 ${id}/${color} 的 product 参考必须是独立的实物商品图，不能把 artwork 文件改标为 product`);
    const key = `${id}\0${color}`;
    demand(!products.has(key), `products 中 id/color 重复：${id}/${color}`);
    product.refs = refs;
    product.facts_sha256 = factsDigest(product);
    products.set(key, product);
  });

  const ids = new Set();
  const outputPaths = new Set();
  const jobs = spec.shots.map((rawShot, index) => {
    const shot = object(rawShot, `shots[${index}]`);
    keysOnly(shot, ["request_id", "product_id", "color", "changes", "status", "scene", "composition", "output_file", "size", "quality"], `shots[${index}]`);
    const requestId = safeId(shot.request_id, `shots[${index}].request_id`);
    demand(!ids.has(requestId), `request_id 重复：${requestId}`);
    ids.add(requestId);
    demand(shot.status === undefined || shot.status === "pending", `shots[${index}].status 只能省略或为 pending；不得在编译时标记已审/通过`);
    const productId = text(shot.product_id, `shots[${index}].product_id`, 200);
    const color = text(shot.color, `shots[${index}].color`, 100);
    const product = products.get(`${productId}\0${color}`);
    demand(product, `shots[${index}] 未匹配到产品/原色：${productId}/${color}`);
    demand(Array.isArray(shot.changes) && shot.changes.every((change) => CHANGES.has(change)), `shots[${index}].changes 只能包含 background/lighting/pose/camera`);
    demand(new Set(shot.changes).size === shot.changes.length, `shots[${index}].changes 不可重复`);
    const scene = shot.scene === undefined ? "" : text(shot.scene, `shots[${index}].scene`, 500);
    const composition = shot.composition === undefined ? "" : text(shot.composition, `shots[${index}].composition`, 500);
    const file = canonicalTarget(shot.output_file, `shots[${index}].output_file`, { mustBeNew: true });
    demand(IMAGE_EXTS.has(path.extname(file).toLowerCase()), `output_file 必须使用图片扩展名：${file}`);
    const outputKey = file.toLowerCase();
    demand(!outputPaths.has(outputKey), `output_file 重复：${file}`);
    outputPaths.add(outputKey);
    demand(!inputs.has(file.toLowerCase()), `output_file 不得覆盖 spec、事实来源或参考图：${file}`);
    const size = shot.size ?? spec.size;
    const quality = shot.quality ?? spec.quality;
    if (size !== undefined) demand(typeof size === "string" && SIZES.has(size), `shots[${index}].size 不受 image2 批次 CLI 支持`);
    if (quality !== undefined) demand(typeof quality === "string" && QUALITIES.has(quality), `shots[${index}].quality 不受 image2 批次 CLI 支持`);
    const prompt = promptFor(product, product.refs, { request_id: requestId, changes: shot.changes, scene, composition });
    const job = {
      request_id: requestId,
      prompt,
      reference_images: product.refs.map((ref) => ref.file),
      n: 1,
      ...(size === undefined ? {} : { size }),
      ...(quality === undefined ? {} : { quality }),
      output_file: file,
      product_lock: {
        product_id: product.id,
        color: product.color,
        model: product.model,
        refs: product.refs.map(({ role, file: refFile, sha256 }) => ({ role, file: refFile, sha256 })),
        facts_sha256: product.facts_sha256,
        review_status: "pending",
        policy_version: POLICY_VERSION,
      },
      product_category: product.category,
      product_facts: product.facts,
      facts_source: product.facts_source,
      facts_source_sha256: product.facts_source_sha256,
    };
    return job;
  });

  const manifest = {
    batch_id: batchId,
    jobs,
    local_files: [],
    _product_fidelity: {
      policy_version: POLICY_VERSION,
      source_spec: sourceSpec,
      source_spec_sha256: sha256Bytes(raw),
    },
  };
  manifest._product_fidelity.manifest_sha256 = manifestDigest(manifest);
  return { manifest, source_spec: sourceSpec, inputs: [...inputs], outputs: [...outputPaths] };
}

function readCompiled(manifestFile) {
  const { canonical, raw, value } = readJson(manifestFile, "--manifest");
  const manifest = object(value, "compiled manifest");
  demand(ID_RE.test(manifest.batch_id) && !manifest.batch_id.includes(".."), "compiled manifest.batch_id 非法");
  demand(Array.isArray(manifest.jobs) && manifest.jobs.length > 0, "compiled manifest.jobs 必须为非空数组");
  demand(Array.isArray(manifest.local_files) && manifest.local_files.length === 0, "product-fidelity manifest 不接受 local_files；本工具不复制或改动素材");
  const meta = object(manifest._product_fidelity, "_product_fidelity");
  demand(meta.policy_version === POLICY_VERSION, "不支持的 product fidelity policy_version");
  const sourceSpec = canonicalInput(meta.source_spec, "_product_fidelity.source_spec");
  demand(sourceSpec === meta.source_spec && SHA_RE.test(meta.source_spec_sha256), "source spec 路径或 SHA 格式非法");
  demand(sha256File(sourceSpec) === meta.source_spec_sha256, "source spec 已变化；需重新编译并重新审核");
  demand(SHA_RE.test(meta.manifest_sha256) && manifestDigest(manifest) === meta.manifest_sha256, "compiled manifest 内容哈希不匹配");
  const inputSet = new Set([canonical.toLowerCase(), sourceSpec.toLowerCase()]);
  const ids = new Set();
  const outputs = new Set();
  const jobs = manifest.jobs.map((jobValue, index) => {
    const job = object(jobValue, `jobs[${index}]`);
    keysOnly(job, ["request_id", "prompt", "reference_images", "n", "size", "quality", "output_file", "product_lock", "product_category", "product_facts", "facts_source", "facts_source_sha256"], `jobs[${index}]`);
    const requestId = safeId(job.request_id, `jobs[${index}].request_id`);
    demand(!ids.has(requestId), `compiled manifest request_id 重复：${requestId}`);
    ids.add(requestId);
    demand(typeof job.prompt === "string" && job.prompt.length > 0 && Array.from(job.prompt).length <= 8000, `jobs[${index}].prompt 非法`);
    demand(job.n === 1, `jobs[${index}].n 必须为1`);
    if (job.size !== undefined) demand(typeof job.size === "string" && SIZES.has(job.size), `jobs[${index}].size 非法`);
    if (job.quality !== undefined) demand(typeof job.quality === "string" && QUALITIES.has(job.quality), `jobs[${index}].quality 非法`);
    const lock = object(job.product_lock, `jobs[${index}].product_lock`);
    keysOnly(lock, ["product_id", "color", "model", "refs", "facts_sha256", "review_status", "policy_version"], `jobs[${index}].product_lock`);
    demand(text(lock.product_id, `jobs[${index}].product_lock.product_id`) === lock.product_id, `jobs[${index}].product_lock.product_id 非法`);
    demand(text(lock.color, `jobs[${index}].product_lock.color`) === lock.color, `jobs[${index}].product_lock.color 非法`);
    demand(lock.model === null || (typeof lock.model === "string" && lock.model.trim() === lock.model), `jobs[${index}].product_lock.model 非法`);
    demand(CATEGORIES.has(job.product_category), `jobs[${index}].product_category 非法`);
    if (job.product_category === "phonecase") demand(typeof lock.model === "string" && lock.model.length > 0, `手机壳必须锁定型号`);
    demand(Array.isArray(job.product_facts) && job.product_facts.length > 0 && job.product_facts.every((fact) => typeof fact === "string" && fact.trim()), `jobs[${index}].product_facts 非法`);
    const factsSource = canonicalInput(job.facts_source, `jobs[${index}].facts_source`);
    inputSet.add(factsSource.toLowerCase());
    demand(factsSource === job.facts_source && SHA_RE.test(job.facts_source_sha256), `jobs[${index}].facts_source 路径或 SHA 格式非法`);
    demand(sha256File(factsSource) === job.facts_source_sha256, `事实来源已变化：${factsSource}`);
    const refs = lock.refs;
    demand(Array.isArray(refs) && refs.length > 0 && refs.length <= 8 && refs.every((ref) => ref && typeof ref === "object" && !Array.isArray(ref)), `jobs[${index}].product_lock.refs 非法`);
    let productRefFound = false;
    for (const [refIndex, ref] of refs.entries()) {
      keysOnly(ref, ["role", "file", "sha256"], `jobs[${index}].product_lock.refs[${refIndex}]`);
      demand(ROLES.has(ref.role) && SHA_RE.test(ref.sha256), `jobs[${index}] 参考图元数据非法`);
      const refFile = canonicalInput(ref.file, `jobs[${index}].product_lock.refs[${refIndex}].file`);
      demand(refFile === ref.file, `参考图路径不是 canonical path：${ref.file}`);
      const bytes = fs.readFileSync(refFile);
      demand(isImage(bytes), `参考图格式不可识别：${refFile}`);
      inputSet.add(refFile.toLowerCase());
      if (ref.role === "product") productRefFound = true;
    }
    demand(productRefFound, `jobs[${index}] 缺少 product 参考图`);
    demand(Array.isArray(job.reference_images) && job.reference_images.length === refs.length && job.reference_images.every((file, refIndex) => file === refs[refIndex].file), `jobs[${index}].reference_images 与锁定参考图顺序不一致`);
    demand(lock.review_status === "pending" && lock.policy_version === POLICY_VERSION, `jobs[${index}] 不允许编译时写入审核状态`);
    demand(SHA_RE.test(lock.facts_sha256), `jobs[${index}].product_lock.facts_sha256 格式非法`);
    const factsHash = sha256File(factsSource);
    demand(factsHash === lock.facts_sha256 && factsHash === job.facts_source_sha256, `jobs[${index}] 商品事实来源 SHA256 与 product_lock.facts_sha256 不匹配`);
    const outputFile = canonicalTarget(job.output_file, `jobs[${index}].output_file`);
    demand(outputFile === job.output_file && IMAGE_EXTS.has(path.extname(outputFile).toLowerCase()), `jobs[${index}].output_file 路径或扩展名非法`);
    const outputKey = outputFile.toLowerCase();
    demand(!outputs.has(outputKey), `compiled manifest output_file 重复：${outputFile}`);
    outputs.add(outputKey);
    return { job, lock, output_file: outputFile };
  });
  for (const output of outputs) demand(!inputSet.has(output), `输出路径与输入路径冲突：${output}`);
  return { canonical, raw, manifest, jobs, inputSet, sha256: sha256Bytes(raw) };
}

function readReport(manifestInfo, reportFile) {
  const { canonical, raw, value } = readJson(reportFile, "--report");
  const report = object(value, "batch report");
  demand(report.batch_id === manifestInfo.manifest.batch_id, "batch report.batch_id 与 compiled manifest 不匹配");
  demand(Array.isArray(report.jobs), "batch report.jobs 必须为数组");
  const byId = new Map();
  for (const [index, entryValue] of report.jobs.entries()) {
    const entry = object(entryValue, `report.jobs[${index}]`);
    demand(typeof entry.request_id === "string" && !byId.has(entry.request_id), `report.jobs[${index}] request_id 缺失或重复`);
    byId.set(entry.request_id, entry);
  }
  return { canonical, raw, report, byId, sha256: sha256Bytes(raw) };
}

function reportSnapshot(manifestInfo, reportInfo) {
  return manifestInfo.jobs.map(({ job, lock, output_file }) => {
    const entry = reportInfo.byId.get(job.request_id);
    let reportState = entry?.state ?? "missing_report_entry";
    let targetMatches = false;
    if (entry?.output_file && path.isAbsolute(entry.output_file)) {
      try { targetMatches = canonicalTarget(entry.output_file, `report.jobs[${job.request_id}].output_file`) === output_file; } catch { targetMatches = false; }
    }
    const exists = isPresent(output_file);
    let outputSha = null;
    let outputRegular = false;
    if (exists) {
      const stat = fs.lstatSync(output_file);
      outputRegular = stat.isFile() && !stat.isSymbolicLink();
      if (outputRegular) outputSha = sha256File(output_file);
    }
    const reportSha = entry?.sha256 ?? entry?.output_sha256 ?? (Array.isArray(entry?.files) ? entry.files.find((file) => file.ordinal === 1)?.sha256 : null) ?? null;
    const shaMatches = typeof reportSha === "string" && SHA_RE.test(reportSha) && reportSha === outputSha;
    const refs = lock.refs.map((ref) => {
      const currentSha = sha256File(ref.file);
      return { ...ref, current_sha256: currentSha, unchanged: currentSha === ref.sha256 };
    });
    const refsUnchanged = refs.every((ref) => ref.unchanged);
    const ready = REPORT_SUCCESS.has(reportState) && targetMatches && outputRegular && shaMatches && refsUnchanged;
    return {
      request_id: job.request_id,
      product_lock: lock,
      product_category: job.product_category,
      product_facts: job.product_facts,
      facts_source: job.facts_source,
      facts_source_sha256: job.facts_source_sha256,
      output_file,
      report_state: reportState,
      output_ready_for_visual_review: ready,
      output_sha256: outputSha,
      checks: CHECKS.map((item) => ({ item, result: "pending", evidence: null })),
      check_basis: {
        product_id: lock.product_id,
        category: job.product_category,
        color: lock.color,
        model: lock.model ?? "未声明；不可猜测或套用固定型号",
        explicit_facts: job.product_facts,
        rule: "逐项人工对照 product 参考图与上述已确认事实；事实未覆盖或表面不可见时记录 unknown，不得凭生成图本身补证。",
      },
      refs,
    };
  });
}

export function reviewPending({ manifestFile, reportFile }) {
  const manifestInfo = readCompiled(manifestFile);
  const reportInfo = readReport(manifestInfo, reportFile);
  return {
    batch_id: manifestInfo.manifest.batch_id,
    manifest_file: manifestInfo.canonical,
    manifest_sha256: manifestInfo.sha256,
    report_file: reportInfo.canonical,
    report_sha256: reportInfo.sha256,
    review_status: "pending",
    note: "这是待人工核对清单；参考图/文件哈希是完整性线索，不是视觉通过、人工批准或发布授权。",
    shots: reportSnapshot(manifestInfo, reportInfo),
  };
}

function meaningful(value, label) {
  const result = text(value, label, 1000);
  demand(!/^(?:unknown|pending|todo|tbd|n\/?a|not provided|未填写|待填写|未知)$/i.test(result), `${label} 不能是占位值`);
  return result;
}

function parseEvidence(evidencePath, expectedIds) {
  const { canonical, raw, value } = readJson(evidencePath, "--evidence");
  const evidence = object(value, "review evidence");
  keysOnly(evidence, ["reviewer", "source", "method", "checked_at", "shots"], "review evidence");
  const reviewer = evidence.reviewer === undefined ? null : meaningful(evidence.reviewer, "evidence.reviewer");
  const source = evidence.source === undefined ? null : meaningful(evidence.source, "evidence.source");
  demand(reviewer || source, "必须记录真实检查人 reviewer 或检查来源 source；不代填人类身份或授权");
  const method = meaningful(evidence.method, "evidence.method");
  demand(typeof evidence.checked_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(evidence.checked_at) && Number.isFinite(Date.parse(evidence.checked_at)), "evidence.checked_at 必须是实际检查时间的 ISO 8601 时间戳及时区");
  demand(Array.isArray(evidence.shots) && evidence.shots.length === expectedIds.length, "evidence.shots 必须逐一覆盖全部输出镜头");
  const byId = new Map();
  for (const [index, shotValue] of evidence.shots.entries()) {
    const shot = object(shotValue, `evidence.shots[${index}]`);
    keysOnly(shot, ["request_id", "checks", "notes"], `evidence.shots[${index}]`);
    const requestId = text(shot.request_id, `evidence.shots[${index}].request_id`, 200);
    demand(expectedIds.includes(requestId) && !byId.has(requestId), `evidence.shots[${index}].request_id 未知或重复`);
    const checks = object(shot.checks, `evidence.shots[${index}].checks`);
    keysOnly(checks, CHECKS, `evidence.shots[${index}].checks`);
    const normalizedChecks = {};
    for (const item of CHECKS) {
      const check = object(checks[item], `evidence.${requestId}.checks.${item}`);
      keysOnly(check, ["result", "evidence"], `evidence.${requestId}.checks.${item}`);
      demand(["pass", "fail", "unknown"].includes(check.result), `evidence.${requestId}.${item}.result 必须是 pass/fail/unknown`);
      normalizedChecks[item] = {
        result: check.result,
        evidence: meaningful(check.evidence, `evidence.${requestId}.${item}.evidence`),
      };
    }
    byId.set(requestId, {
      request_id: requestId,
      checks: normalizedChecks,
      ...(shot.notes === undefined ? {} : { notes: meaningful(shot.notes, `evidence.${requestId}.notes`) }),
    });
  }
  demand(expectedIds.every((id) => byId.has(id)), "evidence 未覆盖全部镜头");
  return { canonical, raw, reviewer, source, method, checked_at: evidence.checked_at, shots: byId };
}

function derivedStatus(evidence) {
  const results = [...evidence.shots.values()].flatMap((shot) => CHECKS.map((item) => shot.checks[item].result));
  if (results.includes("fail")) return "reviewed_fail";
  if (results.includes("unknown")) return "review_pending";
  return "reviewed_pass";
}

function reviewRecord(manifestInfo, reportInfo, evidencePath) {
  const evidence = parseEvidence(evidencePath, manifestInfo.jobs.map(({ job }) => job.request_id));
  const snapshots = reportSnapshot(manifestInfo, reportInfo);
  const notReady = snapshots.filter((shot) => !shot.output_ready_for_visual_review);
  demand(notReady.length === 0, `尚有输出未能从真实批次报告核对或文件未保存：${notReady.map((shot) => `${shot.request_id}(${shot.report_state})`).join(", ")}`);
  const reviewStatus = derivedStatus(evidence);
  return {
    record_type: "product_fidelity_review",
    policy_version: POLICY_VERSION,
    batch_id: manifestInfo.manifest.batch_id,
    manifest_file: manifestInfo.canonical,
    manifest_sha256: manifestInfo.sha256,
    report_file: reportInfo.canonical,
    report_sha256: reportInfo.sha256,
    evidence_file: evidence.canonical,
    evidence_sha256: sha256Bytes(evidence.raw),
    reviewer: evidence.reviewer,
    source: evidence.source,
    method: evidence.method,
    checked_at: evidence.checked_at,
    recorded_at: new Date().toISOString(),
    review_status: reviewStatus,
    note: "记录来自调用者提供的人工检查证据；本地程序未验证检查人身份、视觉结论或发布授权。任何输入、证据或输出变化都会使本记录失效。",
    jobs: snapshots.map((snapshot) => {
      const job = manifestInfo.jobs.find((item) => item.job.request_id === snapshot.request_id);
      const supplied = evidence.shots.get(snapshot.request_id);
      return {
        request_id: snapshot.request_id,
        product_lock_sha256: digestJson(job.lock),
        refs: job.lock.refs,
        output_file: snapshot.output_file,
        output_sha256: snapshot.output_sha256,
        checks: supplied.checks,
        ...(supplied.notes ? { notes: supplied.notes } : {}),
      };
    }),
  };
}

export function createReview({ manifestFile, reportFile, evidenceFile }) {
  const manifestInfo = readCompiled(manifestFile);
  const reportInfo = readReport(manifestInfo, reportFile);
  return reviewRecord(manifestInfo, reportInfo, evidenceFile);
}

function verifyReviewRecord(manifestInfo, reportInfo, reviewFile) {
  const { canonical, value: review } = readJson(reviewFile, "--review");
  object(review, "review record");
  demand(review.record_type === "product_fidelity_review" && review.policy_version === POLICY_VERSION, "review record 类型或版本不匹配");
  demand(review.batch_id === manifestInfo.manifest.batch_id, "review record batch_id 不匹配");
  demand(review.manifest_file === manifestInfo.canonical && review.manifest_sha256 === manifestInfo.sha256, "compiled manifest 已变化；旧审核记录失效");
  demand(review.report_file === reportInfo.canonical && review.report_sha256 === reportInfo.sha256, "batch report 已变化；旧审核记录失效");
  const expected = reviewRecord(manifestInfo, reportInfo, review.evidence_file);
  demand(review.evidence_sha256 === expected.evidence_sha256, "review evidence 文件已变化；旧审核记录失效");
  for (const key of ["reviewer", "source", "method", "checked_at", "review_status"]) {
    demand(review[key] === expected[key], `review record ${key} 与证据内容不一致`);
  }
  demand(JSON.stringify(canonicalValue(review.jobs)) === JSON.stringify(canonicalValue(expected.jobs)), "review record 的输出、参考图哈希或逐项结论与当前文件不一致");
  return { canonical, review_status: expected.review_status };
}

export function verify({ manifestFile, reportFile, reviewFile = null }) {
  try {
    const manifestInfo = readCompiled(manifestFile);
    const reportInfo = readReport(manifestInfo, reportFile);
    const snapshots = reportSnapshot(manifestInfo, reportInfo);
    if (!reviewFile) {
      return {
        valid_integrity: true,
        review_status: "pending",
        passed: false,
        batch_id: manifestInfo.manifest.batch_id,
        manifest_sha256: manifestInfo.sha256,
        report_sha256: reportInfo.sha256,
        shots: snapshots.map(({ request_id, report_state, output_file, output_sha256, output_ready_for_visual_review }) => ({ request_id, report_state, output_file, output_sha256, output_ready_for_visual_review })),
        note: "未提供人工检查记录；编译、报告或输出文件存在不等于商品保真通过。",
      };
    }
    const result = verifyReviewRecord(manifestInfo, reportInfo, reviewFile);
    return {
      valid_integrity: true,
      review_status: result.review_status,
      passed: result.review_status === "reviewed_pass",
      batch_id: manifestInfo.manifest.batch_id,
      manifest_sha256: manifestInfo.sha256,
      report_sha256: reportInfo.sha256,
      review_file: result.canonical,
      note: "通过只表示当前文件哈希与调用者提供的逐项检查记录一致，不是身份认证、签名或发布授权。",
    };
  } catch (error) {
    return { valid_integrity: false, review_status: "stale", passed: false, errors: [error.message], note: "完整性或证据核对失败；不得沿用旧的通过状态。" };
  }
}

function writeNewJson(fileValue, value, forbiddenPaths = []) {
  const file = requireNewJsonTarget(fileValue, "--out");
  const forbidden = new Set(forbiddenPaths.map((entry) => path.resolve(entry).toLowerCase()));
  demand(!forbidden.has(file.toLowerCase()), `--out 不得覆盖本次输入或商品输出：${file}`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, json, { flag: "wx", mode: 0o600 });
  return { file, sha256: sha256File(file) };
}

function parseArgs(argv) {
  const [command, ...tail] = argv;
  const args = {};
  for (let index = 0; index < tail.length; index += 1) {
    const flag = tail[index];
    demand(["--spec", "--manifest", "--report", "--evidence", "--review", "--out"].includes(flag), `未知参数：${flag}`);
    const value = tail[index + 1];
    demand(value && !value.startsWith("--"), `${flag} 缺少值`);
    demand(args[flag.slice(2)] === undefined, `${flag} 不可重复`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  demand(["compile", "review-pending", "review", "verify"].includes(command), "用法：product-fidelity.mjs compile|review-pending|review|verify [选项]");
  if (command === "compile") demand(args.spec, "compile 需要 --spec");
  if (command === "review-pending") demand(args.manifest && args.report, "review-pending 需要 --manifest 和 --report");
  if (command === "review") demand(args.manifest && args.report && args.evidence, "review 需要 --manifest、--report、--evidence");
  if (command === "verify") demand(args.manifest && args.report, "verify 需要 --manifest 和 --report");
  demand(command !== "compile" || !args.review, "compile 不接受 --review");
  demand(command !== "review" || !args.spec, "review 不接受 --spec");
  return { command, ...args };
}

export function runCli(argv) {
  const args = parseArgs(argv);
  if (args.command === "compile") {
    const compiled = compileSpec(args.spec);
    if (!args.out) return { stdout: `${JSON.stringify(compiled.manifest, null, 2)}\n`, exitCode: 0 };
    const forbidden = [...compiled.inputs, ...compiled.outputs];
    const written = writeNewJson(args.out, compiled.manifest, forbidden);
    return { stdout: `${JSON.stringify({ ok: true, batch_id: compiled.manifest.batch_id, manifest_file: written.file, manifest_sha256: written.sha256, jobs: compiled.manifest.jobs.length, review_status: "pending" }, null, 2)}\n`, exitCode: 0 };
  }
  if (args.command === "review-pending") return { stdout: `${JSON.stringify(reviewPending({ manifestFile: args.manifest, reportFile: args.report }), null, 2)}\n`, exitCode: 0 };
  if (args.command === "review") {
    const record = createReview({ manifestFile: args.manifest, reportFile: args.report, evidenceFile: args.evidence });
    if (!args.out) return { stdout: `${JSON.stringify(record, null, 2)}\n`, exitCode: 0 };
    const compiled = readCompiled(args.manifest);
    const report = readReport(compiled, args.report);
    const forbidden = [compiled.canonical, report.canonical, args.evidence, ...compiled.inputSet, ...compiled.jobs.map((entry) => entry.output_file)];
    const written = writeNewJson(args.out, record, forbidden);
    return { stdout: `${JSON.stringify({ ok: true, review_file: written.file, review_sha256: written.sha256, review_status: record.review_status, note: record.note }, null, 2)}\n`, exitCode: 0 };
  }
  const result = verify({ manifestFile: args.manifest, reportFile: args.report, reviewFile: args.review ?? null });
  return { stdout: `${JSON.stringify(result, null, 2)}\n`, exitCode: result.valid_integrity && result.passed ? 0 : 3 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
