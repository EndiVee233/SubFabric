/* 波形退化复现探针: 用"类语音"信号跑一遍 server.js 现有的分桶逻辑, 打印分布。
 * 目的: 证明 _drawWaveLayer 画出来为什么是"一坨实心块"而不是起伏。
 * 跑法: node tools/wave_probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AUDIO_SR = 16000;      // 与 server.js startPrepare 一致
const PEAK_GAIN = 7.943;     // 与 server.js 一致 (+18dB)
const RATE = 100;            // 与 server.js 一致

/* ── 造一段 30s 的类语音信号: 音节包络(4~6Hz) × 基频+谐波+噪声, 整体 -26dBFS ── */
function makeSpeechLike(durSec) {
  const n = Math.round(durSec * AUDIO_SR);
  const pcm = Buffer.alloc(n * 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / AUDIO_SR;
    // 音节包络: 有声/无声交替 + 音节起伏
    const gate = (Math.sin(t * 2 * Math.PI * 0.31) > -0.25) ? 1 : 0.06;
    const syl = 0.55 + 0.45 * Math.sin(t * 2 * Math.PI * 4.7);
    const env = gate * syl;
    // 声源: 基频 120Hz + 谐波 + 轻微噪声
    const f0 = 120 + 20 * Math.sin(t * 1.3);
    phase += 2 * Math.PI * f0 / AUDIO_SR;
    const src = 0.6 * Math.sin(phase) + 0.25 * Math.sin(phase * 2) + 0.12 * Math.sin(phase * 3)
      + 0.05 * (Math.random() * 2 - 1);
    // 目标 RMS ≈ -26dBFS → 峰值约 -14dBFS(语音 crest factor ~12dB)
    const s = Math.round(src * env * 0.20 * 32767);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return pcm;
}

/* ── 复制 server.js:2174-2204 的分桶逻辑(逐字一致) ── */
function bucketize(pcm, duration) {
  const rate = RATE;
  const total = Math.max(20000, Math.min(2000000, Math.round(duration * rate)));
  const inSr = AUDIO_SR;
  const spb = duration * inSr / total;
  const buckets = Buffer.allocUnsafe(total);
  let filled = 0, peak = 0, inBucket = 0, carry = null;
  const flush = () => {
    const norm = Math.min(1, (peak / 32768) * PEAK_GAIN);
    if (filled < total) buckets[filled++] = Math.min(255, Math.round(255 * Math.sqrt(norm)));
    peak = 0; inBucket = 0;
  };
  let buf = pcm;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    if (++inBucket >= spb) flush();
  }
  if (inBucket > 0 || peak > 0) flush();
  return { data: buckets.subarray(0, filled), total };
}

function stats(u8) {
  let min = 255, max = 0, sum = 0;
  const hist = new Array(256).fill(0);
  for (const v of u8) { if (v < min) min = v; if (v > max) max = v; sum += v; hist[v]++; }
  const nz = u8.length;
  const pct = (p) => {
    let acc = 0, target = nz * p;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  };
  return {
    n: nz, min, max, mean: +(sum / nz).toFixed(1),
    p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), p999: pct(0.999),
    sat: +(100 * hist.slice(250).reduce((a, b) => a + b, 0) / nz).toFixed(1),
  };
}

const dur = 30;
const pcm = makeSpeechLike(dur);
const { data } = bucketize(pcm, dur);

console.log('=== 现有分桶结果 (PEAK_GAIN=+18dB, clamp, sqrt) ===');
console.log(stats(data));

/* ── 关键指标: 相邻桶之间的起伏幅度。真实波形必须有"高↔低"交替。 ── */
function roughness(u8) {
  let sumAbsDiff = 0, n = 0;
  for (let i = 1; i < u8.length; i++) { sumAbsDiff += Math.abs(u8[i] - u8[i - 1]); n++; }
  return +(sumAbsDiff / n).toFixed(2);
}
console.log('相邻桶平均跳变:', roughness(data), '(0 = 一条平线/实心块, 大 = 起伏明显)');

/* ── 画成 ASCII 看形状(每列取该 px 时间窗内的 max) ── */
const COLS = 100, ROWS = 14;
const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '));
for (let px = 0; px < COLS; px++) {
  const b0 = Math.floor(px / COLS * data.length);
  const b1 = Math.ceil((px + 1) / COLS * data.length);
  let mx = 0;
  for (let b = b0; b < b1; b++) mx = Math.max(mx, data[b] || 0);
  const half = Math.max(1, Math.round((mx / 255) * (ROWS / 2)));
  for (let r = 0; r < half; r++) {
    const up = ROWS / 2 - 1 - r, dn = ROWS / 2 + r;
    if (up >= 0) grid[up][px] = '#';
    if (dn < ROWS) grid[dn][px] = '#';
  }
}
console.log('\n=== 现有波形形状 (每列取窗口内 max) ===');
console.log(grid.map(r => r.join('')).join('\n'));

/* ── 对照: 目标画法应该用 min/max 包络 + 自动归一化, 这里算一下归一化后是什么样 ── */
function bucketizeAuto(pcm, duration) {
  const rate = RATE;
  const total = Math.max(20000, Math.min(2000000, Math.round(duration * rate)));
  const spb = duration * AUDIO_SR / total;
  const lin = new Float32Array(total);
  let idx = 0, peak = 0, inBucket = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    const a = (s < 0 ? -s : s) / 32768;
    if (a > peak) peak = a;
    if (++inBucket >= spb) { if (idx < total) lin[idx++] = peak; peak = 0; inBucket = 0; }
  }
  if ((inBucket > 0 || peak > 0) && idx < total) lin[idx++] = peak;
  // p99.5 作为参考电平 → 归一化到 0.95
  const sorted = Array.from(lin.subarray(0, idx)).sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))] || 1;
  const k = 0.95 / ref;
  const out = Buffer.allocUnsafe(idx);
  for (let i = 0; i < idx; i++) out[i] = Math.min(255, Math.round(255 * Math.min(1, lin[i] * k)));
  return { data: out.subarray(0, idx), ref, k };
}
const auto = bucketizeAuto(pcm, dur);
console.log('\n=== 自动归一化对照 (p99.5 → 0.95, 无 sqrt) ===');
console.log('参考电平 ref =', auto.ref.toFixed(4), ' 增益 k =', auto.k.toFixed(2));
console.log(stats(auto.data));
console.log('相邻桶平均跳变:', roughness(auto.data));

const grid2 = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '));
for (let px = 0; px < COLS; px++) {
  const b0 = Math.floor(px / COLS * auto.data.length);
  const b1 = Math.ceil((px + 1) / COLS * auto.data.length);
  let mx = 0;
  for (let b = b0; b < b1; b++) mx = Math.max(mx, auto.data[b] || 0);
  const half = Math.max(1, Math.round((mx / 255) * (ROWS / 2)));
  for (let r = 0; r < half; r++) {
    const up = ROWS / 2 - 1 - r, dn = ROWS / 2 + r;
    if (up >= 0) grid2[up][px] = '#';
    if (dn < ROWS) grid2[dn][px] = '#';
  }
}
console.log('\n=== 归一化后形状 ===');
console.log(grid2.map(r => r.join('')).join('\n'));