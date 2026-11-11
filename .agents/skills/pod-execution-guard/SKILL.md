---
name: pod-execution-guard
description: 仅在需要POD本地成本/素材预检、复核报告或排查执行拦截时使用。普通定价、生成、查询和上架直接使用对应原技能，不必先加载本技能；不修改原技能，不增加发布或收费授权。
---

# POD 本地检查与执行边界

按任务直接使用原技能：定价用 `pod-pricing`；图片用 `magpie-image`（商品图片加 `product-fidelity`）；视频用 `minimax-video`；上架/恢复用 `pod-image-listing`；工厂设计用 `pod-galaxy-design`。只有整链任务才需 `pod-pipeline`，不为局部操作重复加载整套技能。使用当前安装版，同一任务不重复打卡。

## 本地检查

以下命令不联网、不生成、不发布，参数均为绝对路径。报告保存到新文件，不覆盖历史回执。

```bash
node <本技能目录>/scripts/guard.mjs check \
  --spec /绝对路径/当前spec.json --shop tk-xjcx4623 \
  --costs /绝对路径/本款逐色成本.json
```

成本文件每个在售颜色恰好一行；数值填本款真实成本，`source` 指向已有依据，不套用旧默认档：

```json
{"products":[{"product":"当前skuPrefix","color":"Blanco","cost_cny":32,"source":"/绝对路径/本款报价依据.json"}]}
```

复用原 `media-check.mjs` 和实际安装的定价 `quote`，显式使用当前 `pricing.json` 的费用、单件数量 1；同时显示增加 5% 佣金和九折售价情景。缺成本、亏损或素材不符仍阻止新 spec 写入。本地检查仅适用 `tk-xjcx4623` / MONTISE，不能用于证明手机壳店铺可发布。

`listing-step check` **会公开托管图片并上传预检**，不是纯本地检查。它及实际发布的新 spec 命令需 `POD_GUARD_REPORT=/绝对路径/本地检查报告.json`，仍按原技能传真实 `POD_REPO/POD_IMAGE_BASE_URL`。`publish/off` 不带 `--apply` 只是预览，不要求报告或额外确认。

入口检查重算当前成本和资料，用本轮指纹比对完整报告绑定，不再额外扫描一遍所有文件。不信任报告自填的 `pass/approved`；资料、费率、检查器或绑定原技能变化后旧报告失效。单独审计已有报告才需要：

```bash
node <本技能目录>/scripts/guard.mjs verify --report /绝对路径/本地检查报告.json
```

## 恢复优先，不从头重做

- 有商品 ID 或提交结果不明：先只读回，不重提；查重失败不等于商品不存在，最终导入只点一次。
- 有精确 xlsx 或上传历史：按原上架技能恢复，不造替身 spec、不重建旧表。仅需审计文件依据时：

```bash
node <本技能目录>/scripts/guard.mjs check \
  --xlsx /绝对路径/已有表.xlsx --template /绝对路径/本类官方模板.xlsx \
  --evidence /绝对路径/当前依据.json --shop tk-xjcx4623
```

`evidence` 结构为 `{"shop":"tk-xjcx4623","products":["当前skuPrefix"],"stage":"upload_history","product_ids":[],"files":[{"file":"/绝对路径/已有表.xlsx","sha256":"实际64位SHA256"}]}`；可同时引用原回执。`stage` 取 `new/upload_history/submitted_unknown/readback`，ID 只填真实读回值；spec 检查也可传此索引。有 ID/提交不明只读回，有历史走恢复。xlsx 分支只绑文件，**不解析表格、不证明页面合格**。

## 只保留必要保护

- 真实收费、公开上传、平台写入和工厂操作仍交宿主确认；本地检查与预览不追加确认。真实用户确认仅覆盖本次商品、数量、动作，`approved=true` 和历史报告不是授权。
- 商品图先绑定同款同色真实参考，核验引用指纹与输出不覆盖输入；照片无白边且不裁掉商品关键部分。生成成功不等于视觉/音画验收。
- 401/403/429、额度或提交未知时停止新提交，查询原任务；不换 ID/通道盲重发。
- 旧 `run-product.mjs/run-batch.mjs` 有隐式收费/上传路径，仍禁用；旧 `riin-openapi --dry-run` 会输出认证头，仍禁用。允许只读源码。
- 上架前核真实店铺、官方模板、逐码价量、整款总量、物流和最终页面；交付区分本地检查、视觉/音画验收、上传/点击与真实商品 ID/状态，不把文件存在当合格。

项目只保留 `PreToolUse`：普通 Bash 快速识别，无关 MCP、消息和 Skill 返回不启动护栏；不再记录技能加载状态。只覆盖已识别脚本和生成工具，不解析任意内联代码、浏览器点击或内部子进程，不是安全沙箱。钩子不返回 `allow`，不改全局权限或信任配置。

配置保存和离线测试不等于宿主已加载；以实际 hook 日志/新会话验证。回滚使用本次备份恢复这四个项目文件；原技能、插件及全局设置不动。
