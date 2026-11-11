import assert from "node:assert/strict";
import test from "node:test";
import { openDb } from "../dist/core/db.js";
import { prepareBatch } from "../dist/core/prepare.js";
import { normalizeAspectRatio, normalizeDuration, normalizeResolution } from "../dist/core/validate.js";
import { cleanup, makeTempDir, setupEnv } from "./helpers.mjs";

test("比例别名映射为 minimax-h3 的 portrait/landscape", () => {
  assert.equal(normalizeAspectRatio("9:16"), "portrait");
  assert.equal(normalizeAspectRatio("竖屏"), "portrait");
  assert.equal(normalizeAspectRatio("16:9"), "landscape");
  assert.equal(normalizeAspectRatio("横屏"), "landscape");
  assert.throws(() => normalizeAspectRatio("1:1"), /只支持竖屏或横屏/);
});

test("分辨率和时长限制", () => {
  assert.equal(normalizeResolution("1080P"), "1080p");
  assert.throws(() => normalizeResolution("720p"), /没有 720p/);
  assert.equal(normalizeDuration(10, "1080p"), 10);
  assert.throws(() => normalizeDuration(11, "1080p"), /1080p 最多支持 10 秒/);
  assert.equal(normalizeDuration(15, "768p"), 15);
  assert.throws(() => normalizeDuration(16, "480p"), /1–15/);
});

test("准备批次前拦截素材数量和空提示词", async (t) => {
  const dir = makeTempDir();
  setupEnv("https://example.invalid", dir);
  const db = openDb();
  t.after(() => {
    db.close();
    cleanup(dir);
  });

  await assert.rejects(
    () =>
      prepareBatch(db, {
        jobs: [
          {
            prompt: "测试",
            images: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}.png`),
          },
        ],
      }),
    /最多 9 个/,
  );

  await assert.rejects(() => prepareBatch(db, { jobs: [{ prompt: "   " }] }), /不能为空/);
});

test("1080p 超过 10 秒在登记前报错", async (t) => {
  const dir = makeTempDir();
  setupEnv("https://example.invalid", dir);
  const db = openDb();
  t.after(() => {
    db.close();
    cleanup(dir);
  });

  await assert.rejects(
    () =>
      prepareBatch(db, {
        jobs: [{ prompt: "测试", aspectRatio: "16:9", resolution: "1080p", duration: 12 }],
      }),
    /1080p 最多支持 10 秒/,
  );
});
