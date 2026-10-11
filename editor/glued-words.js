/* ═══════════ 粘连词检测（ASR 把两个词粘成一个）═══════════
 *
 * 解决什么问题
 *   ASR 在词边界处会丢边界符，把两个词写成一个：
 *       toescape  （该是 to escape）
 *       weescape  （该是 we escape）
 *   观感是"这句读不通"，用户报的例子就是 "then how do we escape" → "weescape"。
 *
 * ⚠ 为什么不在识别阶段"顺便"修
 *   识别阶段已经修了（asr.py 的 align_word_starts，用 r.text 当真值）—— 那是**根治**。
 *   但这个模块管的是**已经生成好的项目**：那时真正的词边界（r.text）早被丢掉了
 *   （asr.json 里存的 text 本身就是粘连的），重新识别才能根治。
 *   所以这里做的是"**找出来让用户复核**"，不是"悄悄改"。
 *
 * 判据（四条，每条都对应一类实测误报）
 *   1. 含撇号不判        —— there's / weren't / you're 这类缩略词最容易被误判
 *   2. 本身是常用词不判  —— themes / merely / beliefs / attempting 全是合法词
 *   3. 前半必须是虚词    —— civilizations / beforehand 的前半不是虚词
 *   4. 后半是 -ing/-ed/-ly/-s 形态不判
 *                        —— attempting(as+ tempting) / becomes(be+comes) / asking(as+king)
 *                           这类"后半是变形词"的，整词本身多半就是合法词
 *
 * 实测（4 个真实项目、21342 个词）：
 *   召回 2/2 个已知粘连；误报 4 种，其中 godamn×7、insteady 本身就是 ASR 错误，
 *   只有 withstand 一个是真误报。
 */

/* 虚词前缀：粘连几乎都发生在"虚词被粘到下一个词上" */
const FUNC_PREFIX = new Set([
  'to', 'we', 'the', 'in', 'of', 'for', 'you', 'and', 'is', 'it', 'he', 'she', 'they',
  'no', 'so', 'do', 'be', 'my', 'me', 'on', 'at', 'as', 'if', 'or', 'but', 'not', 'was',
  'a', 'an', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'will', 'would',
  'can', 'could', 'should', 'just', 'like', 'get', 'got', 'go', 'up', 'out', 'all', 'there',
]);

/* 变形词尾：后半是这些形态时不判 */
const INFLECT_RE = /(ing|ed|ly|es|s)$/;

/* 词表补丁：内置词表是"高频词"表，会漏掉一些不算高频但很常见的词。
 * 漏掉它们会让检测器把合法词判成粘连（实测：withstand = with + stand，
 * 就因为表里没有 stand）。这里补最小的必要集合，不追求完备。 */
const DICT_EXTRA = ['stand', 'stands', 'standing'];

/* 允许当"后半"的**三字母**词 —— 必须限死在这个小集合里。
 * 为什么不能直接放宽到"任意三字母词"：那样 wasted = was+ted、asking = as+king
 * 这类会立刻变成误报（ted / king 都是词表里的真词）。
 * 而 the / and / you 这几个是**粘连高发**词（tothe / andthe / youare），值得单列。 */
const SHORT_TAIL = new Set(['the', 'and', 'you', 'for', 'not', 'was', 'are', 'his', 'her',
  'one', 'all', 'out', 'but', 'who', 'why', 'how', 'any', 'own', 'too', 'see', 'way',
  'day', 'man', 'new', 'old', 'get', 'use', 'two', 'six', 'she', 'him', 'did']);

/** 后半能不能当"真词"：≥4 字母的任意词典词，或上面那几个三字母高频词 */
function tailOk(tail, dict) {
  if (tail.length >= 4) return dict.has(tail);
  return tail.length === 3 && SHORT_TAIL.has(tail) && dict.has(tail);
}

let WORDS = null;
let wordsLoadFailed = false;

/**
 * 载入常用词表（editor/wordlist-en.json）。
 * 注入式：调用方把 `words` 直接传进来就不用读文件（测试用）。
 * @param {string[]} [inject] 直接给的词表
 */
function loadWords(inject) {
  if (Array.isArray(inject)) return new Set(inject.map(w => String(w).toLowerCase()));
  if (WORDS) return WORDS;
  if (wordsLoadFailed) return new Set();
  try {
    // 延迟 require：浏览器端跑测试时 import 这个模块不会因为 require 炸掉
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, 'wordlist-en.json');
    // ⚠ 用 utf8 读：词表是纯 ASCII，但不排除有人手改后存成带 BOM —— 去掉 BOM 更稳
    let txt = fs.readFileSync(p, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    const j = JSON.parse(txt);
    WORDS = new Set((j.words || []).map(w => String(w).toLowerCase()));
    for (const w of DICT_EXTRA) WORDS.add(w);
  } catch (e) {
    wordsLoadFailed = true;
    WORDS = new Set();
  }
  return WORDS;
}

