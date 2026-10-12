# 项目当前状态（唯一权威入口）

- 最后更新：2026-10-12 23:04（Asia/Shanghai）。
- 当前目标：通过已有 fork 提交连续性文档 PR 到 `EndiVee233/SubFabric:main`。
- 整体状态：**进行中**；本地文档与认证已验证，fork/PR 通道权限已确认，正在准备云端提交。
- 完整范围与验收：[CONTINUITY.md](CONTINUITY.md)；稳定规则：[../AGENTS.md](../AGENTS.md)。
- 本会话仅要求连续性及云端接入配置，没有另一个明确业务开发任务；已有代码差异属于用户工作。

## 项目与已知可运行状态（首次配置时检查）

- 源码根目录为工作区内 `SubFabric/dev/`，由 README-DEV、`.git/config`、实际源码入口共同确认。
  工作区 `source-snapshot/` 是历史快照；其 `UPSTREAM_MERGE_STATUS.md` 不是当前项目状态。
- 项目是 Node 后端 + 原生前端 ESM 的本地 ASS/SRT 字幕编辑器，含 Python ASR/下载逻辑。
  当前源码 `editor/server.js` 的 `APP_VERSION` 为 `2.4.0`。
- 本次 `GET http://127.0.0.1:8321/api/version` 返回 HTTP 200、版本 `2.4.0`；仅证明现有服务可达，
  未据此确定它加载了 dev 当前源码，也未验收字幕编辑、渲染、ASR 或导出。
- 本机 Node `v24.21.0`；README/CI 使用 Node 22。源码中无 `editor/vendor/`、嵌入 Python；
  上一级安装目录有程序、vendor 与 Python 运行时。本次没有启动/停止服务或复制环境。

## 本次进度与证据

| 工作 | 状态 | 依据 |
| --- | --- | --- |
| 源码与目标仓库对应、远程基线检查 | 已完成且已验证 | upstream 配置、公开 API 仓库/分支/树，2 个后端模块 blob 与远程一致 |
| 连续性规则、状态、完整要求与入口 | 已完成且已验证 | UTF-8、16 个相对链接、唯一状态与原内容保留核对通过 |
| GitHub CLI 安装与授权测试 | 已完成且已验证 | 官方 2.102.0 便携版、下载 SHA-256 核对、网页登录、认证 API 返回 R2FtYml0 |
| GitHub 云端里程碑与 PR | 进行中 | 上游 push=false；已有 fork push=true、admin=true；用户已明确要求 PR |

- 复用 README、README-DEV、PROJECT_MAP、`.github/workflows/ci.yml`、`tests/run-all.mjs`，
  以及 `docs/KARAOKE_DESIGN.md`、既有审查记录；不另建空壳 PLAN/DECISIONS。
- 历史验证见 `docs/CODE_REVIEW_2026-10-11.md`、PROJECT_MAP §8/§11；本次未复跑其中功能测试。
  历史报告称“无 CI/统一测试入口”，但当前文件已具备，不能把该历史结论当作现状。

## 开始基线与保留边界

- 本地 HEAD：`f65ab217c1bc106e6df8b84bda23a7ac5dfa6940`，本地分支 `main`；origin 是 fork
  `R2FtYml0/SubFabric`，upstream 是用户指定 `EndiVee233/SubFabric`，本次不改本地配置。
- 351 个索引条目；开始时索引 SHA-256：`81eb95276e3fe460a0d1c7897d3ea330e413af3f1654b69a4c640823b6ef3f57`。
  首次配置时无 Git 可执行文件；以只读解析现有索引、计算 blob/文件哈希记录基线，未冒充完整 git status。
- 开始时工作文件相对索引有 13 项差异（文本比较排除 CRLF 差异），无索引路径缺失/冲突 stage：
  `asr/asr.py`；`editor/align.js`、`editor/asr-service.js`、`editor/index.html`、
  `editor/js/main.js`、`editor/js/project.js`、`editor/server.js`；
  `tests/jsmod/align.js`、`tests/jsmod/asr-service.js`、`tests/jsmod/main.js`、
  `tests/jsmod/project.js`、`tests/jsmod/server.js`；`tests/log-panel-test.mjs`。
- 本次仅允许云端候选：源码根 `AGENTS.md`、`docs/STATUS.md`、`docs/CONTINUITY.md`，
  以及 README/PROJECT_MAP 的本次导航增量；外层工作区 AGENTS 仅本地导航。
  PROJECT_MAP 的本地基线已不同于远程，恢复提交时必须在最新远程上应用导航增量，不能整文件覆盖。
