// 必剪 ASR 独立探针 —— 排查"识别失败 / 变慢 / 接口字段变了"时, 不经过整个项目流水线,
// 直接看这条云链路的每一步与解析结果。
//
// 用法: node tools/bcut_asr_probe.mjs <音频或视频> [--keep]
//   · 音频（flac/aac/m4a/mp3/wav）直接送; 其它格式(含视频)先用 ffmpeg 抽成 16k 单声道 mp3
//   · --keep 保留临时 mp3（默认删）
// 需要: ffmpeg 在 PATH 上(或 FFMPEG_PATH 指向 ffmpeg.exe)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';

const require_ = createRequire(import.meta.url);
const { transcribe, SUPPORTED_EXTS, API_BASE, MODEL_ID } = require_('../editor/bcut-asr.js');

const input = process.argv[2];
const keep = process.argv.includes('--keep');
if (!input || !existsSync(input)) {
  console.error('用法: node tools/bcut_asr_probe.mjs <音频或视频> [--keep]');
  process.exit(2);
}

const ext = extname(input).slice(1).toLowerCase();
let audio = input;
let tmpDir = null;
if (!SUPPORTED_EXTS.has(ext)) {
  const ff = process.env.FFMPEG_PATH || 'ffmpeg';
  tmpDir = mkdtempSync(join(tmpdir(), 'bcut-probe-'));
  const out = join(tmpDir, basename(input, extname(input)) + '.mp3');
  console.log(`[1/3] 用 ffmpeg 抽音频 → ${out}`);
  const code = await new Promise((res) => {
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out], { stdio: 'inherit' });
    p.on('error', () => res(-1));
    p.on('close', res);
  });
  if (code !== 0) { console.error('ffmpeg 抽音频失败（退出码 ' + code + '）'); process.exit(1); }
  audio = out;
}

console.log(`[2/3] 送必剪云端识别: ${audio} (${(statSync(audio).size / 1048576).toFixed(2)} MB)`);
console.log(`      ${API_BASE}  model_id=${MODEL_ID}`);
const t0 = Date.now();
try {
  const { segments } = await transcribe({
    audioPath: audio,
    log: (m) => console.log('  ·', m),
    onProgress: (pct, msg) => console.log(`  ${String(pct).padStart(3)}% ${msg}`),
  });
  console.log(`[3/3] ${segments.length} 句 / 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  for (const s of segments) {
    console.log(`[${s.start.toFixed(2)} → ${s.end.toFixed(2)}] ${s.text}`);
    console.log('   ' + (s.words.length
      ? s.words.map((w) => `${w.word}(${w.start.toFixed(2)}-${w.end.toFixed(2)})`).join(' ')
      : '（无逐词数据）'));
  }
  if (!segments.length) console.log('（没有识别到语音内容）');
} catch (e) {
  console.error('识别失败:', e.message);
  process.exitCode = 1;
} finally {
  if (tmpDir && !keep) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  else if (tmpDir) console.log('临时文件保留在:', tmpDir);
}
