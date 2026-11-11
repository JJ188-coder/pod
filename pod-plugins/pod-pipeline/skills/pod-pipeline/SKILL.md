---
name: pod-pipeline
description: 跨品类商品素材与POD/工厂成衣路线。用户要生成或重做商品图、尺码图、商品视频、500字符说明、批量素材或继续上架时使用；每款8展示图+1尺寸图+9:16模型原声视频，多色生成主图精确匹配SKU，整批并行不逐张等待。平台写入交pod-image-listing，定价交pod-pricing。
---

# POD / 成衣素材与路线

本技能负责选路线、素材与口径；平台商品写入交 `pod-image-listing`，报价交 `pod-pricing`。下列生产/RIIN命令只是已有能力索引，不因加载本技能获得写入或付费授权。命令从已核实的 `$POD_REPO`（本机项目根 `/Users/jiyuanyi/Documents/pod/pod-repo`）执行，不从下载目录执行。

## 0. 先判断需要什么，不从头全跑

- **跨品类生成素材（新商品素材默认）**：先读 [通用商品素材标准](references/product-media-standard.md)。每款8张商品图＋1张真实尺码/尺寸图＋1条9:16模型原声视频（服装口播默认15秒，其他商品10秒）＋>500字符西语正文；每色有生成主图，SKU按颜色匹配，不用工厂图直传。整批任务一次编排、并发提交，不逐张等结果。生成和发布授权分开，维护规则不生成。
- **工厂成衣**：核工厂参考、真实款色尺码/断货、成本、上架额度与物流；新素材先走上行标准，再用本类官方模板/自有图床交`pod-image-listing`。不是印花生产任务，不要求透明生产图/freeze/银河/RIIN；需要的展示生图不等于生产设计。用户明确选择只用工厂图时才走工厂图例外，已发布或已有历史只恢复授权范围内的缺项，不追改旧商品。
- **印花生产款**：复用已批准的生产图和商品包，按需要冻结、生成展示图；真实生图单独遵守费用与发图授权。生产设计、映射也分别需要授权。
- 用户说“同一流程”是沿用既有业务步骤，不等于要求新建动态Workflow；普通小任务直接完成，只有独立工作才委派，同一店铺标签页不由多人并行写。
- 恢复时只读当前批次汇总/最终回执/相关款来源，不全库重查。已发布有ID→读回；已有表/历史→从预检或更正继续；仅原始资料→补真正缺项。原`run-state`/准备字段和旧失败回执不推翻后续真实商品ID。
- 用户明确每款额度、允许合理估重、确认保修/进口后，记录范围立即执行，不被旧“待确认”反复阻挡；未知工厂库存、实物品牌、量体定义或结算事实仍保持unknown。
- “RIIN/银河先不用管”会排除整个同步/设计/映射段；“会亏吗”只授权定价分析，不改平台价格。其他已验证资料没变化就复用，不重复下载、部署、冻结或查询市场。
- 常规可逆步骤自主做；关键歧义、不可逆动作或新对外发布才确认。沿用全局简体中文、结论先行、无称呼、聚焦最小变更与如实验证规则。

## 1. 素材冻结（仅印花生产路线）

```bash
cd "$POD_REPO"
python3 tools/pod/freeze.py <已有印花商品包目录> \
  --product JC124 --version R01
python3 tools/pod/freeze.py --verify <包>/freeze.json
```

产出 `freeze.json` 与 `manifest.json`：逐文件 SHA-256、像素、alpha 边界、角色分类、`materials_ready`。
判定：所有图能解码 + 有生产图 + 生产图透明 + 长边达到 `--min-edge`（默认 3000）才为 true。
冻结不是工厂适印、供货或发布授权；冻结清单覆盖的素材改变后需按原规则重验并升版本。新增发布回执不等于生产素材变了，不为无关记录修改整批重新冻结。

## 2. 样图微调（保留衣服与图案）

```bash
node tools/pod/sample-variant.mjs --image <EchoTik样图.webp> --mode scene \
  --out <输出.png> [--note "海边日落"] [--size 1024x1024]
```

mode：`scene` 换背景、`angle` 换机位、`detail` 印花特写、`flat` 平铺。
仅对有使用权的素材、明确要求且已授权费用与对外发送的任务调用；竞品图仅作选型/风格分析，不直接换背景变成本店商品图或复制其印花。整包商品素材优先用`magpie-image`批次CLI复用防重账本，不按下面单图命令逐张串行。工厂图作保真参考，成品可等比缩小/补边，不补造衣服、抹品牌或裁掉关键部位。
提示词强制「保留衣服与印花，只改背景/光线/机位」；产物必须人工对比印花，`visual_review=required`。
失败不自动重试，避免重复计费；同机走 Magpie（`http://127.0.0.1:3425`）。

