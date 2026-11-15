"""Android download worker: pinned yt-dlp, shared desktop selectors, no shell or ffmpeg subprocess."""
import http.cookiejar
import io
import ipaddress
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fetch import bilibili, selector

MAX_BYTES = 2 * 1024 * 1024 * 1024


def validate_url(value):
    text = str(value or "").strip()
    if not text or len(text) > 8192 or any(ord(c) < 32 for c in text):
        raise ValueError("链接格式无效")
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("仅支持不含账号密码的 HTTP/HTTPS 链接")
    if parts.scheme == "http":
        try:
            address = ipaddress.ip_address(parts.hostname)
            local = address.is_private or address.is_loopback
        except ValueError:
            local = parts.hostname == "localhost"
        if not local:
            raise ValueError("公网下载链接必须使用 HTTPS")
    return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))


def public_url(value):
    p = urlsplit(str(value or ""))
    query = [(k, v) for k, v in parse_qsl(p.query) if k in ("v", "p")]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(query), ""))


def cookie_jar(bili_text, youtube_text):
    jar = http.cookiejar.MozillaCookieJar()
    if youtube_text.strip():
        loaded = http.cookiejar.MozillaCookieJar()
        loaded._really_load(io.StringIO(youtube_text), "cookies.txt", True, False)
        for cookie in loaded:
            domain = cookie.domain.lstrip(".").lower()
            if not any(domain == d or domain.endswith("." + d) for d in ("youtube.com", "google.com", "youtu.be")):
                raise ValueError("YouTube Cookie 文件含有其它站点")
            cookie.secure = True
            jar.set_cookie(cookie)
    for name, value in bilibili.parse_cookie_input(bili_text).items():
        if name not in bilibili.LOGIN_COOKIE_KEYS:
            continue
        jar.set_cookie(http.cookiejar.Cookie(0, name, value, None, False, ".bilibili.com", True, True,
                                             "/", True, True, None, True, None, None, {}))
    return jar


def runtime_info(quickjs):
    import certifi
    import yt_dlp.version
    import yt_dlp_ejs
    result = subprocess.run([quickjs, "-e", "print(1+1)"], capture_output=True, timeout=5, check=True)
    if result.stdout.strip() != b"2":
        raise RuntimeError("JavaScript 组件不可用")
    return json.dumps({"ytDlp": yt_dlp.version.__version__, "ejs": getattr(yt_dlp_ejs, "__version__", "0.8.0"),
                       "certificateBundle": bool(Path(certifi.where()).is_file()), "quickjs": True})


