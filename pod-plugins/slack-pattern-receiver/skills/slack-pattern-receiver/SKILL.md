---
name: slack-pattern-receiver
description: 从已登录 Slack 页面接收单张 PNG 图案，核 4K、透明度、SHA-256；不合格即停。用于 POD 银河前的图案验收。
---

# Slack 图案接收

先读 `../../README.md`（相对本 SKILL.md）。

## 何时使用

- 用户给出指定 Slack 私信/会话，要求取某一张 4K PNG 图案。
- 需要把“机器人说已交付”与“真实文件尺寸/透明度”分开核。
- 银河、主图、详情、上架之前，先建立图案接收回执。

## 操作顺序

1. 先 `slack_receiver_targets`，确认 9222 中有已登录 Slack 页面；没有就停，不新开登录。
2. 用 `slack_receiver_discover` 只读定位 `file_name`，核对 `fileUrl` 的 basename 与消息上下文。
3. 用 `slack_receiver_capture` 下载并验收，`output_dir` 必须是已存在的绝对目录。
4. 只有 `status: "pass"` 才能交给银河；`blocked` 时报告 `blockedReasons` 和真实像素/alpha，不放大、不插值、不换文件冒充。
5. 回执中 `source.messageContext` 与 `source.fileUrlPath` 必须一起保留，作为“原消息 ↔ 原件”绑定。

## 不要做

- 不发送 Slack 消息、不催机器人、不重发未知请求。
- 不读取 Cookie/Token/storage，不把 `files-pri` URL 的查询参数写入证据。
- 不把 `blocked` 文件改名为合格文件；不删除失败证据。
- 不把本地接收通过称为银河保存、商品上架或在售。
