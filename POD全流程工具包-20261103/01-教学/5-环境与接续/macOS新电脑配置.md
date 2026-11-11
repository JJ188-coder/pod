# macOS 新电脑配置

适用对象：POD 新 macOS 卖货电脑。本文的 `REPO` 指交付仓库根，`PROJECT` 默认指 `REPO/project`；请不要把示例变量替换成旧电脑的用户名或固定 PID。旧电脑上的路径、进程号和登录状态都不是新电脑的值。

在交付仓库根打开终端后，先设置本文后续命令使用的变量（如资料恢复到别处，改写 `PROJECT`）：

```bash
REPO="$(pwd)"
PROJECT="$REPO/project"
```

本交付只做环境检查、公式安装和只读诊断。它不会安装或启动站斧、浏览器、插件、店铺 Profile、登录态或代理，不会发布、付款、推厂，也不会把旧电脑的 Cookie 搬到新电脑。

## 1. 先检查，再决定是否安装

在仓库根执行：

```bash
cd "$REPO"
bash scripts/setup-macos.sh
```

默认命令只检查，不安装、不写文件、不修改 shell 配置。只有明确需要时才执行：

```bash
bash scripts/setup-macos.sh --install
```

`--install` 只使用已有的 Homebrew，最多安装以下四个公式：

```text
git
gh
node@24
python@3.12
```

它不会安装站斧、浏览器、npm 包、Python 第三方包或知识库服务，也不会执行 `brew link --force`、`sudo` 或远程管道脚本。

