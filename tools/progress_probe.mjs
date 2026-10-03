/* 首页卡片进度条一致性: 条的宽度% == 右边的数字% == 服务端 draft.progress（动画结束后），
 * 并且动画期间两者也不能差太多（条 420ms / 数字 420ms, 必须同步）。 */
import { launch, sleep } from './lib/cdp.mjs';
import { readFileSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8356';
const IDS = JSON.parse(readFileSync('D:/Vibe Coding/_t/progress_ids.json', 'utf8'));
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

/* 从 Node 侧轮询采样（页面里的 rAF 循环在 CDP eval 里活不下来）。
 * 先 reload 一次, 这样一定盖住"卡片首次渲染"那一帧 —— 那时 --from = 0, 条和数字都在动。 */
const SAMPLE_JS = `(() => JSON.stringify(Array.from(document.querySelectorAll('.proj-card')).map(c => {
  const track = c.querySelector('.pc-draft-bar'), inner = c.querySelector('.pc-draft-bar-in'), num = c.querySelector('.pc-draft-txt .pct');
  if (!track || !inner || !num) return null;
  const tw = track.getBoundingClientRect().width, iw = inner.getBoundingClientRect().width;
  return {
    name: ((c.querySelector('.pc-name') || {}).textContent || '').trim(),
    barPct: Math.round(iw / Math.max(1, tw) * 100),
    numPct: parseInt(String(num.textContent).replace(/[^0-9]/g, ''), 10) || 0,
  };
}).filter(Boolean)))()`;

const b = await launch({ port: 9421, width: 1440, height: 900 });
try {
  await b.goto(BASE + '/');
  await sleep(1200);
  const samples = [];
  await b.send('Page.reload', {});
  for (let i = 0; i < 26; i++) {
    await sleep(50);
    try {
      const arr = JSON.parse(await b.eval(SAMPLE_JS));
      for (const s of arr) samples.push(s);
    } catch {}
  }
  await sleep(900);

  const samples2 = samples;
  // 注意 .pc-name 里除了项目名还带状态徽标（如 "进度探针-done 完毕"）→ 用前缀匹配
  const pick = (name) => samples2.filter(s => s.name.startsWith(name));
  const server = (await (await fetch(BASE + '/api/projects')).json()).projects;

  console.log('  服务端状态:', server.filter(p => /进度探针/.test(p.name)).map(p => p.name + '=' + ((p.draft || {}).progress) + '%').join('  '));
  for (const st of ['running', 'paused', 'done', 'error']) {
    const want = IDS.find(x => x.key === st);
    const srv = server.find(p => p.id === want.id) || {};
    const target = Number((srv.draft || {}).progress);
    const arr = pick(want.name);
    if (!arr.length) { ok(false, `${st}: 找到了卡片`, 'no samples'); continue; }
    const last = arr[arr.length - 1];
    const maxDiff = Math.max(...arr.map(s => Math.abs(s.barPct - s.numPct)));
    console.log(`  ${st}: 采样 ${arr.length} 次, 末值 bar=${last.barPct}% num=${last.numPct}%, 服务端=${target}%, 动画期最大差=${maxDiff}`);
    ok(Math.abs(last.barPct - last.numPct) <= 1, `${st}: 条与数字一致（±1）`, last.barPct + ' vs ' + last.numPct);
    ok(Math.abs(last.numPct - target) <= 1, `${st}: 数字 == 服务端 progress`, last.numPct + ' vs ' + target);
    ok(maxDiff <= 12, `${st}: 动画期间两者也没拉开（≤12）`, maxDiff);
  }
  await b.shot('D:/Vibe Coding/_t/shots/progress-cards.png');
  console.log('  已截图 progress-cards.png');
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  for (const it of IDS) { try { await fetch(BASE + '/api/projects/' + it.id, { method: 'DELETE' }); } catch {} }
  console.log('已删除 4 个临时项目');
  b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
