/* 共享的"用户可见中文文案"扫描器（tools/copy_inventory.mjs 与 tools/copy_lint.mjs 共用）
 * 只扫用户能看到的字符串：index.html 的文本/title/placeholder/value、js/ps1/cjs 里的字符串字面量。
 * 代码注释不算（注释里的中文不参与文案审评）。
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const HAN = /[\u4e00-\u9fa5]/;

/** 把 JS 字面量源码里的转义还原成运行时的真实字符（`\\`→`\`、`\n`→换行、`\uXXXX`→字符…）。
 *  词典键必须按**运行时字符串**生成，否则 `asr\\runtime-python` 这种键永远匹配不到 DOM 里的真文本（踩过）。 */
export function unescapeJs(s) {
  return String(s).replace(/\\(x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|.)/g, (m, g) => {
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    if (g[0] === 'u') {
      return g[1] === '{'
        ? String.fromCodePoint(parseInt(g.slice(2, -1), 16))
        : String.fromCharCode(parseInt(g.slice(1), 16));
    }
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
    return map[g] != null ? map[g] : g;
  });
}

/**
 * 提取 JS 里的字符串字面量（单/双/反引号），并跳过注释。
 * **必须是状态机**：逐行扫会漏掉跨行的模板串（模型卡片那种整段 HTML 就是多行的，踩过）；
 * 整文件用正则又会跨行配对。这里按字符走，跟踪注释与引号，模板串允许换行。
 * 返回 [{ line（1 基起始行号）, text }]。（不解析正则字面量：极少数带引号的正则可能产出无用键，
 * 但会被「含中文 + 长度≥2」和 extractVisible 过滤掉，不会污染界面。）
 */
export function jsLiterals(src) {
  const out = [];
  const s = String(src);
  const n = s.length;
  let i = 0, line = 1, startLine = 1;
  const HANX = /[\u4e00-\u9fa5]/;
  while (i < n) {
    const ch = s[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      startLine = line;
      i++;
      let buf = '';
      while (i < n && s[i] !== q) {
        if (s[i] === '\\') { buf += s[i]; i++; if (i < n) { buf += s[i]; i++; } continue; }
        if (s[i] === '\n') { if (q !== '`') break; line++; }
        buf += s[i];
        i++;
      }
      i++;
      if (buf.length >= 2) {
        const real = unescapeJs(buf);          // 按运行时字符串进词典，转义已还原
        if (HANX.test(real)) out.push({ line: startLine, text: real });
      }
      continue;
    }
    i++;
  }
  return out;
}

/**
 * 从一段 JS 字符串字面量里提取**用户可见文本**：
 *  · `'删除'` → ['删除']
 *  · `'<button title="删除模型文件">删除</button>'` → ['删除模型文件', '删除']
 *  · 模板变量 `${x}` 归一成 ◇（词典键的占位符约定）
 * 带 HTML 的模板串不该整段进词典（那不是屏幕上的一段文字），所以要拆出来。
 */
export function extractVisible(raw) {
  const s = String(raw == null ? '' : raw);
  if (!HAN.test(s)) return [];
  const out = [];
  const push = (t) => {
    const v = String(t).replace(/\$\{[^}]*\}/g, '\u25C7').replace(/\s+/g, ' ').trim();
    // 残留的标签碎片（含 < 或 >）不是屏幕上的一段文字
    if (v && HAN.test(v) && v.length >= 2 && !/[<>]/.test(v)) out.push(v);
  };
  if (!/<\/?[a-zA-Z][^>]*>/.test(s)) { push(s); return out; }
  // 属性里的可见文案
  for (const m of s.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)) push(m[1]);
  // 标签之间的文本
  for (const piece of s.replace(/<[^>]*>/g, '\u0000').split('\u0000')) push(piece);
  return [...new Set(out)];
}

