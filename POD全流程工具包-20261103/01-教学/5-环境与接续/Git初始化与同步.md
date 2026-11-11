# Gitint：Git初始化与GitHub接续

按用户“gitint也配齐全”的要求，本包提供本地Git仓库、`main`基线、`origin`私有仓库、`.gitignore`、文件字节保持规则和 `scripts/gitint.sh`。这里按Git初始化/连接配置处理，没有擅自安装同名第三方插件。

完整离线ZIP包含隐藏 `.git/`，仅含本项目历史、索引和不带密码的远程URL；不含原电脑全局Git配置、Keychain、GitHub Token或SSH私钥。解压后可保留历史继续开发。`full-bundle.json`记录生成ZIP时的Git提交。

```bash
bash scripts/gitint.sh --status
bash scripts/gitint.sh --setup
```

`--setup`核对origin、配置本仓库换行/中文路径显示，保留已有作者设置；已有.git时不重建历史、不切换分支、不自动暂存或推送。若只有GitHub自动Source code ZIP且缺.git，会在核对项目标识后正常本人登录、fetch main并建立索引，保留现有工作文件；全量数据仍由restore补齐。

本机GitHub身份需要本人正常登录，复制.git不复制登录权限。需要同步时：

```bash
gh auth login --hostname github.com --git-protocol https --web
git fetch origin main
git status --short
```

继续开发时，Agent先检查分支、未提交文件与远程差异，完成适当验证，再执行 `git add <明确文件>`、`git commit`、`git push`。本仓库的`project/`大部分是已交付数据，新增源码若被ignore，应审阅后只对明确源码用 `git add -f <目标>`；不要用 `git add -A`把图片、工作簿和数据库混进普通Git。

二进制资料通过私有Release和完整ZIP交付，源码与规则通过Git维护；生成的知识库vault和本机配置不跟踪，避免首次查询和换电脑制造几千条无业务意义的差异。全量数据的首次哈希验证见SOURCE-MANIFEST；后续真实业务变更保留在产品批次，不为“变干净”覆盖它们。

源POD没有`dts/manifest.json`，因此不伪造浏览器扩展版本。迁移包版本来自根VERSION，交付报告附实际Git提交。若以后加入真实dts工程，再按其manifest版本和所属工程OPERATIONS规则执行。
