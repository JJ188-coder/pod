# pod-pricing

POD 定价助手：从成本、平台费、运费和市场价带反解售价，默认起量阶段每单留 1–3 元。

## 快速开始

```bash
node cli.mjs flow --batch <批次目录> --refresh-costs --save
```

分步：

```bash
node cli.mjs riin --save
node cli.mjs market
node cli.mjs quote --cost 15 --price 70
node cli.mjs recommend --spec <listing-spec.json>
node cli.mjs apply --spec <listing-spec.json> --apply
node cli.mjs audit --batch <批次目录>
```

`riin --save` 会把银河当前打印报价写到 `data/costs/latest.json`；之后的推荐价自动用这份成本。
口径锁定在 `config/pricing.json`（固定费 6 MXN 按单、运费 6%、每单 1–3 元），完整流程见 `FLOW.md`。

## 文件

```
cli.mjs                 命令入口
lib/pricing.mjs         费率、反解、取整
lib/market.mjs          EchoTik 周榜分类与分位
lib/riin.mjs            银河报价读取与成本快照
lib/spec.mjs            listing-spec 读写
lib/config.mjs          锁定口径加载
config/pricing.json     政策源（改口径只改这里）
FLOW.md                 固化流程与门禁
data/market/*.json      市场快照（默认最新一期）
data/costs/latest.json  银河成本快照（riin --save）
test/pricing.test.mjs   单测：node --test test/pricing.test.mjs
```

## 口径

- 黑白 15/17 CNY，四色 18.5/21 CNY（单面/双面）。
- 佣金 6% + SFP 8%（封顶 40）+ IVA 8%/1.16 + ISR 2.5%/1.16 + 固定 6 MXN（**按件**）+ 运费 **0**（工厂墨西哥直发，本地由 SFP 覆盖）。
- 汇率 0.36 CNY/MXN（2026-11-10 按市场 1 CNY = 2.777 MXN 校正）。
- 目标余量 1–3 元/单，落点 2 元；售价向上取整到 1 MXN。

输出是条件余量，不是结算后实收利润。未知费用不按 0。
