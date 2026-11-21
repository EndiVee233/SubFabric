# 应用内下载模型

包体保持几百 KB，模型按需拉取，支持断点续传与完整性校验。

---

## 1. 解决什么问题

内置模型（见 [EMBEDDED_MODEL.md](EMBEDDED_MODEL.md)）有三笔代价：

| 代价 | 说明 |
| --- | --- |
| 安装包 656 MB | 安装/更新极慢，商店分发不友好 |
| 设备占用翻倍 | HAP 内只读一份 + 解包后一份，合计约 1.3 GB |
| 更新要重下整包 | rawfile 变了就得重下 656 MB |

应用内下载避开全部三条：包体不变、只占一份、模型可单独更新。

**两者可以共存**：`prepareModels()` 只在本地没有模型时才去解包内置资源，
所以「内置一个小的兜底模型 + 允许下载更大的」也是可行组合。

---

## 2. 上线前要做的两件事

### 2.1 准备远端清单

在服务器上放一个 `manifest.json`：

```json
{
  "version": "1",
  "model": "parakeet-tdt-0.6b-v2-int8",
  "engine": "tdt",
  "melBins": 128,
  "baseUrl": "https://example.com/parakeet/",
  "files": [
    { "name": "encoder.ms",       "size": 652214272, "sha256": "<64 位小写十六进制>" },
    { "name": "decoder_joint.ms", "size": 35651584,  "sha256": "…" },
    { "name": "vocab.txt",        "size": 9384,      "sha256": "…" }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `files[].name` | ✅ | 文件名，会拼到 `baseUrl` 后面 |
| `files[].size` | ✅ | 字节数，用于长度核对与断点续传定位 |
| `files[].sha256` | 建议 | 小写十六进制；**留空则跳过校验**，不建议 |
| `baseUrl` | 可选 | 文件下载基地址；缺省时取 manifest 所在目录 |
| `engine` / `melBins` | 可选 | 目前仅用于展示，引擎按名字取输出、与顺序无关 |

生成 SHA-256：

```bash
sha256sum encoder.ms decoder_joint.ms vocab.txt
# Windows PowerShell: Get-FileHash encoder.ms -Algorithm SHA256
```

### 2.2 ⚠️ 服务器必须支持 Range 请求

断点续传依赖 HTTP `Range` 头。**不支持 Range 的服务器仍能下载，只是每次从头开始。**

| 服务 | 是否支持 |
| --- | --- |
| GitHub Releases | ✅ |
| 对象存储（OBS / S3 / OSS / COS） | ✅ 默认支持 |
| nginx | ✅ 默认支持（会带 `Accept-Ranges: bytes`） |
| 部分动态接口 / 带鉴权的转发 | ⚠️ 可能不支持，需自行确认 |

自测：

```bash
curl -r 0-99 -o /dev/null -D - https://example.com/parakeet/encoder.ms | grep -i 'accept-ranges\|content-range'
# 期望看到 Accept-Ranges: bytes 与 HTTP/1.1 206 Partial Content
# 若返回 200，说明不支持 Range
```

### 2.3 在应用里填地址

「设置」→「模型下载」→ 填 manifest.json 的完整 URL。
填完后「模型」页面会出现**下载模型**按钮。

---

## 3. 实现里的四个关键点

代码在 `entry/src/main/ets/engine/ModelDownloader.ets`。

### 3.1 必须用 `requestInStream`，不能用 `request`

`request` 会把整个响应读进 `HttpResponse.result` —— 622 MB 的 encoder 直接 OOM。
流式接口通过 `on("dataReceive")` 分块回调 `ArrayBuffer`，边收边写盘，
内存占用恒定（实测每块约几十 KB）。

### 3.2 断点续传要自己兜底「服务端忽略 Range」

续传时发 `Range: bytes=N-`：

- 服务端遵守 → 返回 **206**；
- 服务端忽略 → 返回 **200**，并从 0 重发整个文件。

`requestInStream` 拿不到响应头，但**会返回状态码**，所以直接用 200/206 判定：
续传时若拿到 200，关闭当前 `.part` 句柄，从 0 重新下载一次（`TRUNC` 清空旧内容）。
不能把完整文件追加到半截文件后面，否则得到「长度正确但内容全错」的产物，
设备上表现为**识别结果全空**，而 MindSpore Lite 不会报有指向性的错。

另一个容易踩的坑是文件指针：`fs.openSync` 打开已有文件时 filePointer 在 **0**，
不是 EOF；而 `WriteOptions.offset` 的语义是「filePointer + offset」。
因此续传改用 `createRandomAccessFileSync` + `setFilePointer(resumeAt)` 再顺序写入。
**实测**：直接用 `fs.writeSync(fd, chunk)` 续传会从文件开头覆盖，长度正确但
SHA-256 校验失败；改成显式定位后通过。

### 3.3 `.part` 临时文件 + 校验通过才改名

下载写到 `xxx.ms.part`，SHA-256 通过后才 `renameSync` 成 `xxx.ms`。
这样目标目录里**永远不会出现半成品**，`hasModels()` 的语义才是可信的。

### 3.4 定期 `fsync`

每 16 MB 或 3 秒 `fsyncSync` 一次。否则中断时 `.part` 的**文件长度可能大于
实际落盘内容**，下次续传就会从错误的位置接上——同样是「长度对、内容错」。
收尾时还会把 `.part` 精确截断到期望长度。

---

## 4. 状态与交互

`DownloadStage` 四态：`checking` → `downloading` → `verifying` → `done`，
另有 `cancelled` / `failed`。

- **幂等**：已存在且校验通过的文件直接跳过，所以中断后重跑即可续上；
- **取消**：`cancel()` 会 `destroy()` 请求，`.part` 保留供续传；
- **换模型**：下载成功后自动 `releaseEngine()`，避免旧模型句柄继续被引用。

---

## 5. 验证状态

| 项 | 状态 |
| --- | --- |
| API 用法（`requestInStream` / `dataReceive` / `userCancel` / `Range` / `RandomAccessFile`） | ✅ 逐条对照 SDK `@ohos.net.http.d.ts`、`@ohos.file.fs.d.ts` 核实 |
| 编译 | ✅ hvigor **BUILD SUCCESSFUL**，0 错误 |
| 清单解析 | ✅ 已按 `RemoteManifest` / `RemoteFile` 重建对象；`JSON.parse` 的普通对象没有 `urlOf()` 与 `totalBytes`，曾导致「urlOf is not callable」 |
| 本地 HTTP 全流程 | ✅ 平板模拟器 `127.0.0.1:5557`，经 `hdc rport` 连本机 12 MB 测试文件：进度、速度、SHA-256 校验、完成部署全部通过 |
| 取消 | ✅ 下载中点「取消下载」后立即停止，`.part` 保留 |
| 断点续传（服务端支持 Range） | ✅ 取消在 2.0 MB，重试从 `Range: bytes=2097152-` 接上，最终 SHA-256 通过 |
| 断点续传（服务端忽略 Range） | ✅ 测试服务端强制返回 200；日志出现「服务端忽略了 Range（HTTP 200），从 0 重新下载」，最终 SHA-256 通过 |
| 续传文件指针 | ✅ 实测普通 `fs.writeSync` 会从 0 覆盖；改用 `setFilePointer(resumeAt)` 后校验通过 |
| 模型清理 | ✅ 模型页「清理模型文件」确认后可删除目录内文件，状态回到未安装 |
| **真实 HF 默认清单** | ❌ **未验证** —— 本机访问默认 HF 地址返回 **HTTP 401**（仓库不可公开读取/不存在），模拟器请求为超时；需要换成可匿名读取的 manifest 地址 |
| **真实 622 MB 模型** | ❌ **未验证** —— 尚无可用 `.ms` 权重 |
| **进程被杀后续传** | ❌ **未验证** —— 需要真机长下载配合 |

### 建议的真机验证顺序

1. 先用**小文件清单**（比如只有 `vocab.txt`，9 KB）跑通全流程；
2. 再换真实 656 MB 模型，中途杀进程，重进应用确认**从断点继续**；
3. 用**不支持 Range** 的地址验证兜底逻辑，确认日志里出现
   「服务端忽略了 Range（HTTP 200），从 0 重新下载」，且最终 SHA-256 仍通过。

第 3 步最关键：那是唯一会产生「静默坏模型」的路径。

---

## 6. 用 HuggingFace 托管（默认地址）

### 6.1 ⚠️ 先说清楚：HF 上没有能直接用的模型

| 仓库 | 内容 | 能否用于本项目 |
| --- | --- | --- |
| `istupakov/parakeet-tdt-0.6b-v2-onnx` | ONNX（含 int8） | ❌ MindSpore Lite **只加载 `.ms`** |
| `runanywhere/parakeet_tdt_0.6b_v2_HNPU` | 高通 Hexagon QNN 产物 | ❌ 芯片架构不同（`hexagon`，v75/v81） |
| NVIDIA 官方 `nvidia/parakeet-tdt-0.6b-v2` | NeMo `.nemo` 权重 | ❌ 需要先导出 |

`converter_lite` 只能在 PC 的 Linux 上离线跑，**没有端侧转换的捷径**。
所以默认地址指向的是**一个预留位置**，需要你自己把转换产物传上去。

### 6.2 默认地址

```
https://huggingface.co/EndiVee233/SubFabric/resolve/main/harmonyos-ms/manifest.json
```

这是 HF 的文件直链形式：

```
https://huggingface.co/<user>/<repo>/resolve/main/<path>
```

所以 `baseUrl` 要写到 `resolve/main/harmonyos-ms/` 为止（**末尾必须有 `/`**，
否则文件地址会拼错——`gen_download_manifest.py` 会强制检查这一点）。

### 6.3 完整流程

```bash
# ── 1) 在 Linux 上转换（converter_lite）
python tools/gen_ms_conversion.py --check
python tools/gen_ms_conversion.py --out convert_ms.sh
bash convert_ms.sh                    # 产出 encoder.ms / decoder_joint.ms / vocab.txt

