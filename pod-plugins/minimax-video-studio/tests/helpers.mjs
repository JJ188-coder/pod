import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minimax-video-test-"));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

export function setupEnv(origin, dataDir) {
  process.env.MINIMAX_VIDEO_DATA_DIR = dataDir;
  process.env.MINIMAX_VIDEO_API_KEY = "test-key";
  process.env.MINIMAX_VIDEO_ALLOW_HTTP = "1";
  process.env.MINIMAX_VIDEO_BASE_URL = origin;
}

export function clearEnv() {
  delete process.env.MINIMAX_VIDEO_DATA_DIR;
  delete process.env.MINIMAX_VIDEO_API_KEY;
  delete process.env.MINIMAX_VIDEO_ALLOW_HTTP;
  delete process.env.MINIMAX_VIDEO_BASE_URL;
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
