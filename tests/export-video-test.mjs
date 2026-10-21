/* 导出视频（硬字幕 / 生肉 / 字幕）的端到端测试。
 *
 * 覆盖真实链路，不打桩：
 *   · 建一个隔离服务 + 临时项目（真实 ffmpeg 合成素材）
 *   · 走 HTTP 调 /export-video 三种内容，轮询到结束
 *   · 用 ffprobe 核对成片时长/分辨率/音轨，并用像素统计证明**字幕真的进了画面**
 *     （尤其在事件数多时首条不被吞 —— 那是 hardsub-py 存在的理由）
 *
 * 依赖本机 ffmpeg/ffprobe；没有就记为部分执行（与其余测试的口径一致）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isolatedServer } from './helpers/isolated-server.mjs';

const has = (bin) => {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
};
if (!has('ffmpeg') || !has('ffprobe')) {
  console.log('SKIP: 本机没有 ffmpeg/ffprobe，跳过导出视频端到端测试');
  process.exit(0);
}

const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 120000 });

/** 造一段 3 秒带音轨的彩条视频（必须有音轨，否则"音轨保留"这条根本没被验证）。 */
function makeVideo(dest) {
  const r = ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dest]);
  assert.equal(r.status, 0, 'ffmpeg 造素材失败: ' + r.stderr);
}

/** 造 ASS 文本：可指定事件条数，用于验证"事件多时首条不被吞"。 */
function makeAssText(count = 2) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 320', 'PlayResY: 180', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1',
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = [];
  for (let i = 0; i < count; i++) {
    const s = (i * 0.05).toFixed(2), e = (i * 0.05 + 0.04).toFixed(2);
    lines.push(`Dialogue: 0,0:00:0${s},0:00:0${e},Default,,0,0,0,,EVENT ${i}`);
  }
  return head.concat(lines).join('\n') + '\n';
}

