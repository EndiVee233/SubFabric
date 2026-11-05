/**
 * 视频字幕样式预设：命名预设库 + 文件导入 / 导出（纯逻辑，无 DOM）
 *
 * ── 装的是什么 ───────────────────────────────────────────────────────
 *   ① 中英两条 ASS Style 轨（字体、字号、粗斜、主色/备用色、对齐、边距、描边…）
 *      —— 直接复用 ass.js 的 assStylePresetOf / applyAssStylePreset 那一套；
 *   ② 逐词高亮色、卡拉OK 未唱色与扫过形态（同 assStylePresetOf 的元数据）；
 *   ③ 中英上下顺序（zh-top / en-top，真正生效的是 Dialogue 行序）；
 *   ④ 后处理特效的**整份**配置（微光 zh/en 通道·颜色·半径·强度、词生长、柔和淡入）；
 *   ⑤ 视频区字幕字号缩放（SRT 叠加层用，ASS 由样式字号自己决定）。
 *
 * ── 为什么不只存"面板上那几个控件值" ────────────────────────────────
 * Style 行里还有 Alignment / MarginV / Outline / Shadow / Spacing 等面板没暴露的字段，
 * 只存面板值会在套用时把它们丢掉（静默改坏观感）。所以样式部分原样存
 * `format + values` 两份，套用时**按字段名**搬运（见 ass.js applyAssStylePreset）。
 *
 * ── 存储 ────────────────────────────────────────────────────────────
 * 预设库落在 localStorage（键 subfabric_style_presets），与 postprocess 配置同一层：
 * 「我这台机器上想用哪些样式」属于本机偏好，不是稿件内容，不写进 project.json。
 * 换机器 / 备份 / 分享走导出成 .json 文件（单条或整库都支持）。
 *
 * ── 兼容 ────────────────────────────────────────────────────────────
 * 旧版「ASS 双语样式预设」文件（kind = subfabric.ass-style-preset，只有 tracks + 元数据）
 * 也能导入：当成"只有样式、没有特效"的一条预设，不会因为缺 fx 就拒收。
 */

import { ASS_STYLE_PRESET_KIND } from './ass.js';
import { cloneConfig, DEFAULT_POSTPROCESS_CONFIG } from './postprocess.js';

export const STYLE_PRESET_KIND = 'subfabric.subtitle-style-preset';
export const STYLE_PRESET_BUNDLE_KIND = 'subfabric.subtitle-style-presets';
export const STYLE_PRESET_VERSION = 1;
export const PRESET_STORE_KEY = 'subfabric_style_presets';

/** 单条预设名 / 库的条数上限：localStorage 有 5MB 上限，且下拉框太长没法用 */
const MAX_NAME_LEN = 60;
const MAX_PRESETS = 60;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const HEX = /^#[0-9a-f]{6}$/i;

/** 生成稳定 id（重命名不改 id，这样下拉框选中项不会因为改名而跳走） */
export function newPresetId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 名称清洗：去掉控制字符 / 首尾空白 / 压掉超长 */
export function cleanPresetName(name, fallback = '') {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = s.slice(0, MAX_NAME_LEN);
  return out || String(fallback || '').slice(0, MAX_NAME_LEN) || '未命名预设';
}

/** 从一条 Style 轨里取某个字段（大小写不敏感） */
function styleField(track, key) {
  if (!track || !Array.isArray(track.format) || !Array.isArray(track.values)) return '';
  const i = track.format.findIndex(f => String(f).toLowerCase() === key);
  return i === -1 ? '' : String(track.values[i] == null ? '' : track.values[i]).trim();
}

/** 样式部分的校验（与 ass.js parseAssStylePreset 同一口径，但不抛异常） */
function validStyle(style) {
  if (!style || typeof style !== 'object') return '缺少样式对象';
  const tr = style.tracks;
  if (!tr || typeof tr !== 'object') return '缺少 tracks';
  for (const lang of ['zh', 'en']) {
    const t = tr[lang];
    if (!t || !Array.isArray(t.format) || !Array.isArray(t.values)) return `tracks.${lang} 缺少 format/values`;
    if (t.format.length !== t.values.length) return `tracks.${lang} 的 format 与 values 数量不一致`;
    if (!t.format.some(f => String(f).toLowerCase() === 'fontname')) return `tracks.${lang} 里没有 fontname 字段`;
  }
  return '';
}

