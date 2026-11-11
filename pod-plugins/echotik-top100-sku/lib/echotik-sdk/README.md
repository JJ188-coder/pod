# EchoTik 已登录浏览器会话 SDK

这是一个仅复用现有 Microsoft Edge 标签页的小型 Node.js SDK。它从当前页面发起同源 GET，复用 EchoTik 标准会员在正常 UI 中已经使用的登录请求头，读取商品榜单和类目元数据。它不是 EchoTik 官方 API，也不依赖 MCP、第三方 Node 包或常驻服务器。

当前版本为 `0.1.1`。**已在现有 Edge CDP 连接上，通过本 SDK 实际读取墨西哥男士 T 恤周榜20条、月榜20条。** 离线测试14/14通过。当前推荐使用“复用已有连接”方式，避免每次初始化新建 WebSocket；不再将已经点过允许的用户反复要求确认。SDK补齐了 `Page.enable` 初始化，支持调用者传入已有CDP连接，并且不会在SDK清理时关闭调用者持有的连接。

初期新连接握手及一次页面请求捕获曾失败，记录保留作历史；最新实证见 `evidence/live-validation-20261022.json`。本次成功模式是“现有CDP连接＋SDK”；修正后未另开一个全新CLI连接做重复验证。

## 能做什么

- 周榜、月榜和日榜：`/api/v1/data/products/leaderboard/top-sold`
- 类目元数据：`/api/v1/data/products/product-category`
- 国家只允许 `MX`、`US`，币种分别固定为 `MXN`、`USD`
- 类目按完整 taxonomy 路径传递，例如男装 T 恤为 `824328,839944,601226`
- 每次初始化只刷新一个已经打开的 `echotik.live` 正常市场页，不新建标签、不关闭浏览器

不提供通用 `request()`，也没有访问用户、账单、费用、账号、订单、联系人或其他 API 的方法。

## 运行条件

- Microsoft Edge 已启动，并存在一个已登录的 `echotik.live` 市场页
- 浏览器开启 CDP；SDK 自动读取：

```text
~/Library/Application Support/Microsoft Edge/DevToolsActivePort
```

- Node.js `24.19.0` 或更新版本，必须提供全局 `WebSocket`
- 不需要 `npm install`

每次连接最多等待60秒供浏览器完成连接确认；超时即关闭本次连接，不自动重试。用户点击允许的时间与握手窗口是否匹配，尚无法独立确认。

SDK 不写死当前端口或 browser WebSocket UUID。每次运行重新读取 Edge 的端口文件，只接受 `echotik.live` 的现有 `page` target；登录页、用户页、账单页和定价页不会成为初始化目标。

## 命令行

在 `sdk/` 目录运行。每周男装 T 恤榜：

```bash
node cli.mjs \
  --period weekly \
  --range 20261012-20261018 \
  --category-path 824328,839944,601226 \
  --country MX \
  --page 1 \
  --per-page 20 \
  --out evidence/weekly.json
```

标准会员当前已确认的月榜范围格式：

```bash
node cli.mjs \
  --period monthly \
  --range 20260901-20260930 \
  --category-path 824328,839944,601226 \
  --country MX \
  --out evidence/monthly.json
```

全部类目：不传 `--category-path`，SDK 会发送一次空的 `product_categories[]=`。

单类目可以写成 `--category 601226`，也可以重复传 `--category`。CLI 同时兼容 `--category601226` 和 `--countryMX` 这种无空格写法。单个 T 恤叶子 ID 可能被 EchoTik 正常返回 `code: 0` 和零行数据；这不等同于“市场无销量”，优先使用已确认的三级路径：

```text
product_categories[]=824328
product_categories[]=839944
product_categories[]=601226
```

读取类目接口：

```bash
node cli.mjs --categories --country MX --out evidence/categories.json
```

传 `--out -` 或不传 `--out` 时，只把已脱敏业务 JSON 写到标准输出。进度只写标准错误。

## JavaScript 接口

```js
import { EchoTikSDK } from "./index.mjs";

let sdk;
try {
  sdk = await EchoTikSDK.open({
    onProgress({ stage }) {
      console.error(stage);
    },
  });

  const weekly = await sdk.rankings({
    period: "weekly",
    range: "20261012-20261018",
    categoryPath: ["824328", "839944", "601226"],
    country: "MX",
    page: 1,
    perPage: 20,
  });

  await sdk.rankings({
    period: "monthly",
    range: "20260901-20260930",
    categoryPath: ["824328", "839944", "601226"],
    country: "MX",
    page: 1,
    perPage: 20,
  });

  console.log(weekly.data[0].product_id, weekly.data[0].sale_cnt);
  console.log(sdk.snapshot("rankings")); // Node 内存中的最后一次榜单，不发请求
} finally {
  await sdk?.close(); // 移除注入脚本、清空 closure；传入的共享连接不会关闭
}
```

