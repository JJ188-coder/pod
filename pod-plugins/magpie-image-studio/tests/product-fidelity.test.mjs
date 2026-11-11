import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { compileSpec, createReview, reviewPending, verify } from "../scripts/product-fidelity.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "product-fidelity-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const rehashManifest = (manifest) => {
  const body = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "_product_fidelity"));
  manifest._product_fidelity.manifest_sha256 = sha(Buffer.from(JSON.stringify(body)));
  return manifest;
};
const put = (name, bytes) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
};

function fixture({ category = "garment", roles = ["product", "artwork", "person", "scene"] } = {}) {
  const factsSource = put(`facts-${category}-${roles.length}.json`, Buffer.from('{"origin":"approved source"}\n'));
  const refs = roles.map((role, index) => {
    const file = put(`ref-${category}-${roles.length}-${index}.png`, Buffer.concat([png, Buffer.from([index])]));
    return {
      role,
      file,
      ...(role === "product" || role === "artwork" ? { product_id: "TS-01" } : {}),
      ...(role === "product" ? { color: "Navy", ...(category === "phonecase" ? { model: "Pixel 9 Pro" } : {}) } : {}),
    };
  });
  const output = path.join(root, `output-${category}-${roles.length}.png`);
  const spec = {
    batch_id: `batch-${category}-${roles.length}`,
    products: [{ id: "TS-01", color: "Navy", category, ...(category === "phonecase" ? { model: "Pixel 9 Pro" } : {}), facts: ["Confirmed blue cotton jersey"], facts_source: factsSource, refs }],
    shots: [{ request_id: `shot-${category}-${roles.length}`, product_id: "TS-01", color: "Navy", changes: ["background", "lighting"], scene: "quiet studio", output_file: output }],
  };
  const specFile = put(`spec-${category}-${roles.length}.json`, Buffer.from(`${JSON.stringify(spec, null, 2)}\n`));
  return { spec, specFile, factsSource, refs, output };
}

test("compiles a batch-compatible product lock and binds manifest/fact/reference hashes", () => {
  const f = fixture();
  const { manifest } = compileSpec(f.specFile);
  const body = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "_product_fidelity"));
  assert.equal(manifest._product_fidelity.manifest_sha256, sha(Buffer.from(JSON.stringify(body))));
  const [job] = manifest.jobs;
  assert.equal(job.n, 1);
  assert.deepEqual(job.reference_images, job.product_lock.refs.map((ref) => ref.file));
  assert.deepEqual(job.product_lock.refs.map((ref) => ref.role), ["product", "artwork", "person", "scene"]);
  assert.equal(job.product_lock.facts_sha256, sha(fs.readFileSync(f.factsSource)));
  assert.equal(job.facts_source_sha256, job.product_lock.facts_sha256);
  assert.equal(job.product_lock.review_status, "pending");
  assert.match(job.prompt, /artwork reference\(s\) describe artwork only and never replace the product/);
  assert.match(job.prompt, /Never invent or reveal a back side/);
});

