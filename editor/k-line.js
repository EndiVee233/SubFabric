/**
 * \k 卡拉OK初稿的行文本构造（CommonJS —— 供 editor/server.js 在生成初稿时使用）。
 *
 * 为什么单独一个模块：server.js 是 CJS，不能直接 require ESM 的 editor/js/karaoke.js；
 * 而这段格式逻辑又值得单测（生成端产出的每一行都要能被编辑器无损打开）。
 *
 * 与 karaoke.js buildWordSpecsK 的关系：**同一格式、两个场景** ——
 *   · 这里管"初稿生成"：识别词表没有空档（每词亮到下一词起点、末词收在句尾），
 *     所以没有空档 filler / 明文交错那些复杂度；
 *   · 编辑器那边管"打开后的任何重建"，必须原样保真外来文件的分段与空格布局。
 * 两边格式若不一致，编辑器打开初稿就会判成漂移 —— tests/karaoke-k-test.mjs 里有交叉一致性断言。
 *
 * \k 语义（Aegisub 文档）：时长单位**厘秒**；唱到之前显示 \2c（SecondaryColour），
 * 唱到瞬间切 \1c（PrimaryColour）。
 */
'use strict';

/** 用户文本 → ASS 安全文本：花括号/反斜杠会被 libass 当覆盖标签解析，必须转义
 *  （与 server.js 里颜色切片用的同一套规则）。 */
const escAss = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

/**
 * 一条 \k 卡拉OK行的**文本字段**（不含 "Dialogue: 0,<start>,<end>,Default,<name>,0,0,0,," 前缀）。
 *
 * @param words 识别词表 [{word, start, end}]（秒；end 仅供兜底，段时长按"下一词起点"算）
 * @param start/end 句子起止（秒）—— 首词贴句首、末词收在句尾，与颜色切片同一夹取规则
 * @param sungBgr 已唱位 \1c 的 BBGGRR（逐词高亮色）
 * @param baseBgr 未唱位 \2c 的 BBGGRR（该行有角色 = 角色色；没有 = 「未唱默认色」；空串 = 不写 \2c）
 * @returns 形如 `{\1c&H00FF00&\2c&HFFFFFF&}{\k40}hello {\k60}world{\k100}` 的文本
 */
function wordKText(words, start, end, sungBgr, baseBgr) {
  const startCs = Math.round(start * 100);
  const endCs = Math.max(startCs + 1, Math.round(end * 100));
  let txt = '{\\1c&H' + sungBgr + '&' + (baseBgr ? '\\2c&H' + baseBgr + '&' : '') + '}';
  let cursor = startCs;
  for (let k = 0; k < words.length; k++) {
    // 与颜色切片同一条夹取规则：首词贴句首、每词收在下一词起点、末词收在句尾、时长至少 1cs；
    // 起点同时不越过上一段的终点（单调），保证段时长恒正、总和严格 = 行时长
    let sCs = Math.max(cursor, Math.min(endCs - 1, Math.round(words[k].start * 100)));
    if (sCs >= endCs) sCs = Math.max(startCs, endCs - 1);
    let eCs = Math.max(sCs + 1, Math.min(endCs,
      Math.round((k + 1 < words.length ? words[k + 1].start : end) * 100)));
    if (eCs <= sCs) eCs = Math.min(endCs, sCs + 1);
    txt += '{\\k' + (eCs - sCs) + '}' + escAss(words[k].word) + (k + 1 < words.length ? ' ' : '');
    cursor = eCs;
  }
  if (cursor < endCs) txt += '{\\k' + (endCs - cursor) + '}';   // 行尾兜底（保持段总和 = 行时长）
  return txt;
}

module.exports = { wordKText, escAss };
