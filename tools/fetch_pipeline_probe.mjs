/* 下载初稿流水线真机探针:
 *   POST /api/projects {draft:true, fetch:{url, quality}} → 建项目(阶段=下载中) →
 *   后台下载(bilibili 真机) → 断言:
 *     ① 建项目立刻返回 id, 卡片状态=下载中 且 fetching=true(不会显示"找不到视频")
 *     ② 进度在走, 且最后离开"下载中"
 *     ③ 视频落在**项目目录内** video/ 里, 大小>1MB
 *     ④ source.json 写出来了(标题/UP/时长), meta.source 也填了
 *     ⑤ 交棒成功: prepare 跑过(项目里有 audio.wav) 或 流水线已推进到 ASR 阶段
 *   最后删掉测试项目(连视频一起)。
 * 注意: 仓库没装语音识别模型时, 这条流水线**必然**在 ASR 阶段失败 —— 那是预期结果,
 *       探针只要求"走到 ASR"(证明下载→prepare→ASR 的交接是通的)。 */
import { launch } from './lib/cdp.mjs';
import { readFileSync, existsSync, statSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8360';
const PROJ = process.env.PROJ_DIR || 'D:/Vibe Coding/SubFabric/projects';
const URL = process.env.VIDEO_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7';
const QUALITY = process.env.QUALITY || '360';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = async () => (await (await fetch(BASE + '/api/projects')).json()).projects || [];
const one = async (id) => { try { return await (await fetch(BASE + '/api/projects/' + id)).json(); } catch { return null; } };

let id = '';
try {
  /* ① 建项目（链接模式） */
  const body = JSON.stringify({ name: '', draft: true, wordLevel: false, speakers: false, fetch: { url: URL, quality: QUALITY } });
  const r = await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const created = await r.json();
  ok(r.status === 200 && !!created.id, '建项目返回 id', r.status + ' ' + JSON.stringify(created).slice(0, 120));
  id = created.id;
  if (!id) process.exit(1);
  console.log('  测试项目:', id);

  await sleep(1200);
  const l0 = (await list()).find((p) => p.id === id) || {};
  console.log('  卡片初始:', JSON.stringify({ stage: l0.draft && l0.draft.stage, prog: l0.draft && l0.draft.progress, fetching: l0.fetching, videoExists: l0.videoExists }));
  ok(!!l0.fetching, '① fetching=true（卡片不显示"找不到视频"）', l0.fetching);
  ok(!l0.videoExists, '① 此时视频确实还没落盘', l0.videoExists);

  /* ② 等它下载完（进度要真的在走） */
  const seen = new Set();
  let lastStage = '', lastProg = -1, moved = false;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const p = (await list()).find((x) => x.id === id) || {};
    const d = p.draft || {};
    if (d.stage) seen.add(d.stage);
    if (d.progress !== lastProg) { moved = moved || (d.progress > lastProg && lastProg >= 0); lastProg = d.progress; }
    if (d.stage && d.stage !== '下载中') { moved = true; lastStage = d.stage; break; }
    if (d.status && d.status !== 'running') { lastStage = d.stage || d.status; break; }
  }
  console.log('  经历过的阶段:', Array.from(seen).join(' → '), ' 最后:', lastStage, ' 最后进度:', lastProg);
  ok(moved, '② 进度确实在走（不是卡住）', Array.from(seen).join(','));
  ok(!seen.has('下载中') || lastStage !== '下载中', '② 最后离开了"下载中"', lastStage);

  /* ③④ 落盘检查 */
  const meta = await one(id);
  const vpath = (meta.video && meta.video.path) || '';
  const inProj = vpath.replace(/\\/g, '/').startsWith(PROJ.replace(/\\/g, '/') + '/' + id + '/');
  ok(!!vpath && inProj, '③ 视频路径在项目目录内', vpath);
  ok(!!vpath && existsSync(vpath) && statSync(vpath).size > 1048576, '③ 视频文件真实存在且 >1MB', vpath ? Math.round(statSync(vpath).size / 1048576 * 10) / 10 + ' MB' : 'missing');
  const srcPath = `${PROJ}/${id}/source.json`;
  ok(existsSync(srcPath), '④ source.json 已写出', srcPath);
  if (existsSync(srcPath)) {
    const src = JSON.parse(readFileSync(srcPath, 'utf8'));
    console.log('  source.json:', JSON.stringify({ site: src.source, title: (src.title || '').slice(0, 30), uploader: src.uploader, duration: src.duration, height: src.height, size: Math.round((src.fileSize || 0) / 1048576 * 10) / 10 + 'MB' }));
    ok(!!src.title, '④ 元数据里有标题（给 LLM 分角色用）', src.title);
    ok(src.source === 'bilibili', '④ 站点判定正确', src.source);
    ok(Number(src.duration) > 0, '④ 时长 > 0', src.duration);
  }
  ok(!!(meta.source && (meta.source.title || meta.source.description)), '④ meta.source 已回填', JSON.stringify(meta.source || {}).slice(0, 90));
  ok(String(meta.name || '') !== '', '④ 项目名已用视频标题（原来只有 BV 号）', meta.name);

  /* ⑤ 交棒 */
  const hasWav = existsSync(`${PROJ}/${id}/audio.wav`);
  const st = (meta.prepare && meta.prepare.status) || '';
  const dstage = (meta.draft && meta.draft.stage) || '';
  console.log('  prepare:', st, ' 音频:', hasWav, ' draft.stage:', dstage, ' draft:', JSON.stringify({ status: meta.draft && meta.draft.status, msg: meta.draft && meta.draft.message, err: meta.draft && meta.draft.error }).slice(0, 200));
  ok(hasWav || st === 'done' || dstage !== '下载中', '⑤ 交棒成功：prepare 跑过 / 已推进到后续阶段', 'wav=' + hasWav + ' prepare=' + st + ' stage=' + dstage);
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  if (id) { try { await fetch(BASE + '/api/projects/' + id, { method: 'DELETE' }); console.log('已删除测试项目（连视频一起）'); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
