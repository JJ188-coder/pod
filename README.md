# POD Toolkit（TikTok Shop 墨西哥 POD 全流程工具包）

把「选品 → 印花设计 → 商品图 → 批量上架 → 发货」串成可复现流水线的开源工具集，面向 TikTok Shop 墨西哥站的 POD（Print-on-Demand，按需打印）业务。

> 本仓库只包含**代码与文档**。商品图、视频、供应商货盘、真实上架回执、账号登录态等业务与媒体资产未包含在公开范围内。

## 目录

| 路径 | 内容 |
|---|---|
| `pod-plugins/` | 9 个 ZCode 插件：批量上架、银河设计、T 恤营销包、Slack 图案接收、EchoTik 榜单、生图工作室、视频工作室、素材管道、定价助手 |
| `pod-repo/tools/` | 上架主链路脚本：图片校验、规格生成、批量表构建、页面预检与发布 |
| `pod-repo/docs/` | 银河（RIIN）OpenAPI 接口手册 |
| `pod-repo/RUNBOOK.md` | 本机跑通手册：每条命令与通过标准 |
| `pod-repo/FLOW-FROZEN-v1.md` | 冻结的流程定义 |
| `POD全流程工具包-20261103/` | 教学文档、现行标准、环境配置、工具脚本、安装与排障 |
| `EchoTik接口包-20261103/` | EchoTik 只读 SDK、接口契约与离线测试 |
| `.agents/skills/pod-execution-guard/` | 执行护栏：本地检查与发布边界 |

> `POD全流程工具包-20261103/` 为节选：保留教学、标准、工具与安装文档；其中的插件副本、示例素材、教程截图与真实上架回执未包含，插件请直接使用 `pod-plugins/`。`EchoTik接口包-20261103/` 的 `samples/` 与 `依据/` 同样未包含。

## 能做什么

- **选品**：抓取 EchoTik 墨西哥男装榜单与商品全 SKU（只读、断点续跑、按日额度记账）。
- **设计**：把图案交给银河/工厂出图，锁定款号去重与保存重开读回。
- **素材**：校验主图数量、格式、尺寸、比例；生成西语竖版详情页。
- **上架**：生成 TikTok Shop 官方批量表，先在页面预检，再显式 `--apply` 导入，逐款读回商品 ID。
- **定价**：按成本、平台费、运费与市场价带反解售价，输出可复核的报价。
- **护栏**：发布前重算成本与素材，亏损、缺料或素材不符直接阻止。

## 快速开始

环境：Node.js ≥ 24、Python 3、`playwright-core`。

```bash
# 1. 装插件（ZCode / Codex 插件市场）
#    把 pod-plugins/marketplace.json 注册为本地市场，或直接安装各插件目录

# 2. 只读体检
POD_REPO=/path/to/pod-repo node pod-plugins/pod-image-listing/scripts/listing-step.mjs doctor

# 3. 图片门：逐张校验，不碰店铺
POD_REPO=/path/to/pod-repo node pod-plugins/pod-image-listing/scripts/listing-step.mjs check \
  --spec /path/to/listing-spec.json --prefix DEMO --out /tmp/DEMO.xlsx

# 4. 页面预检通过后，才显式发布
POD_REPO=/path/to/pod-repo node pod-plugins/pod-image-listing/scripts/listing-step.mjs publish \
  --spec /path/to/listing-spec.json --prefix DEMO --apply
```

详细步骤见 [`pod-repo/RUNBOOK.md`](pod-repo/RUNBOOK.md) 与
[`POD全流程工具包-20261103/START-HERE.md`](POD全流程工具包-20261103/START-HERE.md)。

## 设计原则

- **默认只读**：校验、预检、报价都不写平台；真实导入必须显式 `--apply`。
- **先证据后结论**：页面预检、逐款读回、文件指纹与回执，不以“文件已生成”代替验收。
- **提交未知不重发**：收费或异步任务结果不明时先查原任务，禁止换 ID 盲目重试。
- **护栏优先**：成本缺失、亏损、素材不符、额度不明时阻止写入。

## 未包含的内容

以下内容属于业务资产或第三方素材，不在本仓库与 MIT 授权范围内：

- 商品图、生成图、视频、PSD/TIF 等媒体文件；
- 供应商货盘、报价表、联系方式；
- 真实上架回执、店铺与账号信息；
- 登录态、Cookie、API 密钥、本地配置与运行日志；
- TikTok / EchoTik / 银河等平台的官方模板与受版权保护的素材。

仓库中的代码示例使用占位数据；文档里的店铺、品牌、供应商、账号与商品标识已替换为占位符，历史数量与价格仅作业务背景。插件默认使用作者自有的公开基础设施域名（`img.bri-king.com`、`image2.bri-king.com`、`pod-images-atr.pages.dev`），这些是真实可访问的默认值、不是占位符，可按需替换。真实运行需要自备账号、密钥与平台模板。

## 许可证

本项目自有代码与文档采用 [MIT License](LICENSE)。

`pod-plugins/tiktok-tshirt/` 保留其原有 MIT 版权声明；引用第三方依赖时以各依赖自身许可证为准。

MIT 仅覆盖本仓库中由本项目作者拥有权利的代码与文档，不覆盖任何第三方平台、供应商、商标、字体、图片、视频或模板。使用前请自行确认所在平台的服务条款与当地法规。

## 贡献

欢迎提交 Issue 与 Pull Request。涉及平台写入、真实收费或账号数据的改动，请先在 Issue 中说明授权与验证方式。
