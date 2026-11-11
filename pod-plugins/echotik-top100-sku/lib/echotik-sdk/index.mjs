import { createBridgeSource, bridgeExpression } from "./lib/bridge.mjs";
import {
  CATEGORY_PATH,
  LEADERBOARD_PATH,
  LIMITS,
  validateRequestBudget,
} from "./lib/constants.mjs";
import { CdpConnection, defaultActivePortFile } from "./lib/cdp.mjs";
import { sdkError } from "./lib/errors.mjs";
import { RequestGovernor } from "./lib/governor.mjs";
import {
  makeCategoriesDocument,
  makeRankingsDocument,
} from "./lib/redaction.mjs";
import {
  categoriesRequest,
  leaderboardRequest,
  validateCategoriesOptions,
  validateRankingsOptions,
} from "./lib/validation.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function bridgeFailure(error) {
  const code = String(error ?? "BRIDGE_FAILED");
  const messages = {
    NO_CAPTURED_SESSION:
      "页面尚未捕获本次登录态请求；请重新通过正常 UI 打开或刷新市场页",
    REQUEST_LIMIT: `本次运行已达 ${LIMITS.maxNewRequests} 次新请求上限`,
    MIN_INTERVAL: `两次 EchoTik 请求至少间隔 ${LIMITS.minRequestIntervalMs}ms`,
    AUTH_REQUIRED: "EchoTik 登录态已失效（HTTP 401），已停止",
    ACCESS_DENIED: "EchoTik 拒绝访问（HTTP 403），已停止",
    RATE_LIMITED: "EchoTik 限流（HTTP 429），已停止",
    CHALLENGE_OR_MEMBER_WALL: "遇到验证码或会员墙，已停止",
    API_CODE: "EchoTik 返回非 0 code，已停止且不重试",
    INVALID_JSON: "EchoTik 返回非 JSON 业务响应，已停止",
    NETWORK_ERROR: "页面同源请求失败，已停止且不重试",
    RESPONSE_TOO_LARGE: "EchoTik 响应超过安全大小，已停止",
    INVALID_REQUEST: "请求未通过页面侧白名单校验",
    PAUSED: "本次会话已因前序错误暂停，请关闭后重新正常初始化",
    NO_BRIDGE: "当前页面不存在 SDK 桥接，请重新正常初始化",
  };
  return sdkError(
    code.startsWith("HTTP_") ? code : `BRIDGE_${code}`,
    messages[code] ?? "页面桥接失败，已停止且不重试",
  );
}

export class EchoTikSDK {
  #connection = null;
  #ownsConnection = false;
  #sessionId = null;
  #scriptIdentifier = null;
  #ready = false;
  #closing = null;
  #snapshots = { rankings: null, categories: null };
  #governor = new RequestGovernor();
  #onProgress;
  #maxRequests = LIMITS.maxNewRequests;

  static async open(options = {}) {
    const sdk = new EchoTikSDK();
    await sdk.#initialize(options);
    return sdk;
  }

  async #initialize(options) {
    this.#maxRequests = validateRequestBudget(options.maxRequests);
    this.#governor = new RequestGovernor({ maxRequests: this.#maxRequests });
    this.#onProgress =
      typeof options.onProgress === "function" ? options.onProgress : null;
    const timeoutMs = Math.min(
      60_000,
      Math.max(5_000, Number(options.captureTimeoutMs) || 25_000),
    );

