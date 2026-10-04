/**
 * ASS 字幕后处理特效管线（纯文本变换，零侵入编辑层）
 *
 * ── 设计要点（全部是实测出来的，改之前先看这几条）────────────────────
 *  1. **只在「已有事件」的文本里内联标签，绝不新增事件。**
 *     叠加事件（底层发光事件 + 原文抬 Layer+1）会被 libass 的碰撞避让重排 ——
 *     collision 是「按 Layer 分组」的，原文抬层后脱离原碰撞组、不再被避让，
 *     于是回落到自然位置与另一条字幕叠压。实测：两行字幕互相穿插。
 *
 *  2. **绝不动 `\bord`。**
 *     libass 算行布局时把描边算进包围盒，改 `\bord` 会让**整行**（含没发光的字）
 *     一起位移。实测 `\bord3 → \bord6`：活动词之外的 "Randomly," 区域也有 3378 px
 *     差异、整行填充上移 3px。所以光晕大小只能靠 `\blur` 调，不能靠加粗描边。
 *
 *  3. 发光只走 `\3c/\3a`（描边通道）与 `\4c/\4a`（阴影通道）+ `\blur`。
 *     `\blur` 只糊描边/阴影，字形填充保持清晰。
 *     实测这三条路都「差异只覆盖活动词」，零偏位。
 *
 *  4. 收尾一律用**无参复位** `\3c\3a\4c\4a\blur` —— libass 会恢复样式里的值，
 *     所以不必解析 [V4+ Styles]。实测无参复位与显式写回样式值的结果逐像素一致。
 *
 *  5. `\xshad0\yshad0` 时 libass 不画阴影（拿不到零偏移阴影），要居中光晕得写
 *     极小偏移 `\xshad0.1\yshad0.1`。样式自带 Shadow 时不改偏移也够用。
 *
 * ── 作用范围与分语言参数 ────────────────────────────────────────────
 *  target: 'zh' 只给中文字幕行发光 / 'en' 只给英文字幕行发光 /
 *          'all' 中英各用自己的参数整行发光 / 'active_word' 只给逐词高亮词发光。
 *  中英文各自的颜色、通道、半径、强度完全独立（glow.zh / glow.en）。
 *  「哪一行是中文/英文」靠 [V4+ Styles] 的样式名推断；调用方若能拿到更准的
 *  结果（编辑器里的 resolveAssStyleTargets 会结合逐词分析），可通过第三个参数传入。
 */

export const DEFAULT_POSTPROCESS_CONFIG = {
  enabled: false,             // 总开关
  glow: {
    enabled: true,            // 微光分开关
    target: 'active_word',    // 生效范围: 'zh' | 'en' | 'all' | 'active_word'
    zh: {                     // 中文字幕行的微光参数
      enabled: true,
      channel: 'shadow',      // 'shadow'(保留黑描边) | 'outline'(顶替描边) | 'both'(最强)
      color: '#00ff88',       // 微光颜色 (Hex RGB)
      radius: 4.0,            // 光晕半径 → \blur (0.5 ~ 20)
      intensity: 100          // 发光强度 → 发光色不透明度 0~100 (%)
    },
    en: {                     // 英文字幕行的微光参数
      enabled: true,
      channel: 'shadow',
      color: '#00ff88',
      radius: 4.0,
      intensity: 100
    }
  }
};

const STORAGE_KEY = 'subfabric_postprocess_config';

