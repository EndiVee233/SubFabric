#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
字幕处理工具

图形界面：
  python main.py              # 默认打开 ASS 处理界面
  python main.py --srt        # 直接打开 SRT 转换界面
  python main.py --gui        # 同上，显式指定

命令行：
  # ASS 处理
  python main.py ass -i input.ass [-o output.ass]

  # SRT 转换（合并 + 逐词）
  python main.py srt --zh zh.srt --en en.srt [-o output.ass]

  # 查看/写入默认设置（字体字号中英分离）
  python main.py config --show
  python main.py config --set zh_font_size=72 --set en_font_size=60
  python main.py config --set size=65          # 两轨字号同时改

  # 其他
  python main.py ass -i in.ass --dry-run       # 仅分析不写文件
  python main.py fonts                          # 打印推荐字体下载地址
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time

# ============================================================
# 常量与默认配置
# ============================================================

VERSION = "2.1.1"

# 配置目录名（图形界面与命令行共用同一份 config.json）
APP_DIR_NAME = "SubtitleTool"


def _force_utf8_stdio():
    """把标准输出/错误切成 UTF-8。

    打包成 exe 后，Windows 控制台默认代码页是 GBK，中文输出在重定向到文件、
    被其他程序捕获、或用户切到 UTF-8 终端时会乱码。这里统一成 UTF-8，
    并让 Python 对无法编码的字符做替换而不是抛异常。
    """
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


_force_utf8_stdio()

# 重叠判定默认容差（秒）。
# 背景：本工具处理「中文+英文」双语 ASS 时，英文逐词时间轴通常比中文晚收尾
# 0.06~0.34 秒，若用「中文起~英文止」的合并区间判定重叠，会让前后相邻两组
# 产生擦边重叠并沿时间轴链式传染，导致几乎所有组的逐词效果被误清除。
OVERLAP_TOLERANCE = 0.2

FONT_CHOICES = [
    "Comic Sans MS",
    "HappyZcool-2016",
    "MaoKenAssortedSans",
    "Minecraft AE Pixel",
    "PvZ2 Regular",
]

FONT_DOWNLOAD_URLS = {
    "HappyZcool-2016": "https://www.fonts.net.cn/font-36602134856.html",
    "MaoKenAssortedSans": "https://www.fonts.net.cn/font-40862130700.html",
    "Minecraft AE Pixel": "https://www.qiuziti.com/download?id=879b682baf3931357dca2a12b114f313",
    "PvZ2 Regular": "https://m.fontke.com/font/164418598/download/",
}

DEFAULT_SETTINGS = {
    "replace_punct": True,          # 中文标点（、，。）替换为空格
    "remove_linebreak": True,       # 删除中文轨硬换行符 \N（关掉则保留原有换行）
    "highlight_color": "&H00ff00&",  # ASS 内嵌颜色（BGR 顺序）
    # 字体与字号中英分离：中文轨（Style「中文字幕」）与英文轨（Style「Default」）
    # 各用一套，双语字幕里两侧字重/字宽差异大时能分别微调。
    "zh_font_name": "Comic Sans MS",
    "zh_font_size": 65,
    "en_font_name": "Comic Sans MS",
    "en_font_size": 65,
    "auto_role": True,              # 无角色名时自动加 [UNKNOWN]
    "overlap_tolerance": OVERLAP_TOLERANCE,
    "time_mismatch": False,         # 中英 SRT 时间轴是否独立
}

# 旧版单字体配置键 -> 新版中英分离键（读取旧配置时迁移用）
LEGACY_FONT_KEYS = {
    "font_name": ("zh_font_name", "en_font_name"),
    "font_size": ("zh_font_size", "en_font_size"),
}


def _base_dir():
    """程序基目录。

    源码运行时是脚本所在目录；打包成 exe 后是 exe 所在目录
    （而不是 PyInstaller 的临时解压目录 _MEIPASS），这样配置能跟着
    exe 走，做便携分发时拷走 exe + config.json 即可。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _user_config_dir():
    return os.path.join(os.environ.get("LOCALAPPDATA", ""), APP_DIR_NAME)


def config_path():
    """配置文件位置。

    优先程序同目录的 config.json（便于随程序携带）；若该目录不可写
    （例如装在 Program Files），退回用户目录 %LOCALAPPDATA%/SubtitleTool。
    图形界面与命令行共用同一份。
    """
    base = _base_dir()
    local = os.path.join(base, "config.json")
    user_dir = _user_config_dir()
    user_cfg = os.path.join(user_dir, "config.json")

    # 已有配置优先沿用（本地优先，其次用户目录）
    if os.path.exists(local):
        return local
    if user_dir and os.path.exists(user_cfg):
        return user_cfg

    # 都没有：能写本地就写本地，否则退用户目录
    if os.access(base, os.W_OK):
        return local
    return user_cfg if user_dir else local


def load_config():
    path = config_path()
    cfg = dict(DEFAULT_SETTINGS)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            # 兼容原 GUI 版的 {'defaults': {...}} 结构
            data = data.get("defaults", data)
            for k in DEFAULT_SETTINGS:
                if k in data:
                    cfg[k] = data[k]
            # 兼容原 GUI 版的 overlap_tolerance：那里以「×0.01 秒」的整数存储
            # （界面显示 20 表示 0.20 秒），而 CLI 内部一律使用秒。
            tol = cfg.get('overlap_tolerance')
            if isinstance(tol, (int, float)) and tol > 5:
                cfg['overlap_tolerance'] = tol / 100.0

            # 字体键迁移：旧版只有 font_name / font_size 一套，新版中英分离。
            # 旧值同时填给中英文两轨，行为与升级前完全一致。
            for old_key, new_keys in LEGACY_FONT_KEYS.items():
                if old_key in data:
                    for nk in new_keys:
                        if nk not in data:
                            cfg[nk] = data[old_key]
        except Exception as e:
            log(f"[警告] 配置文件读取失败，已使用内置默认值：{e}", level="warn")

    # 归一化高亮颜色：配置文件里可能存成 #RRGGBB / RRGGBB（Qt 或手写），
    # 而 ASS 只认 &HBBGGRR&。这里统一换算，避免把 "#00ff00" 直接写进字幕。
    try:
        cfg['highlight_color'] = hex_to_ass_color(str(cfg['highlight_color']))
    except argparse.ArgumentTypeError:
        log(f"[警告] 配置中的 highlight_color 无法识别"
            f"（{cfg['highlight_color']}），已回退默认值", level="warn")
        cfg['highlight_color'] = DEFAULT_SETTINGS['highlight_color']

    return cfg


def save_config(cfg):
    path = config_path()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        return path
    except Exception as e:
        log(f"[错误] 配置保存失败：{e}", level="error")
        return None


# ============================================================
# 颜色与日志辅助
# ============================================================

def hex_to_ass_color(value):
    """把 #RRGGBB / RRGGBB / 绿 等输入转成 ASS 的 &HBBGGRR& 格式。"""
    synonyms = {
        "red": "#ff0000", "绿色": "#00ff00", "绿": "#00ff00",
        "蓝色": "#0000ff", "蓝": "#0000ff", "黄色": "#ffff00", "黄": "#ffff00",
        "白色": "#ffffff", "白": "#ffffff", "黑色": "#000000", "黑": "#000000",
        "青色": "#00ffff", "紫色": "#ff00ff", "橙色": "#ff8000",
    }
    v = value.strip().lower()
    if v in synonyms:
        v = synonyms[v]
    if v.startswith("#"):
        v = v[1:]
    # 已经是 ASS 格式
    if value.strip().startswith("&H"):
        return value.strip()
    if not re.fullmatch(r"[0-9a-fA-F]{6}", v):
        raise argparse.ArgumentTypeError(
            f"颜色格式无法识别：{value}（应为 #RRGGBB 或 red/green 等名称）")
    r, g, b = v[0:2], v[2:4], v[4:6]
    return f"&H{b.upper()}{g.upper()}{r.upper()}&"


