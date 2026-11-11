# MiniMax Video Studio

通过 Grsai 网关调用 `minimax-h3` 生成视频的 ZCode 插件。包含：

- **Skill**：把自然语言需求整理成提示词和参数；
- **MCP 工具**：校验、登记、查询、恢复任务，提供本机进度页；
- **后台执行器**：唯一允许提交生成的入口，负责提交、轮询和下载；
- **只读进度页**：按需旁路查看阶段与接口进度，不干扰生成。

## 安装

源码：

```
/Users/jiyuanyi/Documents/pod/plugins/minimax-video-studio
```

本地市场根目录：

```
/Users/jiyuanyi/Documents/pod/plugins
```

在 ZCode 打开 **插件市场 → 添加 → 添加插件市场**，粘贴上面的市场根目录；然后在 **个人 → dev-pod-minimax-video** 安装 `MiniMax 视频工作室`。安装后新建任务，选择 `minimax-video` 技能。

## 配置 API Key

```bash
cd /Users/jiyuanyi/Documents/pod/plugins/minimax-video-studio
node dist/cli.js setup
```

输入时不会回显。密钥保存在：

```
~/.zcode/minimax-video-studio/credentials.json
```

目录权限 `0700`、文件权限 `0600`。这是**明文文件的访问控制，不是加密存储**。

也可以用环境变量（不会写入文件）：

```bash
export MINIMAX_VIDEO_API_KEY='...'
node dist/cli.js setup --from-env   # 可选：把环境变量写入本地凭据文件
```

不要在对话、日志或命令行参数里暴露密钥。已经在聊天里贴过密钥，建议到供应商后台轮换。

## 自检

```bash
node dist/cli.js doctor
```

会检查 Node、SQLite、数据目录、数据库完整性、凭据和安装产物，不联网、不显示密钥。

常见问题：

- `credentials.ok: false`：还没配置 Key；
- `data_dir_mode` 不是 `0700`：目录权限过宽；
- `server_bundle` 不存在：重新执行 `npm run build`。

## 使用

对 Agent 说：

> 用这张图做一条 6 秒竖屏产品视频，黑色石台，缓慢推进，轻雾，冷色高级感。

Agent 会：

1. 调用 `video_check`；
2. 整理提示词并调用 `video_prepare_batch`（只登记，不提交、不扣费）；
3. 启动一次后台 `run`，并调用 `video_open_progress` 给出进度页链接；
4. 后台提交、轮询、下载，结束后交付本地文件链接。

也可以直接使用 CLI：

```bash
# 查看未完成批次
node dist/cli.js status

# 从JSON清单登记整批（字段与 video_prepare_batch 一致；不提交生成）
node dist/cli.js prepare --file /absolute/video-batch.json

# 已授权批次：默认本批全量并发提交
node dist/cli.js run --batch-id b-xxxx --max-wait-min 60

# 只读查询，不下载
node dist/cli.js status --batch-id b-xxxx

# 联网刷新已有任务状态
node dist/cli.js status --batch-id b-xxxx --refresh

# 提交结果未知时，补填供应商任务 ID
node dist/cli.js attach --job-id j-xxxx --provider-id task-xxxx

# 本地放弃，释放并发名额（不会取消远端任务）
node dist/cli.js abandon --job-id j-xxxx --reason "手工核对后放弃"
```

批次JSON使用`client_request_id`和`jobs`；每个job使用`prompt`、`aspect_ratio`、`resolution`、`duration`、`images`、`audios`、`seed`、`prompt_skill`、`output_name`，与MCP一致。登记只保存素材与任务，不提交生成；重复ID仍返回原批次，不意味着原批次从未计费。

旧会话若缓存了最多10条的MCP schema，可直接用上述`prepare --file`登记整批，不需要拆批或重启活跃服务。同步插件文件不代表已热加载；新MCP进程才加载新schema。

`run` 退出码：

| 码 | 含义 |
|---|---|
| 0 | 批次完成，视频已下载 |
| 2 | 仍在进行、等待超时，或未知提交需人工核对 |
| 3 | 部分失败，或生成成功但下载失败 |
| 130 | 本地执行停止、丢失租约或认证/额度/限流保护 |

## 进度查看

生成过程中，Agent 会调用 `video_open_progress` 返回一个本机进度页链接：

```text
http://127.0.0.1:<随机端口>/#t=<一次性本机令牌>
```

