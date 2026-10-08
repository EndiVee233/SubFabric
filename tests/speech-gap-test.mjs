/**
 * 波形漏字幕检测（speech-gap.js）的纯逻辑单测。
 *
 * 这个模块回答的是"**哪里有人在说话、却没有任何字幕盖住**"——
 * 与 reflect.js 的 findTimeGaps（只看字幕行之间的空档）互补：
 * 两行紧挨着、中间那段音频本来就没识别出内容时，findTimeGaps 看不出来。
 *
 * 用真实稿件实测过：检出 5 处、共 23.5 秒（例如 36.2~42.4s 与 138.8~145.7s
 * 在 ASS 里完全没有事件）。这里把判定规则钉死，防止阈值/边界被改坏。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const G = require(path.join(REPO, 'editor', 'speech-gap.js'));

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== 1. 静音取反 → 语音区间 ==');
{
  // 静音 [10,20] [30,40]，音频 50 秒 → 语音应为 [0,10] [20,30] [40,50]
  const r = G.speechRegions([{ start: 10, end: 20 }, { start: 30, end: 40 }], 50);
  ok(r.length === 3, '三段语音', r);
  ok(Math.abs(r[0].start - 0) < 1e-6 && Math.abs(r[0].end - 10) < 1e-6, '首段 0~10', r[0]);
  ok(Math.abs(r[1].start - 20) < 1e-6 && Math.abs(r[1].end - 30) < 1e-6, '中段 20~30', r[1]);
  ok(Math.abs(r[2].start - 40) < 1e-6 && Math.abs(r[2].end - 50) < 1e-6, '末段 40~50', r[2]);

  // 开头就是静音 → 不该产出 [0,0] 这种空段
  const r2 = G.speechRegions([{ start: 0, end: 5 }, { start: 20, end: 30 }], 40);
  ok(r2.length === 2 && r2[0].start === 5 && r2[0].end === 20, '开头静音不产出空段', r2);

  // 静音 [0,10] → 语音从 10 开始；再静音 [10,30] → 只剩 [30,40]
  const r3 = G.speechRegions([{ start: 0, end: 10 }, { start: 10, end: 30 }], 40);
  ok(r3.length === 1 && r3[0].start === 30 && r3[0].end === 40, '静音盖住的都不算语音', r3);
  // 静音 [10,11] → 语音 [11,40]，19 秒，够长 → 保留
  const r4 = G.speechRegions([{ start: 0, end: 10 }, { start: 10, end: 11 }], 40);
  ok(r4.length === 1 && Math.abs(r4[0].start - 11) < 1e-6, '静音求并后语音从 11 开始', r4);
  // 真正的"碎段"：语音只有 0.8 秒（静音 [0,10] 与 [10.8,30]）
  const r4b = G.speechRegions([{ start: 0, end: 10 }, { start: 10.8, end: 30 }], 40);
  ok(r4b.length === 1 && r4b[0].start === 30, '0.8 秒语音段被剔除（< 1.2s）', r4b);

  // 静音乱序 / 重叠 → 先排序再求并。
  // [5,12] 与 [10,15] 并成 [5,15] → 语音 [0,5] [15,30] [40,50] 三段
  const r5 = G.speechRegions([{ start: 30, end: 40 }, { start: 5, end: 12 }, { start: 10, end: 15 }], 50);
  ok(r5.length === 3, '重叠静音求并后三段语音', r5);
  ok(Math.abs(r5[0].start - 0) < 1e-6 && Math.abs(r5[0].end - 5) < 1e-6, '首段 0~5', r5[0]);
  ok(Math.abs(r5[1].start - 15) < 1e-6 && Math.abs(r5[1].end - 30) < 1e-6, '中段 15~30（两段静音并起来了）', r5[1]);
  ok(Math.abs(r5[2].start - 40) < 1e-6 && Math.abs(r5[2].end - 50) < 1e-6, '末段 40~50', r5[2]);

  // 没有静音 → 整片都是语音
  const r6 = G.speechRegions([], 30);
  ok(r6.length === 1 && r6[0].start === 0 && r6[0].end === 30, '无静音 → 整片一段', r6);
  // 静音盖满 → 没有语音
  ok(G.speechRegions([{ start: 0, end: 30 }], 30).length === 0, '静音盖满 → 无语音');
  // 边界
  ok(G.speechRegions([], 0).length === 0, '时长 0 → 无结果');
  ok(G.speechRegions(null, 10).length === 1, '静音为 null 也能处理');
  // 没给时长 → 以最后一个静音结束为准
  const r7 = G.speechRegions([{ start: 5, end: 10 }], 0);
  ok(r7.length === 1 && r7[0].start === 0 && r7[0].end === 5, '缺时长时用静音结尾兜底', r7);
}

console.log('\n== 2. 有声无字幕的判定 ==');
{
  const sil = [{ start: 10, end: 20 }];       // 音频 0~30：语音 0~10 与 20~30
  // 字幕把两段都盖住 → 无缺失
  let g = G.speechGaps(sil, [{ start: 0, end: 10 }, { start: 20, end: 30 }], 30);
  ok(g.length === 0, '盖住了就不报', g);

  // 第二段完全没有字幕 → 报 20~30
  g = G.speechGaps(sil, [{ start: 0, end: 10 }], 30);
  ok(g.length === 1, '第二段没字幕 → 报一处', g);
  ok(Math.abs(g[0].start - 20) < 1e-6 && Math.abs(g[0].end - 30) < 1e-6, '区间正确', g[0]);

  // 只盖住一部分 → 报的是**没盖住的那段**，不是整个语音段
  // 语音 [20,30]，字幕盖到 26（+0.3 容差 = 26.3）→ 未覆盖 26.3~30
  g = G.speechGaps(sil, [{ start: 0, end: 10 }, { start: 20, end: 26 }], 30);
  ok(g.length === 1, '部分覆盖 → 报一处', g);
  ok(Math.abs(g[0].start - 26.3) < 1e-6 && Math.abs(g[0].end - 30) < 1e-6,
    '报的是"没盖住的那段"，不是整个语音段', g[0]);
  ok(Math.abs(g[0].covered - 6.3) < 1e-6, '记录被盖住的秒数（含 0.3 容差）', g[0].covered);

  // 盖住 60% 以上 → 剩下的不够 MIN_GAP_SEC，不报
  g = G.speechGaps(sil, [{ start: 0, end: 10 }, { start: 20, end: 29.5 }], 30);
  ok(g.length === 0, '只剩 0.2s 未覆盖 → 不报', g);

  // 整段语音都没字幕 → 报整段
  g = G.speechGaps(sil, [{ start: 0, end: 10 }], 30);
  ok(g.length === 1 && Math.abs(g[0].start - 20) < 1e-6 && Math.abs(g[0].end - 30) < 1e-6,
    '整段没字幕 → 报整段', g[0]);

  // 字幕时间有几十毫秒误差不该误报（PAD_SEC=0.3 的容差）
  g = G.speechGaps(sil, [{ start: 0.2, end: 9.8 }, { start: 20.2, end: 29.8 }], 30);
  ok(g.length === 0, '字幕两端各差 0.2s 仍算盖住（容差 0.3s）', g);

  /* 缝隙太短不报（MIN_GAP_SEC=0.8）：
   * 静音 [10,30] → 只有一段语音 [0,10]；字幕盖到 9.5（+0.3 容差 = 9.8）
   * → 未覆盖 9.8~10 只有 0.2s → 不报 */
  g = G.speechGaps([{ start: 10, end: 30 }], [{ start: 0, end: 9.5 }], 30);
  ok(g.length === 0, '未覆盖只剩 0.2s → 太短不报', g);
}

