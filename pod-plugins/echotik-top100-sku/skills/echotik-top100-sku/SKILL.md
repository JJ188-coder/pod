---
name: echotik-top100-sku
description: 从 EchoTik 导出「墨西哥 → 男装与男士内衣 → 男士T恤」周榜前 100 商品的全部 SKU。用于选品复盘、变体结构分析、价格带与库存参考。只读、断点续跑、按日额度记账；需要本机 Chrome 调试端口且已登录 EchoTik。
---

# EchoTik Top100 SKU 导出

## 什么时候用

用户要：

- 墨西哥男士T恤周榜前 100 商品
- 每个商品的全部 SKU（颜色、尺码、SKU ID、价格、库存、颜色图）
- 导出 CSV / JSON 做分析或选品

不适用于：库存实时监控、下单、改价、抓取买家信息。

## 前置条件

1. 本机 Chrome 以调试端口启动（默认 `9223`）。
2. 该 Chrome 里已登录 `echotik.live`，并至少打开一个 EchoTik 页面。
3. Node 22+。

先调用 `echotik_top100_status` 确认环境和进度；如果报“没有可附加页面”，让用户打开 EchoTik 页面，不要自己去启动或接管浏览器。

## 推荐流程

```
echotik_top100_status      → 看有没有榜单、已抓多少、今日额度
echotik_top100_rankings    → 只在没有榜单时调用（5 次榜单请求）
echotik_top100_skus        → 每次 limit=20，重复调用直到 pending=0
echotik_top100_images      → 下载商品主图，按 product_id 命名
echotik_top100_export      → 生成 CSV 与 bundle
```

`echotik_top100_run` 可以合并“榜单 + 一批 SKU + 主图”，但首次跑仍建议先 status。

## 额度规则

- 标准版会员：每天 100 次“数据详情查看”；专业版 1000 次；企业版不限次。
- 插件默认 `daily_cap=100`（最保守）；专业版请显式传 `daily_cap=1000`，企业版按需。
- 达到上限立即停，返回 `今日详情额度已用满`，不要绕过。
- 不要为了跑完 100 个商品就默认放宽额度；先确认会员版本。
- 抓取间隔默认 1800ms，串行；不要并发轰接口。
- 遇 401/403/429、验证码、会员墙：立即停，让用户重新登录或等额度恢复。
- 禁止：多账号轮换、代理池、伪造区域/币种、绕过计次。

## 数据口径

- 榜单 `sale_cnt_raw` / `total_sale_cnt_raw` 是**展示字符串**（可能含“万”），不要直接当数字。
- SKU 价格 `sku_price_val` 是商品页原始价格（MXN）；`sku_price_display` 是页面展示价（常见 USD），两者不要混用。
- `sku_stock` 是 EchoTik 展示的库存；缺失时为 `null`，不要当 0。
- 周期必须一起标注：`week=YYYYMMDD-YYYYMMDD`，默认上一个完整周。

## 输出

```
data/<week>/rankings.json           Top100 榜单
data/<week>/state.json              每个商品抓取状态
data/<week>/skus/<product_id>.json  单商品全 SKU
data/<week>/images/<product_id>.webp 商品主图（按商品 ID 命名）
data/<week>/images/manifest.json    主图清单（URL、文件、字节数、SHA256）
data/<week>/export/top100-skus.csv  一行一个 SKU，含主图 URL 与本地文件列
data/<week>/export/bundle.json      榜单 + SKU + 主图 + 覆盖率
data/ledger/<date>.json             当日额度账本
```

## 结果汇报

至少说明：

- 周区间、榜单条数（应为 100）
- SKU 覆盖：`ok / partial / failed / missing`
- SKU 总行数
- 主图覆盖：`ok / failed / missing`，以及 `images/` 目录
- 今日已用额度 / 上限
- 失败商品 ID 与错误码（如果有）
- CSV 绝对路径

## 使用边界

- 只读自己的会员数据，不导出凭据、Cookie、Token。
- 商品标题和图片属于原卖家：可以分析结构与价格带，不能直接复制上架。
- 数据是第三方估算，写报告要标来源与周期。
