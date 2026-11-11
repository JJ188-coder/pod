# 批量上架插件（TikTok Shop MX · 自有图床 URL 路线）

用途：把一款商品直接变成官方批量表并走完「分析 → 预检 → 导入 → 读回」，**图片列填自有域名
的公网直链，不再经过媒体中心**。

## 为什么可行（有据，不是猜）

官方模板 `Image` 表「图片上传说明」写了两条路，第 2 条原文：

> 2）对于在线存储的图片。如果你已在 Web 服务器上命名并保存了商品图片文件，
> 则可以将图片 URL 添加到你的发品中。

模板 `Template!E5` 也写「…或选择公开图片 URL」。所以自有域名直链是官方支持的通道，
不是绕过。

## 但 pre_check 不能当图片证明

实测（2026-11-01，MONTISE / tk-xjcx4623）：

| 文件 | /excel/analysis | /excel/pre_check | 页面在线编辑器 |
|---|---|---|---|
| 原表（媒体中心 CDN 图） | code 0，1 款 | code 0 success | 通过 |
| 换成自有 COS 外链 | code 0，1 款 | code 0 success | 通过 |
| 换成本机不存在的域名 | code 0，1 款 | **code 0 success** | — |
| 自有域名但图抓取失败时 | code 0，1 款 | code 0 success | **「无法处理该图片 URL …」** |

结论：`/excel/pre_check` 的 `code` 只说明表格字段被接受，**不代表图片能抓到**；
真正的图片门在页面导入前的在线编辑器（它会真的去抓图并列出失败列）。
所以本插件在 plan 阶段先自己逐张验一遍，再看页面回执。

## 实测：外链确实能上架（2026-11-01）

用一个 `PRUEBA TECNICA NO COMPRAR` 测试品跑通：5 张外部 1200×1200 JPEG →
analysis 1 款 1 SKU、pre_check 0 → 页面「1 件商品导入成功」→ 商品 ID `1738318721151633264`，
编辑页 6 个图片地址全部是 `p16-oec-sg.ibyteimg.com`（**平台自己抓取并转存了外部图**）→
下架回读「已下架」，在售 83→82 回到基线。

同一次对照还发现：把图片换成不存在的域名，pre_check 照样 `code 0`。所以图片门必须自己把关。

## 阶段

```bash
# 1) 校验图片（不写平台）
node tools/pod/listing/publish.mjs --spec spec.json --stage plan

# 2) 生成表格 + analysis + pre_check（不建商品）
node tools/pod/listing/publish.mjs --spec spec.json --stage precheck

# 2b) 页面级预检：注入表格，让页面真去抓图，看到「N 款商品准备就绪」就停，不点导入
node tools/pod/listing/publish.mjs --spec spec.json --stage pagecheck \
  --host pages --site-dir "$PWD/.local/pod-images-site" --base-url https://img.bri-king.com --prefix JC160

# 3) 真导入（会建商品，必须显式确认）
node tools/pod/listing/publish.mjs --spec spec.json --stage import --confirm-import

# 4) 按下架 API 下架（会写平台，必须显式确认）
node tools/pod/listing/publish.mjs --spec spec.json --stage deactivate --id <商品ID> --confirm-deactivate

# 5) 按标题片段读回（ID/状态/价格/SKU 数）
node tools/pod/listing/publish.mjs --spec spec.json --stage verify --title "PRUEBA"
```

`plan` 的判据（模板原文）：JPEG/JPG/PNG、≤5 MB、最短边 ≥600、主图 3:4~4:3。
任何一张不合格整体拒绝，不半填。

## spec.json

多款放一个文件里（批量表的正常用法）：

```json
{ "products": [ { ...第一款... }, { ...第二款... } ], "defaults": { "parcel": {...} } }
```

单款直接写成下面这个形状，等价于 `products` 只有一项：

