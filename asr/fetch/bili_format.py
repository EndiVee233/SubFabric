# 取自 FlowFetch (github.com/EndiVee233/flowfetch) 的无 Qt 子集, 说明见本目录 README.md
"""哔哩哔哩画质 / 音质 / 编码体系。

yt-dlp 的哔哩哔哩解析器会把接口返回的 qn（quality）写进格式的
quality 字段，并且格式过滤器支持任意字段，因此可以直接用
bestvideo[quality=120] 这种写法精确指定画质。

qn 对照表与 BBDown 等工具一致。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from .priority import normalize_order

# (qn, 名称, 是否需要大会员)
QUALITY_TIERS: List[Tuple[int, str, bool]] = [
    (127, "8K 超高清", True),
    (126, "杜比视界", True),
    (125, "HDR 真彩色", True),
    (120, "4K 超高清", True),
    (116, "1080P 60帧", True),
    (112, "1080P 高码率", True),
    (80, "1080P 高清", False),
    (100, "AI智能修复", True),
    (74, "720P 60帧", True),
    (64, "720P 准高清", False),
    (32, "480P 标清", False),
    (16, "360P 流畅", False),
    (6, "240P 极速", False),
]

# 档位顺序与 BBDown 一致。qn=100 是哔哩哔哩的「智能修复」，只有部分老视频
# 存在这一路流：支持时才会出现在 accept_quality 里，不支持时格式选择器会
# 自动回退到下一个档位，因此放进优先级列表是安全的。

AUDIO_TIERS: List[Tuple[int, str, bool]] = [
    (30251, "Hi-Res 无损", True),
    (30250, "杜比全景声", True),
    (30280, "192K", False),
    (30232, "132K", False),
    (30216, "64K", False),
]

CODEC_TIERS: List[Tuple[str, str, str]] = [
    ("av1", "AV1", "[vcodec^=av01]"),
    ("hevc", "HEVC（H.265）", "[vcodec^=hvc1]"),
    ("avc", "AVC（H.264）", "[vcodec^=avc1]"),
]

DEFAULT_QUALITY_ORDER = [q for q, _n, _v in QUALITY_TIERS]
DEFAULT_AUDIO_ORDER = [a for a, _n, _v in AUDIO_TIERS]
DEFAULT_CODEC_ORDER = [c for c, _n, _f in CODEC_TIERS]

# 下载页直接展示的常用档位，其余放进“更多画质”
COMMON_QUALITIES = [120, 116, 112, 80, 16]

# 画质候选中最多组合几档音质，避免选择器字符串过长
MAX_AUDIO_COMBINATIONS = 3

_QUALITY_NAMES = {q: n for q, n, _v in QUALITY_TIERS}
_AUDIO_NAMES = {a: n for a, n, _v in AUDIO_TIERS}
_CODEC_FILTERS = {c: f for c, _n, f in CODEC_TIERS}
_CODEC_NAMES = {c: n for c, n, _f in CODEC_TIERS}


def normalize_quality_order(order: Optional[List[Any]] = None) -> List[int]:
    """把保存下来的画质优先级与内置档位表对齐（详见 priority.normalize_order）。"""
    return normalize_order(order, DEFAULT_QUALITY_ORDER)


def normalize_audio_order(order: Optional[List[Any]] = None) -> List[int]:
    """把保存下来的音质优先级与内置档位表对齐。

    三张表都要归一化，理由和 yt_format 那边一致：档位表会随站点调整
    （例如后来新增的 Hi-Res 30251），不做对齐的话老配置里既看不到新档位，
    也会一直留着已经被去掉的旧档位。
    """
    return normalize_order(order, DEFAULT_AUDIO_ORDER)


def normalize_codec_order(order: Optional[List[Any]] = None) -> List[str]:
    """把保存下来的编码优先级与内置档位表对齐。"""
    return normalize_order(order, DEFAULT_CODEC_ORDER)


def _norm_name(name: Any) -> str:
    return re.sub(r"\s+", "", str(name or "")).lower()


# 接口里的 display_desc 是简称（如 "4K"），new_description 才是全称。
# 这里把两种写法都登记上，方便把 yt-dlp 日志里的画质名换回 qn。
_NAME_ALIASES = {
    "8k": 127, "8k超高清": 127,
    "杜比": 126, "dolby": 126,
    "hdr": 125, "hdr真彩": 125,
    "4k": 120, "4k超清": 120,
    "1080p60": 116,
    "1080p+": 112, "1080p高码": 112,
    "智能修复": 100, "ai修复": 100,
    "720p60": 74,
    "720p": 64,
    "480p": 32, "360p": 16, "240p": 6,
}

_NAME_TO_QN = {_norm_name(name): qn for qn, name, _v in QUALITY_TIERS}
_NAME_TO_QN.update(_NAME_ALIASES)


def quality_by_name(name: Any) -> Optional[int]:
    """把画质名称（「4K 超高清」「4K」…）换算成 qn，认不出来时返回 None。"""
    return _NAME_TO_QN.get(_norm_name(name))


def quality_name(qn: Any) -> str:
    try:
        return _QUALITY_NAMES.get(int(qn), f"{qn}P")
    except (TypeError, ValueError):
        return str(qn)


def audio_name(aid: Any) -> str:
    try:
        return _AUDIO_NAMES.get(int(aid), str(aid))
    except (TypeError, ValueError):
        return str(aid)


def codec_name(key: Any) -> str:
    return _CODEC_NAMES.get(str(key), str(key))


def quality_table() -> List[Dict[str, Any]]:
    return [{"value": q, "label": n, "vip": v} for q, n, v in QUALITY_TIERS]


def audio_table() -> List[Dict[str, Any]]:
    return [{"value": a, "label": n, "vip": v} for a, n, v in AUDIO_TIERS]


def codec_table() -> List[Dict[str, Any]]:
    return [{"value": c, "label": n} for c, n, _f in CODEC_TIERS]


def _audio_alternatives(order: List[int]) -> List[str]:
    # format_id 是字符串字段，必须加引号，否则会被当成数字比较而永不匹配
    items = [f'bestaudio[format_id="{a}"]' for a in order if a]
    items.append('bestaudio[format_id="30280"]')
    items.append("bestaudio")
    seen, out = set(), []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def build_audio_selector(order: Optional[List[int]] = None) -> str:
    """仅音频模式：按音质优先级依次尝试。"""
    return "/".join(_audio_alternatives(list(order or DEFAULT_AUDIO_ORDER)))


def build_video_selector(quality_order: Optional[List[int]] = None,
                         audio_order: Optional[List[int]] = None,
                         codec_order: Optional[List[str]] = None) -> str:
    """按“画质优先级 × 编码优先级”生成 yt-dlp 的 format 选择器。"""
    qualities = [q for q in (quality_order or DEFAULT_QUALITY_ORDER) if q]
    audios = [a for a in (audio_order or DEFAULT_AUDIO_ORDER) if a]
    codecs = [c for c in (codec_order or DEFAULT_CODEC_ORDER) if c in _CODEC_FILTERS]
    if not qualities:
        qualities = list(DEFAULT_QUALITY_ORDER)
    if not codecs:
        codecs = list(DEFAULT_CODEC_ORDER)

    # 音质同样要有回退，否则首选音质不存在时整条候选都会失败，
    # 画质优先级就会被后面的兜底项绕过。这里取音质优先级的前几档做组合。
    audio_alts = _audio_alternatives(audios)[:MAX_AUDIO_COMBINATIONS]

    parts: List[str] = []
    for qn in qualities:
        for audio in audio_alts:
            for codec in codecs:
                parts.append(f"bestvideo[quality={qn}]{_CODEC_FILTERS[codec]}+{audio}")
            parts.append(f"bestvideo[quality={qn}]+{audio}")
    # 上述组合都不可用时，仍限制在用户给定的画质档位内
    for qn in qualities:
        parts.append(f"bestvideo[quality={qn}]+bestaudio")
    # 最终兜底，保证下载不会因为档位表而对所有视频都失败
    parts.append("bestvideo+bestaudio")
    parts.append("best")

    seen, out = set(), []
    for item in parts:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return "/".join(out)


def build_selector(cfg, audio_only: bool, preset: str = "",
                   format_id: str = "") -> Optional[str]:
    """构造哔哩哔哩专用的格式选择器；未启用自定义画质时返回 None。

    preset 为 "bili:<qn>" 时表示界面上明确选定了一个画质档位。
    """
    if preset == "custom" and format_id:
        return format_id

    # 三张表都先与内置表对齐：老配置里可能缺少后来新增的档位（音质 30251
    # Hi-Res、编码 av1 等），也可能留着已删除的档位。这里兜一层，保证下载时
    # 用的顺序和设置界面显示的一致。
    audio_order = normalize_audio_order(cfg.get("bili_audio_order"))
    codec_order = normalize_codec_order(cfg.get("bili_codec_order"))

    if isinstance(preset, str) and preset.startswith("bili:"):
        try:
            qn = int(preset.split(":", 1)[1])
        except ValueError:
            qn = 0
        if qn:
            if audio_only:
                return build_audio_selector(audio_order)
            return build_video_selector([qn], audio_order, codec_order)

    # 自动挡：best = 按画质优先级降序（最高优先），worst = 升序（最低优先）
    qn_order = normalize_quality_order(cfg.get("bili_quality_order"))

    if preset == "best":
        if audio_only:
            return build_audio_selector(audio_order)
        return build_video_selector(qn_order, audio_order, codec_order)
    if preset == "worst":
        if audio_only:
            a_order = list(audio_order)
            a_order.reverse()
            return build_audio_selector(a_order)
        return build_video_selector(list(reversed(qn_order)), audio_order, codec_order)

    if not cfg.get("bili_use_custom_quality"):
        return None
    if audio_only:
        return build_audio_selector(audio_order)
    return build_video_selector(qn_order, audio_order, codec_order)
