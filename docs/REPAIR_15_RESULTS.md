# 15 项修复验收记录

日期：2026-10-13（Asia/Shanghai）。完整需求见 [REPAIR_15.md](REPAIR_15.md)，当前快照见 [STATUS.md](STATUS.md)。
本轮按 1–15 顺序推进；各项实际行为回归通过。没有提交、推送、发布、安装或操作真实项目/设置/模型。
源码保持原生前端 ESM、SEA 单入口、零新增 npm 依赖；改动叠加在已有用户修改上。

下表路径相对于源码根；每个 repair 测试均执行实际生产函数或临时副本服务，非源码匹配证明。

| 编号/状态 | 修改代码 | 通过的行为验证 | 实际验收范围与限制 |
| --- | --- | --- | --- |
| 1 已完成且已验证 | editor/server.js、editor/js/project.js、editor/lang/zh-CN.json | [repair01-model-delete-test.mjs](../tests/repair01-model-delete-test.mjs)：合法目录、根/兄弟/自定义/杂文件/junction | 隔离模型目录；不删除真实模型。不可证所属的目录只解除关联，deleted:false |
| 2 已完成且已验证 | editor/server.js、editor/js/project.js | [repair02-save-test.mjs](../tests/repair02-save-test.mjs)：交错上传、多窗口、PUT/beacon、断连及清理 | 独立 HTTP 服务；GET ETag，保存必传 revision，旧工具需适配 428/409 |
| 3 已完成且已验证 | editor/server.js | [repair03-translation-test.mjs](../tests/repair03-translation-test.mjs)：当前 ASS/SRT、人工文本/时间/角色/样式/特效、期间编辑冲突、缓存来源变化 | 本地模拟 LLM HTTP 接口；不代表真实模型质量/吞吐验收 |
| 4 已完成且已验证 | editor/server.js、editor/js/main.js、editor/js/karaoke.js | [repair04-realign-test.mjs](../tests/repair04-realign-test.mjs)：颜色与 k、旧稿/旧文本/词数拒绝、重复及相邻台词 | 共用生产应用函数，识别结果合成；未跑真实 ASR/GPU 全片任务 |
| 5 已完成且已验证 | editor/js/project.js、editor/js/main.js | [repair05-project-load-test.mjs](../tests/repair05-project-load-test.mjs)：A→B 失败、快速切换、首页离场、迟到保存/波形 | 真实 initProjects 配内存 DOM/fetch；未进行有头浏览器操作验收 |
| 6 已完成且已验证 | editor/server.js | [repair06-meta-test.mjs](../tests/repair06-meta-test.mjs)：上传期间改名/任务完成/重连及保存字段保留 | 临时项目 HTTP 服务；原子更新基于最新文件与递归字段差量 |
| 7 已完成且已验证 | editor/asr-service.js、editor/server.js | [repair07-asr-lifecycle-test.mjs](../tests/repair07-asr-lifecycle-test.mjs)：加载/识别中停止、owner 取消、共享任务、迟到结果 | 模拟进程与生产生命周期管理；真实识别引擎与托盘关闭未运行 |
| 8 已完成且已验证 | editor/asr-service.js | [repair08-asr-idle-test.mjs](../tests/repair08-asr-idle-test.mjs)：共享活动任务、全部结束才回收、就绪/替换/计时器 | 可控时钟与模拟 worker；不消耗真实模型 |
| 9 已完成且已验证 | editor/project-pack.js、editor/server.js | [repair09-pack-import-test.mjs](../tests/repair09-pack-import-test.mjs)：声明/实际限额、数量、路径、链接、单层包装、无效字幕清理 | 小型合成 ZIP，实际 zlib 流；ZIP64/加密/分卷/不支持压缩明确拒绝 |
| 10 已完成且已验证 | editor/server.js | [repair10-request-errors-test.mjs](../tests/repair10-request-errors-test.mjs)：同步/异步异常、写失败、超限、断开及重复响应 | 执行生产请求/回调函数；无需全局 unhandledRejection 收尾 |
| 11 已完成且已验证 | editor/server.js、editor/scripts/tray.ps1、tools/http_layer_probe.mjs、tools/route_smoke.mjs | [repair11-origin-test.mjs](../tests/repair11-origin-test.mjs)：实际端口别名、其他端口/协议/外部/null、无 Origin、token 和 Host | 隔离 HTTP；托盘 token 接线及 BOM 静态核对，未启动真实 GUI 托盘 |
| 12 已完成且已验证 | ../build_and_install.cmd、tools/build-install.mjs | [repair12-build-install-test.mjs](../tests/repair12-build-install-test.mjs)：安装目录字节/mtime 零写、构建失败、更新回滚、保护文件、requirements、打包暂存、覆盖路径、真实 batch 入口 | 微型隔离 Python 构建，Inno 模拟；未运行真实 SEA 构建、ISCC 或安装程序 |
| 13 已完成且已验证 | editor/llm-text.js、editor/server.js | [repair13-translation-context-test.mjs](../tests/repair13-translation-context-test.mjs)：首次多批、同版缓存续翻、完整稿件已有译文、context=0、拆批后半批上下文 | 模拟 LLM HTTP 与生产拆批函数；真实模型质量未验证 |
| 14 已完成且已验证 | editor/server.js | [repair14-static-allowlist-test.mjs](../tests/repair14-static-allowlist-test.mjs)：实际 HTTP 页面依赖图、共享模块/语言/字体/wasm、敏感/编码/junction 拒绝、测试模式、媒体 Range/HEAD | vendor 使用小型资源夹具，只验证传输权限及完整依赖图；未跑 wasm 绘制。示例仅 samples/ 顶层文件公开 |
| 15 已完成且已验证 | editor/server.js | [repair15-project-pack-test.mjs](../tests/repair15-project-pack-test.mjs)：不同 cwd/同名文件、中文与引号路径、core-only、真实 tar 首选/PowerShell 回退、失败清理、HTTP 导出→导入 | 本机 Windows 两种工具真实运行；内容和路径来自隔离临时项目 |

