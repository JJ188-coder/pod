import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileSpec, reviewPending, verify } from "../scripts/product-fidelity.mjs";

assert.equal(process.env.IMAGE_STUDIO_OFFLINE_TEST, "1", "Run through scripts/test-offline.mjs; do not run network tests bare");
const CLI = fileURLToPath(new URL("../scripts/batch-images.mjs", import.meta.url));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "product-image2-integration-"));
  const submissions = [];
  let queries = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v2/images/edits") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submissions.push({ body: Buffer.concat(chunks), headers: req.headers });
      res.end(JSON.stringify({ jobs: [{ id: `local-job-${submissions.length}`, status: "queued" }] }));
    } else if (req.method === "GET" && req.url.startsWith("/v2/jobs?")) {
      queries += 1;
      const ids = new URL(req.url, "http://127.0.0.1").searchParams.get("ids").split(",");
      res.end(JSON.stringify({ jobs: ids.map((id) => ({ id, status: "succeeded", result: { data: [{ b64_json: PNG.toString("base64") }] } })) }));
    } else {
      res.writeHead(404).end(JSON.stringify({ error: { message: "Unexpected offline test route" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };
  // These tiny fixtures exercise file binding, not real product appearance or visual acceptance.
  const image = (name) => write(`${name}.png`, Buffer.concat([PNG, Buffer.from(name)]));
  const facts = write("facts.json", { source: "Offline structural fixture only, not real product facts" });
  const env = { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "home/.config"),
    IMAGE2_BASE_URL: `http://127.0.0.1:${server.address().port}`, IMAGE2_API_KEY: "offline-test-key",
    IMAGE2_AUTH_SCHEME: "bearer", IMAGE2_DATA_DIR: path.join(dir, "image2"),
    MAGPIE_IMAGE_URL: "http://127.0.0.1:9/mcp/magpie/image", MAGPIE_IMAGE_DATA_DIR: path.join(dir, "magpie") };
  const run = (manifest, execute = true) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "--manifest", manifest, "--provider", "image2",
      "--concurrency", "1", "--max-wait-min", "0.02", "--poll-seconds", "0.2", ...(execute ? ["--run"] : [])],
    { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      try { resolve({ code, report: JSON.parse(stdout), stderr }); }
      catch { reject(Error(`Offline batch returned invalid JSON (${code}): ${stdout} ${stderr}`)); }
    });
  });
  const compile = (spec, name = "compiled.json") => {
    const source = write(`source-${name}`, spec);
    const { manifest } = compileSpec(source);
    return { manifest, manifestFile: write(name, manifest) };
  };
  return { dir, submissions, write, image, facts, run, compile, queries: () => queries };
}

