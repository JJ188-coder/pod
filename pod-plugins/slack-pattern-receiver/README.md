# slack-pattern-receiver

用途：从**已登录的 Slack 页面**接收**一张精确命名的 PNG 图案**，绑定原消息与原始文件地址，验真实像素、透明度、SHA-256。任何一项不达标就返回 `blocked`，不把低清、插值或半透明稿送进银河/上架。

## 边界

- 只复用现有 Chrome CDP `127.0.0.1:9222` 中已登录的 Slack 标签；不新开、不重启、不改代理。
- 不读取/导出 Cookie、Token、localStorage、Authorization；文件字节通过页面自身会话按 Range 读取。
- 不发送 Slack 消息；只做站内搜索、打开文件预览和读附件。
- `blocked` 时保留下载文件与回执，不删除、不自动返工、不重发。
- 结果是“本地已接收并验收”，不等于银河设计、商品上架或在售。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `slack_receiver_targets` | 列出 9222 中打开的 Slack 页面 |
| `slack_receiver_discover` | 只读定位一个 `file_name` 的原件 URL 和消息上下文，不下载 |
| `slack_receiver_capture` | 下载、验像素/alpha/SHA，写文件和回执，返回 `pass`/`blocked` |
| `slack_receiver_verify` | 只验本地已有 PNG，不联网 |

`slack_receiver_capture` 关键参数：

```json
{
  "conversation_url": "https://app.slack.com/client/T0000000000/D0000000000",
  "file_name": "JESUS198-F.png",
  "output_dir": "/absolute/existing/dir",
  "expected_sha256": "optional 64-hex",
  "min_long_edge": 3840,
  "min_transparent_ratio": 0.01,
  "max_semi_ratio": 0.08,
  "require_transparency": true,
  "overwrite": false
}
```

## 门槛

默认按 POD 印花口径：

1. 长边 ≥ 3840（`min_long_edge`）；`isNative4096` 另报长边是否 ≥4096。
2. PNG 必须带 alpha 通道。
3. 全透明背景 ≥1%。
4. 半透明像素 ≤8%（只允许边缘抗锯齿，不允许大面积半透明）。
5. 可选 `expected_sha256` 必须完全一致。
6. 文件名与 Slack 原始 URL 的 basename 必须一致。

失败码示例：`BELOW_MIN_LONG_EDGE` 对应 gate `min_long_edge`；`semi_transparent_ratio`；`alpha_channel`。回执同时保留 `messageContext`，便于核对机器人自述的尺寸是否与真实文件一致。

## CLI

```bash
node tools/pod/slack-pattern-receiver.mjs targets
node tools/pod/slack-pattern-receiver.mjs discover \
  --conversation-url 'https://app.slack.com/client/T0000000000/D0000000000' \
  --file-name 'JESUS198-F.png'
node tools/pod/slack-pattern-receiver.mjs capture \
  --conversation-url 'https://app.slack.com/client/T0000000000/D0000000000' \
  --file-name 'JESUS198-F.png' \
  --output-dir "$PWD/project/T恤/批次/<batch>/证据/Slack接收"
node tools/pod/slack-pattern-receiver.mjs verify --file /abs/path.png --min-long-edge 3840
node tools/pod/slack-pattern-receiver.mjs mcp
```

## 本地实测（2026-11-01）

五款 F 面真实接收（同一 Slack 私信、同一固定标签）：

| 款 | 文件 | 实际像素 | SHA 与本地旧文件 | 半透明占比 | 结果 |
|---|---|---|---|---|---|
| JC124 | JESUS211-F.png | 1024×1536 | 一致 | 72.59% | blocked |
| JC140 | JESUS163-F.png | 1146×1372 | 一致 | 50.08% | blocked |
| JC144 | JESUS213-F.png | 1199×1312 | 一致 | 64.11% | blocked |
| JC188 | JESUS158-F.png | 1374×1145 | 一致 | 63.49% | blocked |
| JC192 | JESUS198-F.png | 1374×1145 | 一致 | 56.55% | blocked |

结论：5/5 原消息附件与本地旧文件字节一致，**0/5 是原生 4K**；五款都因 `min_long_edge` 与 `semi_transparent_ratio` 被拦下。机器人消息自述“仅清 alpha=1”，但实测半透明像素占 50%–73%，不能当作合格印花稿。

`JESUS198-F.png` 的 SHA-256 为 `e264e21399f4679c8d5832e75d904571d39f62edda866da29e5f210e9e81888a`，与本地旧登记一致。alpha 计数另用 `ffmpeg` 独立解码交叉核对，透明/不透明/半透明像素数与 bbox 完全一致。

## 接入

插件清单在当前目录：

- `.codex-plugin/plugin.json`
- `.mcp.json` → `sh ./mcp/launch.sh`
- `skills/slack-pattern-receiver/SKILL.md`

宿主未自动发现 project plugin 时，可把 `.mcp.json` 的 `slack-pattern-receiver` 条目加到对应宿主的 MCP 配置，或直接用上面的 CLI。不要把本插件加入全局插件市场或提交凭据。
