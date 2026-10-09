/**
 * 视频区"点什么改什么"的文本分段与**最小替换**工具（纯函数，供单测）。
 *
 * 口径：可见纯文本按空白切片段；行首 [角色] 标签是只读前缀，不参与编辑
 * （与右侧列表行内编辑隐藏 _editTag 的做法一致）。
 *
 * 关键设计 —— 为什么不用整行纯文本重建：
 *   本项目的 ASS 行里常带**行内变色标签**（`{\c&H..&}才有机会击败Flame`）。
 *   若用纯文本重建整行（buildAnchorText 那条路），行内其它片段的颜色标签会被丢掉，
 *   画面立刻变色。所以这里只把**被点中的那一段**换成新文本，其余原文一字不动
 *   —— 提示语里的"仅替换"才名副其实。
 */

/** 行首 [角色] 标签的长度（含收尾空白）；纯文本里覆盖标签已被剥掉，所以只看 [..] */
export function leadPrefixLen(plain) {
  const m = /^\s*\[[^\]\n]{1,64}\]\s*/.exec(String(plain == null ? '' : plain));
  return m ? m[0].length : 0;
}

/**
 * ASS 原文 → 可见纯文本 + **逐字符下标映射**。
 * 口径与 ass.js 的 assPlainText 完全一致（\{ \} \\ 还原、\N \n \h → 空格、
 * {..} 覆盖标签整段跳过、空白折叠、首尾 trim），区别只是顺带把
 * "纯文本第 i 个字符来自原文的第 map[i] 个字符"记下来 —— 有了它才能做最小替换。
 * @returns {{ plain: string, map: number[] }}
 */
export function assPlainAndMap(raw) {
  const s = String(raw == null ? '' : raw);
  const chars = [];
  let i = 0, prevSpace = true;                 // prevSpace 起手为 true ⇒ 顺带吃掉行首空白(等效 trimLeft)
  while (i < s.length) {
    const c = s[i];
    let ch = '', at = i, adv = 1;
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'N' || n === 'n' || n === 'h') { ch = ' '; adv = 2; }
      else if (n === '{' || n === '}' || n === '\\') { ch = n; adv = 2; }
      else { ch = c; adv = 1; }
    } else if (c === '{') {
      const end = s.indexOf('}', i);
      if (end >= 0) { i = end + 1; continue; }   // 覆盖标签：整段跳过，不产出字符
      ch = c; adv = 1;
    } else { ch = c; adv = 1; }

    if (/\s/.test(ch)) {
      if (!prevSpace) { chars.push({ ch: ' ', at }); prevSpace = true; }
    } else {
      chars.push({ ch, at });
      prevSpace = false;
    }
    i += adv;
  }
  while (chars.length && chars[chars.length - 1].ch === ' ') chars.pop();   // trimRight
  return { plain: chars.map(c => c.ch).join(''), map: chars.map(c => c.at) };
}

/** SRT 行 → 可见纯文本 + 逐字符下标映射（跳过行内 HTML 标签 `<i> <b> <font ...>`） */
export function htmlPlainAndMap(raw) {
  const s = String(raw == null ? '' : raw);
  const chars = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '<') {
      const end = s.indexOf('>', i);
      if (end >= 0) { i = end + 1; continue; }
    }
    chars.push({ ch: s[i], at: i });
    i += 1;
  }
  return { plain: chars.map(c => c.ch).join(''), map: chars.map(c => c.at) };
}

/** kind: 'ass' | 'srt' */
export function plainAndMap(raw, kind) {
  return kind === 'srt' ? htmlPlainAndMap(raw) : assPlainAndMap(raw);
}

/**
 * 纯文本 → 可编辑片段。
 * @returns {{ prefix: string, segs: {text:string,start:number,end:number}[] }}
 *          start/end 是相对**纯文本**的下标（含行首角色标签的偏移，方便直接喂回 replaceSegmentInRaw）
 */
export function splitSegments(plain) {
  const text = String(plain == null ? '' : plain);
  const pre = leadPrefixLen(text);
  const segs = [];
  const re = /\S+/g;
  re.lastIndex = pre;
  let m;
  while ((m = re.exec(text))) segs.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return { prefix: text.slice(0, pre), segs };
}

/** 用户在片段框里打的字 → ASS 安全文本（花括号/反斜杠转义、换行转 \N）。
 *  片段框只做"快速改字"，不解析内联标签；要写标签请用整行文本弹窗（那里按 Text 字段原样替换）。 */
export function escapeAssUser(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\\N');
}

/**
 * 把片段替换进**原始文本**，返回新的原始文本。
 * @param raw   当前原文（ASS 的 ev.text / SRT 的 line）
 * @param kind  'ass' | 'srt'
 * @param seg   splitSegments 给出的片段（其 start/end 来自同一份纯文本）
 * @param text  用户输入（ASS 会做转义；SRT 原样写入）
 * @returns 新原文；若文档已变导致区间对不上 → null（调用方重新命中即可，绝不猜着改）
 */
export function replaceSegmentInRaw(raw, kind, seg, text) {
  const s = String(raw == null ? '' : raw);
  const { plain, map } = plainAndMap(s, kind);
  if (!seg || plain.slice(seg.start, seg.end) !== seg.text) return null;
  const rawStart = map[seg.start];
  const rawEnd = map[seg.end - 1];
  if (rawStart == null || rawEnd == null) return null;
  const user = kind === 'srt' ? String(text == null ? '' : text) : escapeAssUser(text);
  return s.slice(0, rawStart) + user + s.slice(rawEnd + 1);
}
