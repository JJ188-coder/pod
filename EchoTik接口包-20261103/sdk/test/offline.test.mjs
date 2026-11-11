import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { parseCliArgs } from "../cli.mjs";
import {
  buildLeaderboardParams,
  validateCategoryPath,
  validateRankingsOptions,
} from "../index.mjs";
import { BRIDGE_GLOBAL } from "../lib/constants.mjs";
import { BRIDGE_SOURCE } from "../lib/bridge.mjs";
import {
  parseActivePort,
  selectEchoTikTarget,
} from "../lib/cdp.mjs";
import { RequestGovernor } from "../lib/governor.mjs";
import { parseEchoTikJsonText } from "../lib/json.mjs";
import {
  makeCategoriesDocument,
  makeRankingsDocument,
} from "../lib/redaction.mjs";

const WEEKLY = Object.freeze({
  period: "weekly",
  range: "20261012-20261018",
  categoryPath: ["824328", "839944", "601226"],
  country: "MX",
  page: 1,
  perPage: 20,
});

test("榜单使用重复 product_categories[]，All 传空值", () => {
  const ranked = validateRankingsOptions(WEEKLY);
  const params = buildLeaderboardParams(ranked);
  assert.deepEqual(
    params.filter(([key]) => key === "product_categories[]"),
    [
      ["product_categories[]", "824328"],
      ["product_categories[]", "839944"],
      ["product_categories[]", "601226"],
    ],
  );
  assert.equal(new URLSearchParams(params).get("time_type"), "weekly");
  assert.equal(new URLSearchParams(params).get("time_range"), "20261012-20261018");
  assert.equal(new URLSearchParams(params).get("order"), "sale_cnt");

  const all = validateRankingsOptions({
    ...WEEKLY,
    period: "monthly",
    range: "20260901-20260930",
    categoryPath: [],
  });
  assert.deepEqual(
    buildLeaderboardParams(all).filter(
      ([key]) => key === "product_categories[]",
    ),
    [["product_categories[]", ""]],
  );
});

test("daily 使用单个日期，weekly/monthly 使用起止范围", () => {
  const daily = validateRankingsOptions({
    ...WEEKLY,
    period: "daily",
    range: "20261021",
  });
  assert.equal(daily.range, "20261021");
  assert.throws(
    () => validateRankingsOptions({ ...WEEKLY, period: "daily" }),
    (error) => error.code === "INVALID_RANGE",
  );
  assert.throws(
    () => validateRankingsOptions({ ...WEEKLY, range: "20261021" }),
    (error) => error.code === "INVALID_RANGE",
  );
});

test("参数校验拒绝任意路径、限额外分页和非法类目", () => {
  assert.throws(
    () => validateRankingsOptions({ ...WEEKLY, perPage: 21 }),
    (error) => error.code === "INVALID_PARAMETER",
  );
  assert.throws(
    () => validateRankingsOptions({ ...WEEKLY, page: 6 }),
    (error) => error.code === "INVALID_PARAMETER",
  );
  assert.throws(
    () => validateRankingsOptions({ ...WEEKLY, period: "yearly" }),
    (error) => error.code === "INVALID_PERIOD",
  );
  assert.throws(
    () => validateRankingsOptions({ ...WEEKLY, country: "CN" }),
    (error) => error.code === "INVALID_COUNTRY",
  );
  assert.throws(
    () => validateCategoryPath(["824328/839944"]),
    (error) => error.code === "INVALID_CATEGORY_PATH",
  );
  assert.throws(
    () => validateCategoryPath(["1", "2", "3", "4"]),
    (error) => error.code === "INVALID_CATEGORY_PATH",
  );
  assert.throws(
    () => validateRankingsOptions({ ...WEEKLY, range: "../private" }),
    (error) => error.code === "INVALID_RANGE",
  );
});

