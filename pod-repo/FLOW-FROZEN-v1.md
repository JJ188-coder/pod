# POD 墨西哥 T恤 · 流程固化 v1

固化时间：2026-11-04　验证范围：5 款真实商品、30 个工厂 SKU 全链路跑通
适用：`/Users/jiyuanyi/Documents/pod/pod-repo`（下称 `$POD_REPO`）

本文件只记录**已经在本机真实跑过、有证据文件**的路径。没跑过的写在 §8，不混进来。

---

## 1. 主链路（12 步，顺序固定）

```
【素材】①生产图 → ②建包冻结 → ③营销图 → ④规格表 → ⑤定价
【上架】⑥页面预检 → ⑦银河设计 → ⑧真导入 → ⑨读回
【映射】⑩本地映射 → ⑪RIIN 设计绑定 → ⑫工厂映射读回
```

| # | 步骤 | 命令 / 入口 | 通过标准 | 证据文件 |
|---|---|---|---|---|
| ① | 生产图 | `grsai-image.mjs` → `remove-white-bg.py` | 4K、透明、长边≥3000、不触边 | 生产图 + sidecar |
| ② | 建包冻结 | `python3 tools/pod/freeze.py <包> --product <款号> --version R01` | `materials_ready: true` | `freeze.json` / `manifest.json` |
| ③ | 营销图 | `node tools/pod/marketing-pack.mjs` | 1 主图 + 8 变体 + 3:4 上传图 = 9/9 | `marketing-manifest.json` |
| ④ | 规格表 | `python3 tools/pod/make-listing-spec.py` | 9 张图 URL 可访问、尺码 S–3XL | `listing-spec.json` |
| ⑤ | 定价 | `node <pod-pricing>/cli.mjs apply --spec <包>/listing-spec.json --apply`（先跑 `audit`） | 无 `BELOW_BREAKEVEN` / `NO_PRICE`，余量落在 1–3 元 | `pricing-report.json` |
| ⑥ | 页面预检 | `node tools/pod/run-product.mjs --pack <包> --code <款号>`（默认 steps 含 check） | 预检 0 错误 | `证据/<款号>-页面预检.xlsx` |
| ⑦ | 银河设计 | 同上加 `--galaxy-apply` | `fill.sku_rows > 0 && all_full`（48 SKU，铺满 100%） | `银河交接-<款号>-*.json` |
| ⑧ | 真导入 | 同上加 `--import` | `imported === 1` | `商品读回-*.json` |
| ⑨ | 读回 | 同上加 `--finish` | 拿到 product_id + 在售/审核中 | `证据/商品读回-*.json` |
| ⑩ | 本地映射 | `node tools/pod/sku-map.mjs --pack <包> --code <款号>` | 6 行、SKU 唯一、`factory_saved:false` | `mapping.json` |
| ⑪ | RIIN 设计绑定 | `node tools/pod/riin-design-batch.mjs <manifest.json>` | `mappingState: true` | `证据/RIIN映射读回-*.json` |
| ⑫ | 工厂映射读回 | 与 ⑪ 同一步完成（设计保存即写映射） | 6/6 mapped | 同上 |

一条命令跑 ②–④ 与 ⑥–⑨（定价 ⑤ 单独跑，run-product 尚未内置）：

```bash
cd $POD_REPO
node tools/pod/run-product.mjs --pack <包> --code <款号> \
  --pattern <生产图.png> --reference <白底4K.png> --theme "..." \
  --title "..." --description "..." \
  --galaxy-apply --import --finish
```

多款串行：

```bash
node tools/pod/run-batch.mjs --manifest batch.json --steps spec,check,import,readback,mapping \
  --galaxy-apply --import --finish [--continue-on-error]
```

状态写 `<包>/run-state.json`，已完成步骤默认跳过，`--force` 重跑。

### 1.1 定价（pod-pricing 0.1.0，2026-11-04 锁定）

