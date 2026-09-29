# 取自 FlowFetch (github.com/EndiVee233/flowfetch) 的无 Qt 子集, 说明见本目录 README.md
"""yt-dlp 的唯一入口：确保它在、并把它交给其它模块。

为什么要单独一层：
程序打包成 exe 分发时**不内置 yt-dlp**（它更新频繁，内置就等于把版本冻结在打包那一刻），
而是沿用程序既有的能力 —— 从 PyPI 下载官方 wheel 解压到 `%APPDATA%\\YtDlpGui\\lib`。
副作用是：全新机器上首次启动时 `import yt_dlp` 会失败（旧代码是顶层 import，会直接崩）。

因此这里统一提供：
- `available()`     —— 静默探测，能拿到 yt_dlp 就返回 True（不会联网、不弹窗）；
- `ensure()`        —— 缺失时抓取安装，返回 `(成功?, 失败原因)`；
- `require()`       —— 模块导入期用，拿不到就抛 `YtDlpMissing`，由上层给出中文提示；
- `yt_dlp` 代理对象 —— 支持 `yt_dlp.YoutubeDL` / `yt_dlp.utils.DownloadError` /
  `yt_dlp.version.__version__` / `yt_dlp.postprocessor.xxx` 等全部子模块访问方式。

其它模块请一律写 `from .ytdlp import yt_dlp`（或 `from ..core.ytdlp import yt_dlp`），
不要再直接 `import yt_dlp`，否则打包后又会出现「顶层导入即崩溃」的问题。
"""
from __future__ import annotations

import importlib
import json
import os
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional, Tuple

# 与 app/__init__.py 保持一致：程序自管的组件目录
_PKG_DIR = Path(__file__).resolve().parent.parent / "ytdlp"   # SubFabric: 组件自管目录 asr/ytdlp
PYPI_JSON = "https://pypi.org/pypi/yt-dlp/json"
_USER_AGENT = "SubFabric/2.0 (+https://github.com/EndiVee233/SubFabric)"

# 安装失败的原因（中文，直接可以显示给用户）
ERR_OFFLINE = "无法连接 PyPI（pypi.org）。上传/下载引擎需要联网获取，请检查网络或代理后重试。"
ERR_NO_WHEEL = "PyPI 上没有找到可用的 yt-dlp 安装包（wheel）。"
ERR_UNPACK = "下载完成但解压失败，可能是磁盘空间不足或文件被占用。"

# 最近一次导入失败的原因：打包后最容易出的问题就是「文件都在但 import 不起来」，
# 把真实异常留住，界面和日志里才能看见，而不是只报一句「未就绪」。
_LAST_ERROR = ""


class YtDlpMissing(RuntimeError):
    """yt-dlp 尚未就绪时抛出（调用方应给出中文提示而不是让它崩到控制台）。"""


def lib_dir() -> Path:
    return _PKG_DIR


def _insert_lib_path() -> None:
    p = str(_PKG_DIR)
    if _PKG_DIR.is_dir():
        if p in sys.path:
            sys.path.remove(p)
        sys.path.insert(0, p)


def _import_now() -> Optional[Any]:
    """尝试导入 yt_dlp；失败原因记进 _LAST_ERROR（供界面显示与排查）。"""
    global _LAST_ERROR
    _insert_lib_path()
    # 清掉 importlib 的目录缓存，否则刚解压出来的包可能仍是「找不到」
    importlib.invalidate_caches()
    try:
        import yt_dlp  # noqa: PLC0415 —— 必须在插入 sys.path 之后再导入
    except Exception as exc:
        _LAST_ERROR = f"{type(exc).__name__}: {exc}"
        return None
    _LAST_ERROR = ""
    return yt_dlp


def last_import_error() -> str:
    """最近一次导入失败的原因（成功则为空）。"""
    return _LAST_ERROR


def _dbg(message: str) -> None:
    """把自举过程写进 %APPDATA%\\YtDlpGui\\logs\\bootstrap.log。

    打包分发后没有控制台，用户报「打不开」时这份日志是唯一线索，
    因此即使成功也留一行。
    """
    try:
        from datetime import datetime
        base = _PKG_DIR.parent / "logs"
        base.mkdir(parents=True, exist_ok=True)
        with open(base / "bootstrap.log", "a", encoding="utf-8") as fh:
            fh.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}\n")
    except Exception:
        pass


def _package_files_ok() -> bool:
    """组件目录里是否已有一份**看起来完整**的 yt_dlp。

    只在 import 失败后才用：避免把上次解压到一半的残缺包当成可用，
    也避免「明明装过、只是这次没网」就白跑一趟下载。
    """
    pkg = _PKG_DIR / "yt_dlp"
    if not (pkg / "__init__.py").is_file():
        return False
    # 关键子模块各查一个，缺任何一个都说明上次解压没完成
    required = (
        "version.py", "YoutubeDL.py", "extractor/__init__.py",
        "downloader/__init__.py", "postprocessor/__init__.py",
        "utils/__init__.py", "networking/__init__.py",
    )
    return all((pkg / rel).is_file() for rel in required)


def available() -> bool:
    """静默探测：能导入 yt_dlp 就为 True（不联网）。"""
    return _import_now() is not None


