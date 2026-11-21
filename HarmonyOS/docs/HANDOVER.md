# SubFabric HarmonyOS 接管记录

更新时间：2026-11-17

## 当前基线

- 工程：SubFabric for HarmonyOS，视频字幕工作台，ArkTS + Native FFmpeg/MindSpore Lite。
- 模块：`common`（HAR 跨端公共层）与 `entry`（应用 HAP）。
- Bundle：`com.subfabric.harmony`。
- DevEco Studio：`26.0.0.851`，SDK/API 26。
- 已连接设备：`127.0.0.1:5555`。

## 已验证

1. Hvigor `assembleHap` 构建成功，41 个任务完成，产物位于 `entry/build/default/outputs/default/entry-default-signed.hap`。
2. 签名 HAP 已安装到连接设备，并成功启动 `EntryAbility`。
3. 57 个 `.ets` 文件已完成 MCP ArkTS 静态检查：无 error，报告 3312 条 warning，主要集中在规则脚本对类成员 `this` 的误报；以 Hvigor 实际编译结果为准。

## 已知事项

- Hvigor 会提示 `common: HAR modules cannot be installed independently`，当前不阻塞构建，但后续若调整产品应用配置，需要同步检查 `applyToProducts` 的作用范围。
- MCP 使用无空格路径别名 `<DevEco Studio>` 指向实际 DevEco 安装目录，以兼容 Windows 子进程参数传递。
- 本地 HarmonyOS MCP 已修正 Windows 可执行文件启动、ArkTS 文件数组传参、HAP 产物发现和 `hilog` 参数兼容问题；重新安装 MCP 包时需要复核这些修复。

## 接管后的优先级

1. 在已启动应用上做真实运行链路验证：模型页、媒体导入、字幕识别、导出与日志。
2. 在真机上验证 NPU/NNRT 路径和 Parakeet 模型加载，不以模拟器结果替代。
3. 根据真实运行日志处理阻塞问题，再清理静态检查中的高价值 warning。

