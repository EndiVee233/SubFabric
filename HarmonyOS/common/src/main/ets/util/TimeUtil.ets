/*
 * 时间轴工具：秒 <-> 时间戳字符串。
 *
 * 与 SubFabric editor/js/srt.js 和 Parakeet Studio app/subtitles.py 的行为保持一致，
 * 包括 ASS 使用的厘秒（centisecond）格式。
 */

function pad(value: number, width: number): string {
  let s = Math.floor(Math.abs(value)).toString();
  while (s.length < width) {
    s = '0' + s;
  }
  return s;
}

/**
 * 秒 -> "HH:MM:SS,mmm"（SRT）或 "HH:MM:SS.mmm"（VTT）。
 * comma 为 true 时用逗号，符合 SRT 规范。
 */
export function formatTimestamp(seconds: number, comma: boolean = true): string {
  const safe = Math.max(0, seconds);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const sep = comma ? ',' : '.';
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms, 3)}`;
}

/** 秒 -> ASS 时间戳 "H:MM:SS.cc"（厘秒）。 */
export function formatAssTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const totalCs = Math.round(safe * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

/**
 * 接受 "1:02:03.5" / "02:03,500" / "12.34" / "83.2" 等多种写法并转成秒。
 * 与 SubFabric 时间列编辑框的宽松解析保持一致。
 */
export function parseTimestamp(text: string): number {
  const t = text.trim().replace(/,/g, '.');
  if (t.length === 0) {
    return 0;
  }

  const parts = t.split(':');
  if (parts.length === 1) {
    // 纯秒数。
    const v = Number.parseFloat(parts[0]);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }

  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 2) {
    m = Number.parseFloat(parts[0]);
    s = Number.parseFloat(parts[1]);
  } else {
    // 超过 3 段时，前若干段按小时累加（容错）。
    const tail = parts.slice(parts.length - 2);
    const head = parts.slice(0, parts.length - 2);
    let acc = 0;
    for (let i = 0; i < head.length; i++) {
      const v = Number.parseFloat(head[i]);
      acc = acc * 60 + (Number.isFinite(v) ? v : 0);
    }
    h = acc;
    m = Number.parseFloat(tail[0]);
    s = Number.parseFloat(tail[1]);
  }

  const hh = Number.isFinite(h) ? h : 0;
  const mm = Number.isFinite(m) ? m : 0;
  const ss = Number.isFinite(s) ? s : 0;
  return Math.max(0, hh * 3600 + mm * 60 + ss);
}

/** "MM:SS.d" 形式的紧凑时间轴标签（时间轴刻度用）。 */
export function formatClock(seconds: number, withMs: boolean = false): string {
  const safe = Math.max(0, seconds);
  const totalSec = Math.floor(safe);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (!withMs) {
    return `${pad(m, 2)}:${pad(s, 2)}`;
  }
  const ms = Math.round((safe - totalSec) * 10);
  return `${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 1)}`;
}

/** 便于表格显示的两位小数秒。 */
export function formatSeconds(seconds: number, digits: number = 2): string {
  const f = Math.pow(10, digits);
  return (Math.round(Math.max(0, seconds) * f) / f).toFixed(digits);
}
