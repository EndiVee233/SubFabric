# 全项目测试与维护

本任务承接用户 2026-10-15 的“继承，全量测试此项目，并让项目便于维护”。当前进度只记在
[STATUS.md](STATUS.md)，历史 UI 与 15 项修复的完整需求入口仍保留。

## 范围与验收

1. 对当前源码重新运行全部可隔离 JS 回归、Python 纯逻辑与合成音频测试、源码语法检查；
   记录本轮环境、逐项结果、失败和跳过原因，不用历史验收代替。
2. 测试默认不访问正在使用的服务或修改用户设置/稿件。真实服务、GPU/NPU、模型、在线 LLM、
   wasm、GUI、完整构建安装需要实际依赖，缺少条件时明确列为未验证。
3. 收敛重复回归入口、提供可选择测试及 JSON 结果；解决在本次检查中发现的实际错误和可移植性问题。
   测试输出中的业务“跳过”不再当成漏测，缺依赖不得伪装成完整通过。
4. 保持原生 ESM、无前端构建、后端零 npm 依赖与 SEA 单文件入口约束。
   不为了维护进行没有行为证据的大规模重构，不安装模型/推理环境、不覆盖已安装程序。
5. 整理日常维护与 CI 命令，修正文档和代码的冲突；精简权威状态并完整保留历史记录。
6. 按 AGENTS/CONTINUITY 审阅本次增量并尝试具备并发校验的云端里程碑保存；权限或接口不足时
   写明阻塞与未提交文件，不以本地提交推送或无版本校验接口替代。

## 日常命令

JS 全量回归（Node 22+，无需安装 npm 依赖）：

```powershell
node tests/run-all.mjs --report _test/maintenance/js-results.json
```

可在命令后附 `tests/` 根目录中的一个或多个 `.mjs` 文件名，做定向复核。统一入口会生成 ASS 合成夹具，
串行执行，默认设 `SUBFABRIC_TEST_ISOLATED=1`，不连接默认服务；`tools/repair15-regression.mjs` 仅为兼容别名。
机器报告新建或覆盖指定文件，不混入以往结果。Python 运行、语法检查及 CI 入口见
[README-DEV.md](../README-DEV.md)。

## 本轮验证（2026-10-15）

- JS：Node v24.21.0；96 项执行，88 通过、7 部分执行、1 个诊断脚本、0 失败；另排除 2 项。
  7 项部分执行分别缺少私有 ASS、样本项目/字幕或隔离模式下的 GUI 浏览器行为；排除项为真实用户项目颜色修复与需真实项目的字体状态 GUI 验收。
  可隔离的字体选择器静态断言仍执行。将 Python 3.12.14 通过 `SUBFABRIC_PYTHON` 传入后，词边界与 VibeVoice 行为用例也完整执行。
- Python：8 项（confidence 65、draft-role-gap 12、fetch-format 58、glommed-split 47、frame-units 11 静态、asr-segment-parity 24、VibeVoice unittest 3、diarize WAV 合成音频/峰值内存）全部退出 0；其中 frame-units 私有历史数据明确跳过。NPU `samples=None` 的既有已知边界提示不影响通过。
- 语法：273 个 JS/MJS/CJS 文件 `node --check` 通过；33 个 Python 文件 `ast.parse` 通过。
- 修复：AES 密钥优先沿用原 `os.userInfo().username`；Windows 受限账户 API 报 `ERR_SYSTEM_ERROR` 时才回退 `USERNAME`/`USER`，保持正常系统上的已有密钥兼容。纠错“跟随翻译”测试转为临时服务和临时设置。修复 `verify_home_only_running.mjs` 嵌套注入模板的额外反引号，并更新陈旧说明。
- 限制：本机没有 ESLint/Ruff；没有真实 GUI、GPU/NPU、模型、vendor、SEA 运行时或安装器验收条件；这些不作已验证声明。旧 `docs/repair15-regression-results.json` 已按开始 SHA-256 恢复，新的逐项报告保存在 gitignore 下的 `_test/maintenance/`。

## 执行顺序

记录本地文件和远程 HEAD 基线 → 原入口安全回归 → 统一入口与针对性修复 →
运行统一全量验收并核对原文件 → 更新地图、维护命令与 STATUS → 云端保存能力核对。

云端保存核对：目标为 `EndiVee233/SubFabric` main，提交前复查 HEAD 为
`8cb07bac42e3f6a85c9c6cbb966d5419887e67ef`（与开始基线一致，无并发变化）。本轮增量（18 个文件）
已通过 GitHub 连接器以单次原子多文件提交写入 main，提交后核对父提交与变更文件范围；该接口不提供
expected HEAD 参数，以"提交前核对 HEAD + 提交后核对父提交"代替并发校验。状态与恢复入口见
[STATUS.md](STATUS.md)。