export function scanCopy(root) {
  const out = [];
  const seen = new Set();
  const add = (file, line, kind, text) => {
    const t = String(text).trim();
    if (!t || !HAN.test(t)) return;
    const key = file + '|' + kind + '|' + t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line, kind, text: t });
  };

  // index.html
  {
    const file = 'editor/index.html';
    let html = '';
    try { html = readFileSync(path.join(root, file), 'utf8'); } catch { return out; }
    html.split('\n').forEach((raw, i) => {
      for (const m of raw.matchAll(/>([^<>{}]*[\u4e00-\u9fa5][^<>{}]*)</g)) add(file, i + 1, 'text', m[1]);
      for (const m of raw.matchAll(/(title|placeholder)="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) add(file, i + 1, m[1], m[2]);
      for (const m of raw.matchAll(/\bvalue="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) add(file, i + 1, 'value', m[1]);
    });
  }

  const scanJs = (rel) => {
    let src = '';
    try { src = readFileSync(path.join(root, rel), 'utf8'); } catch { return; }
    for (const { line, text } of jsLiterals(src)) {
      const pieces = extractVisible(text);
      if (pieces.length) for (const p of pieces) add(rel, line, text.includes('<') ? 'html' : 'str', p);
      else add(rel, line, 'str', text);
    }
  };

  const jsDir = path.join(root, 'editor', 'js');
  try { for (const f of readdirSync(jsDir)) if (f.endsWith('.js')) scanJs('editor/js/' + f); } catch {}
  scanJs('editor/server.js');
  const scDir = path.join(root, 'editor', 'scripts');
  try {
    for (const f of readdirSync(scDir)) if (f.endsWith('.ps1') || f.endsWith('.cjs')) scanJs('editor/scripts/' + f);
  } catch {}
  return out;
}

/** 文案自检规则（来自"去 AI 味"专项评审）。white=true 表示只提示不强制。 */
export const RULES = [
  { id: 'dash', name: '破折号插入解释（现象 —— 解释）', re: /——/, advice: '拆成两句：先事实，再怎么办' },
  { id: 'market', name: '营销词/拟人', re: /一键|智能|轻松|高效|不仅|而且|即可|秒开|秒级|请耐心|无需|极速|挂了|认不到|自行退出|不用守着|可以先去做别的/, advice: '按钮用动词；只写事实与数字' },
  { id: 'polite', name: '客服腔（请…）', re: /请(先|到|在|确认|选择|注意|耐心|确保|运行|把|重新|填写|安装|打开|点击)/, advice: '改命令式或陈述式' },
  { id: 'dashAsk', name: '破折号+请求（最典型 AI 味）', re: /——\s*(请|建议|可|如需|否则)/, advice: '必改' },
  { id: 'parenWhy', name: '括号里写因果/解释', re: /[（(][^）)]*(因为|所以|否则|以免|说明|表示|下次|不影响|会自动)[^）)]*[）)]/, advice: '括号只放数字/单位/英文名/快捷键' },
  { id: 'halfPunct', name: '中文里混半角标点', re: /[\u4e00-\u9fa5]\s*[,;:!?]\s*[\u4e00-\u9fa5]/, advice: '用全角，或改句子结构' },
  { id: 'ellipsis', name: '省略号未用中文 …', re: /\.\.\./, advice: '统一用 …', white: true },
  { id: 'terms', name: '术语红线（转写/断句/词级/切片/去噪/草稿）', re: /转写|断句|词级|切片|去噪|草稿/, advice: '统一：识别 / 分句 / 逐词 / 降噪 / 初稿' },
  // 「导入」在"把已有字幕带进新项目"这一处是对的用法（导入已有字幕），只盯「载入」与其它地方的「导入」
  { id: 'io', name: '资源进入界面词不统一（载入 / 多余导入）', re: /载入|导入(?!与音频|已有字幕)/, advice: '按钮=打开；过程=加载中/加载失败；导入只用于"导入已有字幕"' },
  { id: 'logPrefix', name: '日志前缀自由发挥', re: /^\[(?!提示|错误|重试|分句|翻译|识别|波形|预热|模型|云端|GPU|CPU|ASR|NeMo|whisper|sherpa|bcut|capcut)[^\]]{1,10}\]/, advice: '统一前缀', white: true },
  { id: 'emoji', name: '文案里混入 emoji（界面图标应用 data-ico）', re: /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u, advice: '换成 SVG 图标', white: true },
];