def installed_version() -> str:
    mod = _import_now()
    try:
        return str(mod.version.__version__) if mod is not None else ""
    except Exception:
        return ""


def _request(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    return urllib.request.urlopen(req, timeout=30)


def _unpack_wheel(archive: Path) -> bool:
    """把 wheel（本质是 zip）解压出来，跳过 .dist-info 的元数据目录结构。"""
    try:
        _PKG_DIR.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as zf:
            for member in zf.namelist():
                # 只取包本体与 dist-info：wheel 里不会有路径穿越的合法成员
                if member.endswith("/") or member.startswith(".."):
                    continue
                top = member.split("/", 1)[0]
                if not (top == "yt_dlp" or top.endswith(".dist-info")):
                    continue
                target = _PKG_DIR / member
                if member.endswith(".dist-info/RECORD"):
                    # RECORD 里的哈希在解压后校验不了，留着会让「更新」逻辑误判
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 256)
        return (_PKG_DIR / "yt_dlp" / "__init__.py").is_file()
    except Exception:
        return False


def install(force: bool = False) -> Tuple[bool, str]:
    """从 PyPI 抓取官方 wheel 并解压到组件目录。返回 (成功?, 失败原因)。"""
    if not force and available():
        return True, ""

    try:
        with _request(PYPI_JSON) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as exc:
        _dbg(f"查询 PyPI 失败：{type(exc).__name__}: {exc}")
        # 没网但本地已有一份完好的包 —— 直接用，不要让用户卡在首次启动
        if _package_files_ok():
            _dbg("网络不可用，但组件目录已有完整的 yt_dlp，直接使用")
            if available():
                return True, ""
            _dbg(f"本地包仍无法导入：{_LAST_ERROR}")
        return False, ERR_OFFLINE

    url = ""
    for item in (data.get("urls") or []):
        name = str(item.get("filename") or "")
        if item.get("packagetype") == "bdist_wheel" and name.endswith(".whl"):
            url = str(item.get("url") or "")
            break
    if not url:
        return False, ERR_NO_WHEEL

    _PKG_DIR.mkdir(parents=True, exist_ok=True)
    archive = _PKG_DIR / "yt_dlp-download.whl"
    try:
        with _request(url) as resp, open(archive, "wb") as fh:
            shutil.copyfileobj(resp, fh, 1024 * 256)
        _dbg(f"已下载 {archive.stat().st_size} 字节")
    except Exception as exc:
        _dbg(f"下载 wheel 失败：{type(exc).__name__}: {exc}")
        try:
            archive.unlink()
        except OSError:
            pass
        if _package_files_ok() and available():
            _dbg("下载失败，但组件目录已有完整的 yt_dlp，直接使用")
            return True, ""
        return False, ERR_OFFLINE

    ok = _unpack_wheel(archive)
    try:
        archive.unlink()
    except OSError:
        pass
    if not ok:
        _dbg("解压失败")
        return False, ERR_UNPACK

    importlib.invalidate_caches()
    if available():
        _dbg(f"安装完成：{installed_version()}")
        return True, ""
    _dbg(f"解压成功但导入失败：{_LAST_ERROR}")
    return False, ERR_UNPACK


def ensure() -> Tuple[bool, str]:
    """确保 yt-dlp 可用（已就绪时零开销、不联网）。"""
    if available():
        return True, ""
    # 导入失败但文件齐全，多半是「刚解压完、解释器缓存还没刷新」或某个标准库缺失，
    # 把真实原因记下来再尝试安装，否则日志里只剩一句「未就绪」没法查。
    if _package_files_ok():
        _dbg(f"组件目录已有文件但导入失败：{_LAST_ERROR}")
    ok, reason = install()
    # 收尾再确认一次：install() 内部的 available() 与这里的调用可能不同步，
    # 记下来才能区分「装好了」和「装好了但导入仍失败」。
    final = available()
    _dbg(f"ensure 结束：install={ok} 最终 available={final} 导入错误={_LAST_ERROR or '无'}")
    if ok or final:
        return True, ""
    return False, reason


def require() -> Any:
    """模块导入期调用：拿不到就抛 YtDlpMissing。"""
    mod = _import_now()
    if mod is None:
        raise YtDlpMissing(
            "未找到 yt-dlp 下载引擎。请在「设置 → 组件」中安装，或检查网络后重启程序。")
    return mod


class _LazyYtDlp:
    """`yt_dlp` 的惰性代理。

    模块导入期不再真的去 import，只有真正用到属性时才触发，
    因此就算引擎尚未安装，程序也能启动到界面（设置页会显示「未安装」）。
    """

    __slots__ = ("_mod",)

    def __init__(self) -> None:
        object.__setattr__(self, "_mod", None)

    def _target(self) -> Any:
        mod = object.__getattribute__(self, "_mod")
        if mod is None:
            mod = require()
            object.__setattr__(self, "_mod", mod)
        return mod

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._target(), name, value)

    def __repr__(self) -> str:  # pragma: no cover - 便于调试
        return "<lazy yt_dlp>"


# 全项目唯一的 yt_dlp 入口
yt_dlp: Any = _LazyYtDlp()
