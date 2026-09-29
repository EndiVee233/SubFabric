# SubFabric 下载内核: 格式选择器（纯函数, 不联网/不依赖 Qt → 可直接单测）
#
# 职责: 把界面上选的"画质档位"翻译成 yt-dlp 的 -f 表达式。
# 站点差异交给 vendor 来的 bili_format / yt_format（它们带完整的 qn/height、音质、编码优先级表），
# 本站只做: URL 判站 → 档位归一 → 候选列表 → 兜底链。
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import bili_format, yt_format

# 画质档位（界面上给出的选项）; "bili:<qn>" / "yt:<height>" 是站点专用写法, 高级用户可用
PRESETS = ["best", "2160", "1440", "1080", "720", "480", "360", "audio", "worst"]

# bilibili 的 qn → 名义高度。用它把"1080"这类档位映射成 qn 候选列表。
# （label 是中文("1080P 60帧"/"4K 超高清"), 不适合解析, 所以这里显式列一张表。）
BILI_QN_HEIGHT: Dict[int, int] = {
    127: 4320, 126: 2160, 125: 2160, 120: 2160, 116: 1080, 112: 1080,
    100: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 6: 240,
}


def site_of(url: str) -> str:
    """判定站点: 'bilibili' / 'youtube' / ''（其他站点不支持）。"""
    u = str(url or "").strip()
    if not u:
        return ""
    try:
        if bili_format is not None and _is_bili(u):
            return "bilibili"
        if _is_yt(u):
            return "youtube"
    except Exception:
        return ""
    return ""


def _is_bili(url: str) -> bool:
    from .bilibili import is_bilibili_url
    return is_bilibili_url(url)


def _is_yt(url: str) -> bool:
    return bool(yt_format.is_youtube_url(url))


def supported(url: str) -> bool:
    return site_of(url) != ""


def quality_choices(url: str) -> List[Dict[str, Any]]:
    """给界面用的画质选项（站点原表, 只保留用户能选的意义上的档位）。"""
    site = site_of(url)
    if site == "bilibili":
        return bili_format.quality_table()
    if site == "youtube":
        return yt_format.quality_table()
    return []


def _bili_qn_candidates(height: int) -> List[int]:
    """不超过 height 的 qn 候选，按"从高到低"排（高码率/60帧优先于普通档）。"""
    cands = [qn for qn, h in BILI_QN_HEIGHT.items() if h <= height]
    cands.sort(key=lambda qn: (-BILI_QN_HEIGHT[qn], -qn))
    return cands


def build_format_selector(url: str, preset: str = "best", cfg: Optional[Dict[str, Any]] = None,
                          custom: str = "") -> str:
    """把档位翻译成 -f 表达式。

    - best    : 站点画质优先级里的最高档（有大会员 cookie 时自然吃到 8K/HDR）
    - 2160/1080/720/... : 不超过该高度的最高档
    - audio   : 只要音频
    - worst   : 最低档（自检/快速试跑用）
    - bili:<qn> / yt:<height> : 站点专用写法
    - custom  : 直接使用用户给的表达式
    返回值永远**带兜底**（`/bestvideo+bestaudio/best`），某一档拿不到时 yt-dlp 会往下退，
    而不是直接失败 —— 这是"没有大会员也能下"的关键。
    """
    cfg = cfg or {}
    p = str(preset or "best").strip()
    if p == "custom" and custom:
        return custom
    site = site_of(url)

    if p == "audio":
        base = bili_format.build_audio_selector(bili_format.normalize_audio_order(cfg.get("bili_audio_order"))) \
            if site == "bilibili" else yt_format.build_audio_selector(yt_format.normalize_audio_order(cfg.get("yt_audio_order")))
        return base or "bestaudio/best"

    if site == "bilibili":
        order = bili_format.normalize_quality_order(cfg.get("bili_quality_order"))
        a_order = bili_format.normalize_audio_order(cfg.get("bili_audio_order"))
        c_order = bili_format.normalize_codec_order(cfg.get("bili_codec_order"))
        if p == "worst":
            return "worstvideo*+worstaudio/worst"
        if p == "best":
            return _with_fallback(bili_format.build_video_selector(order, a_order, c_order))
        if p.startswith("bili:"):
            try:
                qn = int(p.split(":", 1)[1])
            except ValueError:
                qn = 0
            if qn:
                return _with_fallback(bili_format.build_video_selector([qn], a_order, c_order))
        if p.isdigit():
            cands = _bili_qn_candidates(int(p))
            if cands:
                return _with_fallback(bili_format.build_video_selector(cands, a_order, c_order))
        return _with_fallback(bili_format.build_video_selector(order, a_order, c_order))

    # YouTube / 其他
    if p == "worst":
        return "worstvideo*+worstaudio/worst"
    y_order = yt_format.normalize_quality_order(cfg.get("yt_quality_order"))
    y_audio = yt_format.normalize_audio_order(cfg.get("yt_audio_order"))
    y_codec = yt_format.normalize_codec_order(cfg.get("yt_codec_order"))
    if p.startswith("yt:"):
        try:
            height = int(p.split(":", 1)[1])
        except ValueError:
            height = 0
        if height:
            return _with_fallback(yt_format.build_video_selector([height], y_audio, y_codec))
    if p.isdigit():
        return _with_fallback(yt_format.build_video_selector([int(p)], y_audio, y_codec))
    return _with_fallback(yt_format.build_video_selector(y_order, y_audio, y_codec))


def _with_fallback(sel: Optional[str]) -> str:
    """站点选择器后面缀一条通用兜底链。"""
    base = (sel or "").strip()
    fb = "bestvideo+bestaudio/best"
    if not base:
        return fb
    if fb in base:
        return base
    return base + "/" + fb


def describe(url: str, preset: str, cfg: Optional[Dict[str, Any]] = None) -> str:
    """给日志用的一句人话。"""
    site = site_of(url) or "未知站点"
    return "%s · 档位 %s → %s" % (site, preset, build_format_selector(url, preset, cfg))