const GLOW_CHANNELS = ['shadow', 'outline', 'both'];
const GLOW_TARGETS = ['zh', 'en', 'all', 'active_word'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/** 归一化单个语言参数块 */
function normBlock(src, fallback) {
  const s = src || {};
  const fb = fallback || {};
  const pick = (k) => (s[k] !== undefined ? s[k] : fb[k]);
  const radiusRaw = num(pick('radius'), NaN);
  const legacyBlur = num(s.blur !== undefined ? s.blur : fb.blur, NaN);   // 旧字段 blur（可能在块内，也可能在扁平的 glow 上）
  return {
    enabled: s.enabled !== undefined ? s.enabled !== false : (fb.enabled !== false),
    channel: GLOW_CHANNELS.includes(pick('channel')) ? pick('channel') : 'shadow',
    color: (typeof pick('color') === 'string' && /^#?[0-9a-fA-F]{6}$/.test(String(pick('color')).trim()))
      ? (String(pick('color')).trim().startsWith('#') ? String(pick('color')).trim() : '#' + String(pick('color')).trim())
      : '#00ff88',
    radius: clamp(isFinite(radiusRaw) ? radiusRaw : (isFinite(legacyBlur) ? legacyBlur : 4.0), 0.1, 40),
    intensity: clamp(num(pick('intensity'), 100), 0, 100)
  };
}

/**
 * 深拷贝 / 归一化配置对象。
 * 兼容两代旧存档：① 只有 `blur` 没有 `radius`/`intensity`；② 扁平结构
 * （channel/color/radius/intensity 直接挂在 glow 上，没有 zh/en 分组）。
 */
export function cloneConfig(cfg) {
  if (!cfg) return JSON.parse(JSON.stringify(DEFAULT_POSTPROCESS_CONFIG));
  const g = cfg.glow || {};
  const flat = {
    enabled: g.enabled,
    channel: g.channel,
    color: g.color,
    radius: g.radius,
    intensity: g.intensity,
    blur: g.blur
  };
  const hasFlat = !g.zh && !g.en
    && (g.color !== undefined || g.radius !== undefined || g.blur !== undefined || g.channel !== undefined);
  const zh = normBlock(g.zh, hasFlat ? flat : DEFAULT_POSTPROCESS_CONFIG.glow.zh);
  const en = normBlock(g.en, hasFlat ? flat : DEFAULT_POSTPROCESS_CONFIG.glow.en);
  return {
    enabled: !!cfg.enabled,
    glow: {
      enabled: g.enabled !== false,
      target: GLOW_TARGETS.includes(g.target) ? g.target : (g.target === 'all' ? 'all' : 'active_word'),
      zh,
      en
    }
  };
}

/** 从本地存储读取后处理配置 */
export function loadPostProcessConfig() {
  if (typeof localStorage === 'undefined') return cloneConfig(DEFAULT_POSTPROCESS_CONFIG);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneConfig(DEFAULT_POSTPROCESS_CONFIG);
    return cloneConfig(JSON.parse(raw));
  } catch {
    return cloneConfig(DEFAULT_POSTPROCESS_CONFIG);
  }
}

/** 保存后处理配置到本地存储 */
export function savePostProcessConfig(cfg) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* 忽略存储满或被禁用的异常 */
  }
}

/** Hex RGB ('#RRGGBB' / 'RRGGBB') 转 ASS BGR ('BBGGRR') */
export function hexToAssBgr(hex) {
  const clean = String(hex || '').replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '88FF00'; // 缺省微光浅绿
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return (b + g + r).toUpperCase();
}