```bash
cd <pod-pricing>            # ~/.zcode/cli/plugins/cache/pod-toolkit/pod-pricing/0.1.0
node cli.mjs riin --save    # 读银河当前打印报价，写 data/costs/latest.json
node cli.mjs audit --batch <批次目录>          # 只读审计
node cli.mjs apply --batch <批次目录> --apply  # 写回 listing-spec.json 的 price
```

口径锁在 `config/pricing.json`（v1.0.0），改口径只能改文件并升版本，不在命令行漂移。
费率合计约 **29.05% + 6 MXN/单**；反解：`售价 = (成本CNY/汇率 + 6 + 目标余量CNY/汇率) / (1 - 29.05%)`。

实测（黑白单面，成本 15 CNY，汇率 0.39）：

| 售价 | 条件余量 | 说明 |
|---|---|---|
| 70 MXN | 5.2 MXN ≈ 2.03 CNY | 起量价，保本价 62.67 |
| 123 MXN | 42.8 MXN ≈ 16.69 CNY | 现线上价，贵但走得慢 |

现状：4 款本地 spec 已改成 70（CLOWN01 仍是 123），**线上商品仍是 123**，改价要在平台重新提交。
`run-product.mjs` 还没内置定价步骤，跑之前要先单独执行 `apply`。

---

## 2. 五道闸门（少一道都不算过关）

1. **素材闸**：`freeze.json.materials_ready === true`。改任何文件都要重新冻结并升版本号。
2. **银河闸**：设计对象存在且 48 SKU 铺满 100%。0 SKU 的空对象必须弃用重做，不能带病往下走。
3. **发布闸**：`imported === 1` 且读回到真实 product_id + 状态。预检通过 ≠ 已上架。
4. **映射闸**：RIIN 读回每条 SKU `mappingState === true`，6/6 才算工厂侧真的收到。
5. **定价闸**：`audit` 无 `BELOW_BREAKEVEN` / `NO_PRICE`，余量落在 1–3 元；亏损价不许上架。

`factory_saved` 只有在第 ⑫ 步读回 `mappingState: true` 之后才算真，之前一律 false。

---

## 3. 环境常量（已核实，勿随手改）

| 项 | 值 |
|---|---|
| 仓库 | `/Users/jiyuanyi/Documents/pod/pod-repo` |
| 官方模板 | `project/T恤/批次/B20261026-NODE-WORKFLOW-01/官方模板/Tiktoksellercenter_男装与男士内衣_20261027_男士T恤_template.xlsx` |
| 模板版本 / SHA-256 | V5.0.2 / `<模板指纹未公开>` |
| 图床基址 | `https://pod-images-atr.pages.dev`（Cloudflare Pages 项目 `pod-images`） |
| 店铺 | tk-shop-a / BRAND-A；在售 600+（2026-11-04 实测），未发现 300 款总量上限 |
| 工厂款号 | `MXTMC001`（180G T恤成人款-墨西哥） |
| RIIN shopPk | `2000000000000000001` |
| RIIN platform shopId | `2000000000000000002` |
| RIIN factoryId | `10001`（tenant 10002 / Brk） |
| 生图模型 | Grsai `nano-banana-2.1`，`imageSize: 4K`，约 1 分钟/张 |
| 商品参数 | Blanco × S/M/L/XL/2XL/3XL，123 MXN，库存 30 |

---

## 4. 图片门限

- 格式 JPEG/PNG，单张 ≤ 5 MB，最短边 ≥ 600。
- 首图宽高比 3:4 ~ 4:3。做 3:4 时宽度取 `floor(H*0.75)+1`，否则 1148/1531=0.7498 会被判 0.75 不过。
- 生产图：透明背景、长边 ≥ 3000、主体不触边。
- Cloudflare 边缘缓存会短暂返回旧图：新图用新 key，或部署后等一会儿再探针。

---

## 5. RIIN 智能解码规则（实测原文，id=186）

接口：`POST /trade/decode/rule/page`　返回 `ruleJsonV2`：

```json
{"id":"186","name":"MXTMC001-Blanco","shopTypes":"11","priority":1,"status":true,
 "productType":0,"applyAllShop":false,"creator":"creator-a","createTime":"2026-11-04 10:07:20"}
```

