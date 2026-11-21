"""Generate the exact `converter_lite` invocation for the Parakeet `.ms` models.

Why this exists: ONNX cannot be loaded by MindSpore Lite on HarmonyOS, so the
Parakeet ONNX export has to be converted to `.ms` on a PC first. `converter_lite`
ships with the MindSpore Lite Linux package (and inside DevEco for some
versions), so this script does not perform the conversion - it inspects the real
ONNX graphs in `models/` and prints the command lines plus the expected shapes,
so the conversion is reproducible instead of guesswork.

Usage:
    python tools/gen_ms_conversion.py                    # print commands
    python tools/gen_ms_conversion.py --check            # also sanity-check graphs
    python tools/gen_ms_conversion.py --out build.sh     # write a shell script
"""
import argparse
import os
import struct
import sys

# 模型目录：默认按顺序找第一个存在的候选位置。模型（约 3.2 GB）不随项目分发，
# 用 --model-dir 显式指定，或设 SUBSFABRIC_MODELS 环境变量。
MODEL_CANDIDATES = [
    os.environ.get("SUBSFABRIC_MODELS", ""),
    os.path.join("models", "istupakov__parakeet-tdt-0.6b-v2-onnx"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models",
                 "istupakov__parakeet-tdt-0.6b-v2-onnx"),
]


def _default_model_dir():
    for c in MODEL_CANDIDATES:
        if c and os.path.isdir(c):
            return c
    return MODEL_CANDIDATES[1]


MODEL_DIR = _default_model_dir()

# Shapes the HarmonyOS side expects. These are NOT guesses - they are the static
# shapes that app/asr.py applies before compiling on the OpenVINO path, and the
# ArkTS backend (entry/src/main/ets/engine/ParakeetEngine.ets) hard-codes the
# same contract.
ENC_HIDDEN = 1024
DEC_HIDDEN = 640
MEL_BINS = 128
WINDOW_FRAMES = 1501      # 15.01 s of mel @ 100 fps
ENC_FRAMES = 188          # (1501 - 1) // 8 + 1
VOCAB_INCL_BLANK = 1025
JOINT_DIM = 1030          # 1025 vocab + 5 duration heads


def read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


def fields(buf):
    pos = 0
    n = len(buf)
    while pos < n:
        key, pos = read_varint(buf, pos)
        fnum, wt = key >> 3, key & 7
        if wt == 0:
            val, pos = read_varint(buf, pos)
            yield fnum, wt, val
        elif wt == 2:
            ln, pos = read_varint(buf, pos)
            yield fnum, wt, buf[pos:pos + ln]
            pos += ln
        elif wt == 1:
            yield fnum, wt, buf[pos:pos + 8]
            pos += 8
        elif wt == 5:
            yield fnum, wt, buf[pos:pos + 4]
            pos += 4
        else:
            raise ValueError("bad wire type %d" % wt)


ETYPE = {1: "float32", 2: "uint8", 3: "int8", 6: "int32", 7: "int64",
         9: "bool", 10: "float16", 11: "float64"}