相关 tests/jsmod 镜像已同步且逐字节核对一致；原基线中镜像与源码没有独立差异。
保留 asr/asr.py、editor/align.js、editor/index.html 等用户已有修改，未因本轮修复回退。

## 整体回归与静态检查

- 安全入口：`node tools/repair15-regression.mjs`。结果见 [repair15-regression-results.json](repair15-regression-results.json)：66 个文件完整通过、20 个文件包含明确跳过子项、0 失败；另排除 4 个真实项目/真实设置/GUI 测试。15 个新 repair 测试均完整通过。
- 旧 log-panel 保存测试中的源码形状断言已替换为隔离 HTTP 提交/重载/冲突行为，72 passed。其他既有测试保留原断言；它们的静态断言不计作本轮 15 项行为证明。
- 私有素材测试采用 `SUBFABRIC_TEST_ISOLATED=1`：ass-fixture 用合成稿，ass-group/zh-ghost/reload/frame-units 跳过真实私有素材。frame-units 最终仅记录 11 项静态通过；初次默认运行读到的历史结果不计作本轮真实识别验收。
- Python 已有纯逻辑/隔离测试：confidence 65、draft-role-gap 12、fetch-format 58、glommed-split 47、asr-segment-parity 24 passed；frame-units 静态 11 passed。均未运行模型推理；禁写 bytecode。
- Node `--check`：基线及新增本轮文件共 291 项通过。Python 内存 compile：33 项通过，没有生成 pyc。
- 本机已有缓存的 ESLint 离线执行：相关源码/工具/测试 0 errors、15 warnings（未使用变量和旧 eslint-disable）。广域首次扫描另发现既有未入基线的 `tools/verify_home_only_running.mjs:97` 语法错误；其文件头已注明无法运行。本轮保留该用户文件，复核命令排除该单项，不能声称全部工具 lint 无错误。
- 第一轮普通沙箱拒绝旧测试写临时模块/镜像及 secret-store 的用户信息读取；获批测试执行权限后复核通过。不是吞掉错误或放宽被测校验。

未执行原 run-all 的真实数据/GUI 部分，也未运行会改同树设置的旧 HTTP 探针；已用上述新隔离测试替代相关行为。
没有 GPU/NPU、真实 ASR/LLM、实际媒体播放/wasm 绘制、完整 SEA/Inno 或真实安装验收。

## 范围与保存状态

- 安装目录仅修改用户指定的 `../build_and_install.cmd`；测试中的安装/解包/恶意输入都作用于临时目录。
- Git index、HEAD、config、main 引用与任务基线哈希一致。没有本地暂存/提交/推送，也没有 GitHub/PR 写入。
- 托盘脚本 UTF-8 BOM 保留（EF BB BF）。
- 云端状态：**尚未提交 GitHub**，原因是本轮需求明确禁止提交与推送；不沿用上一任务的里程碑授权。