/** ASS BGR ('BBGGRR' / '&HBBGGRR&') 转 Hex RGB ('#RRGGBB') */
export function assBgrToHex(bgr) {
  const clean = String(bgr || '').replace(/^&*[Hh]*/, '').replace(/&+$/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '#00ff88';
  const b = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const r = clean.slice(4, 6);
  return ('#' + r + g + b).toLowerCase();
}

/** 发光强度(%) → ASS alpha（00 不透明 … FF 全透明） */
export function intensityToAssAlpha(intensity) {
  const a = Math.round((100 - clamp(num(intensity, 100), 0, 100)) / 100 * 255);
  return a.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * 从 ASS 文本的 [V4+ Styles] 推断「哪条样式是中文、哪条是英文」。
 * 规则与编辑器的 resolveAssStyleTargets 保持一致（只是拿不到逐词分析里的
 * wordStyle，所以少一条线索）。识别不出就返回 null，调用方据此走兜底。
 * @returns {{zh:string, en:string}|null}
 */
export function resolveStyleTargets(assText) {
  if (typeof assText !== 'string') return null;
  const names = [];
  let inStyles = false;
  for (const line of assText.split(/\r\n|\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) { inStyles = sec[1].trim().toLowerCase() === 'v4+ styles' || sec[1].trim().toLowerCase() === 'v4 styles' || sec[1].trim().toLowerCase() === 'styles'; continue; }
    if (!inStyles) continue;
    const m = /^\s*Style\s*:\s*([^,]+),/.exec(line);
    if (m) names.push(m[1].trim());
  }
  const uniq = names.filter((n, i, all) => all.findIndex(x => x.toLowerCase() === n.toLowerCase()) === i);
  if (uniq.length < 2) return null;
  const has = (n) => n && uniq.some(x => x.toLowerCase() === n.toLowerCase());
  let en = uniq.find(n => /^(default|english|en|eng|英文)$/i.test(n))
    || uniq.find(n => /english|英文|(^|[-_])en([-_]|$)/i.test(n)) || '';
  let zh = uniq.find(n => n.toLowerCase() !== String(en).toLowerCase()
    && /chinese|中文|mandarin|(^|[-_])zh([-_]|$)|^(cn|chi)$/i.test(n)) || '';
  if (!en && zh) en = uniq.find(n => n.toLowerCase() !== zh.toLowerCase()) || '';
  if (!zh && en) zh = uniq.find(n => n.toLowerCase() !== en.toLowerCase()) || '';
  if (!en || !zh || en.toLowerCase() === zh.toLowerCase()) return null;
  return { zh, en };
}

/**
 * 逐词高亮 span：`{\c&H......&}word{\c}`（karaoke.js 的固定产物，也兼容 \1c）。
 * 开/闭标签的**内部命令原样捕获**，这样注入发光时能保住活动词原本的高亮色 ——
 * 直接整段替换会把 `\c&H00FF00&` 一起吃掉，活动词就变回样式白字了。
 */
const HL_SPAN_SRC = '\\{((?:\\\\[1]?c&H[0-9A-Fa-f]{6}&)+)\\}([^{}]+?)\\{(?:\\\\[1]?c)+\\}';
const HL_SPAN_TEST = new RegExp(HL_SPAN_SRC);
const HL_SPAN_ALL = new RegExp(HL_SPAN_SRC, 'g');

/** 行首覆盖标签块（{\...}{\...}…），用于「整行发光」时把标签插在它后面 */
const LEADING_TAGS_RE = /^(?:\s*\{[^}]*\})+/;

/** 拼装发光起始标签的命令串 */
function glowOpenCommands(channel, bgr, alpha, radius) {
  const outline = `\\3c&H${bgr}&\\3a&H${alpha}&`;
  const shadow = `\\4c&H${bgr}&\\4a&H${alpha}&`;
  let cmd = '';
  if (channel === 'outline' || channel === 'both') cmd += outline;
  if (channel === 'shadow' || channel === 'both') cmd += shadow;
  return cmd + `\\blur${radius}`;
}

/** 拼装发光收尾（无参复位，libass 会恢复样式值） */
function glowResetCommands(channel) {
  let cmd = '';
  if (channel === 'outline' || channel === 'both') cmd += '\\3c\\3a';
  if (channel === 'shadow' || channel === 'both') cmd += '\\4c\\4a';
  return cmd + '\\blur';
}

/** 由参数块构造 { openCmd, closeCmd } */
function buildGlowTags(block) {
  const bgr = hexToAssBgr(block.color);
  const alpha = intensityToAssAlpha(block.intensity);
  const radius = clamp(num(block.radius, 4.0), 0.1, 40).toFixed(1);
  return {
    openCmd: glowOpenCommands(block.channel, bgr, alpha, radius),
    closeCmd: glowResetCommands(block.channel)
  };
}

/** 只给逐词高亮词发光：把发光命令并进原有的开/闭标签里 */
function glowActiveWords(text, openCmd, closeCmd) {
  if (!HL_SPAN_TEST.test(text)) return null;
  HL_SPAN_ALL.lastIndex = 0;
  return text.replace(HL_SPAN_ALL,
    (m, openInner, word) => `{${openInner}${openCmd}}${word}{\\c${closeCmd}}`);
}

/** 整行发光：把发光标签插在行首覆盖标签之后，不闭合（作用到行尾） */
function glowWholeLine(text, openCmd) {
  const plain = text.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/gi, '').trim();
  if (!plain) return null;                          // 空行不发光
  const lead = LEADING_TAGS_RE.exec(text);
  const at = lead ? lead[0].length : 0;
  return text.slice(0, at) + `{${openCmd}}` + text.slice(at);
}

