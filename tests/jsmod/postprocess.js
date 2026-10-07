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
 * ── ★★ 绝不要用 `\t()` 做动画（最贵的教训，附 libass 源码证据）★★ ──────
 *  6. **任何 `\t()` 都会让事件彻底退出 libass 的碰撞避让。**
 *     libass 源码 `ass_parse.c` 的 `complex_tag("t")` 分支里无条件写着：
 *         state->detect_collisions = 0;      // ass_parse.c:694
 *     而 `ass_render.c` 的 fix_collisions() 两处都有
 *         if (!imgs[i].detect_collisions || ...) continue;   // :3216 / :3255
 *     —— 该事件既不算「阻挡物」也不算「待避让物」，等于从避让里消失。
 *
 *     这是 libass 对齐 VSFilter 的**刻意设计**：变换动画的尺寸随时间变化，
 *     给不出稳定包围盒，索性不参与避让。
 *
 *     实测（ffmpeg + libass 渲染、逐行扫像素带，1280×720，中英双行同 MarginV）：
 *       - 无特效                  → 3 条文字带  ✓
 *       - 纯微光 `\blur`           → 3 条文字带  ✓
 *       - **静态** `\fscx\fscy`    → 3 条文字带  ✓
 *       - 带动画 `\t()`           → 2 条文字带  ✗ 中文行与英文行叠压
 *       - `\t(0,240,\fscx100\fscy100)`（空转、零视觉变化）→ 2 条  ✗
 *       - `\t(0,240,\1a&H00&)`（纯 alpha、不碰几何）        → 2 条  ✗
 *     结论：**触发条件是 `\t` 这个标签本身，与它内部动画什么属性无关。**
 *     所以「先小后大」这类真·动画生长，在多行字幕上是做不到的。
 *
 *  7. 好消息：`\fad` / `\fade` / `\k` **不**设 detect_collisions=0
 *     （不在 ass_parse.c 那 6 处赋值里），是碰撞安全的。实测 `\fad(300,0)`
 *     与 `\k100` 都保持 3 条文字带。
 *     所以「柔和淡入」用 `\fade` 实现 —— 效果与原 `\t` 版一致，且不破坏避让。
 *
 *  8. **时长必须钳到事件自身长度内**（ratio 参数）。否则一个 80ms 的短行配 300ms
 *     的淡入，动画会在字幕早就消失后才结束 —— 视觉上就是「没淡进来就没了」。
 *     所以按 `min(配置时长, 事件时长 × ratio%)` 取值。
 *
 *  9. 于是「词生长」改成**静态放大**：给活动词加静态 `\fscx\fscy`，
 *     逐词事件切换时高亮词自然「跳」过去，观感接近逐词强调，且完全碰撞安全。
 *     放大倍数不宜过大（默认 130%）：`\fscx/\fscy` 会改变该词占宽，
 *     放大太多可能让整行重新折行。
 *
 * 10. `\fade` 是**事件级**标签（libass 里落在 `state->fade`，与 span 无关），
 *     所以「柔和淡入」只能整行生效，无法只淡入某个词 —— 生效范围因此只有
 *     中文 / 英文 / 全部三档。要只淡入活动词就得用 `\t`，而那是要点 6 的禁区。
 *
 * ── 作用范围与分语言参数 ────────────────────────────────────────────
 *  target: 'zh' 只给中文字幕行 / 'en' 只给英文字幕行 /
 *          'all' 中英各用自己的参数 / 'active_word' 只给逐词高亮词（仅微光/生长）。
 *  微光（glow）中英文各自的颜色、通道、半径、强度完全独立（glow.zh / glow.en）。
 *  词生长（grow）与柔和淡入（fadein）只用几何/时间参数、没有颜色分歧，
 *  因此共用**单个参数块** + 一个 target 选择器，避免 UI 爆炸。
 *  「哪一行是中文/英文」靠 [V4+ Styles] 的样式名推断；调用方若能拿到更准的
 *  结果（编辑器里的 resolveAssStyleTargets 会结合逐词分析），可通过第三个参数传入。
 */

