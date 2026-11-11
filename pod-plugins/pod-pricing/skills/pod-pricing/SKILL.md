---
name: pod-pricing
description: POD与多品类成衣定价。用户问卖多少、成本是多少、会不会亏、保本价或优惠佣金影响时使用；按本款工厂成本和实际费用配置算条件余量，区分每件/每单及未验证运费假设，不套T恤成本或跨品类市场分位，不因分析请求自动改价。
---

# POD / 成衣定价助手

先回答结论，再给成本、现价、保本和风险。只分析时不改spec、费率、库存或平台；本地写价需本次请求包含该动作，远端改价另走上架岗位和授权。复用已有报价及计算证据，只有输入/范围改变才重算对应部分。

## 1. 先锁成本来源和单位

- 成本优先取**本款、同工厂、同颜色/尺码、同报价档位**的已知值。记录币种、单件/套组、是否含印花/包装/本地配送；不因货盘表头叫“白坯原衣”就把裤子误当T恤，成衣可解释为未加印花的成品衣裤参考价。
- 裤子、卫衣、水洗、Polo、瑜伽不能套15/17元T恤档；不同工厂报价、断码、量体不互相覆盖。无本款成本就unknown，不用0或默认档造盈利。
- `data/costs/latest.json`与内置黑白/彩色档只可在款号/工艺确实匹配时复用。已确认工厂成衣成本且排除RIIN/银河，不为定价再访问它们或运行`--refresh-costs`。
- 单件上架数量50不是一单卖50。普通单点报价用`qty=1`；多件订单另算，分别报整单与每件余量。目标“每单1–3元”不能因函数返回per-item被扩大为任意件数订单的相同目标。
- 商品销量/均价不是某个颜色尺码销量/成交价；水洗与未水洗、单件与2/3件套、同款不同工厂要分开比较。竞品图/品牌/销量不搬成本店声明。

## 2. 费率以实际配置为准，不用旧默认

每个任务读取本次实际执行插件的 `config/pricing.json`；已有相同版本和哈希证据可复用。说明使用版本及假设，不为对齐文档擅改配置。2026-11-07本机核查为v1.2.0，当前快照如下，未来以实际文件为准：

| 项 | 当前配置 | 适用/限制 |
|---|---|---|
| 汇率 | 0.36 CNY/MXN（2026-11-10 校正，市场 1 CNY=2.777 MXN） | 不是保证结汇价 |
| 佣金 | 6% | 不含另加达人佣金 |
| SFP | 8%，每件封顶40 MXN | 按当前模型 |
| IVA / ISR | 售价÷1.16 × 8% / 2.5% | 代扣口径，实际抵扣未验证 |
| 固定服务费 | 6 MXN/件，`fixedScope=item` | 3件扣18，不按整单6摊薄 |
| 运费 | 0，`shippingBasis=sfp_local_covered` | 假设工厂本地直发、SFP覆盖；未以本店账单逐笔验证 |
| 起量目标 | 单件订单1–3 CNY，落点2 | 薄余量，不是已实现净利润 |
| 取整 | 向上到1 MXN | 报价后正向复算 |

当前未触发SFP封顶时可变费率约23.05%：

```
单件售价 = (本款成本CNY / fx + 固定费MXN + 目标余量CNY / fx)
         / (1 - commission - sfp - (iva + isr)/1.16 - shipping)
```

不要把此式推广到封顶区或所有费用模型。`priceForTarget/recommendCost`的线性反解不处理全部分段场景；预计触发封顶时以现有`quote`正向核算候选价格，不能假称通用精确保本线。

**已知旧实现陷阱：** 部分CLI注释、帮助文字和`lib/pricing.mjs`的`DEFAULT_FEES`仍是旧按单/运费6%。CLI `quote`读取CONFIG；直接调用库时显式传`policy.fees`及target/round，禁止依赖默认参数。本次技能改动不等于修复或同步了那些代码。

“预计运费59”不等于实际卖家另扣59；`shipping=0`也不证明无额外运费。首单结算应核SFP、平台费、税、达人费、补贴/折扣归属、出库/包装/配送费，不能重复计同一运费或省掉真实收费。

## 3. 最短只读计算路径（多品类优先）

在本次实际插件根执行；成本/售价来自当前任务，不照抄示例数字：

```bash
# 当前单件余量，显式本款成本；不写spec、不访问店铺
node cli.mjs quote --cost <CNY单件成本> --price <MXN单件价> --json

# 同成本的保本与目标价
node cli.mjs quote --cost <CNY单件成本> --json

# 确有多件订单分析需求才指定件数
node cli.mjs quote --cost <CNY单件成本> --price <MXN单件价> --qty 3 --json
```

一次性分析多款/多个情景时复用现有库，不反复启动相同计算或查询市场：

```js
// 从已确认的同一插件根读取config，并导入其lib/pricing.mjs
const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
const current = quote(priceMxn, costCny, policy.fees, 1);
const recommended = recommendCost(costCny, {
  fees: policy.fees, target: policy.target_cny, round: policy.round
});
const breakEvenCeil = Math.ceil(recommended.break_even_raw);
const extraFive = quote(priceMxn, costCny, {
  ...policy.fees, commission: policy.fees.commission + 0.05
}, 1);
const sellerDiscount = quote(priceMxn * 0.9, costCny, policy.fees, 1);
```

片段复用已验证的`quote`/`recommendCost`，路径、fs导入及数值由调用者先确认；不新造API。校验成本/售价/汇率有限且为正，费率和件数有效，缺输入报缺项而非默认为0。`--commission`是总佣金率，不是额外加数。