def ass_color_to_hex(ass_color):
    """&HBBGGRR& -> #RRGGBB（用于展示）。"""
    m = re.fullmatch(r"&[Hh]([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})&?", ass_color)
    if not m:
        return ass_color
    b, g, r = m.groups()
    return f"#{r.upper()}{g.upper()}{b.upper()}"


# 日志级别：quiet 只输出错误；normal 输出关键信息；verbose 输出全部
LOG_LEVEL = "normal"


def log(msg, level="info"):
    """统一日志出口。level: info / ok / warn / error / debug / plain"""
    if LOG_LEVEL == "quiet" and level not in ("error", "ok"):
        return
    if LOG_LEVEL != "verbose" and level == "debug":
        return
    prefix = {
        "info": "", "ok": "", "warn": "[警告] ", "error": "[错误] ",
        "debug": "  ", "plain": "",
    }.get(level, "")
    stream = sys.stderr if level == "error" else sys.stdout
    text = msg if level == "plain" or msg.startswith("[") else prefix + msg
    # 打包成无控制台的 GUI exe 时，sys.stdout / sys.stderr 可能是 None，
    # 直接 print 会抛 AttributeError。此时静默丢弃即可（界面自己会显示日志）。
    if stream is None:
        return
    try:
        print(text, file=stream)
    except (ValueError, OSError, UnicodeError):
        # 流已关闭或编码异常：不影响主流程
        pass


# ============================================================
# 通用文本过滤 / 时间处理
# ============================================================

def clean_text_markers(text):
    text = re.sub(r'\[音乐\]', '', text)
    text = re.sub(r'\[music\]', '', text, flags=re.IGNORECASE)
    text = re.sub(r'^>>\s*', '', text)
    return text


def parse_time(ass_time):
    parts = ass_time.split(':')
    if len(parts) != 3:
        raise ValueError(f"Invalid time format: {ass_time}")
    h, m, s = parts
    try:
        return int(h) * 3600 + int(m) * 60 + float(s)
    except (ValueError, TypeError) as e:
        raise ValueError(f"Invalid time value in '{ass_time}': {e}") from e


