# 把 Parakeet 模型内置进 App

目标：让用户**装完即用**，不需要自己找模型、不需要联网下载。

---

## 1. 原理

hvigor 会把 `entry/src/main/resources/rawfile/` 下的所有文件**原样打包进 HAP**。
所以「内置模型」就是把转换好的 `.ms` 放进那个目录，App 首次启动时再解包到
可写目录，交给 MindSpore Lite 加载。

```
HAP 内（只读）                            App 私有目录（可写）
resources/rawfile/parakeet/               files/subfabric/models/parakeet/
  manifest.json      ← 清单 + SHA-256       encoder.ms
  encoder.ms         ← 622 MB      ──解包──▶ decoder_joint.ms
  decoder_joint.ms   ←  34 MB               vocab.txt
  vocab.txt
```

**为什么必须解包而不能直接从 rawfile 读？**
MindSpore Lite 的 `loadModelFromFile` / `loadModelFromFd` 需要**真实文件路径或 fd**，
而 rawfile 在 HAP（一个 zip）内部，没有可直接使用的路径。

---

## 2. 操作步骤

### 2.1 先转换出 `.ms`

这一步必须在 **Linux x86_64** 上做（`converter_lite` 只随 MindSpore Lite 的
Linux 发布包提供，DevEco Studio 里**没有**）。详见
[`MODEL_CONVERSION.md`](MODEL_CONVERSION.md)，命令可用
`python tools/gen_ms_conversion.py --out convert_ms.sh` 生成。

转换完成后你会得到：

```
encoder.ms          约 622 MB（int8）或 2.27 GB（fp32）
decoder_joint.ms    约 34 MB
vocab.txt           9.2 KB
```

### 2.2 内置进工程

```bash
# 查看当前状态
python tools/embed_model.py status

# 内置（会复制文件并生成带 SHA-256 的 manifest.json）
python tools/embed_model.py add --model-dir /path/to/ms_models

# 不想要内置了，随时移除
python tools/embed_model.py remove
```

`add` 做的事：
1. 校验目标文件是否齐全；
2. 逐个计算 SHA-256；
3. 复制到 `entry/src/main/resources/rawfile/parakeet/`；
4. 生成 `manifest.json`。

### 2.3 构建

```powershell
$d = '<DevEco Studio>'
$env:NODE_HOME = "$d\tools\node"
$env:DEVECO_SDK_HOME = "$d\sdk"
$env:JAVA_HOME = "$d\jbr"
$env:Path = "$d\tools\node;$d\tools\ohpm\bin;$d\jbr\bin;$env:Path"
Set-Location '<HarmonyOS repo>'
& "$d\tools\hvigor\bin\hvigorw.bat" --mode module `
    -p product=default -p module=entry@default assembleHap --no-daemon
```

产物在 `entry/build/default/outputs/default/entry-default-unsigned.hap`。
可以这样确认模型确实进包了：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('...\entry-default-unsigned.hap')
$z.Entries | Where-Object { $_.FullName -match 'rawfile' } |
    ForEach-Object { "{0,12:N0}  {1}" -f $_.Length, $_.FullName }
$z.Dispose()
```

---

## 3. 体积与占用（**务必先看**）

| 项 | int8 模型 | fp32 模型 |
| --- | --- | --- |
| HAP 增量 | ~656 MB | ~2.3 GB |
| 安装后 HAP 占用 | ~656 MB | ~2.3 GB |
| 首启解包后额外占用 | ~656 MB | ~2.3 GB |
| **设备上合计** | **~1.3 GB** | **~4.6 GB** |

⚠️ 三个现实问题：

1. **会同时存在两份。** HAP 内的 rawfile 是只读的、无法删除，解包后又有一份。
2. **安装/更新很慢。** 应用商店与系统安装器都要处理这个体积；更新时如果
   rawfile 变了，整包要重下。建议后续改成「按需下载 + 断点续传」。
3. **上架风险。** 华为对单个应用包的体积上限请以 AppGallery Connect 的
   最新要求为准（本文未核实到确切数字）。超大包在审核与分发上都更麻烦。
   小范围分发（`hdc install` 或企业内部）不受此限。

如果这些代价不可接受，**改用 110M 模型**：单文件 126 MB（int8），
词表与 0.6B 完全一致（`<blk>`=1024，`▁I`=31，`▁the`=6），
只需要把 mel 改成 80 bins 并换一个 CTC 贪心解码器，其余链路可原样复用。

---

## 4. 代码在哪

| 文件 | 职责 |
| --- | --- |
| `tools/embed_model.py` | 复制模型 + 生成清单（构建期） |
| `entry/src/main/ets/engine/ModelStore.ets` | 读清单、流式解包、SHA-256 校验（运行期） |
| `entry/src/main/ets/store/AppStore.ets` | `prepareModels()`：启动时判断走内置还是本地已有 |
| `entry/src/main/ets/engine/ParakeetEngine.ets` | 从解包后的目录加载 `.ms` |

### 实现里两个关键点（都是踩过的坑）

**① 不能用 `getRawFileContent`。**
它会把整个文件读进 `Uint8Array` —— 622 MB 直接 OOM。
必须用 `getRawFd`，返回 `RawFileDescriptor { fd, offset, length }`。

**② 不能用 `fileIo.copyFileSync` 拷那个 fd。**
`fd` 指向**整个 HAP**，直接拷会把整个包复制出来。
必须按 `descriptor.length` 自己分块读写（`ModelStore.ets` 里用 4 MB 一块）。
另外 `ReadOptions.offset` 的语义是「当前文件指针 + offset」而非绝对位置，
所以代码采用**顺序读**，最不容易错。

### 完整性校验

解包完会比对 SHA-256。原因：656 MB 的拷贝一旦中断，会留下一个
「大小对但内容坏」的文件，而 MindSpore Lite 对坏模型的报错毫无指向性
（可能只是「解码结果全空」）。校验失败的文件会被删除，下次启动重新解包。

解包是**幂等**的：已存在且校验通过的文件会跳过，所以第二次启动很快。

---

## 5. 验证状态

| 项 | 状态 |
| --- | --- |
| rawfile 会被打进 HAP | ✅ 已实测：把测试文件放进 `rawfile/parakeet/` 后构建，HAP 里出现 `resources/rawfile/parakeet/…` |
| `manifest.json` 结构 | ✅ 与 `EmbeddedManifest` 字段一致（model / engine / melBins / files[{name,size,sha256}]） |
| 解包与校验代码可编译 | ✅ `hvigor` 构建通过，0 错误 |
| **真机解包 656 MB** | ❌ **未验证** —— 需要真模型，且 `converter_lite` 只能在 Linux 上跑 |
| `tools/embed_model.py` 完整流程 | ❌ **未实测**（本机沙箱不允许子进程写工程目录）；逻辑简单，`status` 子命令已跑通 |

真机首次启动解包 656 MB 预计需要十几秒到一分钟（取决于存储速度），
期间「模型」页面与顶部状态栏会显示进度。