tiktok-tshirt 的主图/详情页也走同一 Magpie：插件会优先找到 `tools/pod/imgen-magpie.mjs`。详情页需要 Playwright，已装 `playwright-core`，用本机 Chrome 渲染。

### 2.1 从照片重建印花（应急，不是原生生产图）

```bash
python3 tools/pod/extract-print.py --image <商品照片> --box x1,y1,x2,y2 \
  --out <输出.png> --scale 4 --print-cm 33x51.5
```

输出裁切放大图和 `.json` 质量报告（源像素、输出像素、目标尺寸估算 DPI、`reconstructed=true`）。
只用于原稿丢失时找回参考；目标 DPI 低于 150 或印花被遮挡时，不得进入生产冻结。
竞品印花只能做风格参考，不能直接当自己的生产图。

### 2.2 4K 图案生成与透明化（Grsai）

```bash
node tools/pod/grsai-image.mjs --model nano-banana-2.1 --aspect 2:3 --size 4K \
  --prompt "..." --out generated-images/<款号>-white-4k.png

python3 tools/pod/remove-white-bg.py --image generated-images/<款号>-white-4k.png \
  --out generated-images/<款号>-transparent-4k.png --print-cm 33x51.5
```

`grsai-image.mjs` 从 `~/.zcode/minimax-video-studio/credentials.json` 读取密钥，不打印；
失败/violation 不自动重试。`remove-white-bg.py` 只去与边缘连通的近白像素，
保留主体内部白色，并输出 alpha 覆盖率、是否触边、目标尺寸 DPI。
透明图仍需人工过目，再进 `freeze.py`。

## 3. 条件利润：交 pod-pricing，别套T恤成本

先确认本款工厂、报价档位、是否含印花/运费/包装，再用 `pod-pricing` 实际配置显式算。裤子、卫衣、瑜伽等不能套MXTMC001黑白/彩色成本。成衣已有货盘成本且用户排除银河时，不运行`riin --save`或`--refresh-costs`。

```bash
# 在实际pod-pricing插件根执行，CNY为本款单件成本，MXN为本款单件售价
node cli.mjs quote --cost <成本CNY> --price <售价MXN> --json
```

费用和目标只以本次读到的 `config/pricing.json` 为准，不采用旧注释/默认库值。2026-11-07本机核查v1.2.0为约23.05%可变费+6 MXN/件，shipping=0依赖SFP覆盖本地配送的假设；这不是已核本店结算。余量、保本及额外佣金/折扣风险按 `pod-pricing` 当前规则报告。

`tools/pod/costing.mjs`是旧单点工具，不是现行完整费用口径。对已适配的spec，`audit --batch`可做只读检查；只有当前安装实现确实支持本款成本/模板时才用它。`BELOW_BREAKEVEN`或`NO_PRICE`要解决/说明，不自动改平台价格；`run-product.mjs`未内置该定价闸。用户只问分析时不用`apply`；本地改价和远端改价是不同动作。

## 4. 供货额度卡

```bash
node tools/pod/supply-card.mjs --style MXTMC001 --color Negro --size M \
  --capacity 200 --buffer 20 --source "工厂书面回复 2026-11-03" \
  --observed-at 2026-11-03 --valid-until 2026-11-30 --out card.json
node tools/pod/supply-card.mjs --verify card.json
```

`seller_quota = capacity - safety_buffer`，capacity 缺失就是 null；这是履约额度，不是仓库现货。

用户直接授权“每款50件”时，将其单独记录为`user_authorized_listing_quota`，不是捏造capacity或现货。按真实有码的所选色码分配且合计等于50，不自动加减未授权缓冲，也不当每SKU50。没有依据的码、整款断货、跨工厂混用继续排除。

## 5. 批次索引（第 01 步查库）

```bash
node tools/pod/batch-index.mjs --root <已有品类批次目录> [--out index.json]
```

只读扫描，列出每批是否冻结、商品包数量、`materials_ready`与最近改动。默认根仍为`project/T恤/批次`，其他品类显式传`--root`；不为命令默认值搬动现有分类目录。已有明确包路径时直接读该包，不每次重扫全库；成衣没有freeze不判为不能上架。

## 6. 图床