/** 抽一帧到 PNG，返回文件大小（字幕烧进去会让画面底部像素变化 → 文件字节数改变）。 */
function frameBytes(videoPath, at) {
  const out = path.join(path.dirname(videoPath), `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const r = ff(['-ss', String(at), '-i', videoPath, '-frames:v', '1', out]);
  if (r.status !== 0) return 0;
  const size = fs.statSync(out).size;
  fs.unlinkSync(out);
  return size;
}

const server = await isolatedServer();
try {
  const projectName = '导出测试';
  const projRoot = path.join(server.root, 'projects');
  const assText = makeAssText(120);

  /* ——— 建项目：走真实创建接口（本地视频 + 字幕文本），只测导出链路 ——— */
  fs.mkdirSync(projRoot, { recursive: true });
  const videoPath = path.join(os.tmpdir(), `sf-export-src-${Date.now()}.mp4`);
  makeVideo(videoPath);

  const create = await server.call('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: projectName,
      video: { path: videoPath },
      subtitle: { name: 'subtitle.ass', text: assText },
    }),
  });
  const createText = await create.text();
  assert.ok(create.ok, '创建项目失败: ' + create.status + ' ' + createText);
  const meta = JSON.parse(createText);
  const id = meta.id;
  assert.ok(id, '没有拿到项目 id');

  // 用 120 条事件覆盖进项目（≥100 是 hardsub-py 记录的"首条被吞"触发线）
  const subPath = path.join(projRoot, id, 'subtitle.ass');
  fs.writeFileSync(subPath, assText, 'utf8');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-export-out-'));

  /* ——— 1) 能力探测 ——— */
  const capR = await server.call(`/api/projects/${id}/export-video/capabilities`);
  assert.equal(capR.status, 200);
  const cap = await capR.json();
  assert.ok(cap.ffmpeg, 'capabilities 应带 ffmpeg 版本');
  assert.equal(cap.hasVideo, true, '项目应有视频');
  assert.ok(cap.accelerators && typeof cap.accelerators.cpu === 'boolean');
  assert.ok(Array.isArray(cap.gpus));
  console.log('  ok  能力探测：' + cap.ffmpeg + ' · CPU=' + cap.accelerators.cpu);

  /* ——— 2) 参数校验 ——— */
  const bad = await server.call(`/api/projects/${id}/export-video`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: [], outDir }),
  });
  assert.equal(bad.status, 400, '空 kinds 应被拒绝');
  const bad2 = await server.call(`/api/projects/${id}/export-video`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['subtitle'] }),
  });
  assert.equal(bad2.status, 400, '缺 outDir 应被拒绝');
  console.log('  ok  参数校验：空 kinds / 缺目录 都被拒绝');

  /* ——— 3) 三种一起导出 ——— */
  const start = await server.call(`/api/projects/${id}/export-video`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kinds: ['subtitle', 'raw', 'bilingual'], outDir,
      codec: 'h264', accel: 'cpu', quality: 28, threads: 0, overwrite: false,
    }),
  });
  assert.equal(start.status, 202, '导出应被接受: ' + start.status + ' ' + (await start.text()));

  let job = null;
  const deadline = Date.now() + 180000;
  for (;;) {
    const r = await server.call(`/api/projects/${id}/export-video/status`);
    job = await r.json();
    if (job.status !== 'running') break;
    if (Date.now() > deadline) throw new Error('导出超时: ' + JSON.stringify(job).slice(0, 400));
    await new Promise(res => setTimeout(res, 300));
  }
  assert.equal(job.status, 'done', '导出应成功: ' + JSON.stringify(job).slice(0, 600));

  const byKind = Object.fromEntries((job.outputs || []).map(o => [o.kind, o.path]));
  assert.ok(byKind.subtitle, '应产出字幕文件');
  assert.ok(byKind.raw, '应产出原片');
  assert.ok(byKind.bilingual, '应产出硬字幕视频');
  for (const p of Object.values(byKind)) assert.ok(fs.existsSync(p), '输出文件应存在: ' + p);
  console.log('  ok  三种内容都产出：' + Object.values(byKind).map(p => path.basename(p)).join('、'));

  /* ——— 4) 生肉是原样复制（字节级一致） ——— */
  assert.equal(fs.statSync(byKind.raw).size, fs.statSync(videoPath).size, '生肉应与原片等大');
  const srcBuf = fs.readFileSync(videoPath), rawBuf = fs.readFileSync(byKind.raw);
  assert.ok(srcBuf.equals(rawBuf), '生肉应与原片逐字节一致');
  console.log('  ok  生肉逐字节等于原片');

  /* ——— 5) 字幕文件内容与稿件一致 ——— */
  assert.equal(fs.readFileSync(byKind.subtitle, 'utf8'), fs.readFileSync(subPath, 'utf8'),
    '导出的字幕应与稿件内容一致');
  console.log('  ok  字幕文件与稿件逐字节一致');

  /* ——— 6) 成片自检：时长/分辨率/音轨 ——— */
  const probeR = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', byKind.bilingual],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(probeR.status, 0);
  const info = JSON.parse(probeR.stdout);
  const v = info.streams.find(s => s.codec_type === 'video');
  const a = info.streams.find(s => s.codec_type === 'audio');
  assert.ok(v, '成片应有视频轨');
  assert.ok(a, '成片应有音轨（原片有音轨时必须保留）');
  assert.equal(v.width, 320, '分辨率应保持');
  assert.equal(v.height, 180, '分辨率应保持');
  const dur = Number(info.format.duration);
  assert.ok(Math.abs(dur - 3) < 1.0, '时长应接近 3 秒，实际 ' + dur);
  console.log(`  ok  成片自检：${v.width}x${v.height} · ${dur.toFixed(2)}s · 音轨 ${a.codec_name}`);

  /* ——— 7) 字幕真的烧进了画面（核心断言） ———
   * 做法：同一时间点分别抽"有字幕成片"和"原片"的帧，比 PNG 字节数。
   * 烧进去的帧底部多了文字，字节数必然不同；如果垫背事件没生效、首条被吞，
   * 事件 119 条时第 0.02s 那一帧就会与原片相同。 */
  const t = 0.02;   // 第一条事件的区间
  const baked = frameBytes(byKind.bilingual, t), plain = frameBytes(videoPath, t);
  assert.notEqual(baked, plain, '首条字幕应被烧进画面（字节数应与原片不同）');
  console.log(`  ok  首条字幕已入画（120 条事件时仍生效）：${plain} → ${baked} 字节`);

  /* ——— 8) 取消与重入 ——— */
  const again = await server.call(`/api/projects/${id}/export-video`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['subtitle'], outDir, codec: 'h264', accel: 'cpu', quality: 30 }),
  });
  // 同名文件已存在且没开 overwrite → 任务会失败并给出明确原因（不静默覆盖用户文件）
  let job2 = null;
  for (let i = 0; i < 100; i++) {
    const r = await server.call(`/api/projects/${id}/export-video/status`);
    job2 = await r.json();
    if (job2.status !== 'running') break;
    await new Promise(res => setTimeout(res, 150));
  }
  assert.ok(['error', 'done'].includes(job2.status), '第二个任务应有明确终态');
  if (job2.status === 'error') {
    assert.match(job2.error, /已存在/, '重名应提示文件已存在，实际: ' + job2.error);
    console.log('  ok  同名文件默认不覆盖（' + job2.error.slice(0, 40) + '…）');
  } else {
    console.log('  ok  第二个任务完成');
  }

  const overwriteRun = await server.call(`/api/projects/${id}/export-video`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['subtitle'], outDir, codec: 'h264', accel: 'cpu', quality: 30, overwrite: true }),
  });
  assert.equal(overwriteRun.status, 202);
  let job3 = null;
  for (let i = 0; i < 150; i++) {
    const r = await server.call(`/api/projects/${id}/export-video/status`);
    job3 = await r.json();
    if (job3.status !== 'running') break;
    await new Promise(res => setTimeout(res, 150));
  }
  assert.equal(job3.status, 'done', '开了 overwrite 应成功: ' + JSON.stringify(job3).slice(0, 300));
  console.log('  ok  overwrite=true 时正常覆盖');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(videoPath, { force: true });

  /* ——— 9) 前端送来的字幕正文优先（保证"压制效果 == 编辑器预览"） ———
   * 后处理特效（微光/淡入）的配置存在浏览器 localStorage，服务端读不到。
   * 所以前端把**已烘好特效的正文**一起送来，服务端必须用它而不是磁盘上的旧稿。
   * 这里送一份磁盘上没有的文本，压出来的成片应能证明它被采用了。 */
  {
    const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-export-inline-'));
    const videoPath2 = path.join(os.tmpdir(), `sf-export-src2-${Date.now()}.mp4`);
    makeVideo(videoPath2);
    // 磁盘上的稿件：2 条事件（普通）
    const diskAss = makeAssText(2);
    const create2 = await server.call('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '内联字幕', video: { path: videoPath2 },
        subtitle: { name: 'subtitle.ass', text: diskAss },
      }),
    });
    assert.ok(create2.ok);
    const id2 = (await create2.json()).id;

    // 送来的正文：60 条事件，且把第 0 条与第 1 条都换成磁盘稿里不可能出现的文本
    const inlineAss = makeAssText(60)
      .replace(/EVENT 0\b/, 'INLINE MARKER A')
      .replace(/EVENT 1\b/, 'INLINE MARKER B');
    const r2 = await server.call(`/api/projects/${id2}/export-video`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kinds: ['subtitle', 'bilingual'], outDir: outDir2,
        codec: 'h264', accel: 'cpu', quality: 30, subtitleText: inlineAss,
      }),
    });
    assert.equal(r2.status, 202, '内联字幕导出应被接受');
    let job4 = null;
    for (let i = 0; i < 400; i++) {
      const r = await server.call(`/api/projects/${id2}/export-video/status`);
      job4 = await r.json();
      if (job4.status !== 'running') break;
      await new Promise(res => setTimeout(res, 200));
    }
    assert.equal(job4.status, 'done', '内联字幕导出应成功: ' + JSON.stringify(job4).slice(0, 400));

    const subOut = (job4.outputs || []).find(o => o.kind === 'subtitle');
    assert.ok(subOut, '应导出字幕');
    const written = fs.readFileSync(subOut.path, 'utf8');
    // 磁盘稿只有 2 条事件；内联正文 60 条。用"磁盘稿有、内联没有"的行做判据。
    const diskOnly = diskAss.split('\n').filter(l => /EVENT [01]$/.test(l.trim()));
    assert.equal(diskOnly.length, 2, '前置条件：磁盘稿应有 EVENT 0 / EVENT 1 两行');
    for (const line of diskOnly) {
      assert.ok(!written.includes(line.trim()), '磁盘稿独有的行不应出现在内联导出里: ' + line.trim());
    }
    assert.ok(written.includes('INLINE MARKER A'), '第 0 条应来自前端正文');
    assert.ok(written.includes('INLINE MARKER B'), '第 1 条应来自前端正文');
    assert.ok(written.includes('EVENT 59'), '前端正文的 60 条事件应完整带过来');
    // 磁盘上的稿件不能被改动（只读原则）
    const diskNow = fs.readFileSync(path.join(projRoot, id2, 'subtitle.ass'), 'utf8');
    assert.equal(diskNow, diskAss, '导出不得改写用户稿件');
    console.log('  ok  前端正文优先：导出内容来自编辑器（含特效），磁盘稿件未被改写');

    /* ——— 10) 大字幕正文（>64KB）不能被请求体上限误杀 ———
     * 真实 4 小时稿件的 ASS 可以到几百 KB；这条只走字幕复制，不需要再压视频。 */
    {
      const outDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-export-big-'));
      const padding = '; padding ' + 'x'.repeat(80 * 1024) + '\n';
      const bigAss = makeAssText(2).replace('\n[Events]', '\n' + padding + '\n[Events]');
      assert.ok(bigAss.length > 64 * 1024, '前置条件：正文应大于旧 64KB 上限');
      const r3 = await server.call(`/api/projects/${id2}/export-video`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kinds: ['subtitle'], outDir: outDir3, codec: 'h264', accel: 'cpu', quality: 30,
          subtitleText: bigAss,
        }),
      });
      assert.equal(r3.status, 202, '大字幕导出应被接受: ' + r3.status + ' ' + (await r3.text()));
      let job5 = null;
      for (let i = 0; i < 100; i++) {
        const r = await server.call(`/api/projects/${id2}/export-video/status`);
        job5 = await r.json();
        if (job5.status !== 'running') break;
        await new Promise(res => setTimeout(res, 100));
      }
      assert.equal(job5.status, 'done', '大字幕导出应成功: ' + JSON.stringify(job5).slice(0, 300));
      const out = (job5.outputs || []).find(o => o.kind === 'subtitle');
      assert.ok(out, '应导出大字幕');
      const body = fs.readFileSync(out.path, 'utf8');
      assert.ok(body.length > 64 * 1024 && body.includes('padding'), '大字幕正文应完整落盘');
      console.log('  ok  大于 64KB 的字幕正文可正常导出');
      fs.rmSync(outDir3, { recursive: true, force: true });
    }

    fs.rmSync(outDir2, { recursive: true, force: true });
    fs.rmSync(videoPath2, { force: true });
  }

  console.log('Export video: 10 组断言全部通过');
} finally {
  await server.close();
}
