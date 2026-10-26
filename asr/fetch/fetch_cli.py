# SubFabric 下载内核 CLI
#
# 由 editor/server.js 以子进程方式调用, 逐行输出 JSON（与 asr/*.py 的 progress 协议一致）:
#   {"type":"progress","pct":37,"msg":"下载中 … 12.3 MB / 45.6 MB  2.1 MB/s  剩 16s"}
#   {"type":"done","file":"...","metaPath":"...","meta":{...}}
#   {"type":"error","msg":"..."}
#
# 用法示例:
#   python -m fetch.fetch_cli --url https://www.bilibili.com/video/BVxxxx \
#       --out "D:\...\projects\p-xxx\video" --quality best --meta-out "...\source.json" \
#       --cookies-file "...\bili_cookies.txt" --proxy http://127.0.0.1:7890
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

# 允许 `python fetch_cli.py` 与 `python -m fetch.fetch_cli` 两种跑法
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from fetch import bilibili as bili  # type: ignore
    from fetch import selector as sel  # type: ignore
    from fetch import ytdlp as ytdlp_mod  # type: ignore
else:
    from . import bilibili as bili
    from . import selector as sel
    from . import ytdlp as ytdlp_mod


# stdout 强制 UTF-8: Windows 默认按 ANSI(GBK) 输出, 而服务端按 UTF-8 读 —— 不锁就会拿到乱码。
# （服务端虽然会设 PYTHONIOENCODING=utf-8, 但 CLI 不该依赖调用方。）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 兜底"最新 mtime 文件"时的媒体扩展名白名单 —— 免得把 _bili_cookies.txt / *.part / *.ytdl 之类当成下载产物。
MEDIA_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".flv", ".ts",
              ".m4a", ".mp3", ".aac", ".opus", ".ogg", ".wav", ".m4v"}


