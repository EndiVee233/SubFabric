/**
 * 基于**波形**的漏字幕检测。
 *
 * 与 findTimeGaps（reflect.js，扫"两行字幕之间的空档"）的分工：
 *   · findTimeGaps  —— 只看字幕自身的空档。两行**紧挨着**、但中间那段音频本来就没识别出
 *                      内容的情况，它看不出来（那是"识别漏了"而不是"行间有空档"）。
 *   · 本模块        —— 直接看音频：**哪里有人在说话，却没有任何字幕覆盖**。
 *                      上一类漏检的正是这种（实测：64.25~65.75s 有说话声、字幕轨全空）。
 *
 * 实现只依赖 `detectSilences()`（音频切片模块里现成的 ffmpeg silencedetect），
 * 把"静音区间"取反就是"有人在说话"的区间 —— 比自己做 RMS 阈值可靠得多
 * （silencedetect 用的是帧内中位能量模型，对背景噪声不敏感；实测音频全程有底噪，
 *   单纯按 RMS 定阈值会把整片都判成"有声"）。
 *
 * `speechGaps()` 是**纯函数**（不碰 ffmpeg / 文件系统），便于离线单测。
 */

const fs = require('fs');

/** 语音段短于这个秒数就忽略（呼吸、咳嗽、鼠标点击之类） */
const MIN_SPEECH_SEC = 1.2;
/** 字幕与语音段重叠达到这个比例就算"盖住了"（起止时间本来就有几十毫秒误差，别卡太死） */
const COVER_RATIO = 0.5;
/** 判断覆盖时给字幕两端各放宽这么多秒 */
const PAD_SEC = 0.3;
/** 缝隙短于这个秒数就不报（多半只是字幕比语音早收尾一点） */
const MIN_GAP_SEC = 0.8;

/**
 * 由"静音区间"反推出"有人在说话"的区间。
 *
 * @param silences [{start,end}] 静音区间（可乱序、可重叠）
 * @param duration 音频总时长（秒）；0/缺失时以最后一个静音结尾为准
 * @returns [{start,end}] 语音区间，已排序、已求并、已剔除过短的
 */
