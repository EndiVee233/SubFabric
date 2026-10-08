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
    """不超过 height 的 qn 候选，按站点档位表的**原位顺序**（从高到低；60帧/高码率在普通档之前）。

    顺序与 QUALITY_TIERS（BBDown 对齐）一致，例：1080 → [116, 112, 80, 100, 74, 64, 32, 16, 6]。
    这同时就是 bilibili 默认档的“只降不升”链（见 build_format_selector 的 best 分支）。"""
    return [q for q in bili_format.DEFAULT_QUALITY_ORDER if BILI_QN_HEIGHT.get(q, 0) <= height]


def build_format_selector(url: str, preset: str = "best", cfg: Optional[Dict[str, Any]] = None,
                          custom: str = "") -> str:
    """把档位翻译成 -f 表达式。

    - best    : bilibili 侧 = **1080P 优先、只降不升**（大会员先试 1080P 60帧，见下方注释）；
                YouTube 侧仍为站点画质优先级里的最高档（带通用兜底）
    - 2160/1080/720/... : 不超过该高度的最高档，且**不向上越档**（兜底链带 height 上限）
    - audio   : 只要音频
    - worst   : 最低档（自检/快速试跑用）
    - bili:<qn> / yt:<height> : 站点专用写法（高级用户）
    - custom  : 直接使用用户给的表达式
    bilibili 的兜底链带高度上限（只降不升）；YouTube 侧仍以 /bestvideo+bestaudio/best 收尾 ——
    某一档拿不到时往下退而不是直接失败，这是“没有大会员也能下”的关键。
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
        a_order = bili_format.normalize_audio_order(cfg.get("bili_audio_order"))
        c_order = bili_format.normalize_codec_order(cfg.get("bili_codec_order"))
        if p == "worst":
            return "worstvideo*+worstaudio/worst"
        if p == "best":
            # 默认档 = 「1080P 优先、只降不升」（2026-10-08 定策）:
            #   · 大会员: 先试 1080P 60帧(116) → 1080P 高码率(112) → 1080P(80) → AI修复(100) → 720P… → 240P
            #   · 非大会员/未登录: 116/112/100/74 这些 VIP 档不会出现在接口返回的可用列表里,
            #     选择器就在本地下移到 1080P(80) —— 一条链同时覆盖两种身份, 掉档不发额外请求。
            #   · **不向上取**: 链与兜底都带 height<=1080; 4K/8K/HDR 需要把档位显式选成 2160。
            return bili_format.build_video_selector(_bili_qn_candidates(1080), a_order, c_order, height_cap=1080)
        if p.startswith("bili:"):
            try:
                qn = int(p.split(":", 1)[1])
            except ValueError:
                qn = 0
            if qn:
                return _with_fallback(bili_format.build_video_selector([qn], a_order, c_order))
        if p.isdigit():
            cap = int(p)
            cands = _bili_qn_candidates(cap)
            if cands:
                return bili_format.build_video_selector(cands, a_order, c_order, height_cap=cap)
        # 未知档位：退回默认（1080P 优先链，只降不升）
        return bili_format.build_video_selector(_bili_qn_candidates(1080), a_order, c_order, height_cap=1080)

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
