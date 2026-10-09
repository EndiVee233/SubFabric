/**
 * 区域字幕导入：按**时间区间**裁剪字幕（纯逻辑，可离线单测）。
 *
 * 用途：用户只要一个片段（比如某首歌、某段对话），导入 SRT/ASS 或项目包时
 * 填一个 start~end，就只留这个区间内的字幕行，其余丢弃。
 *
 * 两条硬规则：
 *   1. **默认全部导入**（区间留空 = 不过滤）。裁剪是显式动作，不能悄悄改用户的数据。
 *   2. **跨界保留**：一行字幕与区间有**任何重叠**就保留整行（不切半行文字）。
 *      切文字会让时间轴与文本对不上 —— 那比"多留一句"糟得多。
 *
 * 不与 `ass.js` / `srt.js` 的解析耦合：这里只做"给定 cue 列表 → 该留哪些"的判定，
 * 解析与重新序列化由调用方用现有模块做（避免重复实现两套解析）。
 */

/**
 * 解析用户填的时间。接受：
 *   `90`、`90.5`（秒）、`1:30`、`01:30.5`（分:秒）、`1:02:03`（时:分:秒）
 * @returns {number|null} 秒；无法解析返回 null
 */
function parseRegionTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // 纯数字 = 秒
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p.trim())) return null;
    nums.push(parseFloat(p));
  }
  let sec = 0;
  if (nums.length === 3) sec = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else sec = nums[0] * 60 + nums[1];
  return sec;
}

/**
 * 规范化区间输入。
 * @returns {{ ok:boolean, error:string, start:number|null, end:number|null, active:boolean }}
 *   active=false 表示"不过滤"（两个都空，或只有一边且另一边是 0/∞）
 */
function normalizeRegion(startRaw, endRaw) {
  const s = parseRegionTime(startRaw);
  const e = parseRegionTime(endRaw);
  const sBad = String(startRaw == null ? '' : startRaw).trim() !== '' && s === null;
  const eBad = String(endRaw == null ? '' : endRaw).trim() !== '' && e === null;
  if (sBad || eBad) {
    return { ok: false, active: false, start: null, end: null,
      error: '时间格式看不懂，用 秒（90）、分:秒（1:30）或 时:分:秒（1:02:03）' };
  }
  // 都没填 → 不过滤
  if (s === null && e === null) return { ok: true, active: false, start: null, end: null, error: '' };
  const a = s === null ? 0 : s;
  const b = e === null ? Infinity : e;
  if (b <= a) {
    return { ok: false, active: false, start: null, end: null,
      error: `结束时间（${e === null ? '∞' : b}s）必须大于开始时间（${a}s）` };
  }
  return { ok: true, active: true, start: a, end: b, error: '' };
}

/** 这个 cue 与区间有重叠吗（含边界）。active=false 时恒真。 */
function cueInRegion(cue, start, end, active) {
  if (!active) return true;
  if (!cue) return false;
  const cs = Number(cue.start), ce = Number(cue.end);
  if (!Number.isFinite(cs)) return false;
  const e = Number.isFinite(ce) ? ce : cs;
  // 重叠判定：cue 的 [cs, ce] 与 [start, end] 有交集。
  // 零长 cue（cs === ce）用"点在区间内"判定，否则边界上的零长行会被漏掉。
  if (cs === e) return cs >= start && cs <= end;
  return cs < end && e > start;
}

/**
 * 裁一组 cue。
 * @param {Array} cues  [{start, end, ...}]
 * @returns {{ kept:Array, dropped:number, from:number|null, to:number|null }}
 *   from/to = 实际保留下来的时间范围（给用户看"留了什么"）
 */
function filterCues(cues, start, end, active) {
  const list = Array.isArray(cues) ? cues : [];
  if (!active) return { kept: list.slice(), dropped: 0, from: null, to: null };
  const kept = list.filter(c => cueInRegion(c, start, end, true));
  let from = null, to = null;
  for (const c of kept) {
    const cs = Number(c.start), ce = Number(c.end);
    if (Number.isFinite(cs) && (from === null || cs < from)) from = cs;
    if (Number.isFinite(ce) && (to === null || ce > to)) to = ce;
  }
  return { kept, dropped: list.length - kept.length, from, to };
}

/**
 * 把区间信息塞进项目元信息 —— 事后能看出"这份稿子是裁过的"，而不是像丢了内容。
 * 裁剪会让时间轴从 0 之外的地方开始，之后"波形漏字幕检测"之类的功能需要知道这件事。
 */
function applyRegionToMeta(meta, res, note) {
  const m = Object.assign({}, meta || {});
  if (res && res.active) {
    m.region = {
      start: res.start === null ? 0 : res.start,
      end: res.end === null ? null : (Number.isFinite(res.end) ? res.end : null),
      importedAt: note || new Date().toISOString(),
    };
  } else {
    delete m.region;
  }
  return m;
}

/** 给用户看的一句话摘要 */
function regionSummary(res, keptCount, dropped) {
  if (!res || !res.active) return '';
  const f = (n) => {
    if (n == null) return '?';
    const s = Math.floor(n % 60), mm = Math.floor(n / 60) % 60, hh = Math.floor(n / 3600);
    const ss = String(s).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  const a = f(res.start === null ? 0 : res.start);
  const b = res.end === null || !Number.isFinite(res.end) ? '片尾' : f(res.end);
  return `只导入 ${a} ~ ${b} 的字幕：保留 ${keptCount} 行`
    + (dropped ? `，丢弃 ${dropped} 行` : '');
}

export {
  parseRegionTime, normalizeRegion, cueInRegion, filterCues, applyRegionToMeta, regionSummary,
};