`snapshot()` 支持 `"rankings"`、`"categories"` 或不传参数。它只返回当前 Node 进程已经成功取得的脱敏业务结果。

## 复用已有连接（本次实际使用）

```js
// existingConnection 由当前JS/CDP宿主持有，整个任务只建立一次浏览器连接。
const sdk = await EchoTikSDK.open({ connection: existingConnection });
const weekly = await sdk.rankings({
  period: "weekly", range: "20261012-20261018",
  categoryPath: ["824328", "839944", "601226"], country: "MX",
  page: 1, perPage: 20,
});
// 月榜在同一个sdk实例上调用，不要每次new WebSocket。
// 任务期间保留sdk供按需读取；结束时await sdk.close()清理桥和本SDK的session。
// 调用者自行决定何时关闭自己的existingConnection；不自动重连。
```

共享连接需要提供 `attachToEchoTikPage()`、`send(method, params, sessionId)`、`evaluate(sessionId, expression)` 和 `detach(sessionId)` 方法。可同时提供 `isOpen()` 返回当前传输是否仍连通，供SDK在读取前和status()中检查。`attachToEchoTikPage()`返回 `{target, sessionId}`；`evaluate()`返回CDP `Runtime.evaluate` 的 `result.value`，出现异常应抛错。这些方法只适配已有CDP传输，本SDK不会为该模式再建立浏览器连接。初始化依次执行Page.enable、注册document-start桥、刷新现有市场页，再等待正常页面请求捕获。

本次JS宿主持有的实例已发出2次业务读取，剩余实例预算3次。成功读取后曾保留连接，随后观察到WebSocket以1006异常关闭、无原因文本。已停止，不循环重连；已保存的周月榜数据可继续分析，没有定时轮询。实例预算不等于平台会员每日剩余额度。若现有连接失效，停止并报告，不在后台循环重连或重复弹出确认；浏览器原生权限无法承诺永久免确认。

## 请求和参数边界

榜单 query 使用以下规则：

```text
time_type=daily|weekly|monthly
time_range=YYYYMMDD（daily）或 YYYYMMDD-YYYYMMDD（weekly/monthly）
page=1..5
per_page=1..20
order=sale_cnt
product_categories[]=<按路径顺序重复 append；All 为单个空字符串>
```

日期必须存在。daily 使用页面原生的单个日期，例如 `20261021`；weekly/monthly 使用起止范围，例如月榜 `20260901-20260930`，且开始日期不能晚于结束日期。日榜格式按 2026-10-22 的快速审查修正，尚未做 live 验证；SDK 不自行猜测其他月份的边界。

国家白名单会覆盖页面捕获的 `x-region` 和 `x-currency`：

| country | x-region | x-currency |
|---|---|---|
| MX | MX | MXN |
| US | US | USD |

## 凭据隔离

初始化流程如下：

1. 通过浏览器级 CDP WebSocket 执行 `Target.getTargets`。
2. 选择现有 `echotik.live` 页面并 `Target.attachToTarget(flatten: true)`。
3. 用 `Page.addScriptToEvaluateOnNewDocument` 在下一个 document 主执行环境安装桥。
4. 刷新该市场页一次，让正常 UI 请求发生。
5. 桥只缓存同源 `/api/v1/data/` GET 请求头到闭包；`read()` 在页面同源 `fetch` 中复用这些头。
6. CDP 只把 EchoTik 业务响应带回 Node。

缓存头不会出现在 `state()`、`read()`、`snapshot()` 或 CLI JSON 中。SDK 不读取 Cookie、localStorage 或 sessionStorage，不把 `Authorization`、`X-User-Id`、Cookie 或 browser WebSocket UUID 打印或写入文件。`fetch` 与 XHR 观察失败也不会中断页面正常请求。

页面退出逻辑会执行 bridge `dispose()`、调用 `Page.removeScriptToEvaluateOnNewDocument`、清空闭包中的请求头和响应、尽力恢复当前主执行环境的 `fetch`/XHR wrappers，然后断开 flat session。它不刷新页面、不关闭标签或浏览器。

## 响应收敛

商品行只输出以下字段：

