---
name: pod-browser-control
description: "用于本POD项目复用原站斧和正常已登录网页，做有界读取、授权内草稿填写与保存读回。"
---

# pod-browser-control

先读 docs/站斧与浏览器控制.md 及 project/docs/zhanfu-ai-control-20261022.md。2026-10-30 用户明确授权：POD 业务优先复用当前已登录页面及已存在的 CDP 连接；银河优先使用现有 Chrome CDP 9222，通过正常页面和同源客户端操作，不要求为此另装扩展或重复授权。授权不等于平台账号权限、验证码或 macOS 授权已通过：按当前页面实际状态处理，遇真实权限拒绝、验证码或限额停止对应入口。

Mac 原站斧已验路径为 PID 绑定 Apple Events 页面 JS，不是原版标准 CDP。重新发现 PID，核窗口名、店铺、标签 origin、目标商品后才操作；SHOP_MISMATCH 立即停。控制脚本为 project/work/zhanfu-instance-control-20261022/native-control/appleevents-control.js。银河及 EchoTik 的 SDK 读取只使用现有同源客户端、明确允许的只读接口和请求预算；已获用户授权的设计、草稿及提交使用经核对的页面对象，并保存重开读回。不得导出 Cookie 或 Token、杀/重启浏览器、改 IP 或在站外重放登录态。超时或结果未知先读回原对象，不重复创建或提交。

LCU 的 App 授权由系统实际决定，不能用修改文档冒充已授权。LCU 对某个 App 未获授权时，不重复尝试该 LCU 入口；若用户已明确授权且项目支持 CDP 或专用控制工具，使用该已授权替代路径继续，无需要求用户为同一普通任务再开通 LCU。实际必须本人完成的系统权限、验证码或必要登录才请用户介入。
