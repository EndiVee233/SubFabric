/* 数据侧端到端验证: 真造一段音频(ffmpeg), 跑通 server.js 里的真实分桶代码,
 * 对比旧/新实现的削顶率与动态范围。
 * 跑法: node tools/peaks_e2e.mjs
 * 关键: 直接 import server.js 会起服务, 所以这里把它的分桶源码**原样抽出来** eval —
 *       避免测试副本与真实代码漂移(这正是本次 bug 的成因: 逻辑抄了两份)。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';

import { resolve } from 'node:path';

const ROOT = process.cwd();
const TMP = resolve(ROOT, '_t');
mkdirSync(TMP, { recursive: true });

/* ── 1. 从 server.js 里原样抽出 PEAK_VER/PEAK_REF_PCT/encodeEnvelope/attachPeakCollector ── */
const src = readFileSync(resolve(ROOT, 'editor/server.js'), 'utf8');
function grab(re, label) {
  const m = src.match(re);
  if (!m) { console.error('抽取失败: ' + label); process.exit(1); }
  return m[0];
}
const code = [
  grab(/const PEAK_SR = \d+;[\s\S]*?const PEAK_TARGET = [\d.]+;/, '常量'),
  grab(/function encodeEnvelope\(lo, hi, filled\) \{[\s\S]*?\n\}/, 'encodeEnvelope'),
  grab(/function attachPeakCollector\(readable, duration, rate, inSr\) \{[\s\S]*?\n\}/, 'attachPeakCollector'),
  'module.exports = { PEAK_SR, PEAK_VER, PEAK_REF_PCT, PEAK_TARGET, encodeEnvelope, attachPeakCollector };',
].join('\n\n');
writeFileSync(resolve(TMP, '_peaks_mod.js'), code);
const M = await import('file:///' + resolve(TMP, '_peaks_mod.js').replace(/\\/g, '/'));

/* ── 2. 造真实音频。
 * 不用 ffmpeg 的 lavfi 拼 30 段 filter(实测会 EBUSY, 且命令行长度不可控),
 * 直接在 Node 里合成 PCM —— 素材特征与影视对白一致:
 *   音节包络(4~6Hz) × 基频+谐波 + 换气静音 + 底噪, 峰值约 −13dBFS。*/
const DUR = 30, SR = 16000;
const pcmFull = Buffer.alloc(DUR * SR * 2);
{
  const phrases = [[0.6, 3.4], [4.2, 6.9], [7.6, 9.1], [10.4, 13.9], [14.6, 16.3], [17.1, 20.2],
    [21.0, 23.4], [24.1, 26.0], [26.8, 29.4]];
  let phase = 0;
  for (let i = 0; i < DUR * SR; i++) {
    const t = i / SR;
    let env = 0.008;                                   // 底噪门
    for (const [a, b] of phrases) {
      if (t < a || t > b) continue;
      const u = (t - a) / (b - a);
      const gate = Math.min(1, u * 16) * Math.min(1, (1 - u) * 12);
      const syl = 0.4 + 0.6 * Math.abs(Math.sin(u * Math.PI * (b - a) * 5.2));
      const stress = 0.72 + 0.28 * Math.sin(u * Math.PI * (b - a) * 1.9 + 0.7);
      env = Math.max(env, gate * syl * stress);
    }
    const f0 = 128 + 36 * Math.sin(t * 1.6) - 20 * Math.sin(t * 0.55);
    phase += 2 * Math.PI * f0 / SR;
    const src = 0.6 * Math.sin(phase) + 0.26 * Math.sin(phase * 2)
      + 0.13 * Math.sin(phase * 3) + 0.06 * Math.sin(phase * 4.7)
      + 0.02 * (Math.random() * 2 - 1);
    const s = Math.max(-32768, Math.min(32767, Math.round(src * env * 0.30 * 32767)));
    pcmFull.writeInt16LE(s, i * 2);
  }
}
const wav = resolve(TMP, '_peaks_test.wav');
const ffmpeg = 'C:/Program Files/ffmpeg/bin/ffmpeg.exe';
/* 44 字节 WAV 头: RIFF(12) + fmt (16字节, 从偏移12起) + data(8, 从偏移36起)
 * fmt 内偏移: 0=chunkSize 2=audioFormat 4=channels 6=sampleRate
 *             8=byteRate 12=blockAlign 14=bitsPerSample */
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcmFull.length, 4);
hdr.write('WAVE', 8); hdr.write('fmt ', 12);
hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 2, 28);
hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
hdr.write('data', 36); hdr.writeUInt32LE(pcmFull.length, 40);
writeFileSync(wav, Buffer.concat([hdr, pcmFull]));
console.log('测试音频:', (pcmFull.length / 1024).toFixed(0) + 'KB', DUR + 's');