def format_time(total_sec):
    h = int(total_sec // 3600)
    m = int((total_sec % 3600) // 60)
    s = total_sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def split_dialogue(line):
    if not line.startswith("Dialogue:"):
        return None
    content = line[len("Dialogue:"):].strip()
    parts = content.split(',', 9)
    if len(parts) < 10:
        parts += [''] * (10 - len(parts))
    return parts


def build_dialogue(fields):
    return "Dialogue: " + ",".join(fields) + "\n"


def time_overlap(start1, end1, start2, end2, tolerance=0.0):
    return end1 > start2 + tolerance and end2 > start1 + tolerance


def remove_ass_tags(text):
    return re.sub(r'\{[^}]*\}', '', text)


def has_karaoke_tag(text):
    return '{\\c&' in text and '{\\c}' in text


def _replace_color_tag(match, color):
    return '{\\c' + color + '}'


def clean_chinese_text(text, replace_punct=True, remove_linebreak=True):
    """清理中文轨文本。

    remove_linebreak=False 时保留硬换行符 \\N，原有分行排版原样保留
    （适合 [译者注] 这类本身就分两行/三行的文本）；默认为 True，
    删掉 \\N 把断行接回一整句。
    """
    text = clean_text_markers(text)
    if remove_linebreak:
        text = text.replace('\\N', '')
    if replace_punct:
        for punct in ['、', '，', '。']:
            text = text.replace(punct, ' ')
    text = re.sub(r'\](\S)', r'] \1', text)
    return text


def generate_karaoke_lines(text, start_time, end_time, style, name,
                           margin_l, margin_r, margin_v, effect, highlight_color):
    lines = []
    words = text.split()
    if not words:
        return lines
    total_duration = end_time - start_time
    if total_duration <= 0:
        highlighted_text = f"{{\\c{highlight_color}}}{text}{{\\c}}"
        fields = ['0', format_time(start_time), format_time(end_time), style, name,
                  margin_l, margin_r, margin_v, effect, highlighted_text]
        lines.append(build_dialogue(fields))
        return lines
    lens = [len(w) for w in words]
    total_len = sum(lens)
    durations = [total_duration * l / total_len for l in lens]
    t = start_time
    for k, word in enumerate(words):
        t_start = t
        t_end = end_time if k == len(words) - 1 else t_start + durations[k]
        highlighted = words.copy()
        highlighted[k] = f"{{\\c{highlight_color}}}{word}{{\\c}}"
        new_text = " ".join(highlighted)
        fields = ['0', format_time(t_start), format_time(t_end), style, name,
                  margin_l, margin_r, margin_v, effect, new_text]
        lines.append(build_dialogue(fields))
        t = t_end
    return lines


# ============================================================
# 核心：ASS 处理
# ============================================================

def apply_font_to_styles(header_lines, settings):
    """把 settings 里的字体名/字号写进 [V4+ Styles] 中对应 Style。

    只改 Fontname / Fontsize 两个字段，其余样式属性（颜色、对齐、边距、描边等）
    一律原样保留——避免把源文件精心调过的样式整段覆盖掉。
    仅当 settings['apply_font'] 为真时由 process_ass 调用。

    字段下标按 Style 区的 Format 行动态解析（标准 ASS 里 Fontname 在第 1 列、
    Fontsize 在第 2 列），不硬编码，兼容非标准顺序的样式表。
    """
    zh_name = settings.get('zh_font_name')
    zh_size = settings.get('zh_font_size')
    en_name = settings.get('en_font_name')
    en_size = settings.get('en_font_size')
    out = []
    in_styles = False
    fmt = None
    for line in header_lines:
        if line.startswith('[V4+ Styles]'):
            in_styles = True
            fmt = None
            out.append(line)
            continue
        if line.startswith('[') and not line.startswith('[V4+ Styles]'):
            in_styles = False
        if in_styles and line.startswith('Format:'):
            fmt = [f.strip() for f in line[len('Format:'):].split(',')]
        if in_styles and line.startswith('Style:'):
            parts = line.rstrip('\n').split(',')
            if fmt and len(parts) >= len(fmt):
                name = parts[0][len('Style:'):].strip()
                idx_name = fmt.index('Fontname') if 'Fontname' in fmt else 1
                idx_size = fmt.index('Fontsize') if 'Fontsize' in fmt else 2
                if name == '中文字幕':
                    if zh_name:
                        parts[idx_name] = zh_name
                    if zh_size is not None:
                        parts[idx_size] = str(zh_size)
                elif name == 'Default':
                    if en_name:
                        parts[idx_name] = en_name
                    if en_size is not None:
                        parts[idx_size] = str(en_size)
                line = ','.join(parts) + '\n'
        out.append(line)
    return out


def process_ass(input_path, output_path, settings=None, dry_run=False):
    """处理 ASS 文件。返回 (added, removed, color_replaced, stats)。"""
    if settings is None:
        settings = load_config()
    proc_start = time.time()

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"输入文件不存在: {input_path}")

    file_size = os.path.getsize(input_path)
    if file_size > 50 * 1024 * 1024:
        log(f"文件较大 ({file_size / 1024 / 1024:.1f} MB)，处理可能需要较长时间", "warn")

    with open(input_path, 'r', encoding='utf-8-sig') as f:
        lines = f.readlines()

    header = []
    events_section = []
    in_events = False
    for line in lines:
        if line.startswith('[Events]'):
            in_events = True
            header.append(line)
            continue
        if not in_events:
            header.append(line)
        else:
            events_section.append(line)

    base_lineno = len(header)

    # --- 第一步：文本清理 ---
    cleaned_count = 0
    for i, line in enumerate(events_section):
        if line.startswith('Dialogue:'):
            fields = split_dialogue(line)
            if fields and fields[3] == "中文字幕":
                old_text = fields[9]
                new_text = clean_chinese_text(
                    old_text,
                    replace_punct=settings['replace_punct'],
                    remove_linebreak=settings['remove_linebreak'])
                if new_text != old_text:
                    fields[9] = new_text
                    events_section[i] = build_dialogue(fields).rstrip('\n') + '\n'
                    cleaned_count += 1
            elif fields and fields[3] == "Default":
                old_text = fields[9]
                new_text = clean_text_markers(old_text)
                if new_text != old_text:
                    fields[9] = new_text
                    events_section[i] = build_dialogue(fields).rstrip('\n') + '\n'
                    cleaned_count += 1

    # --- 第二步：按开始时间排序事件区 ---
    format_lines = []
    dialogue_lines = []
    other_lines = []
    for i, line in enumerate(events_section):
        if line.startswith('Format:'):
            format_lines.append(line)
        elif line.startswith('Dialogue:'):
            fields = split_dialogue(line)
            if fields:
                dialogue_lines.append((line, i, fields, base_lineno + i + 1))
            else:
                other_lines.append((line, i))
        else:
            other_lines.append((line, i))

    dialogue_lines.sort(key=lambda x: parse_time(x[2][1]))
    new_events_section = format_lines.copy()
    for line_text, _, _, _ in dialogue_lines:
        new_events_section.append(line_text)
    for line_text, _ in other_lines:
        new_events_section.append(line_text)

    sorted_orig_linenos = [orig_lno for _, _, _, orig_lno in dialogue_lines]
    index_to_orig_lineno = {}
    di_counter = 0
    for i, line in enumerate(new_events_section):
        if line.startswith('Dialogue:'):
            index_to_orig_lineno[i] = sorted_orig_linenos[di_counter]
            di_counter += 1

    dialogue_indices = []
    for i, line in enumerate(new_events_section):
        if line.startswith("Dialogue:"):
            fields = split_dialogue(line)
            if fields:
                dialogue_indices.append((i, fields))

    # --- 第三步：轮询式分组 ---
    # 原实现假定「中文字幕」行后面紧跟属于它的若干「Default」行，但实际文件里
    # 中英文常被导出成两段（英文在前/中文在后），排序交织后这个假定并不总成立，
    # 会使部分英文行被错误地并入最后一条中文。
    # 改为：先收集全部中文区间，再把英文行聚成「句块」后按块分配。
    # 句块 = 时间上连续且全文相同的一串英文行（逐词字幕正是同一句文本重复 N 行、
    # 时间轴首尾相接铺满整句）。必须按块分配而不是按单行：译者注等单中文行与
    # 双语组重叠（包住/被包住/相交）时，若按单行分配，整句逐词铺满的中间切片
    # 会离被包住的小时间区间更近，同一句会被拆给两个组，最后重复输出。
    zh_groups = []
    orphan_en = []
    for di, fields in dialogue_indices:
        if fields[3] == "中文字幕":
            zh_groups.append({
                'zh_idx': di,
                'zh_start': parse_time(fields[1]),
                'zh_end': parse_time(fields[2]),
                'name': fields[4].strip(),
                'def_indices': [],
                'blocks': [],
            })
        elif fields[3] == "Default":
            orphan_en.append((di, fields))

    en_blocks = []
    for di, fields in orphan_en:
        t_start = parse_time(fields[1])
        t_end = parse_time(fields[2])
        text = remove_ass_tags(fields[9]).strip()
        if (en_blocks and en_blocks[-1]['text'] == text
                and t_start <= en_blocks[-1]['end'] + 0.5):
            en_blocks[-1]['end'] = max(en_blocks[-1]['end'], t_end)
            en_blocks[-1]['indices'].append(di)
        else:
            en_blocks.append({'start': t_start, 'end': t_end, 'text': text,
                              'indices': [di], 'name': fields[4].strip()})

    # 中文区间按起点排序，并计算「前缀最大结束时间」，用于精确剪枝：
    # 对某个英文行，只有起点 <= t_end 的中文才可能与之相交；
    # 其中再借助前缀最大结束时间跳过那些结束时间 < t_start 的（不可能包含 t_start）。
    import bisect
    zh_order = sorted(range(len(zh_groups)), key=lambda gi: zh_groups[gi]['zh_start'])
    zh_starts = [zh_groups[gi]['zh_start'] for gi in zh_order]
    prefix_max_end = []
    _cur = float('-inf')
    for gi in zh_order:
        _cur = max(_cur, zh_groups[gi]['zh_end'])
        prefix_max_end.append(_cur)

    def _candidates(t_start, t_end):
        """返回所有可能与 [t_start, t_end) 相交的中文组索引（精确）。"""
        pos = bisect.bisect_right(zh_starts, t_end)
        out = []
        k = pos - 1
        while k >= 0:
            if prefix_max_end[k] < t_start:
                break
            gi = zh_order[k]
            g = zh_groups[gi]
            if g['zh_end'] > t_start and g['zh_start'] <= t_end:
                out.append(gi)
            k -= 1
        return out

    for blk in en_blocks:
        t_start, t_end = blk['start'], blk['end']
        cand = _candidates(t_start, t_end)

        # 归属打分：
        # 1) 名字匹配优先——英文句块 Name 非空且候选中文里有同名者（双语成对导出
        #    的正常情况），只在同名候选里挑。这样「译者注」等无名单中文行即使时间
        #    上包住/相交双语组，也抢不走英文句块。
        # 2) 端点贴合度——|块开始-中开始| + |块结束-中结束| 越小越贴合。双语逐词
        #    句块与其中文区间完全贴合（得 0 分），比旧的中心距离启发式更稳。
        if blk['name']:
            named = [gi for gi in cand if zh_groups[gi]['name'] == blk['name']]
            if named:
                cand = named

        target = None
        best_fit = None
        for gi in cand:
            g = zh_groups[gi]
            fit = abs(t_start - g['zh_start']) + abs(t_end - g['zh_end'])
            if best_fit is None or fit < best_fit:
                best_fit = fit
                target = gi

        if target is None and zh_groups:
            # 完全不相交时的兜底：取开始时间最接近的中文组
            target = min(
                range(len(zh_groups)),
                key=lambda gi: abs(zh_groups[gi]['zh_start'] - t_start)
            )
        if target is not None:
            zh_groups[target]['def_indices'].extend(blk['indices'])
            zh_groups[target]['blocks'].append(blk)

    groups = []
    for g in zh_groups:
        groups.append({
            'zh_idx': g['zh_idx'],
            'def_indices': sorted(g['def_indices']),
            'blocks': sorted(g['blocks'], key=lambda b: b['start']),
            'zh_start': g['zh_start'],
            'zh_end': g['zh_end'],
        })

    # --- 第四步：重叠检测 ---
    # 只用「中文区间」判定，不用被英文尾巴撑大的合并区间。双语字幕里中英互为
    # 翻译，不应重复计入；真正需要检测的是「同一时刻是否有多条中文同时可见」
    # （多人抢话），这才是逐词高亮会糊在一起的场景。
    tolerance = settings.get('overlap_tolerance', OVERLAP_TOLERANCE)
    overlap_set = set()
    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            if time_overlap(groups[i]['zh_start'], groups[i]['zh_end'],
                            groups[j]['zh_start'], groups[j]['zh_end'],
                            tolerance=tolerance):
                overlap_set.add(i)
                overlap_set.add(j)

    for i, group in enumerate(groups):
        group['is_overlap'] = i in overlap_set
        if group['is_overlap']:
            need_remove = False
            for d_idx in group['def_indices']:
                fields = split_dialogue(new_events_section[d_idx])
                if has_karaoke_tag(fields[9]):
                    need_remove = True
                    break
            group['action'] = 'remove_karaoke' if need_remove else 'keep'
        else:
            if len(group['blocks']) == 1:
                blk = group['blocks'][0]
                has_kara = False
                for d_idx in blk['indices']:
                    fields = split_dialogue(new_events_section[d_idx])
                    if has_karaoke_tag(fields[9]):
                        has_kara = True
                        break
                group['action'] = 'add_karaoke' if not has_kara else 'keep'
            else:
                group['action'] = 'keep'

    # --- 第五步：重建事件区 ---
    # 按 new_events_section 的自然顺序逐行发射，遇到「需处理的英文组」就地展开，
    # 其余行原样输出。这样无论中英如何交织、组内行号是否连续，都不会丢行或串行。
    handled = {}
    emit_override = {}

    # 先收集所有 remove_karaoke 组的合并计划（按句块拆分），再做「同句去重」：
    # 译者注等中文行与双语组重叠时，两组可能各自持有相同全文的英文句块，
    # 若各自合并输出，同一句英文会出现两条（时间区间还互相重叠）。
    # 因此把 clean_text 相同且时间区间相交的合并计划并成一条（区间取并集）。
    merge_plans = []
    for group in groups:
        if group['action'] != 'remove_karaoke':
            continue
        if LOG_LEVEL == "verbose":
            log("修改前：", "debug")
            for d_idx in group['def_indices']:
                orig_lineno = index_to_orig_lineno.get(d_idx, "?")
                raw = new_events_section[d_idx].rstrip('\n')
                log(f"【行{orig_lineno}】{raw}", "debug")
        zh_fields = split_dialogue(new_events_section[group['zh_idx']])
        zh_start = parse_time(zh_fields[1])
        zh_end = parse_time(zh_fields[2])
        for blk in group['blocks']:
            first_d_idx = blk['indices'][0]
            first_fields = split_dialogue(new_events_section[first_d_idx])
            clean_text = remove_ass_tags(first_fields[9])
            # 组内只有一个句块时沿用中文区间（英文跟随中文起止）；
            # 多个句块时各用各的时间区间，避免合并行互相重叠。
            if len(group['blocks']) == 1:
                p_start, p_end = zh_start, zh_end
            else:
                p_start, p_end = blk['start'], blk['end']
            merge_plans.append({
                'start': p_start,
                'end': p_end,
                'text': clean_text,
                'first_d_idx': first_d_idx,
                'first_fields': first_fields,
                'indices': list(blk['indices']),
            })

    def _plans_key(p):
        return p['text']

    plans_by_text = {}
    for p in merge_plans:
        plans_by_text.setdefault(_plans_key(p), []).append(p)

    for text_key, plist in plans_by_text.items():
        # 同一全文的多条合并计划：按开始时间排序后，把相互重叠/相接的区间
        # 合并成一条输出；其余组的英文行全部跳过（同句全文，跳过不丢内容）。
        plist.sort(key=lambda p: (p['start'], p['end']))
        clusters = []
        for p in plist:
            if clusters and p['start'] <= clusters[-1]['end']:
                clusters[-1]['end'] = max(clusters[-1]['end'], p['end'])
                clusters[-1]['members'].append(p)
            else:
                clusters.append({'start': p['start'], 'end': p['end'],
                                 'members': [p]})
        for cl in clusters:
            members = cl['members']
            # 并集区间（members[0] 开始时间最早，end 已在聚类时取过最大值）
            start_s = format_time(cl['start'])
            end_s = format_time(cl['end'])
            # 取位置最靠前的成员做载体行（字段/样式沿用它的首行英文）
            lead = min(members, key=lambda p: p['first_d_idx'])
            ff = lead['first_fields']
            merged_fields = [ff[0], start_s, end_s, ff[3],
                             ff[4], ff[5], ff[6], ff[7], ff[8], text_key]
            merged_line = build_dialogue(merged_fields)
            for p in members:
                for d_idx in p['indices'][1:]:
                    handled[d_idx] = 'skip'
                if p is lead:
                    emit_override[p['first_d_idx']] = [merged_line]
                else:
                    # 同句重复组的载体行直接跳过（内容已由 lead 输出）
                    handled[p['first_d_idx']] = 'skip'
            if LOG_LEVEL == "verbose":
                log("修改后：", "debug")
                log(merged_line.rstrip('\n'), "debug")

    for group in groups:
        if group['action'] == 'add_karaoke':
            blk = group['blocks'][0]
            d_idx = blk['indices'][0]
            fields = split_dialogue(new_events_section[d_idx])
            # 用句块的完整时间跨度（单行块即该行区间；多行块为整句铺满区间）
            start_time = blk['start']
            end_time = blk['end']
            total_duration = end_time - start_time
            words = fields[9].split()
            out_lines = []
            if total_duration > 0 and words:
                lens = [len(w) for w in words]
                total_len = sum(lens)
                durations = [total_duration * l / total_len for l in lens]
                t = start_time
                for k, word in enumerate(words):
                    t_start = t
                    t_end = end_time if k == len(words) - 1 else t_start + durations[k]
                    highlighted = words.copy()
                    highlighted[k] = f"{{\\c{settings['highlight_color']}}}{word}{{\\c}}"
                    new_fields = [fields[0], format_time(t_start), format_time(t_end),
                                  fields[3], fields[4], fields[5], fields[6],
                                  fields[7], fields[8], " ".join(highlighted)]
                    out_lines.append(build_dialogue(new_fields))
                    t = t_end
            if out_lines:
                emit_override[d_idx] = out_lines

    final_events_section = []
    for i, line in enumerate(new_events_section):
        if i in handled:
            continue
        if i in emit_override:
            final_events_section.extend(emit_override[i])
        else:
            final_events_section.append(line)

    # --- 第六步：全局高亮颜色统一 ---
    color_replaced_count = 0
    highlight_color = settings['highlight_color']
    for i in range(len(final_events_section)):
        line = final_events_section[i]
        if line.startswith('Dialogue:'):
            fields = split_dialogue(line)
            if fields and fields[3] == "Default" and '{\\c&' in fields[9]:
                fields[9] = re.sub(r'{\\c&[^}]*&}',
                                   lambda m: _replace_color_tag(m, highlight_color),
                                   fields[9])
                final_events_section[i] = build_dialogue(fields)
                color_replaced_count += 1

    added = sum(1 for g in groups if g['action'] == 'add_karaoke')
    removed = sum(1 for g in groups if g['action'] == 'remove_karaoke')
    overlap_count = len(overlap_set)

    if not dry_run:
        out_header = header
        if settings.get('apply_font'):
            out_header = apply_font_to_styles(header, settings)
        output_lines = out_header + final_events_section
        with open(output_path, 'w', encoding='utf-8-sig') as f:
            f.writelines(output_lines)

    duration = time.time() - proc_start
    stats = {
        'duration': duration,
        'cleaned': cleaned_count,
        'zh_groups': len(groups),
        'overlap_groups': overlap_count,
        'kept': sum(1 for g in groups if g['action'] == 'keep'),
        'input_size': file_size,
    }
    return added, removed, color_replaced_count, stats


# ============================================================
# 核心：SRT -> ASS
# ============================================================

def parse_srt(srt_path):
    with open(srt_path, 'r', encoding='utf-8-sig') as f:
        content = f.read()
    blocks = re.split(r'\n\s*\n', content.strip())
    subtitles = []
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) >= 3:
            time_line = lines[1]
            text = '\n'.join(lines[2:])
            m = re.match(r'(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})', time_line)
            if m:
                start = m.group(1).replace(',', '.')
                end = m.group(2).replace(',', '.')
                subtitles.append((start, end, text))
    return subtitles