test("商品响应只保留业务字段，meta 只保留分页六字段", () => {
  const body = {
    code: 0,
    data: [
      {
        product_id: "1737423637648869219",
        product_name: "SanJudas T-shirt sales@example.com",
        category: "Men's Clothing",
        categories: [{ id: 601226, name: "T-shirts", path: "/internal/private" }],
        region: "MX",
        avg_price: 299.9,
        min_price: 199,
        max_price: 399,
        sale_cnt: 3645,
        total_sale_cnt: 12000,
        total_gmv_amt: 100000.5,
        total_sale_gmv_amt: 500000.5,
        influencers_count: 99,
        total_video_cnt: 101,
        total_live_cnt: 4,
        product_rating: 4.8,
        review_count: 77,
        cover_url: "https://user:pass@cdn.example.com/p.jpg?size=large",
        seller: {
          seller_id: "1730000000000000123",
          seller_name: "Demo Seller",
          email: "owner@example.com",
          phone: "+86 13800000000",
          contact_url: "https://internal.example/user",
          description: "contact owner@example.com",
          follower_count: 88,
        },
        skus: Array.from({ length: 200 }, (_, index) => ({ id: index })),
        authorization: "must-not-leak",
      },
    ],
    meta: {
      current_page: 1,
      per_page: 20,
      last_page: 3,
      total: 60,
      from: 1,
      to: 20,
      path: "http://10.3.0.34/api/internal",
      links: [{ url: "http://10.3.0.34/next" }],
    },
  };

  const document = makeRankingsDocument(
    body,
    validateRankingsOptions(WEEKLY),
    new Date("2026-10-22T00:00:00.000Z"),
  );
  assert.deepEqual(Object.keys(document.data[0]), [
    "product_id",
    "product_name",
    "category",
    "categories",
    "region",
    "avg_price",
    "min_price",
    "max_price",
    "sale_cnt",
    "total_sale_cnt",
    "total_gmv_amt",
    "total_sale_gmv_amt",
    "influencers_count",
    "total_video_cnt",
    "total_live_cnt",
    "product_rating",
    "review_count",
    "cover_url",
    "seller",
  ]);
  assert.deepEqual(Object.keys(document.meta), [
    "current_page",
    "per_page",
    "last_page",
    "total",
    "from",
    "to",
  ]);
  const serialized = JSON.stringify(document);
  assert.doesNotMatch(serialized, /sales@example\.com|owner@example\.com/i);
  assert.doesNotMatch(serialized, /10\.3\.0\.34|must-not-leak|\+86/);
  assert.doesNotMatch(serialized, /"skus"/);
  assert.equal(document.data[0].product_id, "1737423637648869219");
  assert.equal(document.data[0].seller.email, undefined);
  assert.equal(document.data[0].seller.phone, undefined);
  assert.equal(document.data[0].seller.contact_url, undefined);
  assert.match(document.data[0].cover_url, /^https:\/\/cdn\.example\.com\//);
});

test("code 0 + 空 data 是合法空结果；非 0 code 直接失败", () => {
  const request = validateRankingsOptions(WEEKLY);
  const empty = makeRankingsDocument(
    { code: 0, data: [], meta: { current_page: 1, per_page: 20 } },
    request,
  );
  assert.deepEqual(empty.data, []);
  assert.throws(
    () => makeRankingsDocument({ code: 50001, data: [] }, request),
    (error) => error.code === "API_CODE",
  );
});

test("类目响应去掉内部路径和联系方式", () => {
  const document = makeCategoriesDocument(
    {
      code: 0,
      data: [
        {
          category_id: 601226,
          name: "T-shirts",
          children: [],
          url: "http://10.3.0.34/category",
          owner_email: "cat@example.com",
        },
      ],
    },
    { country: "MX", currency: "MXN" },
  );
  const serialized = JSON.stringify(document);
  assert.equal(document.data[0].category_id, 601226);
  assert.equal(document.data[0].url, undefined);
  assert.equal(document.data[0].owner_email, undefined);
  assert.doesNotMatch(serialized, /10\.3\.0\.34|cat@example\.com/);
});

test("三级 taxonomy 数组与对象交替嵌套仍保留叶子 T 恤", () => {
  const leaf = { category_id: 601226, name: "T-shirts", children: [] };
  const document = makeCategoriesDocument(
    {
      code: 0,
      data: [
        {
          category_id: 824328,
          name: "Men",
          children: [
            {
              category_id: 839944,
              name: "Clothing",
              children: [leaf],
            },
          ],
        },
      ],
    },
    { country: "MX", currency: "MXN" },
  );
  assert.equal(
    document.data[0].children[0].children[0].category_id,
    601226,
  );
});

test("解析 EchoTik JSON 时保留 19 位商品 ID", () => {
  const parsed = parseEchoTikJsonText(
    '{"code":0,"data":[{"product_id":1737423637648869219,"sale_cnt":3645}]}',
  );
  assert.equal(parsed.data[0].product_id, "1737423637648869219");
  assert.equal(parsed.data[0].sale_cnt, 3645);
});

test("请求节流串行执行，最多 5 次且间隔 1500ms", async () => {
  let clock = 0;
  const sleeps = [];
  let calls = 0;
  const governor = new RequestGovernor({
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      governor.run(async () => {
        calls += 1;
        return calls;
      }),
    ),
  );
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 5);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [1500, 1500, 1500, 1500]);
});