console.log('\n== 3. 真实稿件回归（有真样本就核对，没有就跳过）==');
{
  const D = path.join(REPO, 'projects', 'p-muznj93y-mjquh');
  const wav = path.join(D, 'audio.wav');
  const ass = path.join(D, 'subtitle.ass');
  if (!fs.existsSync(wav)) {
    console.log('  SKIP 没有样本项目（' + D + '）');
  } else {
    const dur = G.readWavDuration(wav);
    ok(dur > 200 && dur < 300, `readWavDuration 读出合理时长（${dur.toFixed(1)}s）`, dur);
    ok(G.readWavDuration(path.join(D, 'no-such.wav')) === 0, '文件不存在返回 0');
    if (fs.existsSync(ass)) {
      const text = fs.readFileSync(ass, 'utf8');
      const sec = (s) => {
        const m = /^(\d+):(\d+):([\d.]+)$/.exec(String(s || '').trim());
        return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : NaN;
      };
      const track = [];
      for (const line of text.split('\n')) {
        if (!line.startsWith('Dialogue:')) continue;
        const f = line.slice(9).split(',');
        const a = sec(f[1]), b = sec(f[2]);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) track.push({ start: a, end: b });
      }
      ok(track.length > 100, `字幕轨行数合理（${track.length}）`, track.length);
      /* 这份稿件的 ASS 里 37.7~45.8s、137.5~145.7s 等区间完全没有事件
       * （asr.json 里却有对应内容）—— 正是"有声无字幕"的典型。
       * 这里不重跑 ffmpeg（单测要快、能离线跑），只验证"给定静音区间时判定正确"：
       * 把静音放在缺口两侧，中间那段就该被判成有声无字幕。 */
      const fakeSil = [{ start: 42.4, end: 42.8 }, { start: 145.7, end: 146.7 }];
      const gaps = G.speechGaps(fakeSil, track, dur);
      ok(gaps.length >= 2, '已知缺口能被检出', gaps.length);
      const has37 = gaps.some(x => x.start < 38.5 && x.end > 42);
      ok(has37, '37.7~42.4s 那处缺口被命中', gaps.map(x => x.start.toFixed(1) + '~' + x.end.toFixed(1)));
      const has137 = gaps.some(x => x.start < 138 && x.end > 145);
      ok(has137, '137.5~145.7s 那处缺口被命中', gaps.map(x => x.start.toFixed(1) + '~' + x.end.toFixed(1)));
      // 检出的都不该过短
      ok(gaps.every(x => x.dur >= G.MIN_GAP_SEC), '每处都 ≥ MIN_GAP_SEC', gaps.map(x => x.dur));
      ok(gaps.every((x, i) => i === 0 || x.start >= gaps[i - 1].end), '按时间有序且不重叠', gaps);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