/**
 * 应用后处理特效核心纯函数。
 * @param {string} assText - 原始 ASS 完整文本
 * @param {object} config  - 后处理配置对象
 * @param {{zh:string,en:string}|null} [styleTargets] - 可选：调用方已解析好的中英样式名
 * @returns {string} 处理后的 ASS 文本；关闭时**原样返回**（逐字节一致）
 */
export function applyPostProcess(assText, config, styleTargets) {
  if (typeof assText !== 'string' || !assText) return '';
  if (!config || !config.enabled) return assText;   // 关闭 → 原样直通，零开销

  const glow = config.glow;
  if (!glow || !glow.enabled) return assText;

  const target = GLOW_TARGETS.includes(glow.target) ? glow.target : 'active_word';
  const zhBlock = glow.zh || DEFAULT_POSTPROCESS_CONFIG.glow.zh;
  const enBlock = glow.en || DEFAULT_POSTPROCESS_CONFIG.glow.en;
  if (target !== 'active_word' && zhBlock.enabled === false && enBlock.enabled === false) return assText;

  const tags = {
    zh: zhBlock.enabled === false ? null : buildGlowTags(zhBlock),
    en: enBlock.enabled === false ? null : buildGlowTags(enBlock)
  };
  if (target === 'active_word' && !tags.en) return assText;   // 逐词用英文参数块

  const targets = styleTargets || resolveStyleTargets(assText);
  const isZh = (style) => !!targets && String(style).toLowerCase() === targets.zh.toLowerCase();
  const isEn = (style) => !!targets && String(style).toLowerCase() === targets.en.toLowerCase();

  const lines = assText.split(/\r\n|\n/);
  const outputLines = new Array(lines.length);

  let inEvents = false;
  let formatCols = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const secMatch = /^\s*\[(.+)\]\s*$/.exec(line);
    if (secMatch) {
      inEvents = secMatch[1].trim().toLowerCase() === 'events';
      formatCols = null;
      outputLines[i] = line;
      continue;
    }

    if (!inEvents) { outputLines[i] = line; continue; }

    const fmtMatch = /^\s*Format\s*:\s*(.+)$/i.exec(line);
    if (fmtMatch) {
      formatCols = fmtMatch[1].split(',').map(s => s.trim().toLowerCase());
      outputLines[i] = line;
      continue;
    }

    const dm = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line);
    if (!dm || !formatCols) { outputLines[i] = line; continue; }

    // 按 Format 列切分（Text 是最后一列，里面的逗号属于正文）
    const parts = [];
    let s = dm[1];
    for (let k = 0; k < formatCols.length - 1; k++) {
      const idx = s.indexOf(',');
      if (idx === -1) break;
      parts.push(s.slice(0, idx).trim());
      s = s.slice(idx + 1);
    }
    parts.push(s);

    const textColIdx = formatCols.indexOf('text');
    const styleColIdx = formatCols.indexOf('style');
    const textIdx = textColIdx === -1 ? parts.length - 1 : textColIdx;
    const style = styleColIdx === -1 ? '' : parts[styleColIdx];
    const rawText = parts[textIdx] || '';

    let newText = null;

    if (target === 'active_word') {
      // 只给逐词高亮词发光（用英文参数块；中文整句行没有高亮 span，自然不动）
      newText = glowActiveWords(rawText, tags.en.openCmd, tags.en.closeCmd);
    } else {
      // 整行发光：按「生效范围」挑语言，再挑该语言的参数块
      let block = null;
      if (target === 'zh') block = isZh(style) ? tags.zh : null;
      else if (target === 'en') block = isEn(style) ? tags.en : null;
      else { // all
        if (isZh(style)) block = tags.zh;
        else if (isEn(style)) block = tags.en;
        else if (!targets) block = tags.en;   // 样式识别不出来时兜底：整篇按英文参数发光
      }
      if (block) newText = glowWholeLine(rawText, block.openCmd);
    }

    if (newText == null) { outputLines[i] = line; continue; }   // 原样保留，不做任何重写

    const outParts = parts.slice();
    outParts[textIdx] = newText;
    outputLines[i] = 'Dialogue: ' + outParts.join(',');
  }

  return outputLines.join('\r\n');
}
