# asr/fetch —— SubFabric 的下载内核

给 2.0 的「下载初稿流水线」用：**粘贴 bilibili / YouTube 链接 → 自动下载进项目目录 → 接着跑初稿**。

## 目录内容

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `yt_format.py` | FlowFetch `app/core/yt_format.py` | YouTube 画质/音质/编码档位表 + 选择器构造（**纯标准库**） |
| `bili_format.py` | FlowFetch `app/core/bili_format.py` | bilibili 的 qn（含 8K/HDR/杜比/大会员档）与选择器构造（**纯标准库**） |
| `priority.py` | FlowFetch `app/core/priority.py` | 上面两个模块用的"优先级列表归一化" |
| `ytdlp.py` | FlowFetch `app/core/ytdlp.py` | **yt-dlp 自举**：从 PyPI 下官方 wheel 解压到 `asr/ytdlp/`，不碰系统 Python；只在改了组件目录与 UA |
| `selector.py` | 本站新写 | 把界面档位（best/2160/1080/…/audio/worst/custom）翻译成 yt-dlp `-f`；站点差异交给上面两张表；bilibili 侧**只降不升**（默认/数字档的兜底链带 height 上限），YouTube 侧仍带通用兜底 |
| `bilibili.py` | FlowFetch 的同名文件精简而来 | 只保留 URL 判定 + Cookie 解析（请求头 / JSON / Netscape 三种写法）+ Netscape 落盘；**Qt 的扫码登录部分没要** |
| `fetch_cli.py` | 本站新写 | CLI：解析 → 下载 → 元数据 → 逐行 JSON 进度（与 `asr/*.py` 同一协议） |

FlowFetch 与 SubFabric 同属 EndiVee233，可直接复用；改动处都在文件头写了注记。

## 设计要点

- **登录态**：`--cookies`（粘贴 `SESSDATA=…; bili_jct=…`）或 `--cookies-file`（Netscape）或 `--cookies-from-browser chrome`。
  **只复制到 SESSDATA 的值**（没有 `SESSDATA=` 前缀）也认 —— 会自动按 `SESSDATA=<值>` 处理（否则整份解析成空 = 未登录，画质掉档）。
  bilibili 的 Cookie 会落到**项目目录**里的 `_bili_cookies.txt`（随项目一起删），绝不写进日志；
  桌面端的设置里则是**密文保存**（Windows 走 DPAPI，其它平台走 AES-GCM），保存后会立刻调 nav 接口验证登录态。
  账号能下哪些档由**服务端按登录态过滤**（116/112/100/74 等大会员档不会出现在非会员的返回里），选择器只负责按固定顺序往下试。
- **bilibili 默认档（best）= 1080P 优先、只降不升**（2026-10-08 定策）：大会员先试 1080P 60帧(116)
  → 1080P 高码率(112) → 1080P(80) → AI修复(100) → 720P → … → 240P；非大会员/未登录时 VIP 档不在
  可用列表里，就地往下退到 1080P(80)/720P。**绝不向上取**：链与兜底都带 `height<=1080`（不会 60帧拿不到
  就跳去 4K），想要 4K 需把档位选成 2160（同样只降不升、封顶 4K）。数字档（720/480/360…）同理带各自上限。
- **代理**：`--proxy http://127.0.0.1:7890`（YouTube 在国内必须；bilibili 一般不用）。
- **兜底**：YouTube 与 bilibili 高级档以 `/bestvideo+bestaudio/best` 结尾；bilibili 默认/数字档的兜底
  带 `height<=` 上限 —— 某一档拿不到（比如没有大会员）会往下退，不是直接失败，也不会往上取。
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
  `--simulate`（无 Cookie）实测：`best`/`1080` → `100026+30280`（qn=80，免登录 1080P）、`720` → `100024`
  （720P）、`2160` 同样只落在可用的 1080P —— 链从 116 起步、无权限档自动下移，"1080P 优先、只降不升"生效。
- YouTube 路径只能做逻辑验证（本机无代理，`youtube.com` 超时）—— 真机验证需要你在有代理的环境跑