test("two garment colors stay bound from compiler through image2 report and pending review", async (t) => {
  const f = await fixture(t);
  const colors = ["Navy", "White"];
  const products = colors.map((color) => ({ id: "HOODIE-TEST", color, category: "garment",
    facts: [`Offline fixture hoodie, color ${color}`], facts_source: f.facts,
    refs: [{ role: "product", file: f.image(`product-${color}`), product_id: "HOODIE-TEST", color }] }));
  const { manifest, manifestFile } = f.compile({ batch_id: "garment-colors", products,
    shots: colors.map((color) => ({ request_id: `hoodie-${color}`, product_id: "HOODIE-TEST", color,
      changes: ["background"], output_file: path.join(f.dir, `out-${color}.png`) })) });
  const precheck = await f.run(manifestFile, false);
  assert.equal(precheck.code, 0, JSON.stringify(precheck.report));
  assert.equal(precheck.report.ok, true);
  assert.equal(f.submissions.length, 0);
  const result = await f.run(manifestFile);
  assert.equal(result.code, 0, JSON.stringify(result.report));
  assert.equal(result.report.ok, true, JSON.stringify(result.report));
  assert.equal(f.submissions.length, 2);
  for (const [index, job] of manifest.jobs.entries()) {
    const entry = result.report.jobs.find((row) => row.request_id === job.request_id);
    assert.equal(entry.sha256, hash(PNG));
    assert.deepEqual(entry.product_lock, job.product_lock);
    assert.equal(entry.product_lock.review_status, "pending");
    assert.equal(fs.readFileSync(job.output_file).equals(PNG), true);
    const reference = fs.readFileSync(products[index].refs[0].file);
    assert.ok(f.submissions[index].body.indexOf(reference) >= 0);
    const other = fs.readFileSync(products[1 - index].refs[0].file);
    assert.equal(f.submissions[index].body.indexOf(other), -1);
  }
  const reportFile = f.write("report.json", result.report);
  const pending = reviewPending({ manifestFile, reportFile });
  assert.equal(pending.review_status, "pending");
  assert.equal(pending.shots.length, 2);
  assert.ok(pending.shots.every((shot) => shot.output_ready_for_visual_review));
  assert.equal(verify({ manifestFile, reportFile }).review_status, "pending");
  const again = await f.run(manifestFile);
  assert.equal(again.report.ok, true, JSON.stringify(again.report));
  assert.equal(f.submissions.length, 2, "resume must not generate again");
});

test("phone case product/artwork/person references retain role order and an explicit model", async (t) => {
  const f = await fixture(t);
  const product = f.image("case-product"), artwork = f.image("case-artwork"), person = f.image("case-person");
  const { manifest, manifestFile } = f.compile({ batch_id: "case-roles", products: [{ id: "CASE-TEST", color: "Clear",
    category: "phonecase", model: "Pixel 9 Pro", facts: ["Offline case fixture for Pixel 9 Pro"], facts_source: f.facts,
    refs: [{ role: "person", file: person }, { role: "artwork", file: artwork, product_id: "CASE-TEST" },
      { role: "product", file: product, product_id: "CASE-TEST", color: "Clear", model: "Pixel 9 Pro" }] }],
  shots: [{ request_id: "case-front", product_id: "CASE-TEST", color: "Clear", changes: ["lighting"],
    output_file: path.join(f.dir, "case-output.png") }] });
  assert.deepEqual(manifest.jobs[0].reference_images, [product, artwork, person].map((file) => fs.realpathSync(file)));
  const result = await f.run(manifestFile);
  assert.equal(result.report.ok, true, JSON.stringify(result.report));
  assert.equal(f.submissions.length, 1);
  const body = f.submissions[0].body;
  assert.equal((body.toString("utf8").match(/name="image"/g) ?? []).length, 3);
  assert.equal(body.toString("utf8").includes('name="image[]"'), false);
  const offsets = [product, artwork, person].map((file) => body.indexOf(fs.readFileSync(file)));
  assert.ok(offsets[0] >= 0 && offsets[0] < offsets[1] && offsets[1] < offsets[2]);
  assert.equal(result.report.jobs[0].product_lock.model, "Pixel 9 Pro");
  assert.doesNotMatch(manifest.jobs[0].prompt, /iPhone 15 Pro|iPhone 18 Pro Max/);
  const reportFile = f.write("report.json", result.report);
  assert.equal(reviewPending({ manifestFile, reportFile }).review_status, "pending");
});

test("a text/artwork-only product request is blocked before reaching the local generator", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.compile({ batch_id: "missing-product", products: [{ id: "CASE-TEST", color: "Clear",
    category: "phonecase", model: "Pixel 9 Pro", facts: ["Offline fixture"], facts_source: f.facts,
    refs: [{ role: "artwork", file: f.image("artwork-only"), product_id: "CASE-TEST" }] }],
  shots: [{ request_id: "missing-front", product_id: "CASE-TEST", color: "Clear", changes: ["background"],
    output_file: path.join(f.dir, "must-not-exist.png") }] }), /product 参考图/);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.queries(), 0);
});
