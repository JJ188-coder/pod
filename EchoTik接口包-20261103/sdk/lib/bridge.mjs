import {
  BRIDGE_GLOBAL,
  CATEGORY_PATH,
  LEADERBOARD_PATH,
  LIMITS,
  validateRequestBudget,
} from "./constants.mjs";
import { parseEchoTikJsonText } from "./json.mjs";

function installBridge(
  parseJson,
  globalName,
  leaderboardPath,
  categoryPath,
  maxRequests,
  minIntervalMs,
) {
  if (globalThis[globalName]) return;

  const nativeFetch = globalThis.fetch;
  const Xhr = globalThis.XMLHttpRequest;
  const xhrProto = Xhr?.prototype;
  const nativeXhrOpen = xhrProto?.open;
  const nativeXhrSend = xhrProto?.send;
  const nativeXhrSetRequestHeader = xhrProto?.setRequestHeader;

  const allowedEndpoints = new Set([leaderboardPath, categoryPath]);
  const allowedPeriods = new Set(["daily", "weekly", "monthly"]);
  const blockedCaptureHeaders = new Set([
    "cookie",
    "host",
    "content-length",
    "connection",
    "origin",
    "referer",
    "user-agent",
    "proxy-authorization",
  ]);

  const state = {
    headers: null,
    capturedAt: null,
    lastResponse: null,
    paused: false,
    requests: 0,
    lastStartedAt: null,
    lastError: null,
  };

  function setFailure(code) {
    state.paused = true;
    state.lastError = code;
    return { ok: false, error: code };
  }

  function absoluteUrl(value) {
    try {
      return new URL(String(value), location.href);
    } catch {
      return null;
    }
  }

  function endpointPath(value) {
    const url = absoluteUrl(value);
    if (!url || url.origin !== location.origin) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return allowedEndpoints.has(url.pathname) ? url.pathname : null;
  }

  function headerEntries(source) {
    if (!source) return [];
    try {
      if (typeof Headers !== "undefined" && source instanceof Headers) {
        return [...source.entries()];
      }
      if (Array.isArray(source)) {
        return source.map((pair) => [String(pair[0]), String(pair[1])]);
      }
      if (typeof source === "object") {
        return Object.entries(source).map(([name, value]) => [
          String(name),
          String(value),
        ]);
      }
    } catch {
      return [];
    }
    return [];
  }

  function cacheHeaders(entries) {
    try {
      const headers = new Headers();
      for (const [rawName, rawValue] of entries) {
        const name = String(rawName).trim();
        const value = String(rawValue);
        const lower = name.toLowerCase();
        if (
          !name ||
          value.length > 4096 ||
          blockedCaptureHeaders.has(lower) ||
          lower.startsWith("sec-") ||
          /[\r\n]/.test(name) ||
          /[\r\n]/.test(value)
        ) {
          continue;
        }
        headers.set(name, value);
      }
      if (!headers.get("authorization") || !headers.get("x-user-id")) {
        return false;
      }
      state.headers = headers;
      state.capturedAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  function captureFetch(args) {
    try {
      const input = args[0];
      const init = args[1] ?? {};
      const method = String(
        init.method ??
          (input && typeof input === "object" && "method" in input
            ? input.method
            : "GET"),
      ).toUpperCase();
      if (method !== "GET") return;

      const rawUrl =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input?.url;
      if (!endpointPath(rawUrl)) return;

      let entries = [];
      if (input && typeof input === "object" && input.headers) {
        entries = headerEntries(input.headers);
      }
      if (init.headers) entries = entries.concat(headerEntries(init.headers));
      cacheHeaders(entries);
    } catch {
      // Observation must never break the page's normal request.
    }
  }

  let wrappedFetch = null;
  if (typeof nativeFetch === "function") {
    wrappedFetch = function fetch(...args) {
      captureFetch(args);
      return nativeFetch.apply(this, args);
    };
    try {
      Object.defineProperty(wrappedFetch, "name", { value: "fetch" });
      globalThis.fetch = wrappedFetch;
    } catch {
      wrappedFetch = null;
    }
  }

  const xhrRequests = new WeakMap();
  let wrappedXhrOpen = null;
  let wrappedXhrSetRequestHeader = null;
  let wrappedXhrSend = null;

  if (
    xhrProto &&
    typeof nativeXhrOpen === "function" &&
    typeof nativeXhrSend === "function" &&
    typeof nativeXhrSetRequestHeader === "function"
  ) {
    try {
      wrappedXhrOpen = function open(method, url, ...rest) {
        xhrRequests.set(this, {
          method: String(method).toUpperCase(),
          url,
          headers: [],
        });
        return nativeXhrOpen.call(this, method, url, ...rest);
      };
      wrappedXhrSetRequestHeader = function setRequestHeader(name, value) {
        const record = xhrRequests.get(this);
        if (record) record.headers.push([String(name), String(value)]);
        return nativeXhrSetRequestHeader.call(this, name, value);
      };
      wrappedXhrSend = function send(...args) {
        try {
          const record = xhrRequests.get(this);
          if (
            record?.method === "GET" &&
            endpointPath(record.url) &&
            record.headers.length > 0
          ) {
            cacheHeaders(record.headers);
          }
        } catch {
          // Observation must never break the page's normal request.
        }
        return nativeXhrSend.apply(this, args);
      };
      xhrProto.open = wrappedXhrOpen;
      xhrProto.setRequestHeader = wrappedXhrSetRequestHeader;
      xhrProto.send = wrappedXhrSend;
    } catch {
      wrappedXhrOpen = null;
      wrappedXhrSetRequestHeader = null;
      wrappedXhrSend = null;
    }
  }

  function validateParams(path, params) {
    if (!Array.isArray(params)) return false;
    if (path === categoryPath) return params.length === 0;

    const allowedKeys = new Set([
      "time_type",
      "time_range",
      "page",
      "product_categories[]",
      "order",
      "per_page",
    ]);
    if (
      params.some(
        (pair) =>
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !allowedKeys.has(String(pair[0])),
      )
    ) {
      return false;
    }

    const grouped = new Map();
    for (const [rawName, rawValue] of params) {
      const name = String(rawName);
      const value = String(rawValue);
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(value);
    }

    const singleton = (name) => {
      const values = grouped.get(name);
      return values?.length === 1 ? values[0] : null;
    };
    const period = singleton("time_type");
    const range = singleton("time_range");
    const page = singleton("page");
    const order = singleton("order");
    const perPage = singleton("per_page");
    const categories = grouped.get("product_categories[]") ?? [];

    return (
      allowedPeriods.has(period) &&
      (period === "daily" ? /^\d{8}$/.test(range ?? "") : /^\d{8}-\d{8}$/.test(range ?? "")) &&
      /^[1-5]$/.test(page ?? "") &&
      order === "sale_cnt" &&
      /^(?:[1-9]|1\d|20)$/.test(perPage ?? "") &&
      categories.length >= 1 &&
      categories.length <= 3 &&
      (categories[0] === "" ||
        categories.every((value) => /^\d{1,30}$/.test(value)))
    );
  }

  async function read(message) {
    if (state.paused) return { ok: false, error: state.lastError ?? "PAUSED" };
    if (!state.headers) return { ok: false, error: "NO_CAPTURED_SESSION" };
    if (state.requests >= maxRequests) {
      return { ok: false, error: "REQUEST_LIMIT" };
    }

    const path = String(message?.path ?? "");
    const country = String(message?.country ?? "").toUpperCase();
    const params = message?.params;
    if (!allowedEndpoints.has(path) || !["MX", "US"].includes(country)) {
      return { ok: false, error: "INVALID_REQUEST" };
    }
    if (!validateParams(path, params)) {
      return { ok: false, error: "INVALID_REQUEST" };
    }

    const now = Date.now();
    if (
      state.lastStartedAt !== null &&
      now - state.lastStartedAt < minIntervalMs
    ) {
      return { ok: false, error: "MIN_INTERVAL" };
    }

    state.lastStartedAt = now;
    state.requests += 1;

    try {
      const headers = new Headers(state.headers);
      headers.set("accept", "application/json, text/plain, */*");
      headers.set("x-region", country);
      headers.set("x-currency", country === "MX" ? "MXN" : "USD");

      const query = new URLSearchParams(params).toString();
      const url = query ? `${path}?${query}` : path;
      const response = await nativeFetch.call(globalThis, url, {
        method: "GET",
        headers,
        credentials: "same-origin",
        cache: "no-store",
      });

      if ([401, 403, 429].includes(response.status)) {
        const error =
          response.status === 401
            ? "AUTH_REQUIRED"
            : response.status === 403
              ? "ACCESS_DENIED"
              : "RATE_LIMITED";
        return setFailure(error);
      }
      if (!response.ok) return setFailure(`HTTP_${response.status}`);

      const text = await response.text();
      if (text.length > 2_000_000) {
        return setFailure("RESPONSE_TOO_LARGE");
      }

      let body;
      try {
        body = parseJson(text);
      } catch {
        const challenge =
          /captcha|verification|verify|member|membership|upgrade|subscribe|登录|验证码|会员/i.test(
            text.slice(0, 20_000),
          );
        return setFailure(
          challenge ? "CHALLENGE_OR_MEMBER_WALL" : "INVALID_JSON",
        );
      }

      if (!body || !(body.code === 0 || body.code === "0")) {
        return setFailure("API_CODE");
      }

      state.lastResponse = body;
      return { ok: true, body };
    } catch {
      return setFailure("NETWORK_ERROR");
    }
  }

  function snapshot() {
    return state.lastResponse
      ? { ok: true, body: state.lastResponse }
      : { ok: false, error: "NO_SNAPSHOT" };
  }

  function getState() {
    return {
      ok: true,
      version: 1,
      captured: Boolean(state.headers),
      captured_at: state.capturedAt,
      requests: state.requests,
      remaining: Math.max(0, maxRequests - state.requests),
      paused: state.paused,
      last_error: state.lastError,
    };
  }

  function dispose() {
    if (wrappedFetch && globalThis.fetch === wrappedFetch) {
      globalThis.fetch = nativeFetch;
    }
    if (xhrProto) {
      if (wrappedXhrOpen && xhrProto.open === wrappedXhrOpen) {
        xhrProto.open = nativeXhrOpen;
      }
      if (
        wrappedXhrSetRequestHeader &&
        xhrProto.setRequestHeader === wrappedXhrSetRequestHeader
      ) {
        xhrProto.setRequestHeader = nativeXhrSetRequestHeader;
      }
      if (wrappedXhrSend && xhrProto.send === wrappedXhrSend) {
        xhrProto.send = nativeXhrSend;
      }
    }
    state.headers = null;
    state.lastResponse = null;
    if (globalThis[globalName]?.version === 1) delete globalThis[globalName];
    return { ok: true };
  }

  const api = Object.freeze({ version: 1, read, snapshot, state: getState, dispose });
  try {
    Object.defineProperty(globalThis, globalName, {
      value: api,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    // A page-level conflict leaves the SDK unavailable; it will fail closed.
  }
}

export function createBridgeSource({ maxRequests = LIMITS.maxNewRequests } = {}) {
  validateRequestBudget(maxRequests);
  return `(() => { const parseJson = ${parseEchoTikJsonText.toString()}; (${installBridge.toString()})(parseJson, ${JSON.stringify(BRIDGE_GLOBAL)}, ${JSON.stringify(LEADERBOARD_PATH)}, ${JSON.stringify(CATEGORY_PATH)}, ${maxRequests}, ${LIMITS.minRequestIntervalMs}); })();`;
}

export const BRIDGE_SOURCE = createBridgeSource();

export function bridgeExpression(method, argument = undefined) {
  const payload = JSON.stringify(argument ?? null);
  return `(async () => { const bridge = globalThis[${JSON.stringify(BRIDGE_GLOBAL)}]; if (!bridge) return JSON.stringify({ ok: false, error: "NO_BRIDGE" }); return JSON.stringify(await bridge.${method}(${payload})); })()`;
}
