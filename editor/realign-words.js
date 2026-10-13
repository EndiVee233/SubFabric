/**
 * 「全片逐词重校对」里可以**脱离 ASR 单测**的那部分纯逻辑。
 *
 * 单独成文件的原因与 hotwords.js 一样：server.js 是一启动就 listen 的单体模块，
 * 没法 require，纯逻辑留在里面就只能靠端到端跑一遍才知道对不对 —— 而"热词候选
 * 怎么整理""LLM 回复怎么抠词""切片区间怎么算"这三件事全是纯函数，值得有单测。
 * 见 tests/realign-words-test.mjs。
 */

/**
 * 从该句已有的词里整理出热词候选。
 *
 * 词的两条来源字段名不同（识别结果是 {word,...}、从 ASS 还原的是 {w,s,e}），
 * 所以这里两种都认 —— 早先 server.js 只认 {w,s,e}，于是"有 asr.json 的稿件"
 * 候选全成了 undefined，LLM 收到的是 "[object Object]"。这个函数把口径收在一处。
 *
 * @param items 词对象数组，或字符串数组
 * @returns 去重后的候选词（已去首尾标点、丢弃长度 < 2 的）
 */
function hotwordCandidates(items) {
  const out = [];
  const seen = new Set();
  for (const it of (items || [])) {
    const raw = (it && typeof it === 'object')
      ? (it.w !== undefined ? it.w : it.word) : it;
    const s = String(raw == null ? '' : raw)
      .replace(/^[^0-9A-Za-z]+/, '')
      .replace(/[^0-9A-Za-z']+$/, '');
    if (!s || s.length < 2 || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/**
 * 从 LLM 回复里抠出挑选结果。
 *
 * 只保留**确实出现在该句候选里**的词：模型偶尔会自己造词或改写拼写，
 * 那种热词比没有还糟 —— 它会把识别带到这句话里根本不存在的词上。
 * 抠不出来（回复不是 JSON、或被截断）就返回空数组，调用方据此跳过第二级。
 *
 * @param reply LLM 的正文
 * @param cand  hotwordCandidates 的结果
 * @param max   最多取几个（默认 6）
 */
function matchPickedWords(reply, cand, max) {
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 6;
  const s = String(reply == null ? '' : reply);
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr = null;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const byLower = new Map((cand || []).map(w => [String(w).toLowerCase(), String(w)]));
  const out = [];
  for (const it of arr) {
    const hit = byLower.get(String(it == null ? '' : it).trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 该句该切哪一段音频：两侧各留 pad，并夹在 [0, duration] 内。
 *
 * padding 是必需的 —— 句子的逐词边界与真实语音边界不会完全齐平，贴边切会把
 * 首尾词的起音/收音削掉（实测 0.20s 够用）。多切进来的相邻句残词对不上本句文本，
 * 会被 planBlock 的对齐判成落单丢掉。
 */
function sliceRange(start, end, pad, duration) {
  const p = Number.isFinite(Number(pad)) ? Math.max(0, Number(pad)) : 0;
  const s = Number(start), e = Number(end);
  const d = Number(duration);
  const hi = (Number.isFinite(d) && d > 0) ? d : Infinity;
  const from = Math.max(0, s - p);
  const to = Math.min(hi, e + p);
  return { from, to: Math.max(from, to) };
}

export { hotwordCandidates, matchPickedWords, sliceRange };