def graph_io(path):
    """Return (inputs, outputs) as lists of (name, dtype, dims) without onnx."""
    with open(path, "rb") as fh:
        raw = fh.read()
    graph = None
    for fnum, wt, val in fields(raw):
        if fnum == 7 and wt == 2:
            graph = val
            break
    if graph is None:
        raise ValueError("no GraphProto in %s" % path)

    def value_info(vi):
        """ValueInfoProto -> (name, dtype, dims).

        NOTE: GraphProto and TensorProto BOTH use field number 5, but for
        different things (Input vs dims). So the input/output lists must be read
        from a position where we already know we are inside GraphProto, and the
        `type` sub-message must be walked structurally. Reading naive
        `fields()` at graph level silently picks up initializers instead of
        inputs - that bug produced empty names here.
        """
        name, etype, dims = "", 0, []
        for f2, w2, v2 in fields(vi):
            if f2 == 1 and w2 == 2:                 # ValueInfoProto.name
                name = v2.decode("utf-8", "replace")
            elif f2 == 2 and w2 == 2:               # ValueInfoProto.type
                # TypeProto.tensor_type == 1, NOT 2 (2 is sequence_type).
                for f3, w3, v3 in fields(v2):
                    if f3 != 1 or w3 != 2:          # TypeProto.tensor_type
                        continue
                    for f4, w4, v4 in fields(v3):
                        if f4 == 1 and w4 == 0:     # TensorProto.elem_type
                            etype = v4
                        elif f4 == 2 and w4 == 2:   # TensorProto.shape
                            for f5, w5, v5 in fields(v4):
                                if f5 != 1 or w5 != 2:   # TensorShapeProto.dim
                                    continue
                                dv, dp = None, None
                                for f6, w6, v6 in fields(v5):
                                    if f6 == 1 and w6 == 2:      # dim_param
                                        dp = v6.decode("utf-8", "replace")
                                    elif f6 == 2 and w6 == 0:    # dim_value
                                        dv = v6
                                dims.append(dp if dp is not None else dv)
                    break
        return name, ETYPE.get(etype, etype), dims

    # ---- GraphProto 字段号（已对本机 ONNX 实测确认，勿凭记忆改）----
    #   field 1  -> node        （encoder 有 4491 条）
    #   field 5  -> initializer （权重；名字是 pre_encode.* 这类张量名）
    #   field 11 -> input
    #   field 12 -> output
    # 早期版本把 input 写成 5、output 写成 11，两处都错位一格，
    # 结果 ins 恒为空、所有输入被误当成输出，--check 的输出完全不可信。
    GF_INPUT = 11
    GF_OUTPUT = 12

    ins, outs = [], []
    for fnum, wt, val in fields(graph):
        if fnum == GF_INPUT and wt == 2:
            info = value_info(val)
            if info[0]:
                ins.append(info)
        elif fnum == GF_OUTPUT and wt == 2:
            info = value_info(val)
            if info[0]:
                outs.append(info)
    return ins, outs


def human(nbytes):
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024 or unit == "GB":
            return "%.1f %s" % (nbytes, unit) if unit != "B" else "%d B" % nbytes
        nbytes /= 1024.0


