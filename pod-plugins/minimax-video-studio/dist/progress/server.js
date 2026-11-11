import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { renderProgressPage } from "./page.js";
import { ProgressError, readProgressSnapshot } from "./snapshot.js";
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
function tokenMatches(expected, provided) {
    if (!provided)
        return false;
    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(provided, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
}
function baseHeaders(port) {
    return {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": [
            "default-src 'none'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline'",
            "connect-src 'self'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ].join("; "),
    };
}
function sendJson(res, status, value, port) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        ...baseHeaders(port),
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}
function sendText(res, status, contentType, body, port, cacheable = false) {
    const headers = {
        ...baseHeaders(port),
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
    };
    if (cacheable)
        headers["Cache-Control"] = "no-cache";
    res.writeHead(status, headers);
    res.end(body);
}
function allowedHost(host, port) {
    if (!host)
        return false;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
function allowedOrigin(origin, port) {
    if (!origin)
        return true;
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
export async function startProgressServer(options) {
    const batchId = options.batchId;
    const token = randomBytes(24).toString("hex");
    const idleMs = Math.max(500, options.idleMs ?? DEFAULT_IDLE_MS);
    let lastAccess = Date.now();
    let closed = false;
    let port = 0;
    const server = http.createServer((req, res) => {
        lastAccess = Date.now();
        if (!allowedHost(req.headers.host, port)) {
            sendJson(res, 403, { error: "forbidden_host" }, port);
            return;
        }
        if (!allowedOrigin(req.headers.origin, port)) {
            sendJson(res, 403, { error: "forbidden_origin" }, port);
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.setHeader("Allow", "GET, HEAD");
            sendJson(res, 405, { error: "method_not_allowed" }, port);
            return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/") {
            sendText(res, 200, "text/html; charset=utf-8", renderProgressPage(), port);
            return;
        }
        if (url.pathname === "/favicon.ico") {
            res.writeHead(204, baseHeaders(port));
            res.end();
            return;
        }
        if (url.pathname === "/api/state") {
            const provided = req.headers["x-progress-token"];
            if (typeof provided !== "string" || !tokenMatches(token, provided)) {
                sendJson(res, 401, { error: "unauthorized", message: "缺少或无效的访问令牌。" }, port);
                return;
            }
            try {
                sendJson(res, 200, readProgressSnapshot(batchId), port);
            }
            catch (error) {
                if (error instanceof ProgressError) {
                    const status = error.code === "batch_not_found" || error.code === "db_missing"
                        ? 404
                        : error.code === "db_schema_unsupported"
                            ? 409
                            : 503;
                    sendJson(res, status, { error: error.code, message: error.message }, port);
                }
                else {
                    sendJson(res, 500, { error: "internal_error", message: "读取进度失败。" }, port);
                }
            }
            return;
        }
        sendJson(res, 404, { error: "not_found" }, port);
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("无法确定进度服务端口。");
    }
    port = address.port;
    const timer = setInterval(() => {
        if (Date.now() - lastAccess >= idleMs)
            void close();
    }, Math.max(250, Math.min(30_000, Math.floor(idleMs / 2))));
    timer.unref();
    async function close() {
        if (closed)
            return;
        closed = true;
        clearInterval(timer);
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
    }
    return {
        batchId,
        url: `http://127.0.0.1:${port}/#t=${token}`,
        port,
        get closed() {
            return closed;
        },
        close,
    };
}