function speechRegions(silences, duration) {
  const sil = (Array.isArray(silences) ? silences : [])
    .filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map(s => ({ start: Math.max(0, s.start), end: s.end }))
    .sort((a, b) => a.start - b.start);
  const total = Number.isFinite(duration) && duration > 0
    ? duration
    : (sil.length ? sil[sil.length - 1].end : 0);
  if (!(total > 0)) return [];

  const out = [];
  let cursor = 0;
  for (const s of sil) {
    if (s.start > cursor) out.push({ start: cursor, end: Math.min(s.start, total) });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < total) out.push({ start: cursor, end: total });
  // 求并（静音可能重叠）+ 剔除过短
  const merged = [];
  for (const r of out) {
    if (!(r.end > r.start)) continue;
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  return merged.filter(r => r.end - r.start >= MIN_SPEECH_SEC);
}

/**
 * 一个语音区间里"字幕没盖住"的那些子区间。
 * 字幕区间按 PAD_SEC 两端放宽后取并，再对语音区间做差集。
 */
function uncoveredParts(region, segs) {
  const hits = [];
  for (const s of segs) {
    const a = Math.max(region.start, Number(s.start) - PAD_SEC);
    const b = Math.min(region.end, Number(s.end) + PAD_SEC);
    if (b > a) hits.push([a, b]);
  }
  hits.sort((x, y) => x[0] - y[0]);
  const gap = [];
  let cursor = region.start;
  for (const [a, b] of hits) {
    if (a > cursor) gap.push([cursor, Math.min(a, region.end)]);
    cursor = Math.max(cursor, b);
    if (cursor >= region.end) break;
  }
  if (cursor < region.end) gap.push([cursor, region.end]);
  return gap.filter(([a, b]) => b > a);
}

/** 单个语音段被字幕覆盖了多少秒（= 段长 − 未覆盖部分之和，只算不重叠的部分） */
function coveredSec(region, segs) {
  const uncovered = uncoveredParts(region, segs).reduce((n, [a, b]) => n + (b - a), 0);
  return Math.max(0, (region.end - region.start) - uncovered);
}

/**
 * 找出"有人在说话、却没有字幕盖住"的**具体区间**。
 *
 * ⚠ 关键：不能按"整段语音的覆盖率"决定报不报。
 *   实测（236 秒的稿件）：语音被切成三大段，各段覆盖率 85% / 76% / 89% —— 都过了阈值，
 *   于是整段被跳过，**可缺口恰恰在这些区间内部**（37.7~45.8s、138.8~146.0s 全空）。
 *   正确做法：算出字幕**没盖住**的那些子区间，逐个按长度与占比筛。
 *
 * @param silences 静音区间（detectSilences 的结果）
 * @param segs     字幕行 [{start,end}]（哪个语言轨都行 —— 传"所有轨"最保险，
 *                 双语稿里只要有一轨盖住就算盖住了）
 * @param duration 音频总时长
 * @returns [{start,end,dur,covered,ratio}] 按时间排序；covered/ratio 描述它所在的语音段
 */
function speechGaps(silences, segs, duration) {
  const regions = speechRegions(silences, duration);
  const lines = (Array.isArray(segs) ? segs : [])
    .filter(s => s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)))
    .map(s => ({ start: Number(s.start), end: Number(s.end) }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of regions) {
    const dur = r.end - r.start;
    const cov = coveredSec(r, lines);
    // 没盖住的子区间 = 语音区间减去（放宽过的）字幕区间
    for (const [a, b] of uncoveredParts(r, lines)) {
      if (b - a < MIN_GAP_SEC) continue;               // 太短：多半只是字幕比语音早收尾一点
      out.push({
        start: +a.toFixed(3), end: +b.toFixed(3),
        dur: +(b - a).toFixed(3),
        covered: +cov.toFixed(3),
        ratio: +(cov / dur).toFixed(3),
      });
    }
  }
  return out;
}

/**
 * 读 WAV 时长（秒）。只解析头部，不读音频数据。
 *
 * 为什么要它：speechRegions 需要一个"音频到哪儿结束"的上界，否则最后一段语音
 * 会被当成延伸到无穷（或者被截掉）。用 ffprobe 多起一个进程不值得 ——
 * 项目的 audio.wav 是固定的 PCM 16k 单声道，头部信息足够。
 * 解析失败返回 0（调用方自己退化处理）。
 */
function readWavDuration(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12) return 0;
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return 0;
    // 逐个 chunk 找 fmt（采样率/位深/声道）与 data（数据长度）
    let pos = 12, byteRate = 0, blockAlign = 0, dataLen = 0;
    const hdr = Buffer.alloc(8);
    while (pos + 8 <= fs.fstatSync(fd).size) {
      if (fs.readSync(fd, hdr, 0, 8, pos) !== 8) break;
      const id = hdr.toString('ascii', 0, 4);
      const size = hdr.readUInt32LE(4);
      if (id === 'fmt ' && size >= 16) {
        const f = Buffer.alloc(16);
        fs.readSync(fd, f, 0, 16, pos + 8);
        byteRate = f.readUInt32LE(8);
        blockAlign = f.readUInt16LE(12);
      } else if (id === 'data') {
        dataLen = size;
        break;
      }
      pos += 8 + size + (size % 2);          // chunk 按偶数字节对齐
    }
    if (byteRate > 0) return dataLen / byteRate;
    if (dataLen > 0 && blockAlign > 0) return dataLen / blockAlign;   // 退路
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

module.exports = {
  speechRegions, speechGaps, coveredSec, uncoveredParts, readWavDuration,
  MIN_SPEECH_SEC, COVER_RATIO, PAD_SEC, MIN_GAP_SEC,
};
