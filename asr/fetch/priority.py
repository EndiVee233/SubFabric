# 取自 FlowFetch (github.com/EndiVee233/flowfetch) 的无 Qt 子集, 说明见本目录 README.md
"""优先级列表的通用处理。

画质 / 音质 / 编码三张优先级表都会存进配置，而内置表会随站点变化
（例如哔哩哔哩后来新增的 qn=100、YouTube 新增的 AV1 档位）。这里负责把
用户保存下来的顺序和当前内置表对齐：

- 内置表里已经去掉的档位 → 丢弃；
- 内置表里新增的档位 → 插回它在默认顺序中的位置，而不是一律追加到末尾；
- 用户自己排好的相对顺序保持不变。
"""
from __future__ import annotations

from typing import Any, Iterable, List


def _same(a: Any, b: Any) -> bool:
    # 配置里的数字可能被 JSON 读成 int 或 str，两种都算相等
    return a == b or str(a) == str(b)


def normalize_order(stored: Any, known: Iterable[Any]) -> List[Any]:
    """返回与内置表对齐后的顺序（元素一律取自 known，保持其类型）。"""
    known_list = list(known)
    out: List[Any] = []
    for value in (stored if isinstance(stored, (list, tuple)) else []):
        for item in known_list:
            if _same(value, item) and not any(_same(item, o) for o in out):
                out.append(item)
                break
    if not out:
        return known_list
    for item in known_list:
        if any(_same(item, o) for o in out):
            continue
        pos = 0
        for prev in reversed(known_list[:known_list.index(item)]):
            hit = next((i for i, o in enumerate(out) if _same(prev, o)), None)
            if hit is not None:
                pos = hit + 1
                break
        out.insert(pos, item)
    return out
