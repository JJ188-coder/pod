---
name: product-fidelity
description: 当商品图片与实物不一致、需要锁定同款同色参考图、编译保真批次或逐图复核时使用；纯本地维护，不触发生图。
---

# 商品保真编译与复核

商品图片任务先加载原 `magpie-image` 与 `pod-pipeline` 技能及商品素材标准。此技能仅补充商品保真约束，不替代原批次 CLI、授权与验收规则；仅编排/维护时不生图。

## 编译

用 `scripts/product-fidelity.mjs` 从本地商品事实和素材 spec 编译出兼容既有 batch manifest 的清单。全程纯本地，不读取凭证、不联网、不调用生成器。每个颜色商品必须有至少一张真实、同款、同色 `product` 参考图；`artwork` 只证明图案素材身份，不能充当商品参考。商品事实列出有明确来源的内容，`facts_source` 指向本地绝对路径文件。引用路径会 canonicalize，SHA-256 在编译时计算并绑定。

最小 spec 示例：

```json
{
  "batch_id": "tee-navy-r01",
  "size": "3:4",
  "products": [{
    "id": "TEE-01",
    "color": "Navy",
    "category": "garment",
    "facts": ["海军蓝棉质针织短袖；正面中央为原稿印花"],
    "facts_source": "/absolute/product-facts.json",
    "refs": [
      {"role":"product", "file":"/absolute/navy-front.jpg", "product_id":"TEE-01", "color":"Navy"},
      {"role":"artwork", "file":"/absolute/approved-artwork.png", "product_id":"TEE-01"},
      {"role":"person", "file":"/absolute/model-reference.jpg"},
      {"role":"scene", "file":"/absolute/studio-reference.jpg"}
    ]
  }],
  "shots": [{
    "request_id": "tee-navy-front-r01",
    "product_id": "TEE-01",
    "color": "Navy",
    "changes": ["background", "lighting"],
    "scene": "中性柔和的摄影棚背景",
    "composition": "正面全身，衣物完整入镜",
    "output_file": "/absolute/new-output/01-Navy-front.png"
  }]
}
```

手机壳必须提供真实 `model`，且每张 `product` 参考记录的 `model` 精确匹配；不默认或硬编码 iPhone 型号。`changes` 允许 `background`、`lighting`、`pose`、`camera`；**手机壳另允许 `color`**：同一材质只需一张最干净的厂家实拍作结构参考，按厂家在售颜色逐色改色生成，改色只动颜色，不改结构、孔位、镜头平台和机型。禁止把厂家 4–8 张材质示例图按顺序硬套成“颜色图”——那既不是同色参考，也不是本店商品图。改色结果逐色对照色名验收；色名与图不符的阻塞该色，不回退首图。`scene`/`composition` 是必要时使用的场景与构图说明；提示词会明确约束其不得重定义商品，但不是语义安全过滤器。商品引用按 `product, artwork, person, scene` 的角色排序，同角色保持输入顺序；锁内 refs 与 `reference_images` 一一同序。

```bash
node /absolute/plugin-root/scripts/product-fidelity.mjs compile --spec /absolute/spec.json
node /absolute/plugin-root/scripts/product-fidelity.mjs compile --spec /absolute/spec.json --out /absolute/new-batch.json
```

不传 `--out` 只向 stdout 输出 manifest；指定 `--out` 只用 `wx` 创建全新文件，不覆盖现有文件。manifest 的每个 `jobs[]` 含 batch CLI 所需 `request_id/prompt/reference_images/n/size?/quality?/output_file` 和 pending `product_lock`，另含可核对的事实来源字段。之后按原 `magpie-image` 技能使用 `batch-images.mjs --manifest /absolute/new-batch.json --provider image2`；真实生成仍需单独获得授权。本编译器不复制素材，也不把生成 mockup 认作商品事实。

## 待复核与证据

先使用真实批次 `latest-report.json`：

```bash
node /absolute/plugin-root/scripts/product-fidelity.mjs review-pending \
  --manifest /absolute/new-batch.json --report /absolute/latest-report.json
node /absolute/plugin-root/scripts/product-fidelity.mjs verify \
  --manifest /absolute/new-batch.json --report /absolute/latest-report.json
```

`review-pending` 按每张图列出 report 状态、输出 SHA、参考图 SHA 与六项待人工检查：款型、颜色、材质、结构、印花、型号。它只给出待查清单，不自动判真、通过或批准。文件存在、哈希匹配、生成成功或 manifest/provider 中的 `approved` 字段都不能替代视觉检查。

只有实际完成逐张对照后，调用者才能准备 evidence JSON，逐张为六项填写 `pass`/`fail`/`unknown` 及具体检查依据，并记录真实 reviewer 或 source、检查方法和实际 ISO 8601 时间。材质图片只核对可见观感与已确认事实，不能证明纤维成分；不适用品类的检查项可在确实核明不适用后记 `pass` 并注明依据。不得伪造人员身份、视觉检查、用户授权或审批。示例：

```json
{
  "reviewer": "实际检查人/工作台标识",
  "method": "逐张将生成图与同款同色 product 参考图比较",
  "checked_at": "2026-11-11T10:00:00Z",
  "shots": [{
    "request_id": "tee-navy-front-r01",
    "checks": {
      "款型":{"result":"pass","evidence":"正面版型与参考图一致"},
      "颜色":{"result":"pass","evidence":"与Navy本色参考图对照"},
      "材质":{"result":"pass","evidence":"仅核对可见表面观感与已确认事实；纤维成分以来源文件为准，图片不能证明成分"},
      "结构":{"result":"pass","evidence":"可见领口与袖型一致"},
      "印花":{"result":"pass","evidence":"位置及文字外观经视觉对照"},
      "型号":{"result":"pass","evidence":"服装款不适用型号；无型号可供检查"}
    }
  }]
}
```

```bash
node /absolute/plugin-root/scripts/product-fidelity.mjs review \
  --manifest /absolute/new-batch.json --report /absolute/latest-report.json \
  --evidence /absolute/review-evidence.json --out /absolute/new-review.json
node /absolute/plugin-root/scripts/product-fidelity.mjs verify \
  --manifest /absolute/new-batch.json --report /absolute/latest-report.json \
  --review /absolute/new-review.json
```

未通过项产生 `reviewed_fail`，未知项或缺少 `--review` 保持未通过/待复核。编译清单、原事实来源、参考图、批次报告、evidence 或输出任何变化都会令复核记录失效。该本地记录只绑定文件内容及调用者提供的检查声明，不是签名、身份认证或发布授权。下载完成不等于视觉通过；上传、视频和上架仍按原技能分别验收。

## 保真边界

提示词仅锁定有明确事实支持的商品特征，参考图、已确认材质/结构/形状/颜色/印花/型号不供场景自由改写；不得虚构未展示背面、内里或细节，不能改写文字或 logo。事实缺失时标未知，不让生成图反过来证明事实。文字提示不能保证印花像素完全一致；精确图案需要已有已批准素材与合适平面模板时做确定性本地合成，不能把生成 mockup 当作真实商品参考。参考图职责分别为商品、图案、人物和场景；首张商品主图未完成真实视觉复核前，不把生成结果复用为后续图的商品事实依据。下载或归档不等待视觉通过，但输出保持待复核，禁止据此宣称商品准确。
