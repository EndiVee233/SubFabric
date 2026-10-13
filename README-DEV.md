# 开发说明（本机）

这个目录是**源码仓库**，运行环境与数据在它的上一级（安装目录）。

```
D:\SubFabric\
├── SubFabric\                    ← 安装目录（程序本体 + 运行时 + 模型 + 项目）
│   ├── SubFabric.exe               程序本体（构建产物）
│   ├── editor\                     源码（由本仓库复制而来）
│   │   └── vendor\                 libass worker + 中文字体（18MB，安装包提供）
│   ├── asr\
│   │   ├── models\                 7.7GB  模型
│   │   ├── runtime-python\         8GB    Python 运行时（torch + NeMo + OpenVINO…）
│   │   ├── settings.json           你的设置（含加密的 API Key）
│   │   └── ytdlp\ whisper.cpp\
│   ├── projects\                   你的项目
│   └── dev\                      ← 【本仓库】只放代码
└── SubFabric-2.2.1-fork.1-setup.exe   安装包
```

## 为什么代码和环境分开放

运行需要 `editor\vendor\`（18MB）、`asr\runtime-python\`（8GB）、`asr\models\`（7.7GB），
**这三样都被 `.gitignore` 排除，仓库里没有**。所以：

- `dev\` 只放**代码**（5MB）
- 运行与环境在**安装目录**
- 靠 `build_and_install.cmd` 把代码复制过去

## 日常开发

```cmd
cd /d D:\SubFabric\SubFabric
build_and_install.cmd                :: 编译 + 覆盖安装（最常用）
build_and_install.cmd --no-install   :: 只编译
build_and_install.cmd --package      :: 额外打出安装包
```

它做四件事：

1. 把 `dev\` 的源码复制到安装目录（**绝不动** models / runtime-python / settings.json / projects）
2. 构建 `SubFabric.exe`（Node SEA + 图标 + 版本信息 + GUI 子系统）
3. 把 exe 放进安装目录
4. 可选：用 Inno Setup 打出 `SubFabric-<版本>-setup.exe`

> **覆盖 exe 前要完全退出应用**（托盘右键 → 完全退出），否则文件被占用会报错。

### 版本号

产品显示版本维护在 `dev\editor\server.js` 的 `APP_VERSION`，并同步更新
`editor\README.md` 标题和 `build\installer\SubFabric.iss` 的 `MyAppVersion`。
Windows 文件版本使用独立的 `MyAppFileVersion`，必须为四段纯数字；本次产品版本
`beta 1.0` 对应 `editor/server.js` 中的 `APP_FILE_VERSION`、安装脚本中的
`MyAppFileVersion`，均设为 `1.0.0.0`。

## Git

```cmd
git fetch origin main      :: 网络恢复后接上 GitHub 历史
git push origin main
```

> 本仓库的基线提交（`chore: 从 2.2.1-fork.1 安装目录重建的源码基线`）
> 的内容与 GitHub 上 `7fb0d59` **完全相同**（tree 哈希 `e8ea6a6b` 一致），
> 所以 `git fetch` 之后历史能干净接上。

- `origin` = `R2FtYml0/SubFabric`（你的 fork）
- `upstream` = `EndiVee233/SubFabric`（原作者）

### ⚠️ 不要在这个安装目录里再建一个 git 仓库

安装目录里有 **19GB** 的东西是"未跟踪且未被 `.gitignore` 排除"的
（`SubFabric.exe`、`unins000.*`、以及被忽略的 `editor/vendor`、`asr/models`、`asr/runtime-python`）。
**一次 `git clean -xfd` 就能把环境删光**。所以 git 只管 `dev\` 这一层。

### git 代理

本机 git 的全局代理**已清掉**（`http.proxy` / `https.proxy` 置空）。
实测走 `127.0.0.1:7897` 会报 `SEC_E_INVALID_TOKEN`，直连反而正常。
若哪天要恢复：`git config --global http.proxy http://127.0.0.1:7897`。

## 为什么 build_and_install.cmd 是纯英文

`cmd.exe` 解析 UTF-8 批处理文件里的非 ASCII 字符会出错 ——
实测中文注释会让它把行拆碎、再把碎片当命令执行。所以：

- `.cmd` 里**只有 ASCII**（注释也是英文）
- 中文说明都放在这份文档里

## 构建依赖

| 需要 | 说明 |
|---|---|
| Node ≥ 22 | 生成 SEA blob；本机 `C:\Program Files\nodejs\node.exe` |
| Python 运行时 | 用安装目录里的 `asr\runtime-python\python.exe` |
| Inno Setup 6 | 只在 `--package` 时需要。`winget install --id JRSoftware.InnoSetup --exact --source winget` |
| rcedit | `build_exe.py` 首次自动下载到 `build\tools\`（1.3MB） |
| node.exe 底版 | `build_exe.py` 首次自动下载 v22.22.2（89MB，缓存到 `build\node-binary.exe`） |

## 已知事项

- `asr\models\ggml-large-v3-turbo`（Whisper）**没下载**。它是"质量优先"的备选，
  实测 NPU 版 Parakeet 比它快得多。要用就在设置里点下载。
- `build\` 里的 exe 与 blob 是构建产物，已 gitignore；
  `build\installer\SubFabric.iss` 等脚本是入库的。