export const DEFAULT_POSTPROCESS_CONFIG = {
  enabled: false,             // 总开关
  glow: {
    enabled: true,            // 微光分开关
    target: 'active_word',    // 生效范围: 'zh' | 'en' | 'all' | 'active_word'
    zh: {                // 中文字幕行的微光参数
      enabled: true,
      channel: 'shadow',      // 'shadow'(保留黑描边) | 'outline'(顶替描边) | 'both'(最强)
      color: '#00ff88',       // 微光颜色 (Hex RGB)
      radius: 4.0,            // 光晕半径 → \blur (0.5 ~ 20)
      intensity: 100// 发光强度 → 发光色不透明度 0~100 (%)
    },
    en: {                     // 英文字幕行的微光参数
      enabled: true,
      channel: 'shadow',
      color: '#00ff88',
      radius: 4.0,
      intensity: 100
    }
  },
  grow: {                     // 词生长：把逐词高亮的活动词放大一圈（静态，碰撞安全）
    enabled: false,
    scale: 130                // 放大到原字号的百分之多少 (100~250)
  },
  fadein: {                   // 柔和淡入：整行从较淡渐显到完全清晰（用 \fade，碰撞安全）
    enabled: false,
    target: 'zh',             // 整行效果，仅三档: 'zh' | 'en' | 'all'
    from: 55,                 // 起始不透明度 (%)，100 = 等于不淡入
    duration: 300,            // 淡入时长 (ms)
    ratio: 70                 // 时长上限 = 事件自身时长 × 此比例 (%)
  }
};

const STORAGE_KEY = 'subfabric_postprocess_config';

const GLOW_CHANNELS = ['shadow', 'outline', 'both'];
const GLOW_TARGETS = ['zh', 'en', 'all', 'active_word'];
const FADE_TARGETS = ['zh', 'en', 'all'];
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

const normTarget = (v, fallback) => (GLOW_TARGETS.includes(v) ? v : fallback);

/**
 * 归一化词生长参数块。
 * 旧存档语义是「起始缩放」（恒 <100，配 `\t` 长到 100%）；新语义是「放大倍数」
 * （恒 ≥100）。见到 <100 的旧值一律换成新默认，免得老用户升级后得到「反而变小」。
 */
function normGrow(src, fallback) {
  const s = src || {};
  const fb = fallback || {};
  const raw = num(s.scale !== undefined ? s.scale : fb.scale, fb.scale);
  const scale = raw < 100 ? fb.scale : clamp(Math.round(raw), 100, 250);
  return {
    enabled: s.enabled === true,
    scale
  };
}

/** 归一化柔和淡入参数块 */
function normFadeIn(src, fallback) {
  const s = src || {};
  const fb = fallback || {};
  const pick = (k) => (s[k] !== undefined ? s[k] : fb[k]);
  const t = pick('target');
  return {
    enabled: s.enabled === true,
    // \fade 是事件级标签，无法只作用于某个词 → active_word 落回整行（默认中文轨）
    target: FADE_TARGETS.includes(t) ? t : 'zh',
    from: clamp(Math.round(num(pick('from'), fb.from)), 0, 100),
    duration: clamp(Math.round(num(pick('duration'), fb.duration)), 20, 3000),
    ratio: clamp(Math.round(num(pick('ratio'), fb.ratio)), 5, 100)
  };
}

