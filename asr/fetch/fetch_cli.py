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

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Cookie: 内联文本 > 文件；给 bilibili 落一份 Netscape 文件给 yt-dlp 用 ──
    cookies: Dict[str, str] = {}
    cookies_file = Path(a.cookies_file) if a.cookies_file else None
    if a.cookies:
        cookies = bili.parse_cookie_input(a.cookies)
    elif cookies_file and cookies_file.exists():
        cookies = bili.read_netscape(cookies_file)
    if cookies and site == "bilibili":
        cookies_file = out_dir / "_bili_cookies.txt"     # 落在项目目录里, 随项目一起删
        bili.write_netscape(cookies, cookies_file)
    log("Cookie: " + (bili.describe_login(cookies) if site == "bilibili"
                     else ("使用浏览器 Cookie（%s）" % a.cookies_from_browser if a.cookies_from_browser else "未提供 Cookie")))

    # ── yt-dlp 本体: 没有就从 PyPI 下官方 wheel 解到 asr/ytdlp ──
    ok, why = ytdlp_mod.ensure()
    if not ok:
        emit({"type": "error", "msg": "下载引擎不可用: " + str(why)})
        return 3
    yt_dlp = ytdlp_mod.require()
    log("下载引擎 yt-dlp " + (ytdlp_mod.installed_version() or "?"))

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
        cands = sorted(out_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
        final_path = str(cands[0]) if cands else ""

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


if __name__ == "__main__":
    sys.exit(main())