- PR 开始基线：上游 `main` 为 `f12fdf36586706acb81ddb693cc55795bbb9b44c`；
  fork 默认 `main` 为 `612241cae00ccf067988e5e87bb38c3ae88e6601`，独立 PR 分支应从上游基线创建。
- 最终哈希核对：349 个其他索引文件逐字节未变，包含原有 13 项差异；README/地图逆向移除本次导航后
  与原哈希一致（地图额外补齐末尾换行）。索引、配置和本地分支 HEAD 保持不变。

## 本次实际验证

- 首次配置：`node --version` → `v24.21.0`；`node --check editor/server.js` → 退出 0（语法通过）。
- Node `fetch('http://127.0.0.1:8321/api/version')` → HTTP 200、`2.4.0`。
- GitHub API GET `/repos/EndiVee233/SubFabric`、`/branches/main`、根/相关目录 Git trees、
  README/地图 blobs、最近 3 次提交 → HTTP 200，确认默认分支与相关文件；branch rules → 200、空列表。
- GitHub compare 本地 HEAD 与远程 HEAD → HTTP 404，不能确认本地提交与远程的祖先关系。
- `node` 内联核对脚本 → 退出 0：UTF-8、16 个相对链接、STATUS 不超过 100 行、唯一状态入口、
  待提交文档凭据模式检查、修改范围、原文与 Git 基线保留均通过；文件列表另经 `rg --files --hidden` 核对。
- 未运行 `node tests/run-all.mjs`、ESLint、ruff、ASR/GUI 全量验收：本次只有文档改动，
  无需下载依赖；测试可能写入夹具和已有镜像，不应触碰用户工作。
- 云端接入：`../../.tools/github-cli/gh.cmd --version` → 2.102.0；官方 ZIP SHA-256 核对通过。
- `gh.cmd auth status` 在可访问系统凭据的正常执行环境 → 登录有效、keyring 存储；
  `gh.cmd api user --jq .login` → R2FtYml0；认证读取目标仓库 → pull=true、push=false、admin=false。
- 直连网页登录接口两次超时；使用本机已有 127.0.0.1:7897 代理后完成设备授权。
  受限执行环境曾报告凭据无效，正常执行环境与实际认证 API 均通过；不将前者误判为登录失效。
- 22:57 核对索引、Git 配置、本地 HEAD 均与接入开始时一致；CLI 配置没有明文 oauth_token 字段。
- PR 准备检查：认证 API 确认 fork 的 parent 为目标上游且可写；读取上游最新文档、目录、现有 PR。
  拟用分支 `R2FtYml0/SubFabric:docs/project-continuity-20261012` 当前不存在。

## GitHub 保存与阻塞

- 状态：**尚未提交 GitHub（提交前快照，fork/PR 通道已确认可用）**。
- 目标：`EndiVee233/SubFabric`，API 确认默认分支 `main`。
- 初始远程 HEAD：`f12fdf36586706acb81ddb693cc55795bbb9b44c`；树：`274716e1f60ca909559ac5c54280352695e53103`。
  初次分支 API `protected=false`，公开 branch rules 为空；当前认证身份为 R2FtYml0。
- 2026-10-12 22:32 再读目标分支 → HTTP 200，远程 HEAD 与开始时一致。
- GitHub CLI 已通过网页登录，凭据保存在 Windows 系统凭据管理器；具备正常认证 API 读取能力。
  对 EndiVee233/SubFabric 的实际权限为 pull=true、push=false、maintain=false、admin=false。
- 用户后续明确授权 PR；已有 `R2FtYml0/SubFabric` 可写。PR 目标仍为上游 `main`，不改变既有分支。
- 本机工具与配置位于工作区 `.tools/github-cli/`（源码库之外）；入口 `gh.cmd` 默认使用已有本地代理，
  优先沿用外部 HTTPS_PROXY；不改系统 PATH、全局 Git 配置，不输出或提交令牌。
- 本快照在提交前写入；最终提交/PR 标识从分支提交记录、关联 PR 与最终报告核对，不为自填 SHA 循环提交。

## 下一步与恢复入口

1. 验证 5 个文档增量和本地基线保留，再读上游最新 HEAD，确保新分支基于核对版本。
2. 通过 API 在 fork 新建独立分支并以预期 HEAD 校验原子提交，再向上游创建 PR。
3. 核对 PR base/head、5 文件差异、提交包含关系及上游/fork 默认分支未改；等待维护者审阅，不自动合并。

恢复时从本文件 → CONTINUITY → AGENTS 开始；按需读 PROJECT_MAP §6/§7/§8、
`editor/server.js`、`editor/index.html`、`tests/run-all.mjs`、`.github/workflows/ci.yml`。
