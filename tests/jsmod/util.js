/** 时间工具: 秒 <-> hh:mm:ss.mmm 等格式 */

export function fmtTime(sec, digits = 3) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = sec - Math.floor(sec);
  const frac = (ms).toFixed(digits).slice(2);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`;
}

export function fmtTimeSrt(sec) { return fmtTime(sec, 3).replace('.', ','); }

/**
 * ASS 时间 (厘秒精度, 小数固定 2 位)。
 * 必须"先整体取整到厘秒再拆分": 若单独对小数部分四舍五入,
 * x.995~x.999 会溢出成 ".100"(如 0:00:01.100), ASS 小数位只允许 2 位,
 * libass 与 parseTimeAss 都会解析失败 → 该行字幕丢失/错位。
 * 参考 main.py 的 format_time: 以秒为单位格式化, 进位由秒字段承担。
 */
export function fmtTimeAss(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const totalCs = Math.round(sec * 100);          // 整体取整(进位交给秒字段)
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** 解析 "hh:mm:ss,mmm" / "hh:mm:ss.mmm" / "h:mm:ss.cc" / 纯秒数 → 秒 */
export function parseTime(str) {
  if (str == null) return NaN;
  str = String(str).trim().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const m = /^(\d+):([0-5]?\d):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(str);
  if (!m) return NaN;
  let frac = 0;
  if (m[4]) {
    // 2 位按厘秒, 3 位按毫秒, 1 位按十分之一秒
    const d = m[4];
    frac = parseInt(d, 10) / Math.pow(10, d.length === 2 ? 2 : d.length);
    if (d.length === 2) frac = parseInt(d, 10) / 100;
  }
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + frac;
}

/**
 * ASS 时间解析: 容忍 1~3 位小数(2 位=厘秒标准, 1 位=十分之一秒, 3 位=毫秒)。
 * 宁可"读出来"也不要返回 NaN —— 返回 NaN 会让 _parseDialogue 丢弃整条事件,
 * 造成模型与文件不一致(逐词切片丢失 / 残留孤儿行)。
 */
export function parseTimeAss(str) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(str).trim());
  if (!m) return NaN;
  let frac = 0;
  if (m[4]) {
    const d = m[4];
    const v = parseInt(d, 10);
    frac = d.length === 2 ? v / 100 : v / Math.pow(10, d.length);
  }
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + frac;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 二分查找: 在按 start 升序的数组中找 start <= t 的最后一项下标 */
export function bisectStart(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 二分查找: 第一个 end > t 的下标 (用于区间检索起点) */
export function firstEndAfter(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].end > t) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export function debounce(fn, ms) {
  let id = null;
  return function (...args) {
    clearTimeout(id);
    id = setTimeout(() => fn.apply(this, args), ms);
  };
}