/**
 * 组装一条预设（调用方给原始素材，这里负责归一化 + 打时间戳）。
 * @param {{id?:string,name?:string,style?:object|null,order?:string,fx?:object,overlayFontScale?:number,
 *          createdAt?:string,updatedAt?:string}} src
 */
export function makeStylePreset(src = {}) {
  const now = new Date().toISOString();
  const preset = {
    kind: STYLE_PRESET_KIND,
    version: STYLE_PRESET_VERSION,
    createdBy: 'SubFabric',
    id: src.id || newPresetId(),
    name: cleanPresetName(src.name),
    createdAt: src.createdAt || now,
    updatedAt: src.updatedAt || now,
    fx: cloneConfig(src.fx || DEFAULT_POSTPROCESS_CONFIG),
  };
  if (src.style) preset.style = src.style;
  if (src.order === 'zh-top' || src.order === 'en-top') preset.order = src.order;
  const scale = Number(src.overlayFontScale);
  if (Number.isFinite(scale) && scale > 0) preset.overlayFontScale = clamp(Math.round(scale * 100) / 100, 0.6, 1.8);
  return preset;
}

/**
 * 校验 / 归一化一条预设（导入、读库都走这里）。
 * 兼容三种输入：新格式 / 旧版纯样式预设 / 缺 kind 但结构对得上的对象。
 * @returns {{ok:boolean, preset?:object, error?:string}}
 */
export function normalizeStylePreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '不是预设对象' };
  const kind = String(raw.kind || '');
  const isLegacy = kind === ASS_STYLE_PRESET_KIND;
  const isNew = kind === STYLE_PRESET_KIND || (!kind && raw.tracks);
  if (!isLegacy && !isNew) return { ok: false, error: '不是 SubFabric 的样式预设（kind 不匹配）' };

  // 旧格式整体就是"样式部分"
  const style = isLegacy ? raw : (raw.style || (raw.tracks ? raw : null));
  if (style) {
    const err = validStyle(style);
    if (err) return { ok: false, error: err };
  }
  const fx = raw.fx && typeof raw.fx === 'object' ? raw.fx : null;
  if (isNew && !style && !fx) return { ok: false, error: '预设里既没有样式也没有特效参数' };

  const preset = makeStylePreset({
    id: raw.id,
    name: raw.name || (style && style.tracks && style.tracks.zh && style.tracks.zh.styleName) || '导入的预设',
    style: style ? {
      kind: ASS_STYLE_PRESET_KIND,
      version: 1,
      createdBy: 'SubFabric',
      createdAt: style.createdAt || raw.createdAt || undefined,
      tracks: { zh: style.tracks.zh, en: style.tracks.en },
      ...(HEX.test(style.wordColor || '') ? { wordColor: String(style.wordColor).toLowerCase() } : {}),
      ...(HEX.test(style.kBase || '') ? { kBase: String(style.kBase).toLowerCase() } : {}),
      ...(typeof style.kSweep === 'boolean' ? { kSweep: style.kSweep } : {}),
    } : undefined,
    order: raw.order,
    overlayFontScale: raw.overlayFontScale,
    fx: fx || DEFAULT_POSTPROCESS_CONFIG,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  });
  return { ok: true, preset };
}

/**
 * 一句摘要（下拉框 / 提示共用）：字体字号 + 特效开关，尽量短。
 * 例：微软雅黑 48 / Arial 40 · 微光·淡入
 */
export function presetSummary(preset) {
  if (!preset || typeof preset !== 'object') return '';
  const parts = [];
  const st = preset.style && preset.style.tracks;
  if (st) {
    const zh = [styleField(st.zh, 'fontname'), styleField(st.zh, 'fontsize')].filter(Boolean).join(' ');
    const en = [styleField(st.en, 'fontname'), styleField(st.en, 'fontsize')].filter(Boolean).join(' ');
    if (zh || en) parts.push([zh || '中文样式', en || '英文样式'].join(' / '));
  } else {
    parts.push('仅特效');
  }
  const fx = preset.fx || {};
  if (fx.enabled) {
    const on = [];
    if (fx.glow && fx.glow.enabled !== false) on.push('微光');
    if (fx.grow && fx.grow.enabled === true) on.push('生长');
    if (fx.fadein && fx.fadein.enabled === true) on.push('淡入');
    parts.push(on.length ? on.join('·') : '特效全关');
  } else {
    parts.push('特效关');
  }
  return parts.join(' · ');
}