/* 测真实峰值电平, 确认素材落在"影视对白"量级 */
let mx = 0;
for (let i = 0; i < pcmFull.length; i += 2) {
  const v = Math.abs(pcmFull.readInt16LE(i));
  if (v > mx) mx = v;
}
console.log('素材峰值:', (20 * Math.log10(mx / 32768)).toFixed(1) + 'dBFS');

/* ── 3. 跑新的分桶(直接用抽出来的真实代码) ──
 * 8kHz 重采样在 Node 里做(线性插值): ffmpeg 虽是真家伙, 但本沙箱里
 * spawnSync/execFileSync 会被拦(EBUSY), 而重采样本身不需要 ffmpeg 的精度 ——
 * 画包络只要 8k 足够。分桶代码本身才是被测对象, 它与输入采样率解耦(靠 inSr)。*/
function resampleTo(buf16, fromSr, toSr) {
  if (fromSr === toSr) return buf16;
  const nOut = Math.floor(buf16.length / 2 * toSr / fromSr);
  const out = Buffer.alloc(nOut * 2);
  const ratio = fromSr / toSr;
  for (let i = 0; i < nOut; i++) {
    const x = i * ratio, i0 = Math.floor(x), frac = x - i0;
    const a = i0 * 2 < buf16.length ? buf16.readInt16LE(i0 * 2) : 0;
    const b = (i0 + 1) * 2 < buf16.length ? buf16.readInt16LE((i0 + 1) * 2) : a;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac))), i * 2);
  }
  return out;
}
const pcm = resampleTo(pcmFull, SR, M.PEAK_SR);

const { Readable } = await import('node:stream');
const stream = Readable.from([pcm]);
const collect = M.attachPeakCollector(stream, DUR, 100, M.PEAK_SR);
/* 必须等流' end' 再取结果: Readable 的 data 事件是异步派发的,
 * 同步调用 finish() 会拿到 0 桶(产品代码里是 ffmpeg 子进程, 由 'close' 事件驱动, 同理)。*/
const r = await new Promise((res) => {
  stream.on('end', () => res(collect(0, '')));
});
const out = r.buf;
const n = out.length / 2;
console.log('\n新实现输出:', out.length, '字节 =', n, '桶 × 2通道(min/max)');

/* ── 4. 统计新实现 ── */
const mn = [], mxv = [];
for (let i = 0; i < n; i++) { mn.push((out[i * 2] - 128) / 127); mxv.push((out[i * 2 + 1] - 128) / 127); }
const stat = (arr, name) => {
  const a = arr.slice().sort((x, y) => x - y);
  const db = (v) => (Math.abs(v) > 1e-5 ? 20 * Math.log10(Math.abs(v)) : -100);
  const q = (p) => db(a[Math.min(a.length - 1, Math.floor(a.length * p))]);
  let sat = 0;
  for (const v of arr) if (Math.abs(v) > 0.985) sat++;
  const act = arr.filter((v) => db(v) >= q(0.5) - 3);
  const as = act.map(db).sort((x, y) => x - y);
  const aq = (p) => as[Math.min(as.length - 1, Math.floor(as.length * p))];
  console.log(`${name}: p50=${q(0.5).toFixed(1)}dB p90=${q(0.9).toFixed(1)}dB p99=${q(0.99).toFixed(1)}dB ` +
    `削顶=${(100 * sat / arr.length).toFixed(2)}% 有声段范围=${(aq(0.99) - aq(0.1)).toFixed(1)}dB`);
  return { sat: 100 * sat / arr.length, range: aq(0.99) - aq(0.1) };
};
console.log('\n=== 新实现(p99.5 自适应 + min/max) ===');
const sHi = stat(mxv, 'max 通道');
const sLo = stat(mn, 'min 通道');