页面每 2 秒读取一次本地任务记录，显示每条任务的阶段、接口返回的百分比、登记后已过时间和记录更新时间。不需要反复询问 Agent，也不占用对话。

也可以不启动 MCP、不改动正在运行的任务，直接旁路查看：

```bash
node dist/progress/standalone.js --batch-id b-xxxx --idle-min 10
```

边界：

- 只监听 `127.0.0.1`，不开放局域网或公网；
- 只读 SQLite，不建库、不迁移、不写任务记录；
- 不提交、不取消、不恢复、不下载，也不额外查询供应商；
- 关闭页面或监控进程不会影响后台生成；
- 空闲 10 分钟自动退出；
- 页面不加载任何外部脚本、字体或统计资源；
- 链接含本机访问令牌，不要外传或写入文档。

进度值按记录原样解释：

| 情况 | 显示 |
|---|---|
| `running` 且接口有 1–99 | 显示该百分比 |
| `running` 且接口返回 100 | 显示“100% · 等待确认”，不算成功 |
| `running` 但值为 0 或缺失 | “尚无可靠进度”，不当作实测 0% |
| `accepted` | “尚未开始” |
| `failed` / `violation` | “未生成” |
| `succeeded` + `download_failed` | “100%（生成完成）”，文件未交付 |

旧版本的受理状态会写入 `progress = 0`，解析层也曾把 `null`、空串、布尔转成 0，因此 0 不能当作真实进度。准确计时需要后续版本补充独立时间字段，当前只显示“登记后已过”，不宣称是纯生成耗时。

文档没有给出平均生成耗时、预计剩余时间、排队位置或 SLA；页面不会伪造倒计时，也不会把已用时间换算成剩余时间。

## API 约束