def srt_time_to_ass(srt_time):
    parts = srt_time.split(':')
    h = int(parts[0])
    m = int(parts[1])
    s = float(parts[2])
    return format_time(h * 3600 + m * 60 + s)


def generate_ass_header(zh_font_name='Comic Sans MS', zh_font_size=65,
                        en_font_name=None, en_font_size=None):
    """生成 ASS 头。

    Style「中文字幕」（中文轨）与 Style「Default」（英文轨）各用一套字体/字号。
    en_* 省略时与中文保持一致，兼容只传两个参数的旧调用。
    """
    if en_font_name is None:
        en_font_name = zh_font_name
    if en_font_size is None:
        en_font_size = zh_font_size
    return f"""[Script Info]
; This is an Advanced Sub Station Alpha v4+ script.
Title: Generated from SRT files
ScriptType: v4.00+
PlayDepth: 0
ScaledBorderAndShadow: Yes
PlayResX: 1920
PlayResY: 1080
WrapStyle: 3

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{en_font_name},{en_font_size},&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,3,2,20,20,120,1
Style: 中文字幕,{zh_font_name},{zh_font_size},&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3.0,2,2,10,10,125,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def merge_srt_to_ass(zh_srt_path, en_srt_path, output_ass_path, settings=None):
    if settings is None:
        settings = load_config()
    zh_subs = parse_srt(zh_srt_path)
    en_subs = parse_srt(en_srt_path)
    if len(zh_subs) != len(en_subs):
        log(f"中英SRT条目数不匹配（中文{len(zh_subs)}，英文{len(en_subs)}），将以中文为准。", "warn")

    time_mismatch = settings.get('time_mismatch', False)
    highlight_color = settings['highlight_color']
    dialogues = []

    for i, (zh_start, zh_end, zh_text) in enumerate(zh_subs):
        if i >= len(en_subs):
            break
        en_start, en_end, en_text = en_subs[i]
        zh_text_clean = clean_chinese_text(
            zh_text,
            replace_punct=settings['replace_punct'],
            remove_linebreak=settings['remove_linebreak'])
        if not re.search(r'\{.*\}', zh_text_clean):
            zh_text_clean = '{\\c&HFFFFFF&}' + zh_text_clean
        if settings['auto_role'] and '[' not in zh_text_clean:
            zh_text_clean = re.sub(r'(\{[^}]*\})', r'\1[UNKNOWN]', zh_text_clean, count=1)
        en_text_clean = clean_text_markers(en_text.strip())

        if time_mismatch:
            zh_ass_start = srt_time_to_ass(zh_start)
            zh_ass_end = srt_time_to_ass(zh_end)
            en_ass_start = srt_time_to_ass(en_start)
            en_ass_end = srt_time_to_ass(en_end)
            zh_line = f"Dialogue: 0,{zh_ass_start},{zh_ass_end},中文字幕,,0,0,0,,{zh_text_clean}\n"
            dialogues.append(zh_line)
            en_words = en_text_clean.split()
            if en_words:
                en_lines = generate_karaoke_lines(
                    en_text_clean, parse_time(en_ass_start), parse_time(en_ass_end),
                    "Default", "", "0", "0", "0", "", highlight_color
                )
                dialogues.extend(en_lines)
            else:
                en_line = f"Dialogue: 0,{en_ass_start},{en_ass_end},Default,,0,0,0,,{en_text_clean}\n"
                dialogues.append(en_line)
        else:
            start = srt_time_to_ass(zh_start)
            end = srt_time_to_ass(zh_end)
            dialogues.append(f"Dialogue: 0,{start},{end},中文字幕,,0,0,0,,{zh_text_clean}\n")
            dialogues.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{en_text_clean}\n")

    with open(output_ass_path, 'w', encoding='utf-8-sig') as f:
        f.write(generate_ass_header(
            settings['zh_font_name'], settings['zh_font_size'],
            settings['en_font_name'], settings['en_font_size']))
        f.writelines(dialogues)

    log(f"SRT 合并完成：中文 {len(zh_subs)} 条 / 英文 {len(en_subs)} 条 -> {len(dialogues)} 行字幕")
    log(f"字体：中文 {settings['zh_font_name']} {settings['zh_font_size']}"
        f"  |  英文 {settings['en_font_name']} {settings['en_font_size']}")
    return len(dialogues)


# ============================================================
# 命令行辅助
# ============================================================

def default_output(input_path, suffix="_karaoke"):
    base, ext = os.path.splitext(input_path)
    if not ext:
        ext = ".ass"
    return f"{base}{suffix}{ext}"


def ensure_ass_extension(path):
    return path if path.lower().endswith('.ass') else path + '.ass'


def apply_overrides(settings, args):
    """把命令行参数覆盖到设置上。"""
    s = dict(settings)
    if getattr(args, 'no_replace_punct', False):
        s['replace_punct'] = False
    if getattr(args, 'keep_linebreak', False):
        s['remove_linebreak'] = False
    if getattr(args, 'highlight', None):
        s['highlight_color'] = args.highlight

    # 字体参数：--font / --font-size 同时作用于中英两轨（快捷写法）；
    # --zh-font / --en-font 等只改指定一轨，且优先级更高。
    font = getattr(args, 'font', None)
    size = getattr(args, 'font_size', None)
    if font:
        s['zh_font_name'] = font
        s['en_font_name'] = font
    if size:
        s['zh_font_size'] = size
        s['en_font_size'] = size
    if getattr(args, 'zh_font', None):
        s['zh_font_name'] = args.zh_font
    if getattr(args, 'en_font', None):
        s['en_font_name'] = args.en_font
    if getattr(args, 'zh_font_size', None):
        s['zh_font_size'] = args.zh_font_size
    if getattr(args, 'en_font_size', None):
        s['en_font_size'] = args.en_font_size

    if getattr(args, 'no_auto_role', False):
        s['auto_role'] = False
    if getattr(args, 'tolerance', None) is not None:
        s['overlap_tolerance'] = args.tolerance
    if getattr(args, 'time_mismatch', False):
        s['time_mismatch'] = True
    if getattr(args, 'apply_font', False):
        s['apply_font'] = True
    return s


def add_common_settings_args(p, include_tolerance=True):
    g = p.add_argument_group("样式设置")
    g.add_argument("--highlight", type=hex_to_ass_color, metavar="COLOR",
                   help="逐词高亮颜色，#RRGGBB 或 red/green 等名称（默认 #00ff00）")
    g.add_argument("--font", metavar="NAME",
                   help="字体名称，中英两轨同时生效（快捷写法）")
    g.add_argument("--font-size", type=int, metavar="N",
                   help="字号，中英两轨同时生效（快捷写法）")
    g.add_argument("--zh-font", metavar="NAME", help="仅中文字幕轨的字体名")
    g.add_argument("--en-font", metavar="NAME", help="仅英文字幕轨的字体名")
    g.add_argument("--zh-font-size", type=int, metavar="N", help="仅中文字幕轨的字号")
    g.add_argument("--en-font-size", type=int, metavar="N", help="仅英文字幕轨的字号")
    g.add_argument("--no-replace-punct", action="store_true",
                   help="不把中文标点（、，。）替换为空格")
    g.add_argument("--apply-font", action="store_true",
                   help="(ASS 模式) 用设置的字体名/字号覆盖源文件 Style 里的字体"
                        "（默认保留源文件原有字体，只做逐词/颜色清理）")
    g.add_argument("--keep-linebreak", action="store_true",
                   help="保留中文轨的硬换行符 \\N（默认删除，把断行接成一整句）")
    if include_tolerance:
        g.add_argument("--tolerance", type=float, metavar="SEC",
                       help=f"重叠检测容差，秒（默认 {OVERLAP_TOLERANCE}）")


def add_common_output_args(p):
    g = p.add_argument_group("输出控制")
    g.add_argument("-q", "--quiet", action="store_true", help="只输出错误信息")
    g.add_argument("-v", "--verbose", action="store_true", help="输出详细处理日志")
    g.add_argument("--dry-run", action="store_true",
                   help="只分析并打印统计，不写出文件")


# ============================================================
# 子命令：ass
# ============================================================

def cmd_ass(args):
    settings = apply_overrides(load_config(), args)

    if not os.path.exists(args.input):
        log(f"输入文件不存在：{args.input}", "error")
        return 2
    if not args.input.lower().endswith('.ass'):
        log(f"输入文件扩展名不是 .ass：{args.input}", "warn")

    output = args.output or default_output(args.input)

    if not args.quiet:
        log("=" * 56, "plain")
        log(f"  字幕处理工具 v{VERSION}  |  ASS 处理模式", "plain")
        log("=" * 56, "plain")
        log(f"输入：{os.path.abspath(args.input)}")
        log(f"输出：{'(仅分析，不写出)' if args.dry_run else os.path.abspath(output)}")
        log(f"高亮色：{ass_color_to_hex(settings['highlight_color'])}")
        log(f"字体：中文 {settings['zh_font_name']} {settings['zh_font_size']}"
            f"  |  英文 {settings['en_font_name']} {settings['en_font_size']}")
        log(f"标点替换：{'开' if settings['replace_punct'] else '关'}"
            f"  |  换行符：{'删除' if settings['remove_linebreak'] else '保留'}"
            f"  |  字体覆盖：{'开' if settings.get('apply_font') else '关（保留源样式）'}"
            f"  |  重叠容差：{settings['overlap_tolerance']:.2f}s")
        log("")

    try:
        added, removed, color_replaced, stats = process_ass(
            args.input, output, settings=settings, dry_run=args.dry_run)
    except Exception as e:
        log(f"处理失败：{e}", "error")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1

    if not args.quiet:
        log("-" * 56, "plain")
        log("摘要", "plain")
        log("-" * 56, "plain")
        log(f"  中文字幕组          {stats['zh_groups']} 组")
        log(f"  添加逐词效果        {added} 句", "ok")
        log(f"  清除重叠组逐词      {removed} 句")
        log(f"  重叠组              {stats['overlap_groups']} 组")
        log(f"  保持原样            {stats['kept']} 组")
        log(f"  文本清理            {stats['cleaned']} 行")
        log(f"  全局颜色统一        {color_replaced} 处")
        log(f"  耗时                {stats['duration']:.2f} 秒")
        log("-" * 56, "plain")
        if args.dry_run:
            log("已跳过写文件（--dry-run）", "warn")
        else:
            log(f"完成，输出已保存：{os.path.abspath(output)}", "ok")
    return 0


# ============================================================
# 子命令：srt
# ============================================================

def cmd_srt(args):
    settings = apply_overrides(load_config(), args)
    if args.no_auto_role:
        settings['auto_role'] = False

    for label, path in (("中文 SRT", args.zh), ("英文 SRT", args.en)):
        if not os.path.exists(path):
            log(f"{label} 文件不存在：{path}", "error")
            return 2

    output = ensure_ass_extension(args.output or default_output(args.zh, "_merged"))

    if not args.quiet:
        log("=" * 56, "plain")
        log(f"  字幕处理工具 v{VERSION}  |  SRT 转换模式", "plain")
        log("=" * 56, "plain")
        log(f"中文：{os.path.abspath(args.zh)}")
        log(f"英文：{os.path.abspath(args.en)}")
        log(f"输出：{'(仅分析，不写出)' if args.dry_run else os.path.abspath(output)}")
        log(f"时间轴：{'独立 + 英文逐词' if settings['time_mismatch'] else '共用中文轴 + 逐词处理'}")
        log(f"自动角色名：{'开' if settings['auto_role'] else '关'}")
        log(f"换行符：{'删除' if settings['remove_linebreak'] else '保留'}")
        log("")

    try:
        if args.dry_run:
            zh_subs = parse_srt(args.zh)
            en_subs = parse_srt(args.en)
            log("摘要", "plain")
            log("-" * 56, "plain")
            log(f"  中文条目            {len(zh_subs)} 条")
            log(f"  英文条目            {len(en_subs)} 条")
            if len(zh_subs) != len(en_subs):
                log(f"  条目数不一致，将以中文为准（丢弃英文多余 {max(0, len(en_subs) - len(zh_subs))} 条）", "warn")
            log("已跳过写文件（--dry-run）", "warn")
            return 0

        if settings.get('time_mismatch', False):
            merge_srt_to_ass(args.zh, args.en, output, settings=settings)
            log("独立时间轴模式：已生成带逐词高亮的 ASS 文件", "ok")
        else:
            tmp_fd, tmp_name = tempfile.mkstemp(suffix='.ass', text=True)
            os.close(tmp_fd)
            try:
                merge_srt_to_ass(args.zh, args.en, tmp_name, settings=settings)
                log("开始逐词处理...")
                added, removed, color_replaced, stats = process_ass(
                    tmp_name, output, settings=settings)
                if not args.quiet:
                    log("-" * 56, "plain")
                    log("摘要", "plain")
                    log("-" * 56, "plain")
                    log(f"  添加逐词效果        {added} 句", "ok")
                    log(f"  清除重叠组逐词      {removed} 句")
                    log(f"  重叠组              {stats['overlap_groups']} 组")
                    log(f"  耗时                {stats['duration']:.2f} 秒")
                    log("-" * 56, "plain")
            finally:
                os.unlink(tmp_name)

        if not args.quiet:
            log(f"完成，输出已保存：{os.path.abspath(output)}", "ok")
    except Exception as e:
        log(f"处理失败：{e}", "error")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1
    return 0


# ============================================================
# 子命令：config
# ============================================================

def cmd_config(args):
    cfg = load_config()

    # 配置项别名，方便手输
    aliases = {
        'highlight': 'highlight_color',
        'color': 'highlight_color',
        'font': 'zh_font_name',
        'size': 'zh_font_size',
        'zh_font': 'zh_font_name',
        'en_font': 'en_font_name',
        'zh_size': 'zh_font_size',
        'en_size': 'en_font_size',
        'tolerance': 'overlap_tolerance',
        'linebreak': 'remove_linebreak',
    }

    # 同时作用于中英两轨的键（写 --set font=X 时两条都改）
    both_tracks = {
        'font_name': ('zh_font_name', 'en_font_name'),
        'font_size': ('zh_font_size', 'en_font_size'),
    }

    if args.set:
        for item in args.set:
            if '=' not in item:
                log(f"参数格式应为 key=value：{item}", "error")
                return 2
            key, value = item.split('=', 1)
            key = key.strip()
            value = value.strip()
            key = aliases.get(key, key)

            # 旧版合并键：展开成中英两条，保持向后兼容
            if key in both_tracks:
                targets = both_tracks[key]
            else:
                targets = (key,)

            for target in targets:
                if target not in DEFAULT_SETTINGS:
                    log(f"未知配置项：{target}"
                        f"（可用：{', '.join(DEFAULT_SETTINGS)}）", "error")
                    return 2
                if target == 'highlight_color':
                    try:
                        cfg[target] = hex_to_ass_color(value)
                    except argparse.ArgumentTypeError as e:
                        log(str(e), "error")
                        return 2
                elif target in ('zh_font_size', 'en_font_size'):
                    try:
                        cfg[target] = int(value)
                    except ValueError:
                        log(f"字号需为整数：{value}", "error")
                        return 2
                elif target == 'overlap_tolerance':
                    try:
                        cfg[target] = float(value)
                    except ValueError:
                        log(f"容差需为数字：{value}", "error")
                        return 2
                elif target in ('replace_punct', 'remove_linebreak',
                                'auto_role', 'time_mismatch'):
                    cfg[target] = value.lower() in ('1', 'true', 'yes', 'on', '开')
                else:
                    cfg[target] = value
        path = save_config(cfg)
        if path:
            log(f"配置已写入：{path}", "ok")
        return 0

    if args.reset:
        path = save_config(dict(DEFAULT_SETTINGS))
        if path:
            log(f"已恢复默认配置并写入：{path}", "ok")
        return 0

    # 默认展示
    path = config_path()
    log(f"配置文件：{path}{'' if os.path.exists(path) else '（尚不存在，以下为内置默认值）'}", "plain")
    log("", "plain")
    for k, v in cfg.items():
        if k == 'highlight_color':
            log(f"  {k:<20} {v}  ({ass_color_to_hex(v)})", "plain")
        elif k == 'overlap_tolerance':
            log(f"  {k:<20} {v}  (秒)", "plain")
        else:
            log(f"  {k:<20} {v}", "plain")
    return 0


def cmd_fonts(args):
    log("可用字体下载地址：", "plain")
    for name, url in FONT_DOWNLOAD_URLS.items():
        log(f"  {name:<22} {url}", "plain")
    log("", "plain")
    log(f"其他内置字体名：{', '.join(FONT_CHOICES)}", "plain")
    return 0


# ============================================================
# 入口
# ============================================================

class SafeArgumentParser(argparse.ArgumentParser):
    """argparse 的无控制台加固版。

    打包成无控制台 exe 后 sys.stderr/stdout 可能为 None，原生 argparse
    在打印帮助或报错时会直接抛异常，用户只看到程序闪退。
    这里把输出统一吞掉，只保留退出码语义。
    """

    def _print_message(self, message, file=None):
        if message is None:
            return
        stream = file or sys.stderr
        if stream is None:
            return
        try:
            stream.write(message)
        except Exception:
            pass

    def exit(self, status=0, message=None):
        if message:
            self._print_message(message, sys.stderr)
        raise SystemExit(status)


def build_parser():
    parser = SafeArgumentParser(
        prog="subtitle-tool",
        description="字幕处理工具：图形界面 / ASS 逐词高亮处理 / 中英 SRT 合并转 ASS",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例：
  打开图形界面（无参数时默认就是图形界面）：
    python main.py
    python main.py --srt            # 直接进 SRT 转换页

  对已有 ASS 添加逐词高亮：
    python main.py ass -i movie.ass
    python main.py ass -i movie.ass -o movie_out.ass --highlight #ff3300

  中英 SRT 合并为双语 ASS 并逐词：
    python main.py srt --zh chs.srt --en eng.srt -o out.ass
    python main.py srt --zh chs.srt --en eng.srt --time-mismatch

  先试跑看看会改多少，不写文件：
    python main.py ass -i movie.ass --dry-run

  查看/修改默认设置：
    python main.py config
    python main.py config --set zh_font_size=72 --set en_font_size=60
    python main.py config --set font_size=65 --set highlight=#00ccff
""",
    )
    parser.add_argument("-V", "--version", action="version",
                        version=f"字幕处理工具 {VERSION}")
    parser.add_argument("-g", "--gui", nargs="?", const="ass", default=None,
                        choices=["ass", "srt"],
                        help="打开图形界面（默认就是图形界面；可跟 ass / srt 指定起始页）")
    parser.add_argument("--srt", dest="gui_srt", action="store_true",
                        help="打开图形界面并直接进入 SRT 转换页")
    sub = parser.add_subparsers(dest="command", metavar="<命令>")

    # --- ass ---
    p_ass = sub.add_parser(
        "ass", help="处理 ASS 字幕（加逐词 / 清重叠 / 统颜色）",
        description="处理 ASS 文件：为无逐词的英文行添加逐词高亮，清除重叠字幕组的逐词效果，"
                    "统一高亮颜色，并清理 [音乐] / >> 等干扰标记。")
    p_ass.add_argument("-i", "--input", required=True, metavar="FILE", help="输入 ASS 文件")
    p_ass.add_argument("-o", "--output", metavar="FILE",
                       help="输出 ASS 文件（默认：输入名 + _karaoke.ass）")
    add_common_settings_args(p_ass)
    add_common_output_args(p_ass)
    p_ass.set_defaults(func=cmd_ass)

    # --- srt ---
    p_srt = sub.add_parser(
        "srt", help="中英 SRT 合并转换为 ASS",
        description="把中文/英文 SRT 合并为双语 ASS。默认两条轨道共用中文时间轴，"
                    "再对英文行做逐词高亮处理；使用 --time-mismatch 则保留各自时间轴。")
    p_srt.add_argument("--zh", required=True, metavar="FILE", help="中文 SRT 文件")
    p_srt.add_argument("--en", required=True, metavar="FILE", help="英文 SRT 文件")
    p_srt.add_argument("-o", "--output", metavar="FILE",
                       help="输出 ASS 文件（默认：中文文件名 + _merged.ass）")
    p_srt.add_argument("--time-mismatch", action="store_true",
                       help="中英时间轴不一致：保留各自时间轴，英文直接生成逐词（不再做重叠清理）")
    p_srt.add_argument("--no-auto-role", action="store_true",
                       help="中文无角色名时不自动添加 [UNKNOWN]")
    add_common_settings_args(p_srt)
    add_common_output_args(p_srt)
    p_srt.set_defaults(func=cmd_srt)

    # --- config ---
    p_cfg = sub.add_parser("config", help="查看或修改默认设置",
                           description="查看、修改或重置默认设置。设置保存在脚本同目录的 config.json。")
    p_cfg.add_argument("--show", action="store_true",
                       help="仅展示当前设置（不加任何参数时也是展示）")
    p_cfg.add_argument("--set", action="append", metavar="KEY=VALUE",
                       help="修改配置项，可重复。字体字号支持中英分离，"
                            "如 --set zh_font=Comic_Sans --set en_font_size=60；"
                            "旧的 --set font= / font_size= 仍可用，会同时改两轨")
    p_cfg.add_argument("--reset", action="store_true", help="恢复全部默认值")
    p_cfg.set_defaults(func=cmd_config)

    # --- fonts ---
    p_font = sub.add_parser("fonts", help="列出推荐字体的下载地址")
    p_font.set_defaults(func=cmd_fonts)

    return parser


