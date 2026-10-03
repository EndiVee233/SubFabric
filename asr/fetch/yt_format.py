# 取自 FlowFetch (github.com/EndiVee233/flowfetch) 的无 Qt 子集, 说明见本目录 README.md
"""YouTube 的画质 / 音质 / 编码体系。

思路和 bili_format.py 一致：把「分辨率」「音轨」「编码」拆成三个互相独立的
维度，用户在设置里各自排好优先级，程序据此拼出 yt-dlp 的格式选择器。
这样就不必在一堆「分辨率 · 编码」混排的格式里逐条去挑 —— 想要 1440P 的
AV1、音轨要 Opus，排一次序就够了。

三张表都按「从好到差」排列，因此“最低品质”只需要把顺序倒过来。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .priority import normalize_order

# (高度, 名称, 是否需要会员) —— YouTube 的分辨率阶梯本身免费，
# 4K/8K 只是需要较新的客户端；这里不做会员标记。
QUALITY_TIERS: List[Tuple[int, str, bool]] = [
    (4320, "8K 超高清", False),
    (2160, "4K 超高清", False),
    (1440, "2K 超高清", False),
    (1080, "1080P 全高清", False),
    (720, "720P 高清", False),
    (480, "480P 标清", False),
    (360, "360P 流畅", False),
    (240, "240P 流畅", False),
    (144, "144P 极速", False),
]

# (itag, 名称, 是否需要 YouTube Premium)
# 注意：顺序必须严格按音质从高到低，"最低品质" 直接取反序。
AUDIO_TIERS: List[Tuple[int, str, bool]] = [
    (258, "AAC 384K", True),
    (328, "杜比全景声", True),
    (141, "AAC 256K", True),
    (256, "AAC 192K", True),
    (251, "Opus 160K", False),
    (140, "AAC 128K", False),
    (250, "Opus 70K", False),
    (249, "Opus 50K", False),
    (139, "AAC 48K", False),
]

# (键, 名称, yt-dlp 格式过滤器)
# YouTube 的 vp9 写法是 "vp09.00.51.08"，用 ^=vp9 永远匹配不上，
# 所以这里统一用正则过滤（~= 是正则匹配）。
CODEC_TIERS: List[Tuple[str, str, str]] = [
    ("av01", "AV1", '[vcodec~="^av01"]'),
    ("vp9", "VP9", '[vcodec~="^vp0?9"]'),
    ("avc1", "H.264（兼容性最好）", '[vcodec~="^avc1"]'),
    ("hevc", "H.265（HEVC）", '[vcodec~="^(hvc1|hev1)"]'),
]

DEFAULT_QUALITY_ORDER = [h for h, _n, _v in QUALITY_TIERS]
DEFAULT_AUDIO_ORDER = [a for a, _n, _v in AUDIO_TIERS]
DEFAULT_CODEC_ORDER = [c for c, _n, _f in CODEC_TIERS]

# 组合候选时最多排几档音轨，避免选择器字符串过长。
# 不能只取一档：默认顺序里靠前的几档是需要会员的，普通账号全都拿不到。
MAX_AUDIO_COMBINATIONS = 3

_QUALITY_NAMES = {h: n for h, n, _v in QUALITY_TIERS}
_AUDIO_NAMES = {a: n for a, n, _v in AUDIO_TIERS}
_CODEC_FILTERS = {c: f for c, _n, f in CODEC_TIERS}
_CODEC_NAMES = {c: n for c, n, _f in CODEC_TIERS}


def is_youtube_url(url: str) -> bool:
    text = (url or "").lower()
    return ("youtube.com" in text or "youtu.be" in text
            or "youtube-nocookie.com" in text)


def quality_name(height: Any) -> str:
    try:
        return _QUALITY_NAMES.get(int(height), f"{height}P")
    except (TypeError, ValueError):
        return str(height)


def audio_name(itag: Any) -> str:
    try:
        return _AUDIO_NAMES.get(int(itag), str(itag))
    except (TypeError, ValueError):
        return str(itag)


def codec_name(key: Any) -> str:
    return _CODEC_NAMES.get(str(key), str(key))


def quality_table() -> List[Dict[str, Any]]:
    return [{"value": h, "label": n, "vip": v} for h, n, v in QUALITY_TIERS]


def audio_table() -> List[Dict[str, Any]]:
    return [{"value": a, "label": n, "vip": v} for a, n, v in AUDIO_TIERS]


def codec_table() -> List[Dict[str, Any]]:
    return [{"value": c, "label": n} for c, n, _f in CODEC_TIERS]


def normalize_quality_order(order: Optional[List[Any]] = None) -> List[int]:
    return normalize_order(order, DEFAULT_QUALITY_ORDER)


def normalize_audio_order(order: Optional[List[Any]] = None) -> List[int]:
    return normalize_order(order, DEFAULT_AUDIO_ORDER)


def normalize_codec_order(order: Optional[List[Any]] = None) -> List[str]:
    return normalize_order(order, DEFAULT_CODEC_ORDER)


def _known_only(values: Any, known: List[Any]) -> List[Any]:
    """按给定顺序取出 known 里存在的项。

    这里刻意不做补齐：显式传进来的顺序（例如「不超过 1080P」筛出来的子集）
    就是最终顺序，补齐会把被筛掉的档位又塞回来。
    """
    out: List[Any] = []
    for value in (values or []):
        for item in known:
            if str(value) == str(item) and item not in out:
                out.append(item)
                break
    return out


def _audio_alternatives(order: List[int]) -> List[str]:
    # format_id 是字符串字段，必须加引号，否则会被当成数字比较而永不匹配
    return [f'bestaudio[format_id="{a}"]' for a in order if a] or ["bestaudio"]


def build_audio_selector(order: Optional[List[int]] = None) -> str:
    """仅音频模式：按音质优先级依次尝试。"""
    audios = _known_only(order, DEFAULT_AUDIO_ORDER) or list(DEFAULT_AUDIO_ORDER)
    return "/".join(_audio_alternatives(audios) + ["bestaudio", "best"])


def build_video_selector(quality_order: Optional[List[int]] = None,
                         audio_order: Optional[List[int]] = None,
                         codec_order: Optional[List[str]] = None,
                         prefer_60fps: bool = False) -> str:
    """按「画质 × 音质 × 编码」三层优先级生成 yt-dlp 的格式选择器。"""
    heights = _known_only(quality_order, DEFAULT_QUALITY_ORDER) or list(DEFAULT_QUALITY_ORDER)
    audios = _known_only(audio_order, DEFAULT_AUDIO_ORDER) or list(DEFAULT_AUDIO_ORDER)
    codecs = _known_only(codec_order, DEFAULT_CODEC_ORDER) or list(DEFAULT_CODEC_ORDER)
    audio_alts = _audio_alternatives(audios)[:MAX_AUDIO_COMBINATIONS]

    parts: List[str] = []

    def add(height: int, codec: Optional[str], audio: str, fps: str) -> None:
        vf = f"[height={height}]"
        cf = _CODEC_FILTERS[codec] if codec else ""
        parts.append(f"bestvideo{vf}{cf}{fps}+{audio}")

    # 高帧率偏好单独走一轮：先在所有档位里找 60fps，再按普通顺序来
    if prefer_60fps:
        for h in heights:
            for codec in codecs:
                add(h, codec, audio_alts[0], "[fps>=50]")
            add(h, None, audio_alts[0], "[fps>=50]")

    # 编码优先级必须和音轨解耦：免费账号拿不到上面那几档会员音轨，
    # 如果只在「会员音轨 + 各编码」的组合里试，编码偏好就会整个失效。
    for h in heights:
        for codec in codecs:
            for audio in audio_alts:
                add(h, codec, audio, "")
        for audio in audio_alts:
            add(h, None, audio, "")
        for codec in codecs:
            add(h, codec, "bestaudio", "")
        add(h, None, "bestaudio", "")

    # 分辨率不在阶梯上时（竖屏视频、直播等），退回到「不超过首选档」的最佳画质
    top = heights[0]
    for audio in audio_alts:
        parts.append(f"bestvideo[height<=?{top}]+{audio}")
    parts.append(f"bestvideo[height<=?{top}]+bestaudio")
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
    """构造 YouTube 专用的格式选择器。

    返回 None 表示不接管，交回 downloader.build_format_selector 的通用规则。
    用户明确指定过格式（手动选的格式、界面上的分辨率档位）时一律照办；
    只有「自动」档位才看 yt_use_custom_quality 开关。
    """
    if preset == "custom" and format_id:
        return format_id

    quality = normalize_quality_order(cfg.get("yt_quality_order"))
    audio = normalize_audio_order(cfg.get("yt_audio_order"))
    codec = normalize_codec_order(cfg.get("yt_codec_order"))
    fps = bool(cfg.get("prefer_60fps"))

    if isinstance(preset, str) and preset.startswith("yt:"):
        try:
            height = int(preset.split(":", 1)[1])
        except ValueError:
            height = 0
        if height:
            if audio_only:
                return build_audio_selector(audio)
            return build_video_selector([height], audio, codec, fps)
        return None

    # 界面上直接选了 4K / 1080P 这类档位：只保留不超过它的部分
    if str(preset).isdigit():
        cap = int(preset)
        limited = [h for h in quality if h <= cap]
        if audio_only:
            return build_audio_selector(audio)
        return build_video_selector(limited or quality, audio, codec, fps)

    if not cfg.get("yt_use_custom_quality"):
        return None

    if preset == "worst":
        audio = list(reversed(audio))
        quality = list(reversed(quality))
    elif preset not in ("best", ""):
        return None

    if audio_only:
        return build_audio_selector(audio)
    return build_video_selector(quality, audio, codec, fps)