```text
product_id, product_name, category, categories, region,
avg_price, min_price, max_price, sale_cnt, total_sale_cnt,
total_gmv_amt, total_sale_gmv_amt, influencers_count,
total_video_cnt, total_live_cnt, product_rating, review_count,
cover_url, seller
```

`meta` 只输出：

```text
current_page, per_page, last_page, total, from, to
```

响应中的内部 IP、内部 path/links、邮箱、电话、联系地址和超大 `skus` 不会进入结果。`seller` 会去掉联系方式、内部链接并限制嵌套深度与数组大小。金额和周期按业务值保留。

解析阶段先保护过长的整数 token，因此 19 位 `product_id` 保持为字符串，不经过 IEEE-754 浮点截断。`sale_cnt` 保持 EchoTik 返回的数值，不把中文“万”换算成可能失真的浮点数。

成功响应必须为 `code: 0`，榜单 `data` 必须是数组。`code: 0 + data: []` 是合法空结果，会正常返回空数组。

## 限额、失败与缓存

- 每次 SDK 实例或每次 CLI 运行最多发起 5 次新业务 GET。
- 相邻两次业务 GET 至少间隔 `1500ms`。
- 不重试。
- HTTP `401`、`403`、`429`、非 0 `code`、验证码或会员墙、非 JSON 响应及网络错误都会让本次桥会话暂停。
- 不会购买会员、刷新验证码或尝试绕过站点限制。
- 页面刷新自身产生的正常 UI 请求不属于 SDK 主动业务 GET，但可能消耗平台侧额度。

标准版页面上的 daily quota 是否与这些请求一一映射，目前没有证据。SDK 不调用 `/api/v1/tools/quota`，也不假装知道每日剩余次数；需要看额度时应由用户查看正常 UI。

v0.1 没有跨进程磁盘缓存，也没有 TTL。`snapshot()` 只读取本进程内存。CLI 只有显式传 `--out` 才写文件。页面重新导航后，新 document 会自动重装桥，但必须再发生一次正常 EchoTik API 请求才能重新捕获请求头。

## 离线测试

```bash
npm run check
npm test
```

测试不连接 Edge、不请求 EchoTik，使用本地 mock 检查以下行为：

- 三级类目使用重复 `product_categories[]` 且顺序不变
- All 类目发送空字符串
- 分页、周期、国家和类目注入边界
- 商品与 meta allowlist，以及联系方式、内部链接和 SKU 清理
- `code: 0 + data: []` 的成功语义
- 19 位商品 ID 保真
- 5 次请求与 1500ms 串行间隔
- 只选择正常 `echotik.live` 页面
- 页面 closure 复用请求头，但 state/read/snapshot 不暴露凭据

## 验证状态

2026-10-22，已有Edge CDP连接＋本SDK实际运行成功：

| 周期 | 范围 | 返回条数 | 第一款ID | 周期销量显示 |
|---|---|---:|---|---:|
| 周榜 | 20261012–20261018 | 20 | 2000000000000000000 | 3645 |
| 月榜 | 20260901–20260930 | 20 | 2000000000000000000 | 1.18万 |

周榜骷髅主题2000000000000000000显示826。三件包销量与单件不能混算，显示取整值不伪装精确订单。两次读取都复用同一条CDP连接，没有再次申请浏览器授权。凭据留在页面closure中，只有经过字段白名单和脱敏的业务结果写入文件。

`evidence/weekly-live.json`、`monthly-live.json`为本SDK本轮真实结果；`live-validation-20261022.json`为验证摘要。`connection-recheck-20261022.json`与`live-attempt-20261022.json`保留初期失败，不能当最新状态。修正后新CLI独立连接、US业务、日榜和长期高频稳定性未验证。不作无限调用或永久免浏览器确认承诺。

官方连接及排障参考：
- https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md#connection-timeouts-with---autoconnect


连接后续检查：成功读取后调试连接曾以1006异常关闭，关闭原因未证实。当前不将连接持续在线或长期免确认标为已完成；已保存数据与成功业务验收保留。SDK新增共享连接isOpen()检查，断开后ready为false、主动读取立即停止，不自动重连。当前测试14/14通过。

## 2026-10-24 日榜与六榜固定采集

页面桥日榜改为接受单日YYYYMMDD，周/月仍要求起止范围；不再将日榜请求在本地误拒。默认主动请求预算保持5，显式男女日/周/月固定采集可传 `EchoTikSDK.open({connection, maxRequests:6})`，最大显式预算8，仍串行、至少1500ms、遇权限/限流/非0码停且不重试。预算是本SDK任务上限，不是会员或平台额度；不得用重新初始化来重试已失败入口。