    this.#progress("connecting");
    if (options.connection) {
      const required = ['attachToEchoTikPage', 'send', 'evaluate', 'detach'];
      if (required.some((name) => typeof options.connection[name] !== 'function')) {
        throw sdkError('INVALID_CONNECTION', '已有 CDP 连接缺少必要方法');
      }
      this.#connection = options.connection;
    } else {
      this.#connection = await CdpConnection.connect(
        options.activePortFile ?? defaultActivePortFile(),
      );
      this.#ownsConnection = true;
    }

    try {
      this.#progress("selecting-target");
      const attached = await this.#connection.attachToEchoTikPage();
      this.#sessionId = attached.sessionId;

      await this.#connection.send('Page.enable', {}, this.#sessionId);

      const installed = await this.#connection.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: createBridgeSource({ maxRequests: this.#maxRequests }) },
        this.#sessionId,
      );
      this.#scriptIdentifier = installed.identifier;

      this.#progress("reloading-market-page");
      await this.#connection.send(
        "Page.reload",
        { ignoreCache: false },
        this.#sessionId,
      );

      this.#progress("waiting-normal-request");
      const deadline = Date.now() + timeoutMs;
      let bridgeState = null;
      while (Date.now() < deadline) {
        await sleep(250);
        try {
          bridgeState = await this.#callBridge("state");
        } catch {
          continue;
        }
        if (bridgeState.captured) break;
        if (bridgeState.paused) {
          throw bridgeFailure(bridgeState.last_error ?? "PAUSED");
        }
      }

      if (!bridgeState?.captured) {
        throw sdkError(
          "SESSION_CAPTURE_TIMEOUT",
          "市场页刷新后未捕获到正常登录态请求；请确认当前 Edge 页面已登录会员账号",
        );
      }

      this.#ready = true;
      this.#progress("ready");
    } catch (error) {
      await this.#cleanup();
      throw error;
    }
  }

  #progress(stage) {
    try {
      this.#onProgress?.({ stage });
    } catch {
      // Progress observers cannot alter SDK behavior.
    }
  }

  #assertReady() {
    if (this.#connection?.isOpen && !this.#connection.isOpen()) {
      this.#ready = false;
      throw sdkError('EDGE_CDP_CLOSED', '已有 CDP 连接已断开；未自动重连');
    }
    if (!this.#ready) {
      throw sdkError("SDK_NOT_READY", "SDK 尚未完成正常页面初始化");
    }
  }

  async #callBridge(method, argument) {
    if (!this.#connection || !this.#sessionId) {
      throw sdkError("SDK_NOT_READY", "SDK 未连接现有 Edge 页面");
    }
    const raw = await this.#connection.evaluate(
      this.#sessionId,
      bridgeExpression(method, argument),
    );
    if (typeof raw !== "string") {
      throw sdkError("PAGE_BRIDGE_INVALID", "页面桥接返回格式无效");
    }

    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      throw sdkError("PAGE_BRIDGE_INVALID", "页面桥接结果无法解析");
    }
    if (!result?.ok) throw bridgeFailure(result?.error);
    return result;
  }

  async rankings(options = {}) {
    this.#assertReady();
    const request = validateRankingsOptions(options);
    const bridgeRequest = leaderboardRequest(request);

    const document = await this.#governor.run(async () => {
      const result = await this.#callBridge("read", {
        path: LEADERBOARD_PATH,
        country: bridgeRequest.country,
        params: bridgeRequest.params,
      });
      return makeRankingsDocument(result.body, request);
    });

    this.#snapshots.rankings = document;
    return clone(document);
  }

  async categories(options = {}) {
    this.#assertReady();
    const request = validateCategoriesOptions(options);
    const bridgeRequest = categoriesRequest(request);

    const document = await this.#governor.run(async () => {
      const result = await this.#callBridge("read", {
        path: CATEGORY_PATH,
        country: bridgeRequest.country,
        params: bridgeRequest.params,
      });
      return makeCategoriesDocument(result.body, request);
    });

    this.#snapshots.categories = document;
    return clone(document);
  }

  snapshot(kind = undefined) {
    if (kind === "rankings" || kind === "categories") {
      return clone(this.#snapshots[kind]);
    }
    if (kind !== undefined) {
      throw sdkError(
        "INVALID_SNAPSHOT_KIND",
        "snapshot kind 只允许 rankings 或 categories",
      );
    }
    return clone(this.#snapshots);
  }

  status() {
    return {
      ready: this.#ready && (!this.#connection?.isOpen || this.#connection.isOpen()),
      requests_used: this.#governor.used,
      requests_remaining: this.#governor.remaining,
      max_new_requests: this.#maxRequests,
      min_interval_ms: LIMITS.minRequestIntervalMs,
    };
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closing = this.#cleanup();
    return this.#closing;
  }

  async #cleanup() {
    this.#ready = false;
    const connection = this.#connection;
    const sessionId = this.#sessionId;
    const scriptIdentifier = this.#scriptIdentifier;
    this.#sessionId = null;
    this.#scriptIdentifier = null;

    if (connection && sessionId) {
      try {
        await connection.evaluate(sessionId, bridgeExpression("dispose"));
      } catch {
        // Navigation may already have removed the page realm.
      }
      if (scriptIdentifier) {
        try {
          await connection.send(
            "Page.removeScriptToEvaluateOnNewDocument",
            { identifier: scriptIdentifier },
            sessionId,
          );
        } catch {
          // The attached page may have navigated away; never open a new one.
        }
      }
      await connection.detach(sessionId);
    }
    if (this.#ownsConnection) connection?.close();
    if (this.#connection === connection) this.#connection = null;
  }
}

export {
  buildLeaderboardParams,
  validateCategoryPath,
  validateRankingsOptions,
} from "./lib/validation.mjs";