依据 [minimax-h3 接口文档](https://qmy27nhsd9.apifox.cn/514679297e0) 和 [异步查询文档](https://qmy27nhsd9.apifox.cn/452409577e0)：

- `POST /v1/api/generate`，`model: minimax-h3`；
- `GET /v1/api/result?id=...`；
- 比例：`portrait` / `landscape`；
- 分辨率：`480p` / `768p` / `1080p`；
- 时长：1–15 秒，1080p 最多 10 秒；
- 参考图最多 9 张，参考音频最多 3 段；
- 状态：`running` / `succeeded` / `failed` / `violation`。

文档**没有提供**：取消、退款、幂等提交、Webhook、单价、余额、并发上限、素材格式/体积上限、成果链接有效期。插件不会假装这些能力存在。

## 状态与恢复

| 状态 | 处理 |
|---|---|
| `queued` | 等待后台执行器 |
| `submitting` | 提交中 |
| `accepted` / `running` | 远端处理中 |
| `succeeded` + `ready` | 已下载 |
| `succeeded` + `download_failed` | 再跑一次 `run`，只重试下载 |
| `submission_unknown` | 不自动重发；核对供应商后台后 `attach` |
| `failed` / `violation` | 修改提示词后新建批次 |
| `pending` | 延长 `--max-wait-min` 再跑同一批次 |
| `stopped` | 远端未必停止；若`note`以`provider_blocked:`开头，解决阻塞并授权后用`--resume-blocked`恢复 |

### 为什么提交超时不重发

视频生成没有幂等键。请求可能已经被供应商接受，只是响应在网络上丢失。自动重发会创建第二个任务并重复计费。因此：

- 超时、网络错误、5xx → `submission_unknown`；
- 保留并发名额；
- 只有用户核对到供应商任务 ID 并 `attach` 后才继续轮询；
- 或用户明确 `abandon` 释放本地名额。

### 为什么后台命令只启动一次

MCP 工具调用应当短。让模型每几秒查一次会消耗上下文，也容易在会话中断时丢任务。插件把提交、轮询、下载放在一个后台 CLI 里，ZCode 在命令结束时通知 Agent。

限制：后台进程仍受 ZCode 进程和机器寿命约束。关闭 ZCode、睡眠或关机后不会继续执行，但任务记录会保留，下次可以恢复。

## 并发

默认采用**本批全量并发＋异常保护**：单批没有固定的10条上限，提交也不再默认1条或硬限4条。本批未提交任务并发发起各自的请求，不等第一条受理或生成完成。不是单个HTTP请求装入所有视频，也不保证供应商同时渲染。

```bash
# 可选：主动降低并发，不写则本批全量
node dist/cli.js run --batch-id b-xxxx --concurrency 2
```

`--concurrency N`必须是正整数，也可用`MINIMAX_VIDEO_CONCURRENCY`设置，命令行优先。显式限制会在SQLite事务中统计同一数据目录下所有批次的在途任务；未知提交也占名额。但不带限制的其他执行器不会受这个N约束，它不是账户级全局限速器。默认不设固定跨批总上限，不得用拆批/换通道规避供应商限制。

查询并发为4，下载并发为2，与生成提交独立。每批仅一个执行器，网络等待期间持续续租；停止或丢失租约后不再派发新任务，等待在途调用安全收尾。未知提交不重发，成功但下载失败只补下载。

遇401/402/403/429或明确认证、额度错误，保存暂停原因，停止尚未派发的请求与后续自动查询。已经发出的请求无法撤回；全量模式可能在收到第一个错误前就发完本批，不能把异常保护当作费用撤销。重启同批也不会自动解除保护。先核对供应商状态并解决阻塞，再由用户授权显式恢复：

```bash
node dist/cli.js run --batch-id b-xxxx --resume-blocked
```

恢复只处理原批次待提交及已有任务，不重提failed或submission_unknown。无固定本地上限不等于无限资源或费用授权；每批数量、规格和付费范围仍需确认。

## 素材

- 参考图：最多 9 张，单张 20MB，总计 40MB；
- 参考音频：最多 3 段，单个 30MB，总计 40MB；
- 支持 HTTPS URL、本地绝对路径、base64 data URL；
- 本地文件会复制到 `~/.zcode/minimax-video-studio/assets/<batchId>/`，供后台执行器使用；
- 远端素材 URL 会校验 HTTPS、拒绝本机和内网地址。

本地素材默认编码为 `data:<mime>;base64,...`。文档只写了“支持 base64”，没有说明是否接受 data URL 前缀。如果真实调用返回参数错误，可切换：

```bash
export MINIMAX_VIDEO_ASSET_ENCODING=raw
```

这需要一次真实小样验证，当前 mock 测试不能证明供应商接受哪种格式。

## 安全边界

- API Key 不进入工具参数、SQLite、日志、Git 或对话；
- 视频流式写入磁盘，不整体读入内存，也不回传给模型；
- 结果先写 `.part`，完成后再重命名；
- 下载拒绝 `text/html`、JSON、空文件和过小文件；
- 日志不打印完整签名 URL；
- 不自动跨节点重提，避免重复任务。

## 开发

```bash
npm install
npm run build
npm test
```

测试使用本地 mock HTTP 服务，不调用真实生成接口、不产生费用。覆盖：

- 参数与比例映射；
- 正常提交/轮询/下载；
- 幂等去重；
- 提交超时不重发与补填任务 ID 恢复；
- 下载失败只重试下载；
- 跨批次全局并发；
- MCP 进程握手、工具列表和自检；
- 只读快照的阶段与进度质量映射；
- 只读连接拒绝写入、进度服务令牌/来源校验、空闲退出。

## 已验证与未验证

已验证：

- TypeScript 编译、esbuild 打包；
- `node:sqlite` 建库、WAL、事务和完整性检查；
- 离线测试覆盖20条真实并发屏障、显式降并发、限流暂停、防重恢复与租约续期，以及只读快照、阶段映射、令牌与来源校验；测试数量与结果以本次运行日志为准；
- MCP stdio 握手、工具列表、`video_check` 调用；
- `doctor` 在隔离数据目录下通过；
- 进度页在桌面、360px 窄屏和深色模式下的真实渲染，控制台无错误；
- 进度页刷新不会增加提交次数或供应商查询次数。

未验证（需要真实付费小样）：

- 真实 API Key 的鉴权；
- 供应商是否接受 `data:` 前缀或需要裸 base64；
- 真实响应中的 `results[].url` 有效期和重定向行为；
- 实际生成耗时、计费、并发限制；
- 真实接口 `progress` 的更新频率、是否会回退或长期停留；
- Desktop 沙箱是否允许 MCP 进程监听 `127.0.0.1` 端口；
- Desktop 启动的 MCP 是否能找到 `node`（终端有 Node 不等于 GUI 进程有）。

建议第一家真实任务只生成 **1 条 480p、4 秒**，确认成功、下载和播放正常后，再批量使用。
