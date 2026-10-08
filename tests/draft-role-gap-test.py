# -*- coding: utf-8 -*-
"""初稿产出的角色名标签空格测试（用户报过：初稿跑完是 "[UNKNOWN]正文"，缺一个空格）。

跑法（bundled python 或任意 python3）：
    python tests/draft-role-gap-test.py
只依赖 main.py 的 merge_srt_to_ass + 两个临时 SRT，不跑 ASR / 不联网。
"""
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import main  # noqa: E402  (main.py 有 __main__ 保护，import 安全)

passed = 0
failed = 0


def ok(cond, name, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print('  ok  ' + name)
    else:
        failed += 1
        print('FAIL  ' + name + ('' if extra is None else ' :: ' + repr(extra)))


def run(zh_lines, en_lines, settings=None):
    """写两个临时 SRT -> merge_srt_to_ass -> 返回 ASS 里的「中文字幕」行文本列表"""
    with tempfile.TemporaryDirectory() as d:
        zh_p, en_p, out_p = [os.path.join(d, n) for n in ('zh.srt', 'en.srt', 'out.ass')]
        with open(zh_p, 'w', encoding='utf-8') as f:
            f.write('\n'.join('%d\n00:00:0%d,000 --> 00:00:0%d,500\n%s\n' % (i + 1, i, i + 1, t)
                              for i, t in enumerate(zh_lines)))
        with open(en_p, 'w', encoding='utf-8') as f:
            f.write('\n'.join('%d\n00:00:0%d,000 --> 00:00:0%d,500\n%s\n' % (i + 1, i, i + 1, t)
                              for i, t in enumerate(en_lines)))
        s = dict(main.DEFAULT_SETTINGS)
        if settings:
            s.update(settings)
        main.merge_srt_to_ass(zh_p, en_p, out_p, s)
        with open(out_p, encoding='utf-8') as f:
            ass = f.read()
    # Dialogue 有 10 个字段, 正文是第 10 个 —— 不能按第一个 ',,' 切(那是 Name 空字段)
    out = []
    for l in ass.splitlines():
        if l.startswith('Dialogue:') and ',中文字幕,' in l:
            parts = l.split(',', 9)
            if len(parts) == 10:
                out.append(parts[9])
    return out


print('== 初稿角色名标签空格 ==')

# ① 无角色名 → 自动补 [UNKNOWN]，标签与正文之间必须有一个空格
zh = run(['今天我们来盖房子'], ['today we build a house'])
ok(len(zh) == 1, '产出了一条中文字幕行', zh)
ok(zh and re.match(r'^\{\\c&H[0-9A-F]{6}&\}\[UNKNOWN\] ', zh[0]), '[UNKNOWN] 后面有一个空格', zh[0] if zh else None)
ok(zh and not re.search(r'\]\S', zh[0]), '不存在 "]正文" 这种紧贴', zh[0] if zh else None)
ok(zh and zh[0].endswith('今天我们来盖房子'), '正文本身没被改动', zh[0] if zh else None)

# ② 正文里本来就有空格 → 不会变成两个空格（用真角色名: [音乐] 会被当非语音标记清掉）
zh = run(['[Spoke] 我们来盖房子'], ['we build a house'])
ok(zh and zh[0].count('[Spoke]') == 1, '原角色名保留', zh[0] if zh else None)
ok(zh and '  ' not in zh[0], '没有出现双空格', zh[0] if zh else None)
ok(zh and re.match(r'^.*\[Spoke\] ', zh[0]), '原角色名后仍是一个空格', zh[0] if zh else None)
ok(zh and '[UNKNOWN]' not in zh[0], '已经有角色名就不再插 [UNKNOWN]', zh[0] if zh else None)

# ③ 正文里角色名紧贴 → 也要被规范成一个空格（clean_chinese_text 的既有规则）
zh = run(['[Spoke]我们来盖房子'], ['we build a house'])
ok(zh and '[Spoke] 我们来盖房子' in zh[0], '原本紧贴的角色名被规范成空格', zh[0] if zh else None)

# ④ 关掉 auto_role → 不插标签，也不该凭空多出空格
zh = run(['我们来盖房子'], ['we build a house'], {'auto_role': False})
ok(zh and '[UNKNOWN]' not in zh[0], 'auto_role=False 时不插 [UNKNOWN]', zh[0] if zh else None)

# ⑤ 多条也要条条都对
zh = run(['第一句', '第二句', '第三句'], ['one', 'two', 'three'])
ok(len(zh) == 3, '三条都产出', len(zh))
ok(all(re.match(r'^\{\\c&H[0-9A-F]{6}&\}\[UNKNOWN\] \S', x) for x in zh), '每条都是 "[UNKNOWN] 正文"', zh)

# ⑥ 默认色是白（深色画面下的默认观感），且「默认颜色」设置真的生效
zh = run(['我们来盖房子'], ['we build a house'])
ok(zh and zh[0].startswith('{\\c&HFFFFFF&}'), '默认 zh_color 产出白色覆盖标签', zh[0] if zh else None)
zh = run(['我们来盖房子'], ['we build a house'], {'zh_color': '#FF0000'})
ok(zh and zh[0].startswith('{\\c&H0000FF&}'),
   'zh_color=红 时对白用红色(#FF0000 -> &H0000FF)', zh[0] if zh else None)
zh = run(['{\\c&H00FF00&}已有着色'], ['already coloured'], {'zh_color': '#FF0000'})
ok(zh and '&H0000FF&' not in zh[0], '正文已有覆盖标签时不插入 zh_color', zh[0] if zh else None)

print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