test("rejects a compiled output that collides with its facts source", () => {
  const f = fixture({ roles: ["product"] });
  f.factsSource = put("facts-source.png", png);
  f.spec.products[0].facts_source = f.factsSource;
  f.specFile = put("facts-source-output-spec.json", Buffer.from(JSON.stringify(f.spec)));
  const manifest = compileSpec(f.specFile).manifest;
  manifest.jobs[0].output_file = fs.realpathSync(f.factsSource);
  rehashManifest(manifest);
  const manifestFile = put("compiled-facts-output-overlap.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const reportFile = put("facts-output-overlap-report.json", Buffer.from("{}\n"));
  const result = verify({ manifestFile, reportFile });
  assert.equal(result.valid_integrity, false);
  assert.match(result.errors[0], /输出路径与输入路径冲突/);
});

test("requires an explicit model and matching real product reference for phone cases", () => {
  const f = fixture({ category: "phonecase" });
  assert.equal(compileSpec(f.specFile).manifest.jobs[0].product_lock.model, "Pixel 9 Pro");
  const altered = { ...f.spec, products: [{ ...f.spec.products[0], refs: f.spec.products[0].refs.map((ref) => ref.role === "product" ? { ...ref, model: "iPhone 18" } : ref) }] };
  const bad = put("phone-model-mismatch.json", Buffer.from(JSON.stringify(altered)));
  assert.throws(() => compileSpec(bad), /必须标明并匹配型号/);
  const missing = { ...f.spec, products: [{ ...f.spec.products[0], model: undefined }] };
  const noModel = put("phone-model-missing.json", Buffer.from(JSON.stringify(missing)));
  assert.throws(() => compileSpec(noModel), /必须提供真实 model/);
});

test("does not accept artwork/person/scene or a relabeled artwork file as the product reference", () => {
  const f = fixture({ roles: ["artwork", "person", "scene"] });
  assert.throws(() => compileSpec(f.specFile), /至少需要一张同款同色真实 product 参考图/);
  const dualRole = fixture({ roles: ["product", "artwork", "scene"] });
  const sameFile = dualRole.refs.find((ref) => ref.role === "product").file;
  dualRole.spec.products[0].refs.find((ref) => ref.role === "artwork").file = sameFile;
  const relabeled = put("same-artwork-and-product.json", Buffer.from(JSON.stringify(dualRole.spec)));
  assert.throws(() => compileSpec(relabeled), /必须是独立的实物商品图/);
});

test("sorts shuffled references by role while retaining order within repeated roles", () => {
  const f = fixture({ roles: ["scene", "person", "product", "artwork", "product", "scene", "artwork", "person"] });
  const job = compileSpec(f.specFile).manifest.jobs[0];
  assert.deepEqual(job.product_lock.refs.map((ref) => ref.role), ["product", "product", "artwork", "artwork", "person", "person", "scene", "scene"]);
  assert.deepEqual(job.reference_images, [2, 4, 3, 6, 1, 7, 0, 5].map((index) => fs.realpathSync(f.refs[index].file)));
});

test("review-pending stays pending; evidence binds report, refs and output; changed output invalidates it", () => {
  const f = fixture();
  const { manifest } = compileSpec(f.specFile);
  const manifestFile = put("compiled.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  fs.writeFileSync(f.output, png);
  const reportFile = put("batch-report.json", Buffer.from(`${JSON.stringify({
    batch_id: manifest.batch_id,
    jobs: [{ request_id: manifest.jobs[0].request_id, output_file: f.output, state: "saved", sha256: sha(png) }],
  }, null, 2)}\n`));
  const pending = reviewPending({ manifestFile, reportFile });
  assert.equal(pending.review_status, "pending");
  assert.equal(pending.shots[0].checks.every((check) => check.result === "pending"), true);
  assert.equal(verify({ manifestFile, reportFile }).review_status, "pending");

  const changedRef = fixture({ roles: ["product", "scene"] });
  const changedManifest = compileSpec(changedRef.specFile).manifest;
  const changedManifestFile = put("compiled-changed-ref.json", Buffer.from(`${JSON.stringify(changedManifest, null, 2)}\n`));
  const changedRefReport = put("batch-report-changed-ref.json", Buffer.from(`${JSON.stringify({
    batch_id: changedManifest.batch_id,
    jobs: [{ request_id: changedManifest.jobs[0].request_id, output_file: changedRef.output, state: "saved", sha256: sha(png) }],
  }, null, 2)}\n`));
  fs.writeFileSync(changedRef.output, png);
  fs.appendFileSync(changedRef.refs[0].file, Buffer.from([0x01]));
  const changedRefSnapshot = reviewPending({ manifestFile: changedManifestFile, reportFile: changedRefReport }).shots[0];
  assert.equal(changedRefSnapshot.refs[0].unchanged, false);
  assert.equal(changedRefSnapshot.output_ready_for_visual_review, false);

  const noHashReport = put("batch-report-no-hash.json", Buffer.from(`${JSON.stringify({
    batch_id: manifest.batch_id,
    jobs: [{ request_id: manifest.jobs[0].request_id, output_file: f.output, state: "saved" }],
  }, null, 2)}\n`));
  assert.equal(reviewPending({ manifestFile, reportFile: noHashReport }).shots[0].output_ready_for_visual_review, false);

  const evidenceFile = put("evidence.json", Buffer.from(`${JSON.stringify({
    reviewer: "local visual reviewer",
    method: "Compared output against product reference and confirmed fact source",
    checked_at: "2026-11-11T10:00:00Z",
    shots: [{
      request_id: manifest.jobs[0].request_id,
      checks: Object.fromEntries(["款型", "颜色", "材质", "结构", "印花", "型号"].map((item) => [item, { result: "pass", evidence: `Visually compared ${item}` }])),
    }],
  }, null, 2)}\n`));
  const reviewFile = put("review.json", Buffer.from(`${JSON.stringify(createReview({ manifestFile, reportFile, evidenceFile }), null, 2)}\n`));
  assert.equal(verify({ manifestFile, reportFile, reviewFile }).review_status, "reviewed_pass");
  fs.appendFileSync(f.output, Buffer.from([0x01]));
  const changed = verify({ manifestFile, reportFile, reviewFile });
  assert.equal(changed.valid_integrity, false);
  assert.equal(changed.review_status, "stale");
});