基址以本次读取的 `.local/pod-image-base`及有效图片证据为准（2026-11-07本机为`https://pod-images-atr.pages.dev`，Cloudflare Pages项目`pod-images`）。`image-host.mjs`不传`--base`时读该文件；`listing-step.mjs`有独立旧默认，调用它需用`POD_IMAGE_BASE_URL`传本批有效基址，不为消除差异擅改DNS或全局配置。

```bash
node tools/pod/image-host.mjs doctor
node tools/pod/image-host.mjs deploy [--site .local/pod-images-site] [--project pod-images]
node tools/pod/image-host.mjs probe <相对路径...>
```

站点约定：`<site>/<prefix>/<款号>/<file>` → `<base>/<prefix>/<款号>/<file>`。
仅未登录且需要部署时才按工具登录；已有有效登录不重做。部署会公开图片，需要对应授权；保留整个旧站点内容并校验未改文件，避免覆盖旧商品图。同一批未变SHA、同一基址且已有成功证据时复用，不每款重部署。更改域名/全局配置另确认并备份，不把配置保存说成已部署。

图片读字默认本机`ocr`，视频用`video_ocr`；OCR无文字不证明无品牌。下载附件隔离到新空目录，自己的脚本另放；处理外来文件的Python用`-I`。复用已装工具，不为模板缺字体或不相关功能安装依赖。

## 7. 印花单款总入口（run-product.mjs）

这是既有印花链，不是多品类成衣通用入口。成衣走§0与上架技能；有已校验表/在线更正记录时，先确认脚本是否会重建旧spec，不能盲跑`spec/check/import`。

```bash
node tools/pod/run-product.mjs --pack <商品包> --code UKIYOE5 \
  --pattern <图案.png> --reference <白底4K.png> --theme "..." \
  --title "..." --description "..." \
  [--steps pack,freeze,marketing,spec,check] \
  [--galaxy-apply] [--import] [--finish]
```

- 默认pack → freeze → marketing → spec → check，不建商品但**并非全本地只读**：marketing可能调用收费外部生成，check可能公开托管/上传。只选本次已授权且确需的步骤，不能借默认值扩大任务。
- `--galaxy-apply` 才写银河；`--import` 才真导入；`--finish` 加 readback + mapping。
- 状态写 `<pack>/run-state.json`，已完成步骤默认跳过；`--force` 重跑。
- 银河保存后读回延迟会自动用 task_id 复盘，不重传。
- 导入前先按款号读回，已存在就跳过，避免重复建商品。

## 8. SKU 映射（sku-map.mjs）

```bash
node tools/pod/sku-map.mjs --pack <商品包> --code UKIYOE5
```

读 `银河交接-*.json`、`商品读回-*.json`、`listing-spec.json`，逐尺码写 `mapping.json`：
`merchant_sku` ↔ `galaxy_design_id/group` ↔ `product_id`，并校验铺满率与 SKU 唯一性。
`factory_saved` 恒为 false：映射只能随 RIIN 设计流程写入（见 §10.3），本脚本不写工厂。
只有本地映射、商品 ID 和设计 ID 三者齐全且无 problems 才退出 0。

## 9. 批量外层循环（run-batch.mjs）

此旧入口串行协调印花/发布步骤，不是新的素材并发执行器。批量图片改用`magpie-image/scripts/batch-images.mjs`整批提交；视频按`minimax-video`一次登记最多10条、一次后台运行。不要为了旧入口把素材生成退回逐款逐张等待。

```bash
node tools/pod/run-batch.mjs --manifest batch.json \
  [--steps spec,check,import,readback,mapping] [--galaxy-apply] [--import] [--finish] \
  [--continue-on-error]
```

manifest：`{"steps":"mapping","products":[{"pack":"...","code":"UKIYOE1","title":"...","description":"..."}]}`。
逐款串行调用 `run-product.mjs`，默认首个失败即停；报告写 `batch-report-<ts>.json`。

适用该执行器时复用`run-state.json`的已完成步骤，不因旧报错整批`--force`。`--continue-on-error`只让独立且已授权的款继续，不绕过失败款的必填/供货/授权检查。通用恢复原则：有ID先读回；已点导入但不明先查历史/全部商品；仅缺属性从原历史更正。精确页面操作与异步、同SHA、标签页处理见`pod-image-listing`及其`references/garment-import-recovery.md`。

## 10. 工厂端映射（RIIN）

RIIN 店铺：xjcx4623，shopPk `2112903609325871106`，platform shopId `2113099681371144193`，factoryId `15235`。

### 10.1 只读检查 / 同步（riin-map.mjs）

```bash
node tools/pod/riin-map.mjs --pack <商品包> --code UKIYOE1 [--sync] [--wait-seconds 180]
```