# ── 2) 生成清单（含 SHA-256）
python tools/gen_download_manifest.py \
    --model-dir ./ms_models \
    --base-url https://huggingface.co/EndiVee233/SubFabric/resolve/main/harmonyos-ms/ \
    --out manifest.json \
    --print-upload EndiVee233/SubFabric

# ── 3) 上传（脚本会打印现成命令）
pip install -U huggingface_hub
huggingface-cli login
huggingface-cli upload EndiVee233/SubFabric ./ms_models/encoder.ms harmonyos-ms/encoder.ms
huggingface-cli upload EndiVee233/SubFabric ./ms_models/decoder_joint.ms harmonyos-ms/decoder_joint.ms
huggingface-cli upload EndiVee233/SubFabric ./ms_models/vocab.txt harmonyos-ms/vocab.txt
huggingface-cli upload EndiVee233/SubFabric ./manifest.json harmonyos-ms/manifest.json
```

上传后在 App 的「设置 → 模型下载」里确认地址，回「模型」页点**下载模型**即可。

> 仓库必须是 **public**。private 仓库需要在请求里带 token，
> 当前实现未支持（`ModelDownloader.fetchManifest` 的 header 里加 `Authorization` 即可扩展）。

### 6.4 可以直接抄的 SHA-256

`vocab.txt` 在所有 parakeet ONNX 导出里是同一份，其 SHA-256 已实测确认：

```
vocab.txt  size=9384  sha256=ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d
```

`encoder.ms` / `decoder_joint.ms` 是你自己转换出来的，哈希必须现场算
（`gen_download_manifest.py` 会自动算）。

### 6.5 HuggingFace 与断点续传

| 项 | 情况 |
| --- | --- |
| 是否支持 Range | ✅ 支持（`huggingface-cli` 的断点续传就依赖它） |
| 直链行为 | `resolve/` 会 **302 跳转到 CDN**（`cdn-lfs*.hf.co`） |
| CDN 是否保留 Range | ⚠️ 通常保留，但**未逐条验证** |

即便某一跳忽略了 Range，下载器也有兜底：检测到异常会
`truncate(0)` 从头重写，并最终用 SHA-256 校验。所以**最坏情况是重下，
不会产生坏文件**。

### 6.6 想省掉自己托管？

另一个办法是把模型**内置进 HAP**（见 [EMBEDDED_MODEL.md](EMBEDDED_MODEL.md)），
代价是安装包 656 MB。两者可以共存：
`prepareModels()` 只在本地没有模型时才解包内置资源，不会和下载冲突。