```json
[
 {"attribute":"style","priority":1,"type":1,"field":"spec","mappingRule":1},
 {"attribute":"color","priority":1,"type":3,"field":"spec","splitChar":"-","splitIndex":1,"mappingRule":1},
 {"attribute":"size", "priority":1,"type":3,"field":"spec","splitChar":"-","splitIndex":2,"mappingRule":1}
]
```

要点（这三条是踩坑换来的）：

1. **取值字段必须是「规格属性」（`field: "spec"`）**，不是 SKU 货号、不是 SKU 编码。
   规格属性的真值是 `Blanco-S`，SKU 编码是 `MXTMC001-UKIYOE4C-BLANCO-S` —— 用编码取第 1 段会得到款号，整条规则就废了。
2. 款号用**模糊匹配**（`type:1`），因为规格属性里根本没有款号。
3. 颜色/尺码用**按分隔符**（`type:3`），`-` 分隔，颜色取第 1 段，尺码取第 2 段；映射表 `BLANCO → White`，尺码同名。
4. 适用平台 TIKTOK（`shopTypes: "11"`），店铺 shop-a（`applyAllShop: false`）。
5. 图片匹配规则当前为空（`暂无规则`）；`imageCode` 由设计保存时生成，不靠解码。

### 5.1 工厂映射写入接口（实测原文，2026-11-04 抓包）

`POST /trade/design/sku/factor/bind`

```json
{
  "designTaskId": "2000000000000000003",
  "factoryId": "10001",
  "shopId": "2000000000000000002",
  "spuId": "2000000000000000000",
  "binds": [
    {"skuId": "2000000000000000000", "styleCode": "MXTMC001", "colorCode": "White", "sizeCode": "S"},
    {"skuId": "2000000000000000000", "styleCode": "MXTMC001", "colorCode": "White", "sizeCode": "M"}
  ]
}
```

返回 `{"successful":true,"message":"","errorCode":"","data":null}`。

UI 里实际调用顺序：`goods/page/v2` → `design/product/page` → `goods/detail/spuId/factoryId/v2`
→ `product/decode`（智能解码）→ `design/style`（产出 `designTaskId`）→ `bind` → 设计器保存。

三个字段坑：

- `shopId` 是**平台店铺 ID** `2000000000000000002`，不是 shopPk `2000000000000000001`。
- `skuId` 是店铺 SKU 的**数字 ID**（详情接口的 `skuId`），不是 `skuCode`。
- 每次点「设计」都会新建 `designTaskId`（两次实测 `2000000000000000000` → `2000000000000000003`）。
  所以单独调 `bind` 会把商品指向一个**空设计任务**，必须与设计器保存配对使用。
  这也是「不能脱离设计流程批量写映射」的根本原因，不是字段没猜对。

只读审计：`node tools/pod/riin-audit.mjs [--detail --max-detail 50] [--out x.json]`
（分页用 `searchAfter` 游标，不是 `pageIndex`）。2026-11-04 实测：600+ 条商品，`designStatus=3` 仅 5 条（全部是我们的），其余数百条未设计。

---

## 6. 字段字典（读回真值）

`POST /trade/goods/detail/spuId/factoryId/v2` 返回的每条 SKU：

| 字段 | 例 | 含义 |
|---|---|---|
| `skuCode` | `MXTMC001-UKIYOE4C-BLANCO-S` | 店铺侧原始 SKU |
| `skuTitle` | `Blanco-S` | 规格属性原文 |
| `styleCode` | `MXTMC001` | 工厂款号 |
| `colorCode` | `White` | 工厂色（已映射） |
| `sizeCode` | `S` | 工厂码 |
| `imageCode` | `CJ2611041040000400` | 设计图编码 |
| `productCode` | `MXTMC001-White-S` | 工厂产品码 |
| `mappingState` | `true` | **映射是否真的写成** |
| `mappingCode` | `MXTMC001-White-S-CJ2611041040000400` | 最终映射码 |

---

## 7. 已固化结果（2026-11-04）