```json
{
  "title": "es-MX 标题，<300 字符，≥25 字符，同款各 SKU 必须完全一致",
  "description": "es-MX 描述",
  "category": "男士上装/男士T恤",
  "brand": "",
  "images": ["https://img.bri-king.com/jc287/01.jpg", "…最多 9 张"],
  "colors": [{ "en": "Negro", "es": "Negro", "image": "https://…/negro.jpg" }],
  "sizes": ["S", "M", "L", "XL"],
  "price": { "default": 128 },
  "quantity": 30,
  "skuPrefix": "MXTMC001-JC287",
  "parcel": { "weight": 200, "length": 15, "width": 15, "height": 15 },
  "sizeChart": "https://…",
  "attributes": {
    "material": "Algodón,Poliéster",
    "pattern": "Gráfico", "neckline": "Cuello redondo",
    "sleeve": "Normal", "style": "Básico"
  }
}
```

- `brand` 留空 = 无品牌（官方说明：不选品牌按无品牌处理）。
- 属性值必须是**西语**，中文会被预检拒（报「不支持使用汉字」）。
- 包裹重量/尺寸是**实际包裹**，不是印位尺寸。

## 图床怎么接

`--host` 决定图片怎么变成公网 URL：

| 模式 | 说明 | 需要 |
|---|---|---|
| `static`（默认） | spec 里已给绝对 URL，插件只校验 | 无 |
| `http-put` | 本地文件 PUT 到 `${base}`，需要写权限 | `--base-url`、`HOST_TOKEN`（可选 `HOST_AUTH_HEADER`） |

`http-put` 适用于 Cloudflare R2 自定义域、腾讯云 COS + CDN 等任何「HTTP PUT 即得公网直链」的网关：

```bash
HOST_TOKEN=**** node tools/pod/listing/publish.mjs --spec spec.json \
  --stage plan --host http-put --base-url https://img.bri-king.com --prefix jc287
```

凭据只从环境变量读，不落仓库、不进日志。

### bri-king.com 现状（2026-11-01 已接通）

- `https://img.bri-king.com/` 已可用：Cloudflare Pages 项目 `pod-images` + CNAME `img → pod-images.pages.dev`（proxied）。
- 部署模型就是「一个文件夹」：本地站点目录 `.local/pod-images-site/` → `wrangler pages deploy` → 立刻可访问。
- 插件已内置该通道：

```bash
node tools/pod/listing/publish.mjs --spec spec.json --stage plan \
  --host pages --site-dir "$PWD/.local/pod-images-site" \
  --base-url https://img.bri-king.com --prefix <款号>
```

文件会落到 `<site-dir>/<prefix>/<文件名>`，URL 为 `https://img.bri-king.com/<prefix>/<文件名>`。

若以后改用 R2/自有网关，只换 `--host http-put --base-url …` 或 `static`，spec 与表格逻辑不变。

## 批量实测（2026-11-01）

3 款 / 6 SKU / 15 张图全部走 `https://img.bri-king.com/lote/p1..p3/`：

```
plan       → 15/15 通过（1254×1254 JPEG，主图比例 1:1）
pagecheck  → 「3 款商品准备就绪」，0 图片报错，未点导入、未建商品
```

这次没有出现单品首跑时那种「无法处理该图片 URL」。原因仍未定位，所以 pagecheck 是批量前的必跑一步：
它用页面自己的抓图能力验图，比任何本地检查都接近真实导入。

## 已实测通道（沿用，不重复发明）

- 浏览器：站斧原版无标准 CDP，用 PID 绑定 Apple Events `ExJa` 注入页面 JS（`zhanfu-bridge.mjs`），
  认证/Cookie/签名全部留在浏览器内，不导出。
- 接口：`/api/v1/product/excel/analysis`、`/pre_check` 可直连；
  `publish` 直连被 `12052588 This page is outdated` 拒，**最终导入必须由页面按钮触发**。
- 重复文件保护：同 sha 重传回 `12001038 The uploaded file is a duplicate`，重跑前先查导入历史。
- 下架：`POST /api/v1/product/products/deactivate` 对空 body 也返回 code 0，
  **必须回读状态**，不能凭返回码宣告成功。

## 边界

- 本插件不碰付款、充值、造单、订单推厂。
- `import` 与 `deactivate` 都要显式确认参数，默认阶段不写平台。
- 图片是否被平台成功抓取，以导入后商品页读回为准；`pre_check` 成功不构成图片证明。
