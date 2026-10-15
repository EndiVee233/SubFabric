# 开发与验证

本文件面向源码工作区。用户数据、模型、推理运行时和发行产物不属于测试夹具；测试和文档任务不得
修改这些内容。项目职责、目录地图、开发红线见 [PROJECT_MAP.md](PROJECT_MAP.md)，持续工作状态见
[docs/STATUS.md](docs/STATUS.md)。

## 环境

- Node.js 22 或更新版本；服务端无 npm 运行依赖，前端使用原生 ESM、没有构建步骤。
- 纯逻辑 ASR 测试可用 Python 3.8+；涉及 `asr` 数值模块时需安装项目对应依赖（至少 numpy）。
- 仓库不包含 GPU/NPU runtime、模型、`editor/vendor` 或已安装应用。缺少这些资源时，真实推理、GUI、
  libass、SEA/安装器端到端不属于已验证范围。
- 可用 `SUBFABRIC_PYTHON` 指向本机 Python，供 JS 行为测试调用；不需要复制或安装应用运行时。

## 测试

```powershell
node tests/run-all.mjs --report _test/maintenance/js-results.json
```

该入口串行运行 `tests/` 的 JS 回归，默认启用隔离模式、生成所需的临时 ASS 夹具，不连接默认 8321 服务，
也不写入用户设置或稿件。报告仅记录本轮结果，不合并旧报告。可附一个或多个测试文件名缩小范围；
文件名只接受 `tests/` 根目录下的 `.mjs`。

旧入口仍可使用，内部转发到同一实现：

```powershell
node tools/repair15-regression.mjs
node tools/repair15-regression.mjs secret-store-test.mjs translate-schemes-test.mjs
```

运行可隔离的 Python 回归（脚本各自使用合成数据/临时目录）：

```powershell
$env:SUBFABRIC_TEST_ISOLATED = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$python = if ($env:SUBFABRIC_PYTHON) { $env:SUBFABRIC_PYTHON } else { 'python' }
confidence-test draft-role-gap-test fetch-format-test glommed-split-test frame-units-test asr-segment-parity-test vibevoice-worker-test diarize-wav-test | ForEach-Object { & $python -B "tests/$_.py"; if ($LASTEXITCODE) { throw "$_ failed" } }
```

修改 JavaScript 或 Python 后，按涉及范围运行单测及语法检查。全仓 JS 语法扫描可用 `node --check` 遍历
`editor/`、`tools/`、`tests/`（跳过 `vendor/`、`jsmod/` 镜像和依赖目录）；Python 语法可用 `ast.parse`，
无需生成 `.pyc`。CI 另外运行 ESLint 9 与 Ruff；这两个是开发检查，不是运行时依赖。

`tests/run-all.mjs` 汇报 `passed`、`partial`、`diagnostic`、`failed`。部分执行表示输出中有明确缺素材、
私有夹具或 GUI/硬件限制；诊断脚本不计入断言测试通过数。需要真实项目或会访问真实服务的手工验收，
应在确认数据与端口后单独执行，不能从隔离回归结果推断其已验证。

## 启动与构建

服务可能读写应用根目录中的设置、项目和缓存。不要为了跑测试直接启动源码服务；使用 `tests/helpers/isolated-server.mjs`
创建的临时副本。需要手工验收时，在一次性工作副本上启动，并确认端口没有被其他应用占用：

```powershell
$env:PORT = '8399'
node editor/server.js --no-tray
```

SEA 与安装器是独立的 Windows 发版验收。构建/安装脚本位于 `tools/build-install.mjs` 与
`build/installer/`；安装操作可能替换现有程序，须由明确授权的发版任务执行。日常回归不启动安装流程。

## 仓库写入

本源码快照可能没有 `.git`。依照根目录 `AGENTS.md` 和 `docs/CONTINUITY.md` 的 GitHub 云端里程碑流程；
不要在安装数据目录初始化仓库，也不要用本地暂存、提交或推送代替云端校验流程。