def dims_str(dims):
    """Render dims where None means 'dynamic' (dim_param or missing)."""
    return "[" + ", ".join("?" if d is None else str(d) for d in dims) + "]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=MODEL_DIR)
    ap.add_argument("--out", default="", help="write commands to this shell script")
    ap.add_argument("--check", action="store_true", help="inspect the ONNX graphs")
    args = ap.parse_args()

    md = args.model_dir
    if not os.path.isdir(md):
        print("找不到模型目录：%s" % md, file=sys.stderr)
        print("模型文件（约 3.2 GB）不随项目分发。请用 --model-dir 指定，", file=sys.stderr)
        print("或设置环境变量 SUBSFABRIC_MODELS，例如：", file=sys.stderr)
        print("  python tools/gen_ms_conversion.py --check \\", file=sys.stderr)
        print("      --model-dir /path/to/istupakov__parakeet-tdt-0.6b-v2-onnx", file=sys.stderr)
        return 1

    enc = os.path.join(md, "encoder-model.onnx")
    dj = os.path.join(md, "decoder_joint-model.onnx")
    vocab = os.path.join(md, "vocab.txt")

    print("=" * 74)
    print("Parakeet TDT 0.6B v2  ->  MindSpore Lite (.ms) 转换参数生成")
    print("=" * 74)

    for p in (enc, dj, vocab):
        if not os.path.exists(p):
            print("[缺失] %s" % p, file=sys.stderr)
            return 1
        print("  %-28s %10s" % (os.path.basename(p), human(os.path.getsize(p))))

    if args.check:
        print("\n--- 图 IO 实测（ONNX 里的真实名字与形状）---")
        for label, path in (("encoder", enc), ("decoder_joint", dj)):
            ins, outs = graph_io(path)
            print("%s:  %d 个输入, %d 个输出" % (label, len(ins), len(outs)))
            for n, t, d in ins:
                print("   IN  %-18s %-8s %s" % (n, t, dims_str(d)))
            for n, t, d in outs:
                print("   OUT %-18s %-8s %s" % (n, t, dims_str(d)))
    out_dir = "ms_models"
    lines = []
    lines.append("#!/usr/bin/env bash")
    lines.append("# 由 tools/gen_ms_conversion.py 生成 —— 请在装有 converter_lite 的")
    lines.append("# Linux x86_64 机器上运行（MindSpore Lite 官方发布包含该工具）。")
    lines.append("set -euo pipefail")
    lines.append("")
    lines.append("CONVERTER=${CONVERTER:-converter_lite}")
    lines.append("SRC=%s" % md)
    lines.append("OUT=%s" % out_dir)
    lines.append("mkdir -p \"$OUT\"")
    lines.append("")
    lines.append("# ---------------------------------------------------------------- 编码器")
    lines.append("# 必须静态化成 [1,128,1501]。NPU 编译器需要静态形状才能做常量折叠；")
    lines.append("# 动态形状（原始 ONNX 的 audio_signal 是 [?,128,?]）会导致转换后")
    lines.append("# 在 NNRt 上无法编译。")
    lines.append("\"$CONVERTER\" \\")
    lines.append("  --modelFile=\"$SRC/encoder-model.onnx\" \\")
    lines.append("  --outputFile=\"$OUT/encoder\" \\")
    lines.append("  --inputShape=\"audio_signal:1,%d,%d;length:1\" \\"
                 % (MEL_BINS, WINDOW_FRAMES))
    lines.append("  --inputDataFormat=NCHW \\")
    lines.append("  --optimize=ascend_oriented \\")
    lines.append("  --saveType=MINDIR \\")
    lines.append("  --fp16=off")
    lines.append("")
    lines.append("# ------------------------------------------------- 预测网络 + joint")
    lines.append("# 注意 encoder_outputs 是**单帧** [1,1024,1]：解码循环在 ArkTS 侧，")
    lines.append("# 模型只保留最小的联合图。这样做的原因是 NPU 缺少 TDT 解码需要的")
    lines.append("# GatherNd / Squeeze / Stack / LogSoftmax / TopK 等算子，")
    lines.append("# 而这块计算量极小（PC 实测 <1 ms/步），放 CPU 完全够用。")
    lines.append("\"$CONVERTER\" \\")
    lines.append("  --modelFile=\"$SRC/decoder_joint-model.onnx\" \\")
    lines.append("  --outputFile=\"$OUT/decoder_joint\" \\")
    lines.append("  --inputShape=\"encoder_outputs:1,%d,1;targets:1,1;target_length:1;"
                 "input_states_1:2,1,%d;input_states_2:2,1,%d\" \\"
                 % (ENC_HIDDEN, DEC_HIDDEN, DEC_HIDDEN))
    lines.append("  --optimize=general \\")
    lines.append("  --saveType=MINDIR \\")
    lines.append("  --fp16=off")
    lines.append("")
    lines.append("cp \"$SRC/vocab.txt\" \"$OUT/vocab.txt\"")
    lines.append("")
    lines.append("echo")
    lines.append("echo '转换完成。把下面三个文件推到设备：'")
    lines.append("echo '  encoder.ms / decoder_joint.ms / vocab.txt'")
    lines.append("echo '目标目录（应用沙箱）: /data/app/el2/100/base/com.subfabric.harmony/"
                 "haps/entry/files/subfabric/models/parakeet/'")
    lines.append("echo")
    lines.append("echo '注意：converter_lite 有时输出 encoder.ms 与 encoder_graph.ms，'")
    lines.append("echo '请确认 ArkTS 侧读取的是 encoder.ms（见 ParakeetModelFiles）。'")
    lines.append("")

    script = "\n".join(lines)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(script)
        print("\n已写入 %s" % args.out)
    else:
        print("\n" + "-" * 74)
        print(script)

    print("\n期望的张量契约（ArkTS 侧硬编码，务必一致）：")
    print("  encoder       IN  audio_signal float32 [1,%d,%d]" % (MEL_BINS, WINDOW_FRAMES))
    print("                IN  length       int32   [1]")
    print("                OUT outputs         float32 [1,%d,%d]" % (ENC_HIDDEN, ENC_FRAMES))
    print("                OUT encoded_lengths int32   [1]")
    print("  decoder_joint IN  encoder_outputs float32 [1,%d,1]" % ENC_HIDDEN)
    print("                IN  targets         int32   [1,1]")
    print("                IN  target_length   int32   [1]")
    print("                IN  input_states_1  float32 [2,1,%d]" % DEC_HIDDEN)
    print("                IN  input_states_2  float32 [2,1,%d]" % DEC_HIDDEN)
    print("                OUT outputs         float32 [1,1,%d]" % JOINT_DIM)
    print("                OUT output_states_1 float32 [2,1,%d]" % DEC_HIDDEN)
    print("                OUT output_states_2 float32 [2,1,%d]" % DEC_HIDDEN)
    print("\n  joint 输出布局: [0..1024] = 词表（blank=1024）, "
          "[1025..1029] = 时长头 [0,1,2,3,4]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