额外5%佣金、卖家九折只是压力情景，不能写成店铺已经配置。平台补贴与卖家承担优惠的扣费不同；实际结算未知就标假设，不为测试调整平台。

## 4. 回答“会亏吗”的必要输出

1. 条件结论：按哪些实际输入/假设不亏或亏，别说“稳赚”。
2. 表格：款号/本款成本/现价MXN与折人民币/向上取整保本线/每件条件余量，说明qty。
3. 薄余量时至少给一个额外达人佣金和一个卖家优惠情景；广告、退款损耗、另收包装/出库费等未计项列明。没费用依据不伪精确。
4. 只提出缓冲价或“不叠加优惠”的建议，不擅自改价、费率、联盟佣金或参加活动。`BELOW_BREAKEVEN`需提示/阻止未经说明的新发布，不自动修改既有线上商品。

只读回归样例（CNY成本/单件MXN售价，policy v1.2.0且qty=1）：

| 成本 / 售价 | 向上取整保本价 | 每件条件余量 | 另加5%佣金 | 卖家九折 |
|---|---:|---:|---:|---:|
| 32 / 122 | 115 | 约¥2.27 | 约-¥0.11 | 约-¥1.39 |
| 27 / 105 | 98 | 约¥2.17 | 约¥0.12 | 约-¥0.98 |
| 37 / 138 | 132 | 约¥2.07 | 约-¥0.62 | 约-¥2.07 |

仅用于验证口径，不是其他商品自动售价。显示四舍五入不改变原计算精度。

## 5. spec与批量命令：先确认安装能力

当前存在源码与安装缓存不同步：源码`lib/spec.mjs costOf()`识别`cost_cny`/`unit_cost_cny`/`cost`，有的已安装0.1.0仍只按黑白/彩色档。**文档写了新字段不证明当前CLI支持。** 非T恤默认用上面的`quote --cost`或显式传fees的库计算；不要盲用缓存`recommend/apply/audit`、只加cost字段就宣称用了本款成本。确认实际实现和输出`cost_cny`后才用批量功能；不要为修文档未经授权顺手同步代码。

对当前实现已支持、成本档准确的spec：

```bash
node cli.mjs recommend --spec <listing-spec.json>       # 只读建议
node cli.mjs audit --batch <批次目录>                    # 只读审计
node cli.mjs apply --spec <listing-spec.json>            # 默认dry-run
node cli.mjs apply --spec <listing-spec.json> --apply    # 授权后写本地price
node cli.mjs flow --batch <批次目录> --save              # 仅已适配批次
```

`apply`写`price`并生成报告，不改平台。价格修改后只更新受影响的发布数据，不直接重跑旧导入：`pod-image-listing`的现有import会重建表，已有上传/已发布商品应分别走历史恢复或明确的更新授权。

审计标记：`BELOW_BREAKEVEN`亏损、`NO_PRICE`缺价、`BELOW_TARGET`低于目标、`ABOVE_TARGET`高于目标、`COLOR_PRICE_LEAK`颜色成本档错配、`ABOVE_MARKET_P90`高于对应样本P90。后两项只有成本档/同类市场样本适用时才解释，不当所有服装通用风险；高于目标不是自动降价指令。

## 6. 市场对照：同类同件数，不跨品类套分位

- 现有`lib/market.mjs`的筛选器固定为基础单件T恤，排除长袖/卫衣/运动服/Polo等。**只传`--market`换文件不会让解析器变成其他品类模型**；非T恤另用匹配类目/结构的样本做明示对照，不引用该分位。
- `node cli.mjs market [--market <rankings.json>]`用于其已支持的T恤样本。优先有效本地快照及已证实SKU价格，不为继续任务反复消耗EchoTik详情额度。新抓取须遵守登录、会员额度和限流，不绕过。
- 水洗单件与未水洗、套组分开；只有件数明确才换算每件价，套组价格不直接当单件成交价。“VENTA POR PIEZA / NO ES CONJUNTO”按单件理解。
- 记录样本时间、类目、具体变体价格和销量统计层级；第三方商品级销量不声称本店或颜色尺码销量。市场分位是样本描述，不是全市场普查或销量承诺。

## 7. 银河报价仅限确需的任务

`node cli.mjs riin [--save] [--style <款号>] [--craft <工艺>]`是已有只读报价能力，前提为其实际支持浏览器已登录。`--save`写本地成本快照；`flow --refresh-costs`会触发这段，不是所有定价的必经步骤。

2026-11-04实测MXTMC001白墨烫画：Black/White原衣13+单面2/双面4=15/17；四色原衣16+单面2.5/双面5=18.5/21 CNY。同款同工艺当时没有尺码档，不推广到其他款/工艺/时间。认证留页面，不读Cookie文件或导出凭证。

## 边界

6 MXN/件、SFP覆盖、税费与汇率均按本次配置及已知证据报告；未用本店账单验证的要说明。新增实际费用先确认按件/按单/按售价的计费单位，不能把固定包装费硬塞进百分比`shipping`。只读情景用克隆参数，不改全局policy；实际政策变更需授权、备份、升版本及复算。

不覆盖其他会话正在编辑的spec；不做无收益目录搬迁、插件重装或重复审计。修改源码/配置遵守全局分支规则，非Git不擅建仓库；交付和清理遵守全局大白话、实际验证与孤儿进程安全规则。