def launch_gui(mode="ass"):
    """本仓库只保留核心命令行功能，未随附图形界面（app_gui.py 在上游字幕工具仓库）。"""
    log("本仓库未包含图形界面（app_gui.py 未随仓库提供），请使用命令行模式。", "warn")
    log("", "plain")
    log("常用命令：", "plain")
    log("  python main.py ass -i input.ass            # ASS 逐词/清重叠/统颜色", "plain")
    log("  python main.py srt --zh zh.srt --en en.srt -o out.ass   # 中英 SRT 合并", "plain")
    log("  python main.py config --show               # 查看/修改默认设置", "plain")
    log("  python main.py --help", "plain")
    return 2


def _no_console_guard(argv):
    """无控制台 exe 被当命令行用时，弹窗提示改走带控制台的版本。

    打包后 GUI 版 exe 的 sys.stdout 是 None，命令行输出会全部丢失，
    用户只会看到"什么都没发生"。这里主动识别并给出可用路径。
    """
    if sys.stdout is not None and sys.stderr is not None:
        return False
    if not argv:
        return False

    cli_exe = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])),
                           "字幕处理工具-cli.exe")
    if os.path.exists(cli_exe):
        hint = "请改用同目录下的：\n  字幕处理工具-cli.exe"
    else:
        hint = ("未找到带控制台的命令行版本，\n"
                "请直接双击本程序使用图形界面。")
    msg = ("这是图形界面版本，命令行输出不可见。\n\n" + hint)
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, "字幕处理工具", 0x40)
    except Exception:
        pass
    return True


def main(argv=None):
    global LOG_LEVEL
    parser = build_parser()

    # 无参数直接开图形界面；带参数但参数非法时，也让 argparse 正常报错。
    if argv is None:
        argv = sys.argv[1:]
    if not argv:
        return launch_gui("ass")

    # 无控制台 exe + 命令行参数：直接提示，不继续跑（否则用户看不到任何东西）
    if _no_console_guard(argv):
        return 2

    args = parser.parse_args(argv)

    # 图形界面入口
    if args.gui is not None or getattr(args, "gui_srt", False):
        mode = "srt" if (args.gui == "srt" or getattr(args, "gui_srt", False)) else "ass"
        return launch_gui(mode)

    if not getattr(args, "command", None):
        parser.print_help()
        return 0

    if getattr(args, "quiet", False):
        LOG_LEVEL = "quiet"
    elif getattr(args, "verbose", False):
        LOG_LEVEL = "verbose"

    try:
        return args.func(args)
    except KeyboardInterrupt:
        log("已中断", "error")
        return 130
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