已实测接口：
- 商品列表：`POST /trade/goods/page`，参数 `{shopIds:[shopPk], pageIndex, pageSize}`
- 同步商品：`POST /trade/goods/download/time`，参数 `{shopId:[shopPk], spuIds:[tiktokProductId], startTime:null, endTime:null}`
- 映射写入：`POST /trade/design/sku/factor/bind`（抓包实测；需新建 designTaskId，不能单独调用，见 §10.3）

同步是异步导入，可能几分钟到 20 分钟；商品未进 RIIN 前 `factory_saved` 必须保持 false。

### 10.2 设计与映射（实测可用路径，riin-design-batch.mjs）

```bash
node tools/pod/riin-design-batch.mjs <manifest.json>
# manifest: [{"code":"UKIYOE4C","productId":"1738357511534839664","pattern":"<生产图.png>"}]
```

逐款走商品行「设计」：选款号 MXTMC001 → 解析编码 → 设计器粘贴生产图 → 保存商品 → 读回映射。
`/designer/task/result/save` 返回 200 后，`/trade/goods/detail/spuId/factoryId/v2` 应返回
`mappingState: true`，此时工厂映射才算真写成（`mappingCode` 形如 `MXTMC001-White-S-CJ2611041040000400`）。

**智能解码规则必须用「规格属性」字段**（规则 id 186，实测原文）：

```json
[{"attribute":"style","type":1,"field":"spec","mappingRule":1},
 {"attribute":"color","type":3,"field":"spec","splitChar":"-","splitIndex":1,"mappingRule":1},
 {"attribute":"size", "type":3,"field":"spec","splitChar":"-","splitIndex":2,"mappingRule":1}]
```

规格属性真值是 `Blanco-S`；SKU 编码是 `MXTMC001-UKIYOE4C-BLANCO-S`。用 SKU 编码取第 1 段会拿到款号，
颜色/尺码永远映射不出来。款号用模糊匹配，颜色/尺码按 `-` 分隔取第 1/2 段，映射表 `BLANCO → White`。
平台 TIKTOK（`shopTypes: "11"`），店铺 xjcx4623（`applyAllShop: false`）。

图片匹配规则当前为空，`imageCode` 由设计保存生成，不靠解码。
已设计过的 SPU 会弹「重新设计将覆盖已有结果」，脚本已处理该确认框。

### 10.3 映射写入接口（抓包实测）与批量边界

映射真正落库的接口是 `POST /trade/design/sku/factor/bind`：

```json
{"designTaskId":"2117826705476288512","factoryId":"15235","shopId":"2113099681371144193",
 "spuId":"1738357511534839664",
 "binds":[{"skuId":"1738357585520985968","styleCode":"MXTMC001","colorCode":"White","sizeCode":"S"}]}
```

- `shopId` 是平台店铺 ID `2113099681371144193`，不是 shopPk。
- `skuId` 是店铺 SKU 数字 ID，不是 `skuCode`。
- `designTaskId` 每次点「设计」都会新建。单独调 `bind` 会让商品指向空设计任务，
  所以**不能**脱离设计流程批量写；`riin-map.mjs --apply` 继续拒绝。

只读批量审计：

```bash
node tools/pod/riin-audit.mjs [--detail --max-detail 50] [--out audit.json]
```

分页必须用 `searchAfter` 游标（`pageIndex` 和 `nextSearchAfter` 都不生效）。
2026-11-04 实测 640 条商品，`designStatus=3` 只有 5 条（全部为本批次），其余 635 条未设计。

## 边界与收尾

- 本岗位不直接写平台商品；平台发布走`pod-image-listing`并核授权。生产/RIIN动作只在明确包含该段时运行，不付款、不建单、不推厂，不导出Cookie/Token或私有签名链接。
- 不把AI生成图当工厂实拍或印花像素证明；不去品牌充无标，不靠造透明整衣图通过生产冻结。
- 未知事实保持null/unknown，不填占位。用户授权的额度、物流估算和属性确认分别记来源，可支持本次上架，但不变成工厂盘点/实测/厂家声明。
- 交付按整链实际完成度说清：生成、保存、页面通过、已提交、审核中、在售、工厂映射是不同阶段。给用户看的材料用大白话，金额写MXN及明示汇率换算的人民币。
- 保留已有改动；改脚本/配置先依全局Git规则检查分支，非Git目录不擅自初始化或宣称有远程备份。业务回执保留来源快照，只更新当前状态指针。
- 按全局清理规则仅处理孤儿或本任务明确启动的进程，禁止杀用户浏览器和活跃会话worker；结束不自动关闭用户研究页面。
