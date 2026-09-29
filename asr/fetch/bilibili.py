# SubFabric 下载内核: bilibili 站点适配（精简版, 无 Qt）
#
# 从 FlowFetch 的 app/core/bilibili.py 里只取"无界面也能用"的部分:
#   URL 判定 / Cookie 解析与落盘（Netscape 格式, yt-dlp 直接能吃）
#   扫码登录的 Qt 部分(QR 绘制/BilibiliAuth signal)这里不要 —— 2.0 的登录走
#   "粘贴 Cookie / --cookies-from-browser", 后续要扫码再加纯 HTTP 版。
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional

# bilibili 需要登录态的 Cookie 名（用于判断"这份 cookie 到底算不算登录了"）
LOGIN_COOKIE_KEYS = ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5")
# 只要这些就够 yt-dlp 拉高画质；其余键保留无害
NETSCAPE_HEADER = "# Netscape HTTP Cookie File"


def is_bilibili_url(url: str) -> bool:
    u = (url or "").lower()
    return "bilibili.com" in u or "b23.tv" in u


def parse_cookie_input(text: str) -> Dict[str, str]:
    """把用户粘进来的东西解析成 {name: value}。

    支持三种写法（怎么方便怎么来）:
      1. 请求头原样:   SESSDATA=xxx; bili_jct=yyy
      2. JSON 对象:    {"SESSDATA": "xxx", ...}
      3. Netscape cookies.txt 的内容（复制整份文件也行）
    """
    s = str(text or "").strip()
    if not s:
        return {}
    # JSON
    if s.startswith("{"):
        try:
            obj = json.loads(s)
            if isinstance(obj, dict):
                return {str(k).strip(): str(v).strip() for k, v in obj.items() if str(k).strip()}
        except Exception:
            pass
    out: Dict[str, str] = {}
    for line in s.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Netscape: domain \t flag \t path \t secure \t expire \t name \t value
        if "\t" in line:
            parts = line.split("\t")
            if len(parts) >= 7:
                name, value = parts[5].strip(), parts[6].strip()
                if name:
                    out[name] = value
                continue
        # 请求头 / 分号分隔
        for item in re.split(r"[;\n]", line):
            item = item.strip()
            if not item or "=" not in item:
                continue
            name, value = item.split("=", 1)
            name, value = name.strip(), value.strip()
            if name:
                out[name] = value
    return out


def has_login(cookies: Dict[str, str]) -> bool:
    """这份 cookie 算不算"已登录"（有 SESSDATA 就基本算了）。"""
    keys = {k.lower() for k in (cookies or {}).keys()}
    return any(k.lower() in keys for k in LOGIN_COOKIE_KEYS if k.lower() == "sessdata") or "sessdata" in keys


def write_netscape(cookies: Dict[str, str], path: Path, domain: str = ".bilibili.com") -> Path:
    """写成 yt-dlp 能吃的 Netscape cookies.txt。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    expire = int(time.time()) + 180 * 24 * 3600
    lines = [NETSCAPE_HEADER, "# 由 SubFabric 生成（来源: 用户粘贴或浏览器 Cookie）", ""]
    for name, value in (cookies or {}).items():
        lines.append("\t".join([domain, "TRUE", "/", "FALSE", str(expire), str(name), str(value)]))
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


def read_netscape(path: Path) -> Dict[str, str]:
    p = Path(path)
    if not p.exists():
        return {}
    return parse_cookie_input(p.read_text(encoding="utf-8", errors="replace"))


def cookie_header(cookies: Dict[str, str]) -> str:
    return "; ".join(f"{k}={v}" for k, v in (cookies or {}).items())


def describe_login(cookies: Optional[Dict[str, str]]) -> str:
    """给日志用: 登录态一句话（**不打印任何 cookie 值**）。"""
    c = cookies or {}
    if not c:
        return "未提供 Cookie（只能下到免登录画质）"
    if has_login(c):
        return "已提供登录 Cookie（含 SESSDATA，可下会员画质）"
    return "提供了 %d 个 Cookie 但没看到 SESSDATA（可能未登录）" % len(c)