/** 测试用：重置缓存的词表 */
function _resetWords() { WORDS = null; wordsLoadFailed = false; }

/**
 * 判断一个词是不是"两个词粘在一起"。
 * @param {string} raw 待查的词（可带尾部标点）
 * @param {Set<string>|string[]} [dict] 词表，不传就用内置的
 * @returns {{head:string,tail:string,word:string}|null}
 */
function detectGluedWord(raw, dict) {
  const D = dict ? (dict instanceof Set ? dict : new Set(dict.map(w => String(w).toLowerCase()))) : loadWords();
  if (!D.size) return null;

  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  // 判据 1：撇号 → 缩略词；撇号本身还是所有格标记，不能当粘连
  if (s.includes("'") || s.includes('\u2019')) return null;

  // 去掉**尾部**标点；词中间有标点/数字的不判（那是另一种退化，不在这里管）
  const core = s.replace(/[.,!?;:]+$/, '');
  if (!/^[A-Za-z]+$/.test(core)) return null;

  const low = core.toLowerCase();
  if (low.length < 5) return null;
  // 判据 2：本身就是合法词
  if (D.has(low)) return null;

  // 判据 3：前半是虚词、后半是词表里的真词（或那几个三字母高频词）
  for (let cut = 2; cut <= Math.min(4, low.length - 3); cut++) {
    const head = low.slice(0, cut);
    const tail = low.slice(cut);
    if (!FUNC_PREFIX.has(head)) continue;
    if (!tailOk(tail, D)) continue;
    // 判据 4：后半是变形词形态 → 整词多半合法
    if (INFLECT_RE.test(tail)) return null;
    return { head, tail, word: s };
  }
  return null;
}

/**
 * 扫一遍句子/词表，返回所有疑似粘连的位置。
 *
 * ⚠ `words` 里的元素**未必带 `word` 字段**：反思纠错的调用方（server.js 的 runReflect）
 *   传的是 `{start, end}` —— 它只需要时间，不需要词面。早先这里只看
 *   `words.length` 就走进词级分支，于是每个 `w.word` 都是 undefined、
 *   `detectGluedWord(undefined)` 一律返回 null，**一个粘连都报不出来**（实测踩过：
 *   走 DeepSeek 跑完整反思，toescape/weescape 都没进结果，notes 也是空的）。
 *   所以这里必须检查"真的拿到了词面"，拿不到就退回按文本扫。
 *
 * @param {Array<{text?:string, words?:Array<{word?:string}>}>} rows 行（或段落）
 * @param {object} [opts] { dict } 自定义词表
 * @returns {Array<{row:number, from:number, to:number, word:string, head:string, tail:string, line:string, reason:string}>}
 */
function scanGluedWords(rows, opts) {
  const o = opts || {};
  const dict = o.dict ? (o.dict instanceof Set ? o.dict : new Set(o.dict.map(w => String(w).toLowerCase()))) : loadWords();
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const words = Array.isArray(r.words) ? r.words : null;
    // 只有"真的能拿到词面"才走词级路径
    const usable = words && words.length && words.some(w => w && typeof w.word === 'string' && w.word);
    const sources = usable ? words.map(w => w && w.word) : String(r.text || '').split(/\s+/);
    for (const src of sources) {
      const hit = detectGluedWord(src, dict);
      if (hit) {
        out.push({
          row: i, from: i + 1, to: i + 1,
          word: hit.word, head: hit.head, tail: hit.tail,
          line: String(r.text || ''),
          reason: `「${hit.word}」像是两个词粘在一起：应为「${hit.head} ${hit.tail}」`,
        });
      }
    }
  }
  return out;
}

/**
 * 扫一遍所有行，返回 `行号(1-based) → 命中数组` 的 Map。
 *
 * 和 scanGluedWords 的区别：这个是**按行索引**，调用方（反思纠错）要拿它
 * 既给模型当提示、又在模型漏报时确定性补条目，所以需要能按行号 O(1) 查。
 * @param {Array<{text?:string, words?:Array<{word:string}>}>} rows
 * @param {object} [opts] { dict }
 * @returns {Map<number, Array<{word:string, head:string, tail:string, reason:string}>>}
 */
function scanGluedByRow(rows, opts) {
  const hits = scanGluedWords(rows, opts);
  const m = new Map();
  for (const h of hits) {
    if (!m.has(h.from)) m.set(h.from, []);
    m.get(h.from).push(h);
  }
  return m;
}

module.exports = {
  detectGluedWord,
  scanGluedWords,
  scanGluedByRow,
  loadWords,
  FUNC_PREFIX,
  _resetWords,
};
