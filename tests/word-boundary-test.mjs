/* 钉住「ASR 拼词丢词边界」这个坑。
 *
 * 背景（2026-10-10 用户实测）：
 *   "then how do we escape" 被识别成 "weescape"、"no way to escape" 被识别成 "toescape"。
 *   根因**不在分句**，而在 asr.py 的 token→词 重建：
 *
 *     sherpa 在词边界处会吐一个**只有空格的 token**（词表里的孤立边界符 ▁）。
 *     _decode_chunks 里 `if not tok.strip(): continue` 把它删了，
 *     recognize_words 于是无从判断词边界，把 ' we' + 'es' + 'ca' + 'pe' 拼成了 "weescape"。
 *
 *   sherpa 自己拼的 `r.text` 一直是对的（"How do we escape?"）——
 *   所以**用文本当词边界的真值**回头修（align_word_starts）。
 *
 * 这个测试不依赖模型/音频：直接喂人造 token 流，验证拼词结果。
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ASR = path.join(REPO, 'asr');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

/* ── 静态断言：两个坑不能再回来 ─────────────────────────────── */
console.log('== ① 静态：_decode_chunks 不能再过滤纯空白 token ==');
const SRCPY = fs.readFileSync(path.join(ASR, 'asr.py'), 'utf8');
{
  const iFn = SRCPY.indexOf('def _decode_chunks');
  const iEnd = SRCPY.indexOf('def align_word_starts');
  const seg = SRCPY.slice(iFn, iEnd);
  ok(iFn > 0 && iEnd > iFn, '找到 _decode_chunks 与 align_word_starts');
  ok(!/if not tok\.strip\(\):\s*\n\s*continue/.test(seg),
    '★ _decode_chunks 里没有 `if not tok.strip(): continue`（那会删掉词边界 token）');
  ok(/getattr\(r, "text", ""\)/.test(seg),
    '★ _decode_chunks 把 r.text 一起带出来（词边界的真值）');
  ok(/return out/.test(seg) && /out\.append\(\(toks, /.test(seg),
    '★ 返回 (tokens, text) 元组');
}
{
  const iFn = SRCPY.indexOf('def recognize_words');
  const seg = SRCPY.slice(iFn, iFn + 3000);
  ok(/align_word_starts\(toks, text\)/.test(seg), '★ recognize_words 调用了文本对齐');
  ok(!/prev_leading/.test(seg),
    '★ 不在消费端重复加断词条件（align_word_starts 已在源头挡住误断，再挡会漏掉该断的）');
  ok(/if not piece:[\s\S]{0,120}words\.append\(cur\)/.test(seg),
    '★ 孤立边界 token 会结掉当前词（不再直接跳过）');
}
{
  const iFn = SRCPY.indexOf('def align_word_starts');
  const seg = SRCPY.slice(iFn, iFn + 2600);
  ok(/text\[pos\]\.isspace\(\)/.test(seg), '★ 对齐时按文本里的空格判词界');
  ok(/is_punct/.test(seg) && /not is_punct/.test(seg),
    '★ 标点不构成词首（否则 "point." 会被拆成 "point" + "."）');
  ok(/not t\.startswith\(" "\)/.test(seg),
    '★ 自带前导空格的 token 不打标记（否则 "H"+"ow" 被拆成 "H ow"）');
}
{
  // stability_of 必须跟着改成解元组
  const iFn = SRCPY.indexOf('def stability_of');
  const seg = SRCPY.slice(iFn, iFn + 1400);
  ok(/for toks, _t in clean_per_chunk/.test(seg),
    '★ stability_of 已跟着改（clean_per_chunk 现在是元组列表）');
  ok(/for toks, _t in one/.test(seg), '★ runs 也是元组列表');
}

/* ── 行为断言：直接调 align_word_starts 与拼词逻辑 ──────────── */
console.log('\n== ② 行为：用 Python 直接跑 align_word_starts + 拼词 ==');
const PY = path.join(ASR, 'runtime-python', 'python.exe');
const PROBE = `
import json, sys
sys.path.insert(0, r'${ASR.replace(/\\/g, '\\\\')}')
import asr

def build(tokens, text):
    """复刻 recognize_words 的拼词循环（不依赖模型）"""
    toks = asr.align_word_starts(tokens, text)
    words, cur = [], None
    for tk in toks:
        tok = tk["text"]; piece = tok.strip()
        if not piece:
            if cur is not None:
                words.append(cur); cur = None
            continue
        if cur is not None and (tok.startswith(" ") or tk.get("wordStart")):
            words.append(cur); cur = None
        if cur is None:
            cur = {"word": piece, "start": tk["frame"]}
        else:
            cur["word"] += piece
    if cur:
        words.append(cur)
    return [w["word"] for w in words]

CASES = [
    # (名字, token 流, 文本, 期望词表)
    ("丢边界 we+escape",
     [{"text": " point", "frame": 0.0}, {"text": ".", "frame": 0.1},
      {"text": " H", "frame": 0.2}, {"text": "ow", "frame": 0.3},
      {"text": " do", "frame": 0.4}, {"text": " we", "frame": 0.5},
      {"text": "es", "frame": 0.6}, {"text": "ca", "frame": 0.7},
      {"text": "pe", "frame": 0.8}, {"text": "?", "frame": 0.9}],
     "point. How do we escape?",
     ["point.", "How", "do", "we", "escape?"]),

    ("丢边界 to+escape",
     [{"text": " But", "frame": 0.0}, {"text": " no", "frame": 0.1},
      {"text": " way", "frame": 0.2}, {"text": " to", "frame": 0.3},
      {"text": "es", "frame": 0.4}, {"text": "ca", "frame": 0.5},
      {"text": "pe", "frame": 0.6}, {"text": ".", "frame": 0.7}],
     "But no way to escape.",
     ["But", "no", "way", "to", "escape."]),

    ("正常词不能切碎 b+ound",
     [{"text": " was", "frame": 0.0}, {"text": " b", "frame": 0.1},
      {"text": "ound", "frame": 0.2}],
     "was bound",
     ["was", "bound"]),

    ("孤立的纯空格 token 要断词",
     [{"text": " we", "frame": 0.0}, {"text": " ", "frame": 0.1},
      {"text": " escape", "frame": 0.2}],
     "we escape",
     ["we", "escape"]),

    ("标点挂前词不独立",
     [{"text": " done", "frame": 0.0}, {"text": ".", "frame": 0.1}],
     "done.",
     ["done."]),

    ("全部正常时不动",
     [{"text": " hello", "frame": 0.0}, {"text": " world", "frame": 0.1}],
     "hello world",
     ["hello", "world"]),
]

out = []
for name, toks, text, want in CASES:
    got = build(toks, text)
    out.append({"name": name, "got": got, "want": want, "ok": got == want})
print(json.dumps(out, ensure_ascii=False))
`;
const raw = execFileSync(PY, ['-c', PROBE], { encoding: 'utf8' });
const results = JSON.parse(raw.trim().split('\n').pop());
for (const r of results) ok(r.ok, `★ ${r.name}`, { got: r.got, want: r.want });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
