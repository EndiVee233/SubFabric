/* 长音频分片单测（纯逻辑，不联网、不跑模型）: node tests/audio-chunk-test.mjs
 * 覆盖: 静音解析 / 分片规划(静音优先·完整覆盖·无重叠) / 偏移合并 / 片间等待 / 串行调度与取消 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const C = require_('../editor/asr-chunks.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + extra : '')); }
};
const j = (x) => JSON.stringify(x);

/* ── 静音解析 ── */
{
  const ff = [
    '[silencedetect @ 0x55] silence_start: 12.3456',
    '[silencedetect @ 0x55] silence_end: 13.4567 | silence_duration: 1.1111',
    '[silencedetect @ 0x55] silence_start: 1500.2',
    '[silencedetect @ 0x55] silence_end: 1502.4 | silence_duration: 2.2',
  ].join('\n');
  const s = C.parseSilences(ff, 3600);
  ok(s.length === 2, '静音解析出 2 段', j(s));
  ok(Math.abs(s[0].start - 12.3456) < 1e-3 && Math.abs(s[0].end - 13.4567) < 1e-3, '第一段起止正确');
  const un = C.parseSilences('[silencedetect] silence_start: 3595.0', 3600);
  ok(un.length === 1 && un[0].end === 3600, '末尾未闭合的静音按 duration 收尾', j(un));
  ok(C.parseSilences('', 100).length === 0 && C.parseSilences(null, 100).length === 0, '空输入安全');
}

/* ── 分片规划：无静音时按名义切点 ── */
{
  const dur = 3 * 3600;                                  // 3 小时
  const ch = C.planAudioChunks({ duration: dur });
  ok(ch.length === 8, '3 小时 → 8 片（7×25 分 + 5 分尾巴）', ch.length);
  ok(ch[0].start === 0 && ch[0].end === 1500, '第一片 0~25 分', j(ch[0]));
  ok(ch.every(c => c.end - c.start >= 60), '每片都 ≥ 1 分钟');
  // 完整性: 首尾相接、无重叠、覆盖 [0,dur]
  let okCover = Math.abs(ch[0].start) < 1e-6 && Math.abs(ch[ch.length - 1].end - dur) < 1e-6;
  for (let i = 1; i < ch.length; i++) if (Math.abs(ch[i].start - ch[i - 1].end) > 1e-6) okCover = false;
  ok(okCover, '分片首尾相接、无重叠、完整覆盖');
}

/* ── 分片规划：静音优先（切点落在静音中点）── */
{
  const dur = 3 * 3600;
  // 在 25 分钟附近、50 分钟附近各放一段静音（离名义切点的偏差 20 秒 / -35 秒）
  const sil = [{ start: 1500 + 18, end: 1500 + 22 }, { start: 3000 - 37, end: 3000 - 33 }];
  const ch = C.planAudioChunks({ duration: dur, silences: sil });
  ok(Math.abs(ch[0].end - 1520) < 1e-6, '第一刀落在静音中点(1520s)', ch[0].end);
  ok(Math.abs(ch[1].end - 2965) < 1e-6, '第二刀落在静音中点(2965s)', ch[1].end);
  ok(ch[1].start === ch[0].end, '两片仍然首尾相接');
  // 静音离名义切点太远 → 不采用
  const far = C.planAudioChunks({ duration: dur, silences: [{ start: 1200, end: 1201 }] });
  ok(far[0].end === 1500, '静音离切点太远时不采用', far[0].end);
  // 静音太靠后（会造成 1 分钟内的尾巴）→ 不采用
  const late = C.planAudioChunks({ duration: dur, silences: [{ start: dur - 30, end: dur - 25 }] });
  ok(late[late.length - 1].end === dur, '尾巴过小时不采用该静音');
}

/* ── 边界: 短视频不分片 / 时长未知 ── */
{
  const one = C.planAudioChunks({ duration: 10 * 60 });
  ok(one.length === 1 && one[0].start === 0 && Math.abs(one[0].end - 600) < 1e-6, '10 分钟 → 单片的整段');
  ok(C.planAudioChunks({ duration: 0 }).length === 0, '时长未知 → 返回 []（交由调用方决定不分片）');
  ok(C.planAudioChunks({ duration: -5 }).length === 0, '负时长 → []');
  const exact = C.planAudioChunks({ duration: 1500 });
  ok(exact.length === 1, '正好 25 分钟 → 1 片', exact.length);
  const tail = C.planAudioChunks({ duration: 1500 + 30 });   // 25 分 30 秒: 尾巴太小
  ok(tail.length === 1, '超出但尾巴 <1 分钟 → 仍 1 片', tail.length);
}