test("Edge ActivePort 自动解析且目标只选正常 EchoTik 页面", () => {
  const active = parseActivePort(
    "9222\n/devtools/browser/78aa342c-3567-4e34-a66f-8a4ceac757d1\n",
  );
  assert.deepEqual(active, {
    port: 9222,
    websocketPath: "/devtools/browser/78aa342c-3567-4e34-a66f-8a4ceac757d1",
  });
  assert.throws(() => parseActivePort("9222\nhttp://remote/debug"));

  const target = selectEchoTikTarget([
    { type: "page", targetId: "login", url: "https://echotik.live/login" },
    { type: "page", targetId: "user", url: "https://echotik.live/user/settings" },
    { type: "page", targetId: "bill", url: "https://echotik.live/bill" },
    { type: "page", targetId: "pricing", url: "https://echotik.live/pricing" },
    {
      type: "page",
      targetId: "market",
      url: "https://echotik.live/board?region=MX",
    },
  ]);
  assert.equal(target.targetId, "market");
});

test("CLI 支持 category-path、重复 category 与无空格写法", () => {
  const parsed = parseCliArgs([
    "--period=monthly",
    "--range",
    "20260901-20260930",
    "--category-path",
    "824328,839944,601226",
    "--countryMX",
    "--page",
    "1",
    "--per-page=20",
    "--out",
    "result.json",
  ]);
  assert.equal(parsed.period, "monthly");
  assert.equal(parsed.country, "MX");
  assert.deepEqual(parsed.categoryPath, ["824328", "839944", "601226"]);

  const repeated = parseCliArgs([
    "--range",
    "20261012-20261018",
    "--category601226",
    "--category",
    "601302",
  ]);
  assert.deepEqual(repeated.categoryPath, ["601226", "601302"]);
  assert.throws(
    () => parseCliArgs(["--generic-request"]),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("页面桥同源复用凭据但 state/read/snapshot 均不暴露 headers", async () => {
  const requests = [];
  const nativeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      async text() {
        return '{"code":0,"data":[{"product_id":1737423637648869219,"sale_cnt":3645}],"meta":{"current_page":1}}';
      },
    };
  };
  class MockXhr {}
  MockXhr.prototype.open = function open() {};
  MockXhr.prototype.send = function send() {};
  MockXhr.prototype.setRequestHeader = function setRequestHeader() {};

  const context = vm.createContext({
    Date,
    Headers,
    MockXhr,
    URL,
    URLSearchParams,
    XMLHttpRequest: MockXhr,
    fetch: nativeFetch,
    location: {
      href: "https://echotik.live/board",
      origin: "https://echotik.live",
    },
    setTimeout,
  });
  vm.runInContext(BRIDGE_SOURCE, context);
  const bridge = context[BRIDGE_GLOBAL];
  assert.ok(bridge);

  await context.fetch(
    "https://echotik.live/api/v1/data/products/product-category",
    {
      method: "GET",
      headers: {
        Authorization: "SENTINEL-SECRET",
        "X-User-Id": "123456",
        "x-region": "US",
        "x-currency": "USD",
      },
    },
  );

  const visibleState = JSON.stringify(bridge.state());
  assert.match(visibleState, /"captured":true/);
  assert.doesNotMatch(visibleState, /SENTINEL-SECRET|123456|headers/);

  const first = await bridge.read({
    path: "/api/v1/data/products/leaderboard/top-sold",
    country: "MX",
    params: [
      ["time_type", "weekly"],
      ["time_range", "20261012-20261018"],
      ["page", "1"],
      ["product_categories[]", "824328"],
      ["product_categories[]", "839944"],
      ["product_categories[]", "601226"],
      ["order", "sale_cnt"],
      ["per_page", "20"],
    ],
  });
  assert.equal(first.ok, true);
  assert.equal(first.body.data[0].product_id, "1737423637648869219");
  assert.doesNotMatch(JSON.stringify(first), /SENTINEL-SECRET|123456/);

  const replay = requests.at(-1);
  const replayUrl = new URL(replay.url, "https://echotik.live");
  assert.deepEqual(replayUrl.searchParams.getAll("product_categories[]"), [
    "824328",
    "839944",
    "601226",
  ]);
  assert.equal(replay.options.headers.get("authorization"), "SENTINEL-SECRET");
  assert.equal(replay.options.headers.get("x-user-id"), "123456");
  assert.equal(replay.options.headers.get("x-region"), "MX");
  assert.equal(replay.options.headers.get("x-currency"), "MXN");

  const immediate = await bridge.read({
    path: "/api/v1/data/products/product-category",
    country: "MX",
    params: [],
  });
  assert.equal(immediate.ok, false);
  assert.equal(immediate.error, "MIN_INTERVAL");
  assert.doesNotMatch(JSON.stringify(bridge.snapshot()), /SENTINEL-SECRET|123456/);

  bridge.dispose();
  assert.equal(context[BRIDGE_GLOBAL], undefined);
  assert.equal(context.fetch, nativeFetch);
});