/**
 * 深拷贝 / 归一化配置对象。
 * 兼容两代旧存档：① 只有 `blur` 没有 `radius`/`intensity`；② 扁平结构
 * （channel/color/radius/intensity 直接挂在 glow 上，没有 zh/en 分组）。
 * grow / fadein 是后加的，老存档里根本没有这两个键 → 走默认值且默认关闭，
 * 所以老用户升级后画面不会突然多出特效。
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
    },
    grow: normGrow(cfg.grow, DEFAULT_POSTPROCESS_CONFIG.grow),
    fadein: normFadeIn(cfg.fadein, DEFAULT_POSTPROCESS_CONFIG.fadein)
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

/** 发光强度(%) / 起始不透明度(%) → ASS alpha（00 不透明… FF 全透明） */
export function intensityToAssAlpha(intensity) {
  const a = Math.round((100 - clamp(num(intensity, 100), 0, 100)) / 100 * 255);
  return a.toString(16).toUpperCase().padStart(2, '0');
}

/** 同一映射的十进制形式 —— `\fade` 的 alpha 参数要写十进制整数 */
export function opacityToAlphaValue(pct) {
  return Math.round((100 - clamp(num(pct, 100), 0, 100)) / 100 * 255);
}

/**
 * ASS 时间码 ('H:MM:SS.cc' / 'H:MM:SS:cc'，也兼容无小时位) → 毫秒。
 * 解析失败返回 null（调用方据此放弃钳制，而不是当成 0 把动画压没）。
 */
export function assTimeToMs(t) {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\s*$/.exec(String(t == null ? '' : t));
  if (!m) return null;
  const fracRaw = m[4] == null ? '' : m[4];
  const frac = fracRaw === '' ? 0
    : fracRaw.length <= 2 ? Number(fracRaw.padEnd(2, '0')) / 100
      : Number(fracRaw) / Math.pow(10, fracRaw.length);
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + frac * 1000;
}

/**
 * 动画时长钳制：取 min(配置时长, 事件时长 × ratio%)，下限 1ms。
 * @param {number} cfgMs - 配置里写的时长
 * @param {number|null} evMs - 事件自身时长（毫秒），null/非法时只用配置值
 * @param {number} ratioPct - 允许吃掉事件时长的百分比
 */
export function resolveAnimDuration(cfgMs, evMs, ratioPct) {
  let d = clamp(Math.round(num(cfgMs, 250)), 1, 5000);
  const ev = num(evMs, NaN);
  if (isFinite(ev) && ev > 0) {
    d = Math.min(d, Math.max(1, Math.round(ev * clamp(num(ratioPct, 80), 5, 100) / 100)));
  }
  return Math.max(1, d);
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
 * 开/闭标签的**内部命令原样捕获**，这样注入特效时能保住活动词原本的高亮色 ——
 * 直接整段替换会把 `\c&H00FF00&` 一起吃掉，活动词就变回样式白字了。
 */
const HL_SPAN_SRC = '\\{((?:\\\\[1]?c&H[0-9A-Fa-f]{6}&)+)\\}([^{}]+?)\\{(?:\\\\[1]?c)+\\}';
const HL_SPAN_TEST = new RegExp(HL_SPAN_SRC);
const HL_SPAN_ALL = new RegExp(HL_SPAN_SRC, 'g');

/** 行首覆盖标签块（{\...}{\...}…），用于「整行特效」时把标签插在它后面 */
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

/**
 * 构造词生长标签 —— **静态** `\fscx\fscy`，绝不用 `\t()`（见文件头要点 6）。
 * @returns {{openCmd:string, closeCmd:string}|null} 100%（不放大）时返回 null
 */
function buildGrowTags(block) {
  const scale = clamp(Math.round(num(block.scale, 130)), 100, 250);
  if (scale === 100) return null;
  return { openCmd: `\\fscx${scale}\\fscy${scale}`, closeCmd: '\\fscx\\fscy' };
}

/**
 * 柔和淡入：用 `\fade` 把透明度从 from% 渐显到完全不透明。
 * `\fade(a1,a2,a3,t1,t2,t3,t4)` 语义（libass ass_parse.c:622）：
 *   t1→t2 由 a1 插值到 a2；之后保持 a3。
 * 取 a1=起始不透明度、a2=a3=0（完全不透明）、t2=t3=t4=dur，即「只淡入、淡完不动」。
 * alpha 参数是**十进制整数**（不是 &H..& 形式），所以这里用 opacityToAlphaValue。
 * @returns {string|null} 起始已完全不透明时返回 null
 */
function buildFadeInCommands(block, evMs) {
  const from = clamp(Math.round(num(block.from, 55)), 0, 100);
  if (from >= 100) return null;
  const dur = resolveAnimDuration(block.duration, evMs, block.ratio);
  const a1 = opacityToAlphaValue(from);
  return `\\fade(${a1},0,0,0,${dur},${dur},${dur})`;
}

/**
 * 只给逐词高亮词加特效：把命令并进原有的开/闭标签里。
 * 闭标签保留前导 `\c`（无参复位回样式色），与微光收尾拼接后依然逐像素一致。
 */
function applyActiveWordTags(text, openCmd, closeCmd) {
  if (!openCmd) return null;
  if (!HL_SPAN_TEST.test(text)) return null;
  HL_SPAN_ALL.lastIndex = 0;
  return text.replace(HL_SPAN_ALL,
    (m, openInner, word) => `{${openInner}${openCmd}}${word}{\\c${closeCmd}}`);
}

/** 整行特效：把标签插在行首覆盖标签之后，不闭合（作用到行尾） */
function applyLineTags(text, openCmd) {
  if (!openCmd) return null;
  const plain = text.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/gi, '').trim();
  if (!plain) return null;                          // 空行不处理
  const lead = LEADING_TAGS_RE.exec(text);
  const at = lead ? lead[0].length : 0;
  return text.slice(0, at) + `{${openCmd}}` + text.slice(at);
}