/**
 * 解析导入的文件内容。支持：单条预设 / 整库（{kind: bundle, presets: []}）/ 旧版纯样式预设。
 * **不抛异常** —— 文件是用户给的，任何形状都可能出现。
 * @returns {{ok:boolean, presets?:object[], error?:string}}
 */
export function parsePresetFile(text) {
  let obj = null;
  try { obj = JSON.parse(String(text == null ? '' : text)); }
  catch { return { ok: false, error: '不是合法的 JSON 文件' }; }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '文件内容不是对象' };

  const rawList = obj.kind === STYLE_PRESET_BUNDLE_KIND
    ? obj.presets
    : (Array.isArray(obj) ? obj : [obj]);
  if (!Array.isArray(rawList) || !rawList.length) return { ok: false, error: '文件里没有预设' };

  const presets = [];
  const bad = [];
  for (const item of rawList) {
    const r = normalizeStylePreset(item);
    if (r.ok) presets.push(r.preset);
    else bad.push(r.error);
  }
  if (!presets.length) return { ok: false, error: bad[0] || '预设格式无法识别' };
  return { ok: true, presets, skipped: bad.length };
}

/** 导出成文件内容。单条时导出单条，多条时导出整库（都带 pretty print，方便手工改）。 */
export function serializePresetFile(presets) {
  const list = (Array.isArray(presets) ? presets : [presets]).filter(Boolean);
  const payload = list.length === 1
    ? list[0]
    : { kind: STYLE_PRESET_BUNDLE_KIND, version: STYLE_PRESET_VERSION, createdBy: 'SubFabric', presets: list };
  return JSON.stringify(payload, null, 2) + '\n';
}

/* ─────────── 本机预设库（localStorage） ─────────── */

function storageOf(storage) {
  if (storage) return storage;
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }   // 隐私模式 / 被禁用时访问就抛
}

/** 读库。坏数据一律当成空库（宁可丢预设，也不要让设置页打不开）。 */
export function loadPresetLibrary(storage) {
  const st = storageOf(storage);
  if (!st) return [];
  let raw = null;
  try { raw = st.getItem(PRESET_STORE_KEY); } catch { return []; }
  if (!raw) return [];
  let arr = null;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const r = normalizeStylePreset(item);
    if (r.ok) out.push(r.preset);
  }
  return out.slice(0, MAX_PRESETS);
}

/** 写库。@returns {boolean} 是否写成功（存储满 / 被禁用时 false） */
export function savePresetLibrary(list, storage) {
  const st = storageOf(storage);
  if (!st) return false;
  const clean = (Array.isArray(list) ? list : []).slice(0, MAX_PRESETS);
  try { st.setItem(PRESET_STORE_KEY, JSON.stringify(clean)); return true; }
  catch { return false; }
}

/** 取一个不重名的预设名：重名就加「（2）」「（3）」… */
export function uniquePresetName(list, want, excludeId) {
  const base = cleanPresetName(want, '预设');
  const taken = new Set((Array.isArray(list) ? list : [])
    .filter(p => p && p.id !== excludeId)
    .map(p => cleanPresetName(p.name).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}（${n}）`.slice(0, MAX_NAME_LEN);
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${base}（${Date.now().toString(36)}）`.slice(0, MAX_NAME_LEN);
}

/** 新增或覆盖（同 id 视为覆盖，保持原位置）。返回新数组，不改入参。 */
export function upsertPreset(list, preset) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const i = arr.findIndex(p => p && p.id === preset.id);
  if (i === -1) arr.push(preset);
  else arr[i] = preset;
  return arr.slice(0, MAX_PRESETS);
}

/** 按 id 删。返回新数组。 */
export function removePresetById(list, id) {
  return (Array.isArray(list) ? list : []).filter(p => p && p.id !== id);
}

/** 按 id 改名（重名自动加后缀）。返回 { list, name }。 */
export function renamePresetById(list, id, name) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const i = arr.findIndex(p => p && p.id === id);
  if (i === -1) return { list: arr, name: '' };
  const next = uniquePresetName(arr, name, id);
  arr[i] = { ...arr[i], name: next, updatedAt: new Date().toISOString() };
  return { list: arr, name: next };
}
