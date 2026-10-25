/* 波形包络分桶回归：浮点 spb 让每桶多取 1 个采样，包络整体短 1/161。
 *
 * 复现数据（真实项目 p-mvo0ymnz-66ylp）：
 *   duration 2700.502333 → 旧算法 spb = 160.00000000000003 → 每桶 161 采样
 *   45 分钟片尾少约 16.77 秒波形，且越往后越提前，和字幕对不上。
 * 这里用 1.6 秒 PCM 就能稳定复现（旧算法 159 桶，正确 160 桶），不必读真实大文件。 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { serverFunctions } from './helpers/server-functions.mjs';

const { attachPeakCollector, encodeEnvelope, peaksCoversAudio } = serverFunctions(
  ['attachPeakCollector', 'encodeEnvelope', 'peaksCoversAudio'],
  { AUDIO_SR: 16000, PEAK_REF_PCT: 0.995, PEAK_TARGET: 0.95,
    fs: { statSync() { throw new Error('unexpected statSync'); } } },
);

const SR = 16000;
const DUR = 2700.502333;          // 实测会得到 spb=160.00000000000003 的时长
const DT = 0.0100625;             // 161 / 16000，旧算法实际每桶覆盖的时间

async function collect(samples, duration = DUR) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // 方波样值，保证每个桶都有非零 min/max；只关心桶数。
    pcm.writeInt16LE(i % 160 < 80 ? 12000 : -12000, i * 2);
  }
  const rs = Readable.from([pcm]);
  const finish = attachPeakCollector(rs, duration, 100, SR);
  await new Promise(resolve => rs.on('end', resolve));
  const r = finish(0, '');
  return { buckets: r.buf.length / 2, buf: r.buf };
}

const onePointSix = await collect(Math.round(1.6 * SR));
assert.equal(onePointSix.buckets, 160,
  '1.6s 应按 160 个采样一桶切出 160 桶（旧浮点实现只有 159）');
assert.equal(onePointSix.buckets, Math.round(1.6 / (160 / SR)),
  '桶宽必须固定为 160 个采样，不能随时长浮点漂移');

const partial = await collect(SR + Math.round(DT * SR));   // 1s + 161 采样
assert.equal(partial.buckets, 102, '末尾不满一桶也要保留');

const exact = await collect(SR * 10);
assert.equal(exact.buckets, 1000, '整 10 秒应恰好 1000 桶');

// 覆盖校验：真实项目 45 分钟的旧 peaks.bin 只有 2683.73s，必须判为未就绪。
const badMeta = {
  peaks: { file: 'peaks.bin', rate: 100, ch: 2, bytes: 536746 },
  audio: { file: 'audio.wav', bytes: 86416120 },
};
assert.equal(peaksCoversAudio(badMeta, 'peaks.bin'), false, '短 0.62% 的旧包络应触发重新提取');

const goodMeta = {
  peaks: { file: 'peaks.bin', rate: 100, ch: 2, bytes: 564812 },
  audio: { file: 'audio.wav', bytes: 90370126 },
};
assert.equal(peaksCoversAudio(goodMeta, 'peaks.bin'), true, '与音频等长的包络应保持就绪');

assert.equal(peaksCoversAudio({ peaks: { file: 'peaks.bin', rate: 100, ch: 2, bytes: 2000 } }, 'peaks.bin'), true,
  '没有 audio.bytes 的旧项目不做误判');

console.log('peaks-span: 160 采样/桶、末尾残桶、真实项目短包络校验通过');
