"""
锁住 asr_npu.py 的**帧单位换算** —— 这里错过一次，代价很大。

出过的 bug：`_tdt_loop` 里的 `frame` 是**编码器帧**索引（12.5fps，和 while 条件、
`at=frame` 同一口径），但下游（`_decode_windows` 加 mel 帧偏移、`_tokens_to_words`
用 1/MEL_FRAME_RATE 换算）一律按 **mel 帧**（100fps）解释。
记录时间戳时不换算 → 时间戳**压缩 8 倍** → 每句话挤在开头、几秒就放完，
看起来像"识别坏了"。

为什么以前没发现：句子级的 start/end 是由词时间拼出来的，压缩后**依然自洽**
（跨度、排序、相邻不重叠全对），只有把"词/秒"算出来才会露馅。

这个测试做两件事：
  1. 静态：源码里所有 `timings.append` 的 frame 都乘了换算系数（防回退）；
  2. 动态：若环境里有真实结果 JSON，校验词/秒落在人类语速范围。
"""

from __future__ import annotations

import io
import json
import os
import re
import sys

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(WS, ".staging", "asr_npu.py")
REPO_SRC = r"D:\SubFabric-fork\asr\asr_npu.py"

passed = 0
failed = 0


def ok(cond, name, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}" + (f" :: {extra}" if extra else ""))


def main() -> int:
    path = SRC if os.path.exists(SRC) else REPO_SRC
    print(f"源码: {path}")
    text = io.open(path, encoding="utf-8").read()

    print('\n== 1. 换算是按【单位】推出来的，不是拍脑袋的常数 ==')
    m = re.search(r"^ENC_TO_MEL\s*=\s*(.+)$", text, re.M)
    ok(m is not None, "定义了 ENC_TO_MEL")
    if m:
        ok(m.group(1).strip() == "MEL_FRAME_RATE / ENCODER_FRAME_RATE",
           "ENC_TO_MEL = MEL_FRAME_RATE / ENCODER_FRAME_RATE（改帧率常量时自动跟着变）",
           m.group(1).strip())

    print("\n== 2. 常量定义顺序：ENC_TO_MEL 必须在两个帧率之后 ==")
    i_enc = text.find("ENCODER_FRAME_RATE =")
    i_mel = text.find("MEL_FRAME_RATE =")
    i_fac = text.find("ENC_TO_MEL =")
    # 取"定义"而不是引用：ENC_TO_MEL 的赋值行位置
    ok(i_enc >= 0 and i_mel >= 0 and i_fac > i_enc and i_fac > i_mel,
       "ENC_TO_MEL 定义在两个帧率常量之后（否则 NameError）",
       f"enc={i_enc} mel={i_mel} fac={i_fac}")

    print("\n== 3. 每一处 timings.append 都做了换算 ==")
    sites = re.findall(r"timings\.append\(\{[^}]*\}\)", text)
    ok(len(sites) >= 2, f"找到 {len(sites)} 处 timings.append")
    for s in sites:
        has = "ENC_TO_MEL" in s
        ok(has, f"已换算: {s[:64]}", "这处没乘换算系数 → 该 token 的时间戳会压缩 8 倍")

    print("\n== 4. 换算只加在'记录'处，循环内部仍是编码器帧 ==")
    # while frame < limit / at=frame 必须是编码器帧口径，不能被乘过
    ok(re.search(r"while frame < limit", text) is not None, "循环条件仍是 `while frame < limit`")
    ok(re.search(r"min\(valid, int\(frame_limit\)\)", text) is not None,
       "limit 仍按编码器帧数 valid 计算")
    ok(re.search(r'"frame": frame \* ENC_TO_MEL', text) is not None,
       "记录时乘系数（而不是把 frame 变量本身改掉）")
    ok(re.search(r"last_frame = max\(0, valid - 1\)", text) is not None,
       "last_frame 仍按编码器帧口径（valid - 1）")

    print("\n== 5. 下游确实按 mel 帧解释（这是换算的依据）==")
    ok(re.search(r"fps = 1\.0 / MEL_FRAME_RATE", text) is not None,
       "_tokens_to_words 用 1/MEL_FRAME_RATE 把 frame 变成秒")

    print('\n== 6. 拿同一份音频的两个引擎结果对照（这是最有说服力的证据）==')
    # .staging 里留着一批历史结果。关键对照是**同一段音频**分别走
    #   sherpa/CUDA（asr.py，单位本来就对）与 OpenVINO/NPU（asr_npu.py）
    # 如果 GPU 正常、NPU 压缩 8 倍，就直接指向 asr_npu.py 的帧单位。
    pairs = [("b_gpu.json", "b_npu.json"), ("s_gpu.json", "s_npu.json")]
    # 历史结果可能在两处：仓库里的 .staging，或（本机）工作区的 .staging。
    # 找不到就跳过 —— 这一段是"锦上添花的证据"，不该让测试因为路径不同而红。
    stage_cands = [
        os.path.join(WS, ".staging"),
        r"C:\Users\Terry\Documents\deepseek-harness\default-workspace\.staging",
    ]
    stage = next((d for d in stage_cands if os.path.isdir(d)), stage_cands[0])

    def median_rate(path):
        try:
            d = json.load(io.open(path, encoding="utf-8"))
        except Exception:
            return None
        rates = []
        for s in d.get("segments") or []:
            ws = s.get("words") or []
            if len(ws) < 2:
                continue
            span = ws[-1]["end"] - ws[0]["start"]
            if span > 0:
                rates.append(len(ws) / span)
        if not rates:
            return None
        rates.sort()
        return rates[len(rates) // 2]

    shown = 0
    for gpu_f, npu_f in pairs:
        gp, npp = os.path.join(stage, gpu_f), os.path.join(stage, npu_f)
        if not (os.path.exists(gp) and os.path.exists(npp)):
            continue
        g, n = median_rate(gp), median_rate(npp)
        if g is None or n is None:
            continue
        shown += 1
        ratio = n / g if g else 0
        print(f"    {gpu_f}: {g:.2f} 词/秒   {npu_f}: {n:.2f} 词/秒   比值 {ratio:.1f}x")
        ok(g < 6.0, f"{gpu_f}（sherpa）语速正常", f"{g:.2f}")
        # 历史文件是修复前留下的：压缩约 8 倍正是**判据有效**的证明
        ok(ratio > 3.0, f"{npu_f} 相对 GPU 明显压缩 → 证明问题的确是 NPU 帧单位", f"{ratio:.1f}x")

    print('\n== 7. 修复后的结果必须正常（若有）==')
    fixed = next((os.path.join(d, "fixed_check.json") for d in stage_cands
                  if os.path.exists(os.path.join(d, "fixed_check.json"))), None)
    if fixed:
        m = median_rate(fixed)
        print(f"    fixed_check.json 中位语速 {m:.2f} 词/秒")
        ok(m is not None and 1.2 <= m <= 4.5, "修复后落在正常英语语速 1.2~4.5 词/秒", f"{m}")
    else:
        print("    （没有 fixed_check.json，跳过）")
    if not shown:
        print("    （没有可对照的历史结果，跳过）")

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
