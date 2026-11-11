---
name: pod-galaxy-design
description: POD 银河设计岗位。接收已验收的单张图案，完成银河建款/图案上传/保存重开读回，产出可闸门校验的银河交接件；内置登录检测与款号去重，禁止重复建款。
---

# POD 银河设计岗位

把「一张合格图案」变成「一份可核验的银河设计对象」。这是 POD 链路里唯一有权写银河的入口。

## 适用与边界

- 适用：T 恤链 `tk-xjcx4623` / MONTISE，工厂 RIIN 墨西哥 1 厂，衣款 `MXTMC001`。
- 与手机壳链（`tk-uump1694`）完全隔离，不共用 SKU、店铺权限或图案。
- 不付款、不充值、不建单、不推厂、不删除平台对象。
- 不读取或导出 Cookie / Token / localStorage 值；不做站外会话 replay。
- 银河会话过期时只提示本人登录，不代填账号密码。

## 输入（缺一项即停）

| 项 | 要求 |
|---|---|
| 图案 | 单张透明 PNG，文件名含款号；优先原生 4K（长边 ≥3840） |
| 像素与透明度 | 需实测宽高、alpha 边界；插值放大件必须显式标注，不得称原生 4K |
| 指纹 | 源文件 SHA-256 |
| 款号 / 素材码 / 版本 | 如 `JC124` / `JESUS211` / `R01` |
| 冻结件 | 商品包内 `freeze.json`、`manifest.json` |
| 目标浏览器 | 现有 Chrome CDP 9222 上的银河标签 |

## 操作（唯一命令入口）

```bash
# 0) 登录：读 macOS 钥匙串，不打印密码（service=pod-galaxy-tshirt-riin / account=BRK）
node plugins/pod-galaxy-design/scripts/galaxy-step.mjs login

# 1) 先看银河是否可用（只读）
node plugins/pod-galaxy-design/scripts/galaxy-step.mjs status

# 2) 款号去重：已建款就不许再传（只读）
node plugins/pod-galaxy-design/scripts/galaxy-step.mjs check \
  --batch "project/T恤/批次/B20261027-MX-BOT-DEV-01/证据/银河-20261030" --product JC124

# 3) 预检上传（仍不写平台）
node plugins/pod-galaxy-design/scripts/galaxy-step.mjs upload --spec <商品包配置.json>

# 4) 确认无误后真正执行
node plugins/pod-galaxy-design/scripts/galaxy-step.mjs upload --spec <商品包配置.json> --apply

# 5) 交接件闸门
node plugins/pod-galaxy-design/scripts/galaxy-step.mjs verify --handoff <银河交接.json>

# 6) 通道验证：单图上传到前片，默认不保存
node plugins/pod-galaxy-design/scripts/upload-pattern.mjs --image <png> --name JCxxx-F.png
```

### 上传通道的唯一有效方式（2026-11-01 实测）

编辑器只接受 **`ClipboardEvent('paste')` + `DataTransfer` 携带 `File`**，投在 `.upload-box` 上。

已实测**无效**：DOM 拖放事件、CDP `Input.dispatchDragEvent`（带真实文件路径）、Playwright filechooser。

每次失败尝试也可能已在图库留下重复记录，所以不要拿失败当无事发生——先核“最近上传记录”再重试。

判定落板看画布 W/H 是否大于 0，不能只看上传请求成功。

### 铺满规则（用户 2026-11-01 指示）

图案要**铺满印区**，不允许出现小图。保存后必须按尺码核覆盖：

```bash
node plugins/pod-galaxy-design/scripts/upload-pattern.mjs --check <taskId>
```

六码（S/M/L/XL/2XL/3XL）每码 `fill_pct` 都要 ≥99%，否则退出码 1。

取舍必须写进交接件：铺满四边时，若原图宽高比与印区不一致，会发生横向或纵向压缩（实测一例 1024×1536 对 2XL 印区 0.643，横向压 3.6%）。要"等比不拉伸"就只能按一边贴合，另一边必然留白。两者不能同时满足，必须显式选一个并记录。



实际写平台的上传/布局/保存交给仓库既有工具，本插件负责门禁、去重与验收，不复制一套会漂移的实现。

## 交付（银河交接 v1）

必须含：`galaxy_task_id`、`galaxy_design_id`、`galaxy_group_id`、`galaxy_template_id`、`sku_built`、逐码几何（cm 与坐标）、效果图及其 SHA、`saved_at` / `readback_at`。

## 验收

1. `verify` 退出码 0；
2. 保存后**重开**读回，而不是只看保存返回；
3. 读回的 `materialImageCodes` 必须含本款号（防贴错款）；
4. 效果图用「印面渲染」判比例，不用穿着图判（穿着图横向压缩 13–15%）。

闸门只证明「声明与文件一致」，不证明图片确实出自该任务；真实核验 = 平台任务号 + 指纹 + 独立复算，三者缺一不可。

## 交接

通过后交给主图/详情岗，并同时给出：图案 SHA、效果图路径与 SHA、设计 ID、逐码几何。主图岗不得使用未通过闸门的银河对象。
