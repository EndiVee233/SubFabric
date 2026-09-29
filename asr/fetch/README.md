# asr/fetch —— SubFabric 的下载内核

给 2.0 的「下载初稿流水线」用：**粘贴 bilibili / YouTube 链接 → 自动下载进项目目录 → 接着跑初稿**。

## 目录内容

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `yt_format.py` | FlowFetch `app/core/yt_format.py` | YouTube 画质/音质/编码档位表 + 选择器构造（**纯标准库**） |
| `bili_format.py` | FlowFetch `app/core/bili_format.py` | bilibili 的 qn（含 8K/HDR/杜比/大会员档）与选择器构造（**纯标准库**） |
| `priority.py` | FlowFetch `app/core/priority.py` | 上面两个模块用的"优先级列表归一化" |
| `ytdlp.py` | FlowFetch `app/core/ytdlp.py` | **yt-dlp 自举**：从 PyPI 下官方 wheel 解压到 `asr/ytdlp/`，不碰系统 Python；只在改了组件目录与 UA |
| `selector.py` | 本站新写 | 把界面档位（best/2160/1080/…/audio/worst/custom）翻译成 yt-dlp `-f`；站点差异交给上面两张表；**永远带兜底链** |
| `bilibili.py` | FlowFetch 的同名文件精简而来 | 只保留 URL 判定 + Cookie 解析（请求头 / JSON / Netscape 三种写法）+ Netscape 落盘；**Qt 的扫码登录部分没要** |
| `fetch_cli.py` | 本站新写 | CLI：解析 → 下载 → 元数据 → 逐行 JSON 进度（与 `asr/*.py` 同一协议） |

FlowFetch 与 SubFabric 同属 EndiVee233，可直接复用；改动处都在文件头写了注记。

## 设计要点

- **登录态**：`--cookies`（粘贴 `SESSDATA=…; bili_jct=…`）或 `--cookies-file`（Netscape）或 `--cookies-from-browser chrome`。
  bilibili 的 Cookie 会落到**项目目录**里的 `_bili_cookies.txt`（随项目一起删），绝不写进日志。
  有大会员 Cookie 时 `--quality best` 自然吃到 8K/HDR —— 选择器里 qn=127/126/125/120 这些档本来就排在前面。
- **代理**：`--proxy http://127.0.0.1:7890`（YouTube 在国内必须；bilibili 一般不用）。
- **兜底**：所有选择器都以 `/bestvideo+bestaudio/best` 结尾 —— 某一档拿不到（比如没有大会员）会往下退，不是直接失败。
- **元数据**：写 `source.json`（title / description / uploader / duration / tags / viewCount / thumbnail / 实际 format 与高度 / 文件路径）。
  这是「LLM 分角色」推断阵容的输入。
- **进度协议**（stdout 一行一个 JSON）：
  `{"type":"progress","pct":37,"msg":"…"}` · `{"type":"done","file":"…","metaPath":"…","meta":{…}}` · `{"type":"error","msg":"…"}`
- **yt-dlp 不进仓库/安装包**：首次使用时由 `ytdlp.ensure()` 从 PyPI 下官方 wheel 到 `asr/ytdlp/`（约 3MB）。
  离线环境下这一步会给出明确的中文报错。

## 手动试跑

```powershell
python asr\fetch\fetch_cli.py --url "https://www.bilibili.com/video/BV1xxxxxxxxx" `
    --out "D:\tmp\fetchtest" --quality 360 --meta-out "D:\tmp\fetchtest\source.json" `
    --ffmpeg "D:\Program Files\ffmpeg\bin"
```

`--simulate` 只解析元数据不下载（用来验证链接/登录态/画质档位）。

## 验证

- `tests/fetch-format-test.py`：纯逻辑单测（判站 / 档位→`-f` / qn 候选 / Cookie 三种写法 / Netscape 往返 / 登录态描述不泄露值）
- 真机（本机 bilibili 可达）：BV1GJ411x7h7，`--quality 360` → 9.17 MB mp4 落盘 + `source.json`；
  `--simulate` 时 `best` 档解析到 `formatId 100026+30280`（**免登录 1080P**）
- YouTube 路径只能做逻辑验证（本机无代理，`youtube.com` 超时）—— 真机验证需要你在有代理的环境跑