def run(request_json, folder, quickjs, bili_cookie, youtube_cookie, callback):
    import certifi
    import yt_dlp
    from yt_dlp.utils import DownloadError

    request = json.loads(request_json)
    root = Path(folder).resolve()
    root.mkdir(parents=True, exist_ok=True)
    url = validate_url(request["url"])
    part = max(1, min(100000, int(request.get("part", 1))))
    if bilibili.is_bilibili_url(url) and part > 1:
        parsed = urlsplit(url)
        query = dict(parse_qsl(parsed.query)); query["p"] = str(part)
        url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))
    quality = request.get("quality", "best")
    if quality not in selector.PRESETS:
        raise ValueError("画质档位无效")
    jar = cookie_jar(bili_cookie, youtube_cookie)

    class Quiet:
        def debug(self, _message):
            pass

        def warning(self, _message):
            pass

        def error(self, _message):
            pass

    def check():
        if callback.isCancelled():
            raise DownloadError("任务已取消")

    opts = {"logger": Quiet(), "noplaylist": True, "playlist_items": str(part), "quiet": True,
            "no_warnings": True, "socket_timeout": 15, "retries": 2, "fragment_retries": 2,
            "concurrent_fragment_downloads": 1, "nocheckcertificate": False,
            "proxy": request.get("proxy", ""), "cachedir": str(root / "cache"),
            "format": selector.build_format_selector(url, quality), "fixup": "never",
            "postprocessors": [], "max_filesize": MAX_BYTES, "continuedl": bool(selector.site_of(url)),
            "js_runtimes": {"quickjs": {"path": quickjs}}, "remote_components": set(),
            "hls_prefer_native": True, "overwrites": False}
    # The interpreter's OpenSSL uses the pinned, extracted CA bundle.
    import os
    os.environ["SSL_CERT_FILE"] = certifi.where()

    def client(extra=None):
        ydl = yt_dlp.YoutubeDL({**opts, **(extra or {})})
        for cookie in jar:
            ydl.cookiejar.set_cookie(cookie)
        return ydl

    check()
    if request.get("kind") == "cookie":
        with client() as ydl, ydl.urlopen("https://api.bilibili.com/x/web-interface/nav") as response:
            data = json.loads(response.read(1024 * 1024).decode("utf-8")).get("data", {})
        return json.dumps({"isLogin": bool(data.get("isLogin")), "message": str(data.get("uname") or "未登录")[:100]})
    callback.onProgress(0, 0, 0, "正在解析链接")
    with client() as ydl:
        info = ydl.extract_info(url, download=False)
        if info and info.get("_type") in ("playlist", "multi_video"):
            info = next((entry for entry in info.get("entries", ()) if entry), None)
        if not info:
            raise DownloadError("没有可下载的媒体")
        if info.get("is_live"):
            raise DownloadError("请等待直播结束后下载回放")
        info = ydl.sanitize_info(info)
        source = {"title": str(info.get("title") or "在线素材")[:200],
                  "uploader": str(info.get("uploader") or info.get("channel") or "")[:200],
                  "description": str(info.get("description") or "")[:20000],
                  "duration": info.get("duration"), "id": str(info.get("id") or "")[:200],
                  "site": selector.site_of(url) or "direct", "url": public_url(info.get("webpage_url") or url)}
        thumbnail = info.get("thumbnail")
        if thumbnail:
            try:
                thumbnail = "https:" + thumbnail if thumbnail.startswith("//") else thumbnail
                with ydl.urlopen(validate_url(thumbnail)) as image:
                    data = image.read(2 * 1024 * 1024 + 1)
                if len(data) <= 2 * 1024 * 1024:
                    (root / "thumbnail.bin").write_bytes(data)
            except Exception:
                pass
        if request.get("kind") == "probe":
            return json.dumps({"source": source}, ensure_ascii=False)

    formats = info.get("requested_formats") or [info]
    if len(formats) > 4:
        raise DownloadError("媒体轨道数量超过上限")
    tracks, completed = [], 0
    for index, fmt in enumerate(formats):
        check()
        validate_url(fmt.get("url", ""))
        extension = str(fmt.get("ext") or "bin").lower()
        if not re.fullmatch("[a-z0-9]{1,8}", extension):
            raise DownloadError("媒体格式无效")
        format_id = re.sub("[^a-zA-Z0-9_-]", "_", str(fmt.get("format_id") or index))[:80]
        target = root / ("track-" + format_id + "." + extension)
        if not selector.site_of(url) and target.with_suffix(target.suffix + ".part").exists():
            partial = target.with_suffix(target.suffix + ".part")
            partial.rename(root / (partial.name + ".retry-" + str(request.get("attempt", 0))))

        def hook(data, base=completed, number=index):
            check()
            size = int(data.get("downloaded_bytes") or 0)
            total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
            if base + size > MAX_BYTES:
                raise DownloadError("素材超过 2GB 上限")
            fraction = min(1, size / total) if total else 0
            callback.onProgress(base + size, total if len(formats) == 1 else 0,
                                (number + fraction) / len(formats) * 90, "正在下载素材")

        track = {**info, **fmt}
        for key in ("requested_formats", "requested_downloads", "__postprocessors", "__files_to_move"):
            track.pop(key, None)
        with client({"outtmpl": str(target), "progress_hooks": [hook]}) as ydl:
            ydl.process_info(track)
        check()
        if not target.is_file() or target.stat().st_size == 0:
            raise DownloadError("下载文件不完整")
        completed += target.stat().st_size
        if completed > MAX_BYTES:
            raise DownloadError("素材超过 2GB 上限")
        tracks.append({"file": target.name, "ext": extension, "video": fmt.get("vcodec") != "none",
                       "audio": fmt.get("acodec") != "none"})
    return json.dumps({"source": source, "tracks": tracks}, ensure_ascii=False)