| 款号 | 商品 ID | 状态 | 银河 SKU | RIIN 映射 |
|---|---|---|---|---|
| CLOWN01 | 2000000000000000000 | 在售 | 48 / 100% | 6/6 |
| UKIYOE1 | 2000000000000000000 | 在售 | 48 / 100% | 6/6 |
| UKIYOE2 | 2000000000000000000 | 在售 | 48 / 100% | 6/6 |
| UKIYOE3B | 2000000000000000000 | 在售 | 48 / 100% | 6/6 |
| UKIYOE4C | 2000000000000000000 | 在售 | 48 / 100% | 6/6 |

5 款全部通过审核，店铺在售 600+、审核中 0。

### 7.1 单文件多款（已验证到预检，未发布）

一个 XLSX 装 UKIYOE3B + UKIYOE4C 两款：

```bash
node tools/pod/listing/publish.mjs --spec <2款spec> --stage precheck --pid 13562
# product_count 2 / sku_count 12 / precheck_code 0
node tools/pod/listing/publish.mjs --spec <2款spec> --stage pagecheck --pid 13562
# readyProducts 2 / imported 0（页面在线编辑器真抓过 18 张图）
```

没有点发布：这两款已在售，再导会重复建品。结论是**文件结构、图片抓取、页面预检都接受多款**，
剩下唯一没验的是「一次点导入会建出 N 款」这一步。

注意：`publish.mjs --stage plan/precheck` 的 spec 图片必须带 `url`（不是只有 `key`），
否则 static 托管模式拿到 `undefined`，18 张全报 `UNREACHABLE`。

---

## 8. 未固化 / 边界（别当成已完成）

| 项 | 状态 |
|---|---|
| 订单 → 推厂闭环 | **未做**。需要真实订单 + 明确授权。 |
| 工厂映射直写 | 真实接口是 `POST /trade/design/sku/factor/bind`（完整请求体已抓到，见 §5.1），但必须带**新建的** `designTaskId`；单独调用会让商品指向空设计任务。**不能**脱离设计流程批量写，`riin-map.mjs --apply` 继续拒绝。 |
| 图片匹配规则 | 规则为空，`imageCode` 依赖设计保存生成。 |
| 空设计对象清理 | 插件无删除能力，0 SKU 对象只能弃用（已记入批次状态）。 |
| 发品额度 | 早期数量记录**不成立**：实测在售 600+、审核中 0，无 300 款总量上限。批量规模只受单文件行数、审核与人工点发布限制。 |
| 多色 | 只验证了 Blanco。换色需扩颜色映射表。 |
| 自有域名 | 仍是 `pages.dev`。 |
| 冻结 ≠ 授权 | 冻结只表示素材可进下一段，不代表工厂适印、供货或发布许可。 |

---

## 9. 失败码对照

| 失败码 | 出现位置 | 处理 |
|---|---|---|
| `DESIGN_NOT_FOUND` | 银河读回 | 轮询 `upload-pattern --check` 最多 60s，**不要重传** |
| `CANVAS_NOT_LANDED` | 银河保存前 | 图太短/未落板；重生成满版图，再保存 |
| `EDITOR_MISSING` | RIIN 设计器 | 多半是「重新设计将覆盖」确认框挡住了；点确定再等 iframe |
| `GOODS_ROW_NOT_FOUND` | RIIN 商品列表 | 先选 TIKTOK → shop-a 再搜索 |
| `IMPORT_FAILED` | 真导入 | 看 `页面预检.xlsx` 的错误列，不要重复提交 |
| `MAPPING_MISSING` | 映射步骤 | 先跑 `--finish` 生成 `mapping.json` |
| `FACTORY_GOODS_NOT_SYNCED` | RIIN 同步 | 同步是异步的，等；或在商品管理手动勾选店铺提交 |

---

## 10. 边界原则

- 不写平台、不付款、不推厂；不导出 Cookie/Token。
- AI 生成图不能当工厂实拍或印花像素证明。
- 未知价格、汇率、库存、供货一律 null/unknown，不填占位值。
- 竞品图只做风格参考，不直接当自己的生产图。
