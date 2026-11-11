# POD 手动跑通手册（本机版）

本仓库提供插件源码与本地演练目录 `pod-repo/`。
这份手册只写**能照着敲**的命令，以及每一步的通过标准。

> 重要：这个仓库是「工具 + 文档」，不是完整业务仓库。
> 真实上架还缺：官方批量表模板、`project/T恤` 底图/面料/尺码表资料。
> 公开仓库未包含示例 spec、packs 与官方模板；第 2–4 步请用自备素材替换 `/path/to/...`。
> 下面第 0–4 步的本地工具可跑；第 5 步起需要店铺和浏览器。

---

## 0. 环境检查（已通过）

```bash
node -v                 # v24.18.0
python3 -V              # 3.9.6
python3 -c "import PIL; print(PIL.__version__)"        # 11.3.0
python3 -c "import openpyxl; print(openpyxl.__version__)"  # 3.1.5
npx wrangler --version  # 4.156.2
```

插件入口：

```bash
PLUGIN=/path/to/repo/pod-plugins
REPO=/path/to/repo/pod-repo
```

---

## 1. 只读体检（已通过一半）

```bash
POD_REPO=$REPO node $PLUGIN/pod-image-listing/scripts/listing-step.mjs doctor
```

本机当前结果：

```
✓ POD 仓库根
✓ publish.mjs 存在
✓ 站点目录存在
✗ wrangler 已登录
✗ 图床探针可访问（probe 404）
```

后两项要等 Cloudflare 登录 / 图床文件就位。

---

## 2. 图片门（已跑通，27/27）

用示例 spec 直接做逐张校验，不碰店铺：

```bash
cd $REPO
node --input-type=module -e '
import fs from "node:fs";
import { verifyAll } from "./tools/pod/listing/images.mjs";
const spec = JSON.parse(fs.readFileSync("/path/to/listing-spec.json","utf8"));
const urls = (spec.products || [spec]).flatMap(p => p.images);
const r = await verifyAll(urls);
console.log({ images: urls.length, ok: r.ok, bad: r.bad.length });
'
```

通过标准：`ok: true`，每张 200、JPEG/PNG、≤5MB、最短边 ≥600、首图 3:4~4:3。

---

## 3. 用示例素材生成 spec（已跑通）

```bash
cd $REPO
python3 tools/pod/listing/make-spec.py \
  --packs /path/to/packs \
  --styles JC002 \
  --out /tmp/pod-spec-local.json \
  --prefix lote
```

产物：`/tmp/pod-spec-local.json`，1 款 × 4 SKU，123 MXN，9 张图。

---

## 4. 生成批量表（本地演练已跑通）

真实上架必须用 TikTok Seller Center 下载的官方模板。
本地演练用 `examples/demo-template.xlsx`（只有表头，**不能上传**）：

```bash
cd $REPO
python3 tools/pod/listing/build-workbook.py \
  --spec /path/to/listing-spec.json \
  --template examples/demo-template.xlsx \
  --out /tmp/pod-demo.xlsx
```

预期：由你的 spec 决定；若用 3 款示例 spec，则为 3 款 / 12 SKU / 12 行。

---

## 5. 真实链路（需要你本人先做）

### 5.1 装战斧并登录

1. 下载：https://www.zhanfubrowser.com/download/
2. 用公司账号登录，进入分给你的墨西哥店铺。
3. 打开：查看 → 开发者 → **允许 Apple 事件中的 JavaScript**。
4. 浏览器窗口名必须和目标店一致（工具包写死的是 `tk-shop-a` / BRAND-A）。

确认 PID：

```bash
ps -Ao pid,comm | grep zhanfu | grep -v Helper
```

### 5.2 确认店铺与模板

- 分给你的店是不是 `tk-shop-a`？不是的话，工具里的店铺校验要改。
- 从 Seller Center 下载官方批量模板 `Tiktoksellercenter_男装与男士内衣_*_男士T恤_template.xlsx`。
- 放到 `$REPO/project/T恤/批次/.../官方模板/`，或建表时用 `--template` 指定。

### 5.3 银河

- 银河地址：https://tshirt.riin.com
- 需要本机 Chrome 开 CDP 9222，并登录银河。
- `tools/pod/chrome-page.mjs` 与 `galaxy-run-batch.mjs` 已在仓库；
  `galaxy-step.mjs status` 走通的前置条件是本机 Chrome 已登录银河。

### 5.4 图床

```bash
npx wrangler login
```

登录后把 probe 图放到 `img.bri-king.com/img/probe-a19.jpg`，
`doctor` 的最后一项才会变绿。

---

## 6. 真实上架顺序（不要跳）

```bash
# 6.1 只校验图片（不写平台）
POD_REPO=$REPO node $PLUGIN/pod-image-listing/scripts/listing-step.mjs check \
  --spec /path/spec-url.json --prefix JC002 --out /tmp/JC002.xlsx

# 6.2 页面级预检：看到「N 款商品准备就绪」就停，绝不点导入
# 6.3 确认无误后真导入（会建商品、占当日配额）
POD_REPO=$REPO node $PLUGIN/pod-image-listing/scripts/listing-step.mjs publish \
  --spec /path/spec-url.json --prefix JC002 --apply

# 6.4 逐款读回
POD_REPO=$REPO node $PLUGIN/pod-image-listing/scripts/listing-step.mjs status \
  --spec /path/spec-url.json --title "Modelo JC002"
```

每波最多 25 款；每波前必须重载批量页。

---

## 7. 当前不要做的事

- 不要直接点导入：没跑 `check` 和页面预检就导入，容易整波失败。
- 不要用 demo 模板上架：它不是官方模板。
- 不要把 `123 MXN` 当利润：完整成本/平台费/物流仍是 null。
- 不要批量铺货：250 款与已上架 302 款同源，有判重风险。