官方要求以安装当天的页面为准。2026-10-23 核对到 Homebrew 的 macOS 要求是 Apple Silicon、macOS Sequoia 15 或更高；Intel Mac 为 Tier 3。没有 Homebrew 时，请按 [Homebrew 安装官方说明](https://docs.brew.sh/Installation) 手工安装，或从 [Homebrew/brew 最新 GitHub Release](https://github.com/Homebrew/brew/releases/latest) 下载官方 macOS `.pkg`。不要在交付脚本中加入 `curl … | bash` 之类的远程管道安装；本脚本也不会这样做。

如果 `brew` 不在当前 PATH，先用官方安装器给出的路径，或只对当前终端执行：

```bash
eval "$(brew shellenv)"
```

这不会修改 `~/.zshrc`。`node@24` 是 keg-only 公式，不会自动覆盖同名的系统 Node；需要 Node 时可用当前终端临时加入：

```bash
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

也可直接用 `$(brew --prefix node@24)/bin/node`。

## 2. 放完整资料到 `project/`

仓库的默认布局是：

```text
REPO/
  README.md                 # 由主会话维护
  AGENTS.md                 # 由主会话维护
  .agents/skills/           # 由主会话维护
  .codex/config.toml        # 需要本地配置时由主会话提供
  project/                  # 完整 POD 资料与业务文件
  scripts/setup-macos.sh
  scripts/doctor.py
  docs/macOS新电脑配置.md
  docs/站斧与浏览器控制.md
```

完整资料应恢复到 `REPO/project/`，包括知识库（含 `mcp_server.py`）、手机壳、T恤、项目级 skills、出的图、SOP、原生控制脚本和 SDK 材料。不要用“只放几个截图”或“聊天同步”代替完整目录。恢复命令、压缩包下载和 `activate.py`/`restore.py`/`start.command` 等入口由主会话的仓库 README 负责，本文件不另造一套。

如果资料已恢复到别的位置，可显式告诉 doctor：

```bash
python3.12 scripts/doctor.py --project /path/to/restored/POD
```

默认值仍是 `REPO/project`。

## 3. 在 ChatGPT 桌面把仓库根设为 primary

在 ChatGPT 桌面的 Projects 中新建本地项目，选择 `REPO` 根目录，然后对该文件夹选择 **Make primary**。主文件夹应是仓库根，不要只把 `project/` 设为 primary。

官方 [Projects and chats](https://learn.chatgpt.com/docs/projects) 说明：新聊天从 primary 文件夹开始，Codex 也从该文件夹自动发现 `AGENTS.md`、skills 和 `config.toml`；secondary 文件夹可以读写，但不会自动发现这些项目文件。同步聊天记录也不会把整个本地文件夹上传到另一台电脑。

因此，新电脑需要两件事同时成立：文件已经实际恢复到本机；ChatGPT 桌面已把仓库根设为 primary。项目里新建的手机壳/T恤任务才会读到正确规则；同步一条旧聊天不等于新电脑能读到旧聊天曾引用的文件。

后续在新项目聊天里继续开发手机壳/T恤项目包、自动化、插件、skills 或 SOP 时，也应以这个 primary 根为入口：根 `AGENTS.md` 和 `.agents/skills` 提供长期规则，`project/手机壳`、`project/T恤` 提供业务材料。创建新项目包或技能不需要把 `project/` 改成 primary；主会话负责的根脚手架、`activate.py`、`restore.py`、`start.command` 和精简阅读包不在本文重复实现。任何新技能或自动化都不自动获得发布、付款或推厂权限。

## 4. 知识库依赖和虚拟环境

当前 `project/knowledge-base` 的正文摄取读取这些格式：Markdown、文本、HTML、JSON/JSONL、CSV/TSV、PDF、DOCX、XLSX。代码中确认的可选第三方模块只有三个：

```text
pypdf           # PDF 文本
python-docx     # DOCX（导入名 docx）
openpyxl        # XLSX
```

当前知识库没有 Pillow、OCR 或其他图片正文读取依赖；图片、音视频和压缩包未支持的正文不会被假装已经读完。需要 OCR/图片处理时应另立任务和依赖决定。

Homebrew 的 Python 属于外部管理环境，不要把包装进 Homebrew 基础 site-packages。按官方 [venv 文档](https://docs.python.org/3.12/library/venv.html) 建一个独立环境，只装上面三项：

```bash
cd "$REPO"
bash scripts/prepare-kb.sh python3.12
```

不要执行“批量把全部库装一遍”。如果只需要文本/Markdown 查询，也可先不建 venv；但当前 `kb.py` 的 `build/sync/search/read/decision` 分支会检查这三项是否可导入，缺任一项会失败或尝试旧机的绝对回退路径。为保证新机可复现，建议使用上面的 venv。

手工同步和查询示例：

```bash
"$REPO/.venv-kb/bin/python" "$PROJECT/knowledge-base/kb.py" sync
"$REPO/.venv-kb/bin/python" "$PROJECT/knowledge-base/kb.py" search '墨西哥首款卡在哪里' --json
```

### 使用已交付的便携知识库入口

`project/knowledge-base/service.py` 和 `kb.py` 中仍有旧电脑的绝对 Python 路径。`kb.py` 在 venv 已具备三项依赖时不会触发该回退，但 `service.py` 的 LaunchAgent 安装常量不可移植。本包已提供 `scripts/kb-service.py`，复用旧服务逻辑并用新机当前venv Python生成LaunchAgent；因此：

- 不要运行 `python3 knowledge-base/service.py install`；
- 不要把旧电脑的 `~/Library/LaunchAgents/com.pod.knowledge.autosync.*.plist` 手工搬过来；
- 只用上面的 venv 手工 `sync` 和 `search`；
- `setup-macos.sh` 不认识、不启动、不更新这个旧服务。

doctor 会把这两个旧机路径标为警告，并检查已有 LaunchAgent 是否指向当前项目且解释器可执行；它不会加载或删除服务。

主会话如果提供 `scripts/kb-service.py` 这类 portable 包装，可由其 README 决定是否启用；`setup-macos.sh` 和 `doctor.py` 都不执行、加载或删除该服务。若根 `start.command`/`activate.py` 仍直接指向 `project/knowledge-base/service.py` 的旧常量，先手工恢复资料、运行 doctor、用 `.venv-kb` 手工查询，等主会话完成入口修正后再启用后台同步。

## 5. 运行 doctor

建议使用 Homebrew Python 3.12：

```bash
cd "$REPO"
python3.12 scripts/doctor.py
python3.12 scripts/doctor.py --project /path/to/restored/POD --json
```

doctor 是 Python 3 标准库、只读工具。它检查：

- macOS 版本/架构、Xcode CLT、`osascript` 的本地 JXA 可用性；
- Homebrew、`git`、`gh`、`node@24`、`python@3.12` 及可执行路径；
- 仓库根 `AGENTS.md`、`.agents/skills`、`.codex/config.toml`；
- 默认 `project/` 或 `--project` 指定的数据目录；
- 知识库、手机壳/T恤规则、原生控制脚本的保护标记；
- RIIN/EchoTik 入口文件是否存在；
- 知识库旧机绝对路径、旧 LaunchAgent 和可选 venv 依赖；
- 站斧 App 是否存在及 Info.plist 版本；不启动它。

它不调用 `kb.py`、不运行 `service.py`、不连接浏览器、不发网络请求、不读取 gh 登录态，也不打印代理值。退出码为 1 表示存在 `FAIL`，0 表示没有 `FAIL`；`WARN`/`SKIP` 仍需人工看完。

doctor 的本地通过只证明“这台机器上的文件和工具条件满足”，不证明新电脑已经完成登录、拿到固定出口、打开正确店铺、获得 Apple Events 权限，也不证明真实上传、草稿保存、发布或收款。

## 6. 建议的首次启动顺序

1. 用官方安装器准备 Homebrew；用 Apple 官方方式准备 Command Line Tools（如确实需要从源码构建）。
2. 把完整交付仓库下载到本机；不要先打开旧聊天里的本地路径。
3. 执行 `bash scripts/setup-macos.sh`，确认平台和 Homebrew。
4. 需要时执行 `bash scripts/setup-macos.sh --install`，再运行一次检查。
5. 按主会话 README 恢复完整资料到 `REPO/project/`；或用 `--project` 指向已恢复目录。
6. 建可选 `.venv-kb`，只安装 `pypdf python-docx openpyxl`。
7. 用 `python3.12 scripts/doctor.py` 复核。
8. 在 ChatGPT 桌面把 `REPO` 根设为 primary，新建项目聊天，让 `AGENTS.md` 和 skills 被自动发现。
9. 按 [站斧与浏览器控制](站斧与浏览器控制.md) 现场恢复登录、店铺和出口；不要把旧 PID 写进新配置。

## 7. 官方来源（核对日期 2026-10-23）

| 主题 | 官方页面 | 本交付采用的要点 |
|---|---|---|
| Homebrew 安装和支持级别 | https://docs.brew.sh/Installation | 官方支持 Apple Silicon + macOS 15 或更高；提供官方 macOS `.pkg`；不采用远程管道 |
| Mac 管理安装 | https://docs.brew.sh/Homebrew-for-Mac-Admins | 推荐官方 `.pkg`/MDM 路径，安装后再配置 PATH |
| Node 24 公式 | https://formulae.brew.sh/formula/node@24 | `node@24` 是 keg-only；使用公式前缀路径，不假定系统 `node` 是 24 |
| Python 3.12 公式 | https://formulae.brew.sh/formula/python@3.12 | 提供 `python3.12`；项目依赖放 venv |
| 语言运行时和 pip | https://docs.brew.sh/Language-Runtimes-and-Packages | Homebrew Python 外部管理；不要把 pip 包塞进基础环境 |
| Node 发布节奏 | https://nodejs.org/en/about/previous-releases | Node 24 为 LTS 线；新机仍以公式实际版本为准 |
| Python venv | https://docs.python.org/3.12/library/venv.html | 独立环境创建和依赖隔离 |
| GitHub CLI | https://cli.github.com/ | `gh` 通过 Homebrew 安装；登录由本人在新机完成 |
| ChatGPT 本地项目和 primary | https://learn.chatgpt.com/docs/projects | primary 根目录发现 `AGENTS.md`、skills、`config.toml`；同步聊天不等于文件可用 |


## 一次性启用命令（本包已实现）

`bash start.command` 会依次安装开发依赖、恢复数据、在本仓库`.venv-kb`安装三项固定版本解析依赖，使用该venv执行activate和知识库同步服务安装；不把包装入Homebrew基础环境。固定基线pypdf6.10.0、python-docx1.2.0、openpyxl3.1.5来自原POD已使用的Python3.12.14环境，并非声称最新版。

```bash
bash scripts/prepare-kb.sh python3.12
.venv-kb/bin/python scripts/activate.py --enable-kb-service
.venv-kb/bin/python scripts/kb-service.py status --root "$PWD/project"
.venv-kb/bin/python project/knowledge-base/kb.py search "手机壳 89 草稿" --json
```

只需要读取索引时也建议同一venv，避免旧CLI因缺解析依赖转往原电脑绝对路径。`kb-service.py`仅更换生成服务所用的Python，不改原业务证据或全局配置。

## 正常下载安装入口（2026-10-23公开页面已实读）

- [站斧官方Mac下载页](https://www.zhanfubrowser.com/download)：厂商公开页面列出Mac OS版；下载当前正式安装器，版本变化后重验原生JS控制。不要从恢复版源码、第三方下载站或旧调试端口猜安装能力。
- [站斧官方帮助中心](https://help.zhanfubrowser.com/)：用于正常账号/店铺Profile迁移、Mac权限和支持；本人在原账号体系完成登录，不传递密码或Cookie。
- [Google Chrome官方](https://www.google.com/intl/zh-CN/chrome/)：确需普通Chrome读取RIIN/EchoTik时使用，勿重启或替换已有营业浏览器。
- [GitHub CLI官方](https://cli.github.com/)和[Homebrew官方安装说明](https://docs.brew.sh/Installation)：GitHub私有资料下载和开发依赖。

站斧官网下载页确认了Mac入口，但本包没有下载/再分发站斧安装器，未在新Mac安装。业务电脑使用本人账户与每店原固定出口；站斧本身的许可、账号及Profile恢复仍遵循厂商正常流程。
