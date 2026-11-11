import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACTIVE_PORT_FILE } from "./constants.mjs";
import { sdkError } from "./errors.mjs";

export function defaultActivePortFile() {
  return join(homedir(), ...ACTIVE_PORT_FILE);
}

export function parseActivePort(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw sdkError(
      "INVALID_ACTIVE_PORT_FILE",
      "Edge DevToolsActivePort 缺少 port 或 browserWSPath",
    );
  }

  const port = Number(lines[0]);
  const websocketPath = lines[1];
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw sdkError("INVALID_ACTIVE_PORT_FILE", "Edge CDP 端口无效");
  }
  if (!/^\/devtools\/browser\/[A-Za-z0-9._~-]+(?:[/?][^\s]*)?$/.test(websocketPath)) {
    throw sdkError("INVALID_ACTIVE_PORT_FILE", "Edge browserWSPath 无效");
  }
  return { port, websocketPath };
}

function safeEchoTikTarget(target) {
  if (target?.type !== "page" || typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "echotik.live" && !url.hostname.endsWith(".echotik.live")) {
      return false;
    }
    const segments = url.pathname
      .toLowerCase()
      .split("/")
      .filter(Boolean);
    if (
      segments.some((segment) =>
        /^(?:login|signin|sign-in|auth|user|users|account|bill|billing|payment|checkout|pricing|orders?)$/.test(
          segment,
        ),
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function targetScore(target) {
  if (!safeEchoTikTarget(target)) return -1;
  const path = new URL(target.url).pathname.toLowerCase();
  if (path === "/board" || path.startsWith("/board/")) return 100;
  if (path.includes("market")) return 95;
  if (path === "/" || path === "") return 80;
  if (path.startsWith("/products") || path.startsWith("/product")) return 70;
  return 50;
}

export function selectEchoTikTarget(targets) {
  const candidates = (Array.isArray(targets) ? targets : [])
    .map((target) => ({ target, score: targetScore(target) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    throw sdkError(
      "TARGET_NOT_FOUND",
      "未找到可复用的 echotik.live 页面；请先在现有 Edge 中打开市场页",
    );
  }
  return candidates[0].target;
}

function parseWebSocketMessage(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return String(data);
}

export class CdpConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  /**
   * 连接以 --remote-debugging-port 启动的 Chrome/Edge。
   * 与 connect() 的区别：不依赖 Edge 的 DevToolsActivePort 文件。
   */
  static async connectHttp(baseUrl) {
    const base = String(baseUrl).replace(/\/+$/, "");
    let info;
    try {
      const response = await fetch(`${base}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw sdkError(
          "CDP_HTTP_FAILED",
          `无法读取 ${base}/json/version：HTTP ${response.status}`,
        );
      }
      info = await response.json();
    } catch (cause) {
      if (cause?.code) throw cause;
      throw sdkError("CDP_HTTP_FAILED", `无法连接调试地址：${base}`, cause);
    }
    if (!info?.webSocketDebuggerUrl) {
      throw sdkError("CDP_HTTP_FAILED", "调试地址没有返回 webSocketDebuggerUrl");
    }
    const url = new URL(info.webSocketDebuggerUrl);
    const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
    const connection = new CdpConnection();
    await connection.#open({
      port,
      websocketPath: `${url.pathname}${url.search}`,
    });
    return connection;
  }

  static async connect(activePortFile = defaultActivePortFile()) {
    if (typeof globalThis.WebSocket !== "function") {
      throw sdkError(
        "WEBSOCKET_UNAVAILABLE",
        "当前 Node 不提供全局 WebSocket；请使用 Node 24.19 或更新版本",
      );
    }

    let text;
    try {
      text = await readFile(activePortFile, "utf8");
    } catch (cause) {
      throw sdkError(
        "EDGE_CDP_UNREADABLE",
        "无法读取 Edge DevToolsActivePort；请确认 Edge 已用调试模式启动",
        cause,
      );
    }
    const activePort = parseActivePort(text);
    const connection = new CdpConnection();
    await connection.#open(activePort);
    return connection;
  }

  async #open({ port, websocketPath }) {
    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}${websocketPath}`);
    } catch (cause) {
      throw sdkError(
        "EDGE_CDP_CONNECT_FAILED",
        "无法建立现有 Edge CDP WebSocket；SDK 未启动浏览器或新标签",
        cause,
      );
    }
    this.#socket = socket;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        callback(value);
      };
      const onOpen = () => {
        finish(resolve);
      };
      const onError = () => {
        finish(
          reject,
          sdkError(
            "EDGE_CDP_CONNECT_FAILED",
            "无法连接现有 Edge CDP；SDK 未启动浏览器或新标签",
          ),
        );
      };
      const timer = setTimeout(() => {
        finish(
          reject,
          sdkError(
            "EDGE_CDP_CONNECT_TIMEOUT",
            "Edge CDP WebSocket 握手超时；SDK 未启动浏览器或新标签",
          ),
        );
        try {
          socket.close();
        } catch {
          // The failed attempt remains isolated from the running browser.
        }
      }, 60_000);
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });

    socket.addEventListener("message", (event) => {
      this.#handleMessage(parseWebSocketMessage(event.data));
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) {
        reject(sdkError("EDGE_CDP_CLOSED", "Edge CDP 连接已关闭"));
      }
      this.#pending.clear();
    });
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(
        sdkError(
          "CDP_COMMAND_FAILED",
          `Edge CDP 命令失败：${message.error.message ?? "unknown"}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.#closed || !this.#socket) {
      return Promise.reject(sdkError("EDGE_CDP_CLOSED", "Edge CDP 连接已关闭"));
    }

    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (cause) {
        this.#pending.delete(id);
        reject(sdkError("EDGE_CDP_SEND_FAILED", "无法向 Edge CDP 发送命令", cause));
      }
    });
  }

  async attachToEchoTikPage() {
    const result = await this.send("Target.getTargets");
    const target = selectEchoTikTarget(result.targetInfos);
    const attached = await this.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    return { target, sessionId: attached.sessionId };
  }

  async evaluate(sessionId, expression) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw sdkError(
        "PAGE_EVALUATION_FAILED",
        "页面桥接执行失败；未重试",
      );
    }
    return result.result?.value;
  }

  async detach(sessionId) {
    if (!sessionId || this.#closed) return;
    try {
      await this.send("Target.detachFromTarget", { sessionId });
    } catch {
      // Closing the browser WebSocket still releases the flat session.
    }
  }

  close() {
    this.#closed = true;
    try {
      this.#socket?.close();
    } catch {
      // Best-effort close only; never touch browser processes or tabs.
    }
  }

  isOpen() {
    return !this.#closed && this.#socket?.readyState === 1;
  }
}