def emit(obj: Dict[str, Any]) -> None:
    """一行一个 JSON, flush 掉, 服务端边读边解析。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    emit({"type": "log", "msg": msg})


def sanitize(name: str, fallback: str = "video") -> str:
    """文件名安全化（保留中文, 去掉 Windows 非法字符）。"""
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", str(name or "")).strip(" .")
    s = re.sub(r"\s{2,}", " ", s)
    return (s[:120] or fallback)


def find_ffmpeg(explicit: str = "") -> Optional[str]:
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return str(p)
        cand = p / "ffmpeg.exe"
        if cand.is_file():
            return str(cand)
    w = shutil.which("ffmpeg")
    return w or None


# ── JavaScript 运行时（yt-dlp 的 YouTube 完整解析需要） ─────────────────────
# 2025 年底以后，yt-dlp 解析 YouTube 的 nsig/挑战脚本需要一个 JS 运行时；默认只启用
# Deno。没有运行时它会退回「jsl」兼容客户端并打一条英文 WARNING —— 用户会把它当成
# 故障（截图反馈）。这里主动找本机已有的 Node.js / Deno / Bun / QuickJS，交给
# yt-dlp 的 `js_runtimes`，能拿到完整格式，也不再出现那条警告。
_RUNTIME_NAMES = {"deno": "deno", "node": "node", "nodejs": "node", "bun": "bun",
                  "qjs": "quickjs", "quickjs": "quickjs", "quickjs-ng": "quickjs"}
_RUNTIME_PRIORITY = {"deno": 0, "node": 1, "quickjs": 2, "bun": 3}


def _runtime_from_path(path: str) -> tuple[str, str]:
    """路径 → (运行时名, 路径)。认不出名字时返回空名。

    ⚠ 不能只靠 Path(path).stem：Windows 路径在 POSIX 上反斜杠不算分隔符，
       CI（Linux）跑测试时 "C:\\Program Files\\nodejs\\node.exe" 会被当成一整个文件名，
       于是认不出 node。这里同时按 / 与 \\ 切，再按最后一个点去扩展名。"""
    p = Path(path)
    base = re.split(r"[\\/]", str(path).rstrip("\\/"))[-1]
    stem = os.path.splitext(base)[0].lower()
    # qjs / qjs-ng / quickjs 的 exe 名不一定带版本号
    if stem.startswith("qjs"):
        return "quickjs", str(p)
    for key, name in _RUNTIME_NAMES.items():
        if stem == key or stem.startswith(key):
            return name, str(p)
    return "", str(p)


def _runtime_version(name: str, path: str) -> str:
    try:
        import subprocess
        if name == "quickjs":
            args = [path, "--help"]
        else:
            args = [path, "--version"]
        out = subprocess.run(args, capture_output=True, text=True, timeout=6,
                             encoding="utf-8", errors="replace")
        text = (out.stdout or "") + (out.stderr or "")
        m = re.search(r"v?(\d+\.\d+(?:\.\d+)?)", text)
        return m.group(1) if m else ""
    except Exception:
        return ""


def find_js_runtimes() -> list[tuple[str, str]]:
    """本机可用的 JS 运行时，按 yt-dlp 的优先级返回 [(name, path)]。
    显式环境变量（SUBFABRIC_JS_RUNTIME / SUBFABRIC_NODE_PATH）优先于 PATH 探测。"""
    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(name: str, path: str) -> None:
        if not name or not path:
            return
        try:
            if not Path(path).is_file():
                return
        except OSError:
            return
        key = str(Path(path).resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        found.append((name, path))

    explicit = os.environ.get("SUBFABRIC_JS_RUNTIME", "").strip()
    if explicit:
        # 支持 `node:C:\path\node.exe`、单条路径、以及 os.pathsep 分隔的多条
        for raw in re.split(r"[;\n]+", explicit):
            raw = raw.strip()
            if not raw:
                continue
            if ":" in raw and not re.match(r"^[A-Za-z]:[\\/]", raw):
                name, path = [x.strip() for x in raw.split(":", 1)]
                add(_RUNTIME_NAMES.get(name.lower(), name.lower()), path)
            else:
                add(*_runtime_from_path(raw))
    node_hint = os.environ.get("SUBFABRIC_NODE_PATH", "").strip()
    if node_hint:
        add("node", node_hint)
    for exe in ("deno", "node", "bun", "qjs"):
        w = shutil.which(exe)
        if w:
            add(*_runtime_from_path(w))
    found.sort(key=lambda x: _RUNTIME_PRIORITY.get(x[0], 9))
    return found


def make_logger():
    """yt-dlp 的 logger: 只把有意义的话转发成 log 行（debug 丢弃, 免得刷屏）。"""
    class _L:
        def debug(self, msg):
            s = str(msg)
            if s.startswith("[") and ("ERROR" in s or "WARNING" in s):
                log(s)

        def info(self, msg):
            pass

        def warning(self, msg):
            log(str(msg))

        def error(self, msg):
            emit({"type": "error", "msg": str(msg)})

    return _L()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="SubFabric 视频下载（bilibili / YouTube）")
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True, help="下载目录（通常是项目目录下的 video/）")
    ap.add_argument("--part", type=int, default=1, help="分P（bilibili 多P视频，默认 1；链接里带 ?p=N 时以链接为准）")
    ap.add_argument("--quality", default="best", help="档位: best/2160/1080/720/480/360/audio/worst")
    ap.add_argument("--custom-format", default="", help="直接给 yt-dlp 的 -f 表达式")
    ap.add_argument("--cookies", default="", help="Cookie 文本（SESSDATA=...; bili_jct=... 或 JSON）")
    ap.add_argument("--cookies-file", default="", help="Netscape cookies.txt 路径")
    ap.add_argument("--cookies-from-browser", default="", help="从浏览器读 cookie: chrome/edge/firefox")
    ap.add_argument("--proxy", default="", help="代理, 如 http://127.0.0.1:7890")
    ap.add_argument("--ffmpeg", default="", help="ffmpeg 可执行文件或其所在目录")
    ap.add_argument("--meta-out", default="", help="把视频信息写成这个 JSON（给 LLM 分角色用）")
    ap.add_argument("--simulate", action="store_true", help="只解析元数据, 不下载")
    ap.add_argument("--timeout", type=int, default=0, help="单次网络超时(秒), 0=yt-dlp 默认")
    a = ap.parse_args(argv)

    url = a.url.strip()
    site = sel.site_of(url)
    if not site:
        emit({"type": "error", "msg": "只支持 bilibili 与 YouTube 链接（其他站点暂不支持）"})
        return 2

    # 分P（bilibili 多P视频）：链接里的 ?p=N 优先，其次用 --part（默认 1）
    if site == "bilibili":
        part_in_url = bili.part_of(url)
        part = part_in_url if part_in_url > 1 else max(1, int(a.part or 1))
        url = bili.set_part(url, part)
        if part > 1:
            log("分P: %d%s" % (part, "（取自链接 ?p=）" if part_in_url > 1 else ""))

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Cookie: 内联文本 > 文件；给 bilibili 落一份 Netscape 文件给 yt-dlp 用 ──
    cookies: Dict[str, str] = {}
    cookies_file = Path(a.cookies_file) if a.cookies_file else None
    if a.cookies:
        cookies = bili.parse_cookie_input(a.cookies)
    elif cookies_file and cookies_file.exists():
        cookies = bili.read_netscape(cookies_file)
    created_cookie_file: Optional[Path] = None
    if cookies and site == "bilibili":
        cookies_file = out_dir / "_bili_cookies.txt"     # 落在项目目录里, 下载收尾随项目一起删
        bili.write_netscape(cookies, cookies_file)
        created_cookie_file = cookies_file               # 本函数自己落盘的明文文件, 收尾必删
    try:
        log("Cookie: " + (bili.describe_login(cookies) if site == "bilibili"
                         else ("使用浏览器 Cookie（%s）" % a.cookies_from_browser if a.cookies_from_browser else "未提供 Cookie")))

        # ── yt-dlp 本体: 没有就从 PyPI 下官方 wheel 解到 asr/ytdlp ──
        ok, why = ytdlp_mod.ensure()
        if not ok:
            emit({"type": "error", "msg": "下载引擎不可用: " + str(why)})
            return 3
        yt_dlp = ytdlp_mod.require()
        log("下载引擎 yt-dlp " + (ytdlp_mod.installed_version() or "?"))
        # YouTube 完整解析需要的 JS 运行时（见 find_js_runtimes 的说明）：
        # 有就交给 yt-dlp，没有就明确写一条中文日志，避免用户把英文 WARNING 当故障。
        js_runtimes = find_js_runtimes()

        fmt = sel.build_format_selector(url, a.quality, {}, a.custom_format)
        # 日志里只留开头一段: bilibili 的 best 链会枚举"画质×编码×音质"几千字符, 整条打进日志会把界面刷爆
        log("格式选择: " + (fmt if len(fmt) <= 160 else fmt[:160] + " …(共 %d 字符, 完整表达式见 source.json)" % len(fmt)))

        state = {"last": -1, "t0": time.time(), "final": None}

        def on_progress(d):
            try:
                if d.get("status") == "downloading":
                    total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    got = d.get("downloaded_bytes") or 0
                    pct = int(got * 100 / total) if total else 0
                    if pct != state["last"] or time.time() - state["t0"] > 2:
                        state["last"] = pct
                        state["t0"] = time.time()
                        sp = d.get("speed") or 0
                        eta = d.get("eta") or 0
                        emit({"type": "progress", "pct": max(0, min(99, pct)), "msg":
                              "下载中 %d%%  %.1f/%.1f MB  %s  剩 %s" % (
                                  pct, got / 1048576, (total / 1048576) if total else 0,
                                  ("%.1f MB/s" % (sp / 1048576)) if sp else "-",
                                  ("%ds" % eta) if eta else "-")})
                elif d.get("status") == "finished":
                    emit({"type": "progress", "pct": 99, "msg": "下载完成, 正在合并音视频 …"})
            except Exception:
                pass

        def on_pp(d):
            try:
                if d.get("status") == "started":
                    emit({"type": "progress", "pct": 99, "msg": "后处理: " + str(d.get("postprocessor") or "")})
            except Exception:
                pass

        opts: Dict[str, Any] = {
            "format": fmt,
            "outtmpl": str(out_dir / "%(title).120B [%(id)s].%(ext)s"),
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "progress_hooks": [on_progress],
            "postprocessor_hooks": [on_pp],
            "logger": make_logger(),
            "retries": 5,
            "fragment_retries": 5,
            "concurrent_fragment_downloads": 4,
            "restrictfilenames": False,
            "windowsfilenames": True,
            "nopart": False,
        }
        ff = find_ffmpeg(a.ffmpeg)
        if ff:
            opts["ffmpeg_location"] = ff
            log("ffmpeg: " + ff)
        if js_runtimes:
            opts["js_runtimes"] = {name: {"path": p} for name, p in js_runtimes}
            desc = "、".join(
                ("%s %s" % (name, _runtime_version(name, p))).strip() for name, p in js_runtimes)
            log("JS 运行时: " + desc + "（YouTube 完整格式解析已启用）")
        else:
            log("未找到 JavaScript 运行时（Node.js / Deno / Bun）：YouTube 会退回兼容客户端，"
                "个别高清格式可能缺失；安装 Node.js 或 Deno 后自动启用完整解析")
        if a.proxy:
            opts["proxy"] = a.proxy
            log("代理: " + a.proxy)
        if cookies_file and Path(cookies_file).exists():
            opts["cookiefile"] = str(cookies_file)
        if a.cookies_from_browser:
            opts["cookiesfrombrowser"] = (a.cookies_from_browser,)
        if a.timeout:
            opts["socket_timeout"] = a.timeout

        emit({"type": "progress", "pct": 1, "msg": "解析链接中 …"})
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=not a.simulate)
        except Exception as exc:
            emit({"type": "error", "msg": "%s: %s" % (type(exc).__name__, exc)})
            return 4

        if info is None:
            emit({"type": "error", "msg": "解析失败（拿不到视频信息）"})
            return 4
        if info.get("_type") == "playlist" and info.get("entries"):
            info = info["entries"][0]

        # 真实落盘文件（合并后的）
        final_path = ""
        rds = info.get("requested_downloads") or []
        if rds and rds[0].get("filepath"):
            final_path = rds[0]["filepath"]
        if not final_path:
            try:
                final_path = info.get("requested_downloads", [{}])[0].get("_filename", "")
            except Exception:
                final_path = ""
        if not final_path and not a.simulate:
            cands = []
            for p in out_dir.glob("*"):
                if p.suffix.lower() not in MEDIA_EXTS:
                    continue                                        # 只认媒体文件, 排除 cookie/part/ytdl 等残留
                try:
                    cands.append((p.stat().st_mtime, str(p)))
                except OSError:
                    continue                                        # 并发删除/被占用 → 跳过, 别让 stat 异常冒出去
            cands.sort(reverse=True)
            final_path = cands[0][1] if cands else ""

        meta = {
            "source": site,
            "url": url,
            "id": info.get("id") or "",
            "title": info.get("title") or "",
            "description": info.get("description") or "",
            "uploader": info.get("uploader") or info.get("channel") or "",
            "uploaderId": info.get("uploader_id") or info.get("channel_id") or "",
            "duration": info.get("duration") or 0,
            "uploadDate": info.get("upload_date") or "",
            "tags": info.get("tags") or [],
            "categories": info.get("categories") or [],
            "viewCount": info.get("view_count") or 0,
            "thumbnail": info.get("thumbnail") or "",
            "qualityPreset": a.quality,
            "formatSelector": fmt,
            "formatId": info.get("format_id") or "",
            "formatNote": info.get("format_note") or "",
            "height": info.get("height") or 0,
            "file": final_path,
            "fileSize": (Path(final_path).stat().st_size if final_path and Path(final_path).exists() else 0),
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        if a.meta_out:
            mp = Path(a.meta_out)
            mp.parent.mkdir(parents=True, exist_ok=True)
            tmp = mp.with_suffix(mp.suffix + ".tmp")
            tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, mp)

        if a.simulate:
            emit({"type": "done", "file": "", "metaPath": a.meta_out, "meta": meta})
            return 0
        if not final_path or not Path(final_path).exists():
            emit({"type": "error", "msg": "下载似乎没有产出文件（检查画质档位或登录态）"})
            return 5

        emit({"type": "progress", "pct": 100, "msg": "已下载: " + Path(final_path).name})
        emit({"type": "done", "file": final_path, "metaPath": a.meta_out, "meta": meta})
        return 0
    finally:
        # 只删本函数自己创建的那份明文 cookie 文件（cookiefile 只喂给 yt-dlp, 此后不再复用）。
        # 调用方经 --cookies-file 传入的文件不在 created_cookie_file 里, 绝不触碰。
        if created_cookie_file is not None:
            try:
                created_cookie_file.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