/** 这个生效范围下，该样式行是否命中整行类特效 */
function lineScopeHit(effTarget, isZh, isEn, hasTargets) {
  if (effTarget === 'all') return hasTargets ? (isZh || isEn) : true;  // 认不出语言时整篇都算命中
  if (effTarget === 'zh') return isZh;
  if (effTarget === 'en') return isEn;
  return false;
}

/**
 * 应用后处理特效核心纯函数。
 * 逐事件跑一遍「多 pass 管线」：
 *   ① 逐词 pass —— 微光（target=active_word 时）与词生长，只动高亮 span；
 *   ② 整行 pass —— 微光（整行范围）与柔和淡入，插在行首标签之后。
 * 两个 pass **互不排斥**：同一行可以既给活动词加标签、又在行首加淡入。
 * @param {string} assText - 原始 ASS 完整文本
 * @param {object} config  - 后处理配置对象
 * @param {{zh:string,en:string}|null} [styleTargets] - 可选：调用方已解析好的中英样式名
 * @returns {string} 处理后的 ASS 文本；关闭时**原样返回**（逐字节一致）
 */
export function applyPostProcess(assText, config, styleTargets) {
  if (typeof assText !== 'string' || !assText) return '';
  if (!config || !config.enabled) return assText;   // 关闭 → 原样直通，零开销

  const glow = config.glow;
  const grow = config.grow;
  const fadein = config.fadein;
  const glowOn = !!glow && glow.enabled !== false;
  const growOn = !!grow && grow.enabled === true;
  const fadeOn = !!fadein && fadein.enabled === true;
  if (!glowOn && !growOn && !fadeOn) return assText;

  const glowTarget = glowOn ? normTarget(glow.target, 'active_word') : null;
  const zhBlock = (glow && glow.zh) || DEFAULT_POSTPROCESS_CONFIG.glow.zh;
  const enBlock = (glow && glow.en) || DEFAULT_POSTPROCESS_CONFIG.glow.en;
  const glowTags = {
    zh: !glowOn || zhBlock.enabled === false ? null : buildGlowTags(zhBlock),
    en: !glowOn || enBlock.enabled === false ? null : buildGlowTags(enBlock)
  };
  const growTags = growOn ? buildGrowTags(grow) : null;

  // 只有微光生效时，若它自己无事可做才能整体直通（保住要点1 的零改动语义）
  if (glowOn && !growOn && !fadeOn) {
    if (glowTarget !== 'active_word' && zhBlock.enabled === false && enBlock.enabled === false) return assText;
    if (glowTarget === 'active_word' && !glowTags.en) return assText;
  }

  const targets = styleTargets || resolveStyleTargets(assText);
  const isZh = (style) => !!targets && String(style).toLowerCase() === targets.zh.toLowerCase();
  const isEn = (style) => !!targets && String(style).toLowerCase() === targets.en.toLowerCase();

  const lines = assText.split(/\r\n|\n/);
  const outputLines = new Array(lines.length);

  let inEvents = false;
  let formatCols = null;
  let startIdx = -1;
  let endIdx = -1;
  const needDur = fadeOn;              // 只有淡入需要事件时长（生长是静态的，不关心时长）
  let changedAny = false;              // 全篇一个字节都没改动时，原样返回入参（连换行符都不规范化）

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
      startIdx = formatCols.indexOf('start');
      endIdx = formatCols.indexOf('end');
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

    // 淡入时长要按事件自身长度钳制。只在需要时才解析时间，省掉纯微光时的开销。
    let evMs = null;
    if (needDur && startIdx !== -1 && endIdx !== -1) {
      const a = assTimeToMs(parts[startIdx]);
      const b = assTimeToMs(parts[endIdx]);
      if (a != null && b != null && b > a) evMs = b - a;
    }

    let text = rawText;

    // ── ① 逐词 pass：微光(仅活动词) + 词生长，命令合并进同一个覆盖块 ──
    const wordOpens = [];
    const wordCloses = [];
    if (glowTarget === 'active_word' && glowTags.en) {
      wordOpens.push(glowTags.en.openCmd);
      wordCloses.push(glowTags.en.closeCmd);
    }
    if (growTags) {
      wordOpens.push(growTags.openCmd);
      wordCloses.push(growTags.closeCmd);
    }
    if (wordOpens.length) {
      const w = applyActiveWordTags(text, wordOpens.join(''), wordCloses.join(''));
      if (w != null) text = w;
    }

    // ── ② 整行 pass：微光(整行范围) + 柔和淡入 ──
    const lineCmds = [];
    if (glowOn && glowTarget !== 'active_word') {
      let block = null;
      if (glowTarget === 'zh') block = isZh(style) ? glowTags.zh : null;
      else if (glowTarget === 'en') block = isEn(style) ? glowTags.en : null;
      else { // all
        if (isZh(style)) block = glowTags.zh;
        else if (isEn(style)) block = glowTags.en;
        else if (!targets) block = glowTags.en;   // 样式识别不出来时兜底：整篇按英文参数发光
      }
      if (block) lineCmds.push(block.openCmd);
    }
    if (fadeOn && lineScopeHit(fadein.target, isZh(style), isEn(style), !!targets)) {
      const fc = buildFadeInCommands(fadein, evMs);
      if (fc) lineCmds.push(fc);
    }
    if (lineCmds.length) {
      const l = applyLineTags(text, lineCmds.join(''));
      if (l != null) text = l;
    }

    if (text === rawText) { outputLines[i] = line; continue; }   // 原样保留，不做任何重写

    const outParts = parts.slice();
    outParts[textIdx] = text;
    outputLines[i] = 'Dialogue: ' + outParts.join(',');
    changedAny = true;
  }

  // 开了特效但一条都没命中（比如放大倍数=100、起始不透明度=100）→ 原样返回，
  // 连 CRLF/LF 都不规范化，确保调用方拿到的仍是**逐字节一致**的原文。
  return changedAny ? outputLines.join('\r\n') : assText;
}