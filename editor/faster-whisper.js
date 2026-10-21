'use strict';
/**
 * Faster-Whisper-XXL（Whisper large-v2）适配层：纯逻辑，可离线单测。
 *
 * 为什么单独成文件：命令参数、默认预处理与 XXL JSON → SubFabric asr.json 的转换
 * 都是纯函数，放进 server.js 就只能靠真的跑一遍 3GB 模型才能验证；这里由
 * tests/faster-whisper-test.mjs 直接覆盖。
 *
 * XXL 的模型目录约定：`--model large-v2` 会去 `<model_dir>/faster-whisper-large-v2`
 * 找 CTranslate2 权重（Systran/faster-whisper-large-v2）。所以调用方传的 modelDir
 * 必须是**父目录**，而不是权重目录本身。server.js 的 fwModelParent() 负责这一层。
 */

/** 默认预处理参数（对照「卡卡的 whisper large v2 设置」：VAD 0.05 / pyannote_v3 /
 *  人声分离 / 逐词时间戳 / 提示词留空）。这些值在这台机器的 4 小时素材上实测可用。 */
const DEFAULTS = {
  language: 'en',
  // 「卡卡」的参考设置是 VAD 开 / 0.05；但同一段 10 分钟素材实测 VAD 会切掉 31 个词
  // （1740 → 1709），关掉后 WER 7.74% vs 8.70%。字幕工具优先“不漏词”，所以默认关。
  vad: false,
  vadThreshold: 0.05,
  vadMethod: 'pyannote_v3',
  vocalExtract: true,
  wordTimestamps: true,
};

/** r245.3 起把 `--ff_mdx_kim2` 改成 `--ff_vocal_extract mdx_kim2`。
 *  用 `--help` 文本探测，避免同一个引擎在两个版本上二选一写死。 */
function mdxArgs(helpText) {
  return /--ff_vocal_extract\b/.test(String(helpText || ''))
    ? ['--ff_vocal_extract', 'mdx_kim2']
    : ['--ff_mdx_kim2'];
}

/** 拼 XXL 的命令行（不含可执行文件本身）。 */
function buildArgs(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!o.audio) throw new Error('缺少音频路径');
  if (!o.modelDir) throw new Error('缺少模型父目录');
  if (!o.outputDir) throw new Error('缺少输出目录');
  const args = [
    String(o.audio),
    '--model', 'large-v2',
    '--model_dir', String(o.modelDir),
    '--output_dir', String(o.outputDir),
    '--output_format', 'json',
    '--language', String(o.language || 'en'),
    '--word_timestamps', o.wordTimestamps ? 'True' : 'False',
    '--vad_filter', o.vad ? 'True' : 'False',
    '--vad_threshold', String(o.vadThreshold),
    '--vad_method', String(o.vadMethod),
    '--beep_off',
    '--print_progress',
  ];
  if (o.vocalExtract) args.push(...mdxArgs(o.helpText));
  const prompt = String(o.prompt || '').trim();
  if (prompt) args.push('--initial_prompt', prompt.slice(0, 300));
  return args;
}

/** XXL 的进度行形如 `  4% |  26/600 | ...`（stdout/stderr 都可能有）。 */
function parseProgress(line) {
  const m = /(\d{1,3})\s*%/.exec(String(line || ''));
  if (!m) return null;
  const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
  return Number.isFinite(pct) ? pct : null;
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 按词拼回一行文本：英文加空格，中日韩字符之间不加。 */
function joinWords(words) {
  let out = '';
  for (const w of words || []) {
    const s = String(w && w.word != null ? w.word : '').trim();
    if (!s) continue;
    if (!out) { out = s; continue; }
    const prev = out[out.length - 1], next = s[0];
    out += (CJK.test(prev) || CJK.test(next)) ? s : ' ' + s;
  }
  return out;
}

/** 把 XXL 的 JSON 转成 SubFabric 的 `{segments:[{start,end,text,words,confidence}]}`。
 *
 *  - XXL 已经给出词级时间戳（`--word_timestamps True`）；这里只做清理、排序、
 *    按句末标点/长停顿/行长重新分组 —— 与 whisper.cpp / crisp 引擎同一条分句口径，
 *    这样后面的语义分句、逐词 ASS、置信度逻辑完全复用，不需要按引擎分支。
 *  - 置信度用词的 `probability` 求均值；XXL 不输出稳定性重跑，parts 里只放 token。
 *    没有概率的段不伪造分数（省略 confidence），界面显示“—”。
 */
function toSegments(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const input = Array.isArray(data) ? data : (data && data.segments);
  if (!Array.isArray(input)) throw new Error('XXL 输出里没有 segments 数组');
  const words = [];
  for (const seg of input) {
    if (!seg) continue;
    const segStart = Number(seg.start), segEnd = Number(seg.end);
    const list = Array.isArray(seg.words) ? seg.words : [];
    if (list.length) {
      for (const w of list) {
        const word = String((w && (w.word != null ? w.word : w.text)) || '').trim();
        if (!word) continue;
        let start = Number(w.start), end = Number(w.end);
        if (!Number.isFinite(start)) start = segStart;
        if (!Number.isFinite(end) || end <= start) end = start + 0.2;
        const probability = Number(w.probability);
        words.push({
          word, start: Math.max(0, start), end: Math.max(start + 0.01, end),
          probability: Number.isFinite(probability) ? probability : undefined,
        });
      }
    } else {
      // 没有词级时间戳时退化：按文本词数均分该段，避免整段丢失
      const textWords = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
      if (!textWords.length || !(segEnd > segStart)) continue;
      const step = (segEnd - segStart) / textWords.length;
      textWords.forEach((word, i) => {
        words.push({ word, start: segStart + i * step, end: segStart + (i + 1) * step });
      });
    }
  }
  if (!words.length) return { segments: [] };
  words.sort((a, b) => a.start - b.start);
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].start) words[i].start = words[i - 1].start;
    if (words[i].end <= words[i].start) words[i].end = words[i].start + 0.2;
  }
  // 与 runWhisperCpp / runCrispAsr 相同的分组规则；唯一新增是 0.2s 以下的
  // 零碎标点不单独起一行（XXL 偶尔把句号拆成独立词）。
  const groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const tooLong = (w.start - cur[0].start) > 10 || cur.length >= 30;
      if (/[.?!…]$/.test(prev.word) || (w.start - prev.end) > 0.8 || tooLong) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  const segments = groups.map((ws) => {
    const probs = ws.map(w => w.probability).filter(Number.isFinite);
    const token = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;
    const lowWord = probs.length
      ? ws.reduce((a, w) => (Number.isFinite(w.probability) && (!a || w.probability < a.probability) ? w : a), null)
      : null;
    const seg = {
      start: +ws[0].start.toFixed(3),
      end: +ws[ws.length - 1].end.toFixed(3),
      text: joinWords(ws),
      words: ws.map(w => ({ word: w.word, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })),
    };
    if (token != null) {
      seg.confidence = {
        score: +token.toFixed(3),
        low: token < 0.6,
        worstWord: lowWord ? lowWord.word : null,
        parts: { token: +token.toFixed(3) },
      };
    }
    return seg;
  });
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) segments[i].start = segments[i - 1].end;
  }
  return { segments, language: 'en' };
}

/** 跑一次 XXL，从 stdout/stderr 里提取百分比。返回一个取消函数。 */
function progressSink(onProgress) {
  let last = -1;
  return (chunk) => {
    const s = String(chunk);
    for (const line of s.split(/[\r\n]+/)) {
      const pct = parseProgress(line);
      if (pct != null && pct !== last) {
        last = pct;
        if (onProgress) onProgress(pct);
      }
    }
  };
}

module.exports = { DEFAULTS, mdxArgs, buildArgs, parseProgress, toSegments, progressSink, joinWords };
