"""WhisperX / pyannote 在本机的兼容补丁（2026-10-23 验证）。

问题链：
  1. pyannote 的 checkpoint 由 Lightning 读取；torch >= 2.6 默认 weights_only=True，
     会拒绝 omegaconf.ListConfig 等对象。设置 TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 可解。
  2. Lightning 的 `_restricted_classmethod_impl` 在 `load_from_checkpoint()` 里调用
     `inspect.stack()`；`inspect.getmodule()` 走到 SpeechBrain 的 LazyModule，触发
     `speechbrain.utils.importutils.LazyModule.__getattr__` 的递归解析，最终
     `RecursionError: maximum recursion depth exceeded`。
  3. 对 LazyModule 的 dunder 属性直接抛 AttributeError，inspect 就会正常跳过；
     VAD 与 diarization 都能加载。

用法：在 import whisperx / whisperx.diarize 之前调用 install()。
必须同时设置环境变量 TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1（本模块会 setdefault）。
"""

import os

os.environ.setdefault('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD', '1')

_installed = False

_DUNDERS = frozenset({
    '__file__', '__spec__', '__loader__', '__path__', '__name__',
    '__package__', '__cached__',
})


def install():
    global _installed
    if _installed:
        return
    # 先导入 pyannote，让 Lightning / torch 先完成初始化；不要在 speechbrain 之后再导入。
    import pyannote.audio.pipelines  # noqa: F401
    from speechbrain.utils import importutils

    orig = importutils.LazyModule.__getattr__

    def safe_getattr(self, name):
        if name in _DUNDERS:
            raise AttributeError(name)
        return orig(self, name)

    importutils.LazyModule.__getattr__ = safe_getattr
    _installed = True


if __name__ == '__main__':
    install()
    import torch
    import whisperx
    from whisperx.vads import Pyannote

    vad = Pyannote(torch.device('cuda'), use_auth_token=None, chunk_size=30,
                   vad_onset=0.5, vad_offset=0.363)
    print('pyannote VAD loaded:', type(vad.vad_pipeline))
