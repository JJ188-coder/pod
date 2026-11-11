# EchoTik Top100 SKU 导出

从 EchoTik 导出「墨西哥 → 男装与男士内衣 → 男士T恤」周榜前 100 商品的全部 SKU。

- 榜单：`top-sold` 接口，5 页 × 20 条 = 100 条
- SKU：商品详情页是服务端渲染，`__NEXT_DATA__` 里直接带 `skus`、颜色/尺码、价格、库存、颜色图
- 只读：不发写请求、不导出 Cookie/Token、不绕过会员额度
- 断点续跑：每个商品抓完立即落盘，失败记状态；重跑只补未完成
- 额度账本：按自然日记录商品页请求数，默认上限 100（标准版）

## 前置条件

1. 本机 Chrome 用调试端口启动，例如 `--remote-debugging-port=9223`
2. 该 Chrome 已登录 `echotik.live`，并打开任意 EchoTik 页面
3. Node 22+

先自检：

```bash
node cli.mjs status --week 20261026-20261101
```

## CLI

```bash
# 1) 榜单（5 次请求）
node cli.mjs rankings --week 20261026-20261101

# 2) SKU（每批 20 个，可重复执行）
node cli.mjs skus --week 20261026-20261101 --limit 20

# 3) 商品主图（按 product_id 命名，已存在则跳过）
node cli.mjs images --week 20261026-20261101

# 4) 导出
node cli.mjs export --week 20261026-20261101

# 一步跑：榜单不存在就先抓，然后抓一批 SKU + 下载主图
node cli.mjs run --week 20261026-20261101 --limit 20
```

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--week` | 上一个完整周 | `YYYYMMDD-YYYYMMDD` |
| `--category-path` | `824328,839944,601226` | 墨西哥男士T恤三级类目 |
| `--cdp` | `http://127.0.0.1:9223` | Chrome 调试地址 |
| `--data-dir` | `<plugin>/data` | 数据目录 |
| `--limit` | 不限 | 本次最多抓多少个商品 |
| `--daily-cap` | 100 | 当日商品页请求上限 |
| `--delay` | 1800 | 商品间隔毫秒 |
| `--image-delay` | 300 | 图片下载间隔毫秒 |
| `--overwrite` | 关 | 覆盖已存在的图片 |
| `--skip-images` | 关 | `run` 时跳过主图下载 |

## MCP 工具

| 工具 | 作用 |
|---|---|
| `echotik_top100_status` | 进度、覆盖率、今日额度 |
| `echotik_top100_rankings` | 抓 Top100 榜单 |
| `echotik_top100_skus` | 抓一批 SKU（默认 20） |
| `echotik_top100_images` | 下载商品主图，按 product_id 命名 |
| `echotik_top100_run` | 榜单 + 一批 SKU + 主图 |
| `echotik_top100_export` | 生成 CSV / bundle |

## 输出

```
data/<week>/
  rankings.json            Top100 榜单（保留原始展示字符串）
  state.json               每个商品状态：pending/ok/partial/failed
  skus/<product_id>.json   单商品全 SKU
  images/<product_id>.webp 商品主图（扩展名按实际格式）
  images/manifest.json     主图清单：product_id、URL、文件、字节数、SHA256
  export/top100-skus.csv   一行一个 SKU
  export/bundle.json       榜单 + SKU + 主图 + 覆盖率
data/ledger/<date>.json    当日额度账本
```

CSV 关键列：

`week, rank, product_id, product_name, sale_cnt_raw, main_image_url, main_image_file, sku_index, sku_id, sku_name, attr_color, attr_size, sku_price_val, sku_price_display, currency, sku_origin_price_val, sku_discount, sku_stock, sku_color_image_url, sku_status`

价格口径：

- `sku_price_val`：商品页原始价格（MXN）
- `sku_price_display`：页面展示价（常见 USD）
- `sku_stock`：EchoTik 展示库存；缺失为 `null`

## 额度与停止条件

- 标准版每天 100 次数据详情查看；专业版 1000 次；企业版不限次。
- 插件默认按最保守的 100 记账。专业版/企业版请显式传 `--daily-cap 1000`（或更高）。
- 达到 `daily_cap` 立即停，返回“今日详情额度已用满”，次日续跑。
- 401/403/429、验证码、会员墙：立即停，不重试、不绕过。
- 失败两次的商品不再自动重试，避免每天耗在同一批上。

## 目录

```
cli.mjs                  CLI 入口
lib/run.mjs              编排：榜单 → SKU → 导出
lib/rankings.mjs         榜单采集与校验
lib/ssr.mjs              商品页 SSR 解析与 SKU 归一化
lib/images.mjs           商品主图下载、按 product_id 命名、SHA256 清单
lib/ledger.mjs           日额度账本
lib/state.mjs            断点续跑状态
lib/export.mjs           CSV / bundle
lib/echotik-sdk/         复用已有 EchoTik 页面会话的 SDK（vendored）
mcp/server.mjs           stdio MCP
tools/cdp-eval.mjs       页面表达式调试工具
tools/verify.mjs         离线验收（榜单/SKU/CSV 一致性）
skills/                  使用说明
```

## 已知边界

- 商品页 SSR 结构属于 EchoTik 前端实现，改版时需要重新验证 `__NEXT_DATA__` 路径。
- “商品页请求是否计入会员详情次数”由 EchoTik 服务端决定；插件按最保守口径记账。
- 商品标题、图片属于原卖家，只能用于分析，不能直接复制上架。