/** 偏移合并 ── */
{
  const parts = [
    { offset: 0, segments: [
      { start: 1, end: 2, text: 'A', words: [{ word: 'a', start: 1, end: 2 }] },
      { start: 3, end: 4, text: 'B', words: [] },
    ] },
    { offset: 100, segments: [
      { start: 0.5, end: 1.5, text: 'C', words: [{ word: 'c', start: 0.5, end: 1.5 }] },
      { start: 2, end: 2, text: '零长', words: [] },        // 丢弃
      { start: 3, end: 4, text: '   ', words: [] },          // 空文本 → 丢弃
    ] },
  ];
  const m = C.mergeChunkSegments(parts);
  ok(m.length === 3, '合并后 3 句（丢掉零长与空文本）', j(m.map(x => x.text)));
  ok(m[0].text === 'A' && m[1].text === 'B' && m[2].text === 'C', '按起点排序');
  ok(Math.abs(m[2].start - 100.5) < 1e-6 && Math.abs(m[2].end - 101.5) < 1e-6, '第二片时间戳加回偏移', j(m[2]));
  ok(Math.abs(m[2].words[0].start - 100.5) < 1e-6, '逐词时间戳也加偏移', j(m[2].words));
  ok(C.mergeChunkSegments([]).length === 0 && C.mergeChunkSegments(null).length === 0, '空输入安全');
  // 边界重复（同一句两片都识别到）→ 只留一句
  const dup = C.mergeChunkSegments([
    { offset: 0, segments: [{ start: 1498, end: 1501, text: 'Same', words: [] }] },
    { offset: 1500, segments: [{ start: 0.1, end: 1.1, text: 'Same', words: [] }] },
  ]);
  ok(dup.length === 1, '切点处的重复句被去掉', j(dup));
}

/* ── 片间等待：云端 10~15 秒随机 ── */
{
  ok(C.randomWaitMs(10000, 15000, () => 0) === 10000, 'rnd=0 → 下限 10 秒');
  ok(C.randomWaitMs(10000, 15000, () => 1) === 15000, 'rnd=1 → 上限 15 秒');
  let allIn = true;
  for (let i = 0; i < 200; i++) { const w = C.randomWaitMs(); if (w < 10000 || w > 15000) allIn = false; }
  ok(allIn, '默认随机值始终落在 10~15 秒内');
  ok(C.CLOUD_WAIT_MIN_MS === 10000 && C.CLOUD_WAIT_MAX_MS === 15000, '云端等待常量 = 10s/15s');
}

/* ── 串行调度：顺序、等待、进度、取消、偏移 ── */
await (async () => {
  const chunks = C.planAudioChunks({ duration: 3 * 3600 });
  const calls = [], waits = [], logs = [], prog = [];
  const fakeSleep = async (ms) => { waits.push(ms); };
  const r = await C.runChunks({
    chunks,
    runOne: async (c, i) => { calls.push(i); return { segments: [{ start: 0.2, end: 1.2, text: 'chunk' + i, words: [] }], engine: 'fake' }; },
    waitBetweenMs: (i) => (i % 2 ? 10000 : 15000),
    onProgress: (done, total) => prog.push(done + '/' + total),
    log: (m) => logs.push(m),
    sleep: fakeSleep,
  });
  ok(calls.length === chunks.length && calls.join(',') === chunks.map((_, i) => i).join(','), '严格串行、按顺序跑完每一片', j(calls));
  ok(waits.length === chunks.length - 1, '片间等待次数 = 片数-1（最后一片不等）', waits.length);
  ok(waits.every(w => w === 10000 || w === 15000), '等待时长来自注入的策略', j(waits.slice(0, 3)));
  ok(prog[prog.length - 1] === chunks.length + '/' + chunks.length, '进度走到最后一片', prog[prog.length - 1]);
  ok(r.perChunk.length === chunks.length && r.perChunk[0].segments === 1, '每片结果都被记录（分片数据）');
  const merged = C.mergeChunkSegments(r.parts);
  ok(merged.length === chunks.length, '合并后每片各贡献一句', merged.length);
  const expectLastOffset = chunks[chunks.length - 1].start;
  ok(Math.abs(merged[merged.length - 1].start - (expectLastOffset + 0.2)) < 1e-6, '最后一片的偏移正确', merged[merged.length - 1].start);
  // 本地: 不等候
  waits.length = 0;
  await C.runChunks({ chunks, runOne: async () => ({ segments: [] }), waitBetweenMs: null, sleep: fakeSleep });
  ok(waits.length === 0, '本地模式（waitBetweenMs=null）片间不等候');
  // 取消
  const ctl = new AbortController();
  let ran = 0;
  try {
    await C.runChunks({
      chunks, signal: ctl.signal, sleep: fakeSleep,
      runOne: async () => { ran++; if (ran === 2) ctl.abort(); return { segments: [] }; },
      waitBetweenMs: () => 10000,
    });
    ok(false, '取消后应当抛错');
  } catch (e) {
    ok(/已取消/.test(e.message), '取消时抛出「已取消」', e.message);
    ok(ran === 2, '取消后不再继续下一片', ran);
  }
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
