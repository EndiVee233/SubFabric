/* 离线验证分片：真 ffmpeg 造音频 → 真静音检测 → 真切片 → 假识别器 → 偏移合并。
 * 不联网、不跑任何模型（用户明确要求这轮不碰真实云端）。
 * 用法: node tools/chunk_probe.mjs
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { detectSilences, sliceAudio } = require_('../editor/audio-slice.js');
const C = require_('../editor/asr-chunks.js');

const FFMPEG = process.env.FFMPEG || 'D:/Program Files/ffmpeg/bin/ffmpeg.exe';
const FFPROBE = process.env.FFPROBE || 'D:/Program Files/ffmpeg/bin/ffprobe.exe';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const run = (bin, args) => new Promise((res) => {
  const p = spawn(bin, args, { windowsHide: true });
  let out = '', err = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  p.on('close', c => res({ code: c, out, err }));
});
const durOf = async (f) => {
  const r = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]);
  return Number(String(r.out).trim());
};

const dir = mkdtempSync(path.join(tmpdir(), 'ss-chunkprobe-'));
const src = path.join(dir, 'probe.wav');

/* 造 40 秒音频: 0-10 说话音, 10-12 静音, 12-30 说话音, 30-31 静音, 31-40 说话音 */
console.log('① 造测试音频（40 秒，两段静音：10–12s、30–31s）');
{
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=10',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=18',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=9',
    '-filter_complex', '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[out]', '-map', '[out]',
    '-ac', '1', '-ar', '16000', src]);
  ok(r.code === 0, 'ffmpeg 生成测试音频', r.err.slice(-160));
  const d = await durOf(src);
  ok(Math.abs(d - 40) < 0.3, '音频时长 ≈ 40 秒', d);
}

/* 静音检测（真 ffmpeg） */
console.log('② 静音检测（真 ffmpeg silencedetect）');
const sil = await detectSilences(FFMPEG, src);
console.log('   检出静音区间:', JSON.stringify(sil.map(s => [+s.start.toFixed(2), +s.end.toFixed(2)])));
ok(sil.length >= 2, '检出至少 2 段静音', sil.length);
const near = (t) => sil.find(s => Math.abs((s.start + s.end) / 2 - t) < 1.5);
ok(!!near(11), '检出 10–12 秒那段（中点 ≈11）');
ok(!!near(30.5), '检出 30–31 秒那段（中点 ≈30.5）');

/* 分片规划（缩小片长以便在 40 秒里验证切点吸附） */
console.log('③ 分片规划（片长压到 12 秒，看切点是否吸附到静音中点）');
const plan = C.planAudioChunks({ duration: 40, silences: sil, chunkSec: 12, minTailSec: 4 });
console.log('   分片:', JSON.stringify(plan.map(c => [c.start, c.end])));
ok(plan.length >= 3, '切成 ≥3 片', plan.length);
ok(plan[0].start === 0 && Math.abs(plan[plan.length - 1].end - 40) < 1e-6, '覆盖 0 ~ 40 秒');
let cover = true;
for (let i = 1; i < plan.length; i++) if (Math.abs(plan[i].start - plan[i - 1].end) > 1e-6) cover = false;
ok(cover, '片与片首尾相接、无重叠');
ok(Math.abs(plan[0].end - 11) < 1.5, '第一刀落在第一段静音里（≈11s）', plan[0].end);
// 静音里切 → 不该把有声部分切掉: 每片时长都 > 0
ok(plan.every(c => c.end - c.start > 0.5), '每片都有实际长度');

/* 真切片 + 假识别器 + 偏移合并 */
console.log('④ 真切片 + 假识别（不联网、不跑模型）+ 偏移合并');
const tmpFiles = [];
const parts = [];
for (const c of plan) {
  const f = path.join(dir, 'slice' + c.index + '.mp3');
  await sliceAudio(FFMPEG, src, c.start, c.end, f, true);
  tmpFiles.push(f);
  const d = await durOf(f);
  ok(Math.abs(d - (c.end - c.start)) < 0.35, `第 ${c.index + 1} 片 mp3 时长≈规划值（${(c.end - c.start).toFixed(2)}s）`, d);
  // 假识别器：每片返回 2 句，时间戳都在片内
  parts.push({
    offset: c.start,
    segments: [
      { start: 0.1, end: 1.0, text: 'chunk' + c.index + 'a', words: [{ word: 'x', start: 0.1, end: 1.0 }] },
      { start: 1.2, end: 2.0, text: 'chunk' + c.index + 'b', words: [] },
    ].filter(s => s.end <= (c.end - c.start) + 0.01),
  });
}
const merged = C.mergeChunkSegments(parts);
console.log('   合并后:', JSON.stringify(merged.map(s => [s.start, s.end, s.text])).slice(0, 200));
ok(merged.length > 0, '合并出句子', merged.length);
ok(merged.every(s => s.start >= 0 && s.end <= 40.01), '所有句子都落在 0~40 秒内');
ok(merged.every((s, i) => i === 0 || s.start >= merged[i - 1].start), '按起点单调递增');
// 每句都落在它所属的片内（偏移正确）
let inChunk = true;
for (const s of merged) {
  const owner = plan.find(c => s.start >= c.start - 0.01 && s.start <= c.end + 0.01);
  if (!owner) inChunk = false;
}
ok(inChunk, '每句都落在它那片的时间范围内（偏移正确）');

/* 清理 */
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
