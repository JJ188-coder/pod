# tiktok-tshirt

把一款 T 恤做成 TikTok Shop 可用的**营销包**：并发出主图、本地排版西语竖版详情页、生成上传选图与门禁回执。

## 依赖

| 依赖 | 用途 | 缺失时 |
|---|---|---|
| `imgen` 插件 | 调用本机 Codex/ChatGPT OAuth 出图（`gpt-image-2`） | 出图工具报 `IMGEN_CLI_MISSING`；先安装 imgen，或设 `IMGEN_CLI` |
| Chrome / Chromium | 本地渲染详情页 | 报 `CHROME_MISSING`；设 `POD_CHROME` 指向可执行文件 |
| Playwright 模块 | 驱动无头 Chrome | 报 `PLAYWRIGHT_MISSING`；设 `POD_PLAYWRIGHT` 指向模块目录 |

排版不依赖 `sharp`、Pillow 或网络字体服务。

## 边界

- 只产本地文件，不写银河、Slack、卖家中心或任何平台；不提交、不发布。
- 产出 ≠ 冻结 ≠ 可上架。`pack.gate` 固定 `visual_review_required` / `frozen: false`。
- 尺码、成分、颜色只来自 spec；缺数据就缺段，不猜数字、不编颜色。
- 详情页文字是真实 DOM 文本，经 `innerText` 逐条核对，不由生图模型绘制。

## 详情页排列

依据 TikTok Shop 服装 PDP 指南与爆款长图惯例：

| 段 | 内容 |
|---|---|
| D01 | 封面：模特全貌 + 商品名 + 一句定位 |
| D02 | 正反并列：Vista frontal / Vista posterior |
| D03 | 图案特写：深色底放大印花 |
| D04 | 版型与成分：圆领、短袖、真实成分、可售尺码 |
| D05 | 颜色：只列启用颜色，附屏幕色差提示 |
| D06 | 尺码表：肩宽/胸围/衣长/袖长，cm，注明来源 |

主图遵循平台要求：白底、正面实物、≥600×600、无字无边框；Good 档要求 ≥5 张不同角度。避免杂乱拼贴、重复角度和“爆款/库存紧张/立即购买”话术。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `tshirt_marketing_run` | 按 spec 并发出主图/底图 |
| `tshirt_detail_render` | 渲染竖版详情页（6 段 + 一张长图） |
| `tshirt_pack_run` | 一次成包：主图 + 详情 + 上传选图 + `pack.json` |
| `tshirt_pack_status` | 读包、逐图复核、上传顺序 |

## spec

营销 spec：`pod-marketing-spec-v1`，字段包括 `product`（款号/版本/衣色/成分/尺码）、`galaxy`（银河前后效果与生产 PNG 的绝对路径、印位厘米）、`style`（摄影参考与风格文字）、`generation`（模型、并发、最小长边）、`jobs`（H01–H10、D01–D05）。

详情 spec：`pod-detail-spec-v1`，字段包括 `product`（标题、副标题、成分、尺码、颜色及效果图）、`images`（封面/正反/模特/印花）、`copy`（西语短句）、`size_table`（真实表头与数值，可缺省）、`theme`（底色/墨色/强调色）。

两个 spec 都要求图片使用**绝对路径**；换款必须换自己的真实尺码表，不能沿用其他款。

## 输出

- `主图/`：H01…H10 各一张 PNG，默认 1:1。
- `详情页/`：D01…D06 分段 PNG（1080×1350）+ `JCxxx_detail_full_*.png`（1080×8100）。
- `manifest.json`：每张图的提示词 SHA、参考图 SHA、像素、比例、文件 SHA、耗时、视觉复核。
- `detail-manifest.json`：分段/长图像素与 SHA、文案核对结果。
- `pack.json`：上传顺序（最多 9 张，H01 起）、主图与详情门禁。
- `rejected/`：重跑前的旧图，保留不覆盖。

## 限制

- 生图约 1.5MP，不是 4K；营销图不承担印花清晰度门槛。
- 详情长图 1080×8100；平台按单图上传时用分段 PNG。
- 图案逐像素一致性、版式与文案仍需人工过目后才算 F2 冻结。
