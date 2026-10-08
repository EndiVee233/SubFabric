/**
 * 用**真实项目**验证基于波形的漏字幕检测。
 *
 * ⚠ 关键：要拿**最终字幕轨**（subtitle.ass）来判，不能拿 asr.json 的行。
 *   asr.json 是"识别到了什么"，subtitle.ass 才是"用户看到什么" ——
 *   两者会分叉（实测：某稿 asr.json 41 行事事齐全，但 ASS 里中文轨缺了前 36 秒、
 *   只有 37 行且乱序，那是编辑器某次自动保存写坏的）。
 *   拿 asr.json 判会得出"0 处缺失"的错误结论。
 *
 * 用法: node tools/check-speech-gap.cjs [项目id]
 */

const fs = require('fs');
const path = require('path');
const { detectSilences } = require('../editor/audio-slice.js');
const speechGap = require('../editor/speech-gap.js');

const PROJ = process.argv[2] || 'p-muznj93y-mjquh';
const D = path.join(__dirname, '..', 'projects', PROJ);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

/** 从 ASS 取出某个 Style 的时间区间 */
function assSpans(text, style) {
  const sec = (s) => {
    const m = /^(\d+):(\d+):([\d.]+)$/.exec(String(s || '').trim());
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : NaN;
  };
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('Dialogue:')) continue;
    const f = line.slice(9).split(',');
    if (style && f[3] !== style) continue;
    const a = sec(f[1]), b = sec(f[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push({ start: a, end: b });
  }
  return out;
}

(async () => {
  const meta = readJson(path.join(D, 'project.json'));
  const wav = path.join(D, (meta.audio && meta.audio.file) || 'audio.wav');
  if (!fs.existsSync(wav)) { console.log('  没有音频：' + wav); return; }
  console.log('  音频 ' + path.basename(wav));

  const sub = (meta.subtitle && meta.subtitle.file) || 'subtitle.ass';
  const subPath = path.join(D, sub);
  let lines = [], duration = 0, label = '';
  if (fs.existsSync(subPath) && /\.ass$/i.test(sub)) {
    const text = fs.readFileSync(subPath, 'utf8');
    lines = assSpans(text);                       // 所有轨合并：任一条盖住就算盖住
    const en = assSpans(text, 'Default');
    const zh = assSpans(text, '中文字幕');
    duration = Math.max(...lines.map(s => s.end)) + 2;
    label = `subtitle.ass（Dialogue ${lines.length} 条：中文字幕 ${zh.length} / Default ${en.length}）`;
  } else {
    console.log('  ⚠ 没找到 ASS，退回 asr.json（结论会偏乐观，见文件头说明）');
    const asr = readJson(path.join(D, 'asr.json'));
    const segs = asr.segments || asr;
    lines = segs.map(s => ({ start: +s.start, end: +s.end }));
    duration = Math.max(...lines.map(s => s.end)) + 2;
    label = `asr.json（${lines.length} 段）`;
  }
  console.log('  字幕轨 ' + label);

  console.log('  正在跑 ffmpeg silencedetect（-35dB / 0.35s）…');
  const t0 = Date.now();
  const sil = await detectSilences(FFMPEG, wav);
  console.log(`  静音区间 ${sil.length} 段，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const regions = speechGap.speechRegions(sil, duration);
  const speechTotal = regions.reduce((n, r) => n + (r.end - r.start), 0);
  console.log(`  语音区间 ${regions.length} 段，合计 ${speechTotal.toFixed(1)}s（`
    + `占全片 ${(100 * speechTotal / duration).toFixed(0)}%）`);

  const gaps = speechGap.speechGaps(sil, lines, duration);
  console.log(`\n  === 检出"有说话、没字幕" ${gaps.length} 处 ===`);
  let tot = 0;
  for (const g of gaps) {
    tot += g.dur;
    console.log(`    ${g.start.toFixed(2)} ~ ${g.end.toFixed(2)}s  (${g.dur.toFixed(2)}s，被盖住 ${g.covered.toFixed(2)}s)`);
    const near = lines
      .map((s, i) => ({ i: i + 1, s, d: Math.min(Math.abs(s.end - g.start), Math.abs(s.start - g.end)) }))
      .sort((a, b) => a.d - b.d).slice(0, 2).sort((a, b) => a.i - b.i);
    for (const n of near) {
      console.log(`        字幕行 ${n.i}: ${n.s.start.toFixed(2)}~${n.s.end.toFixed(2)}`);
    }
  }
  if (!gaps.length) console.log('    （无）');
  else console.log(`\n  合计漏字幕 ${tot.toFixed(1)} 秒`);
})();