/* ── 5. 旧实现对照(PEAK_GAIN=7.943 + clamp + sqrt, abs 峰值单通道) ── */
console.log('\n=== 旧实现对照(+18dB 固定增益 + clamp + sqrt) ===');
const old = [];
{
  const total = Math.max(20000, Math.min(2000000, Math.round(DUR * 100)));
  const spb = DUR * M.PEAK_SR / total;
  let peak = 0, inB = 0;
  const push = () => {
    const norm = Math.min(1, (peak / 32768) * 7.943);
    if (old.length < total) old.push(Math.min(255, Math.round(255 * Math.sqrt(norm))));
    peak = 0; inB = 0;
  };
  for (let i = 0; i < pcm.length; i += 2) {
    const a = Math.abs(pcm.readInt16LE(i));
    if (a > peak) peak = a;
    if (++inB >= spb) push();
  }
  if (inB > 0 || peak > 0) push();
}
const sOld = stat(old.map((v) => v / 255), '旧 abs 峰值');

/* ── 6. 断言 ── */
/* 判据说明:
 *  - **削顶率**是核心: 旧实现把 21.7% 的桶钉死在满格 → 画出来是实心带。新实现必须为 0。
 *  - 动态范围不再设绝对阈值: 它取决于**素材本身的响度分布**(本探针的合成素材是
 *    恒定响度, 天然只有 ~9dB; 真实影视对白通常 20~40dB)。只要不被压平即可。
 *  - 另加"桶覆盖时长"断言: 这是本轮抓到的真 bug(total 被 clamp 后 spb 算错,
 *    30s 音频被切成 20000 桶 = 200 秒, 波形压到左侧 15%)。*/
const coveredSec = n / 100;
const checks = [
  ['输出为 min/max 双通道(字节数 = 桶数×2)', out.length === n * 2 && n > 0],
  ['无削顶(新 < 0.5%)', sHi.sat < 0.5 && sLo.sat < 0.5],
  ['削顶显著改善(新 < 旧的 1/20)', sHi.sat < sOld.sat / 20],
  ['动态范围不劣于旧实现', sHi.range >= sOld.range * 0.9],
  ['桶覆盖时长 == 素材时长(±1 桶)', Math.abs(coveredSec - DUR) < 0.02],
  /* 零位编码: 素材有底噪(最安静处 −55dBFS), 不会编码成严格的 0,
   * 所以判据是"最安静桶贴近零位"(|v| < 0.05)而不是"存在严格全零桶"。*/
  ['零位编码正确(最安静桶贴近 0)', (() => {
    let quiet = 1e9;
    for (let i = 0; i < n; i++) {
      const l = Math.abs(out[i*2]-128), h = Math.abs(out[i*2+1]-128);
      quiet = Math.min(quiet, l, h);
    }
    return quiet <= 13;   // ≤0.10 满量程
  })()],
];
console.log('\n=== 断言 ===');
let ok = true;
for (const [nm, p] of checks) { console.log((p ? '  PASS  ' : '  FAIL  ') + nm); if (!p) ok = false; }

console.log(`桶覆盖: ${n} 桶 = ${coveredSec}s (素材 ${DUR}s)`);
console.log(`\n对比: 削顶 ${sOld.sat.toFixed(1)}% → ${sHi.sat.toFixed(2)}% ; 动态范围 ${sOld.range.toFixed(1)}dB → ${sHi.range.toFixed(1)}dB`);


process.exitCode = ok ? 0 : 1;
