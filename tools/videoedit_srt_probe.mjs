/* 视频区就地编辑（单击字幕 → 就地改那一段；双击字幕 → 整行弹窗）端到端验证 · **SRT 路径**（与 videoedit_probe.mjs 的 ASS 路径成对）。
 * 跑法: node tools/videoedit_srt_probe.mjs
 *
 * 与 ASS 路径的区别（也是"SRT 编辑逻辑尽量同步"的关键）：
 *   SRT 字幕是真实 HTML 层（#srt-overlay 的 .ov-line），所以几何**不需要估算** ——
 *   行矩形来自 getBoundingClientRect，片段边界来自逐字符 Range。
 *   于是这里的验证口径也不同：拿 DOM 自己的真值对照程序给的几何（不需要截图/像素），
 *   但"点哪个片段/写盘写了什么"两条路径必须完全一致。
 */
import { launch, sleep } from './lib/cdp.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'outputs');
const TMP = resolve(ROOT, 'tmp-test');
const PORT = 8322;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};

/* ── 1. 夹具：SRT 双语（第 1 行=主语言中文，其余=副语言英文，与编辑器约定一致） ── */
const VIDEO = resolve(TMP, 'sample.mp4');
if (!existsSync(VIDEO)) {
  console.error('缺测试视频 ' + VIDEO + '\n用 ffmpeg 生成一个即可:\n'
    + '  ffmpeg -v error -y -f lavfi -i "color=c=0x101216:size=1280x720:rate=10:duration=12" -pix_fmt yuv420p -c:v libx264 ' + VIDEO);
  process.exit(1);
}
const ZH1 = '[Wemmbu] 一路打到决赛 才有机会击败Flame';
const EN1 = 'battling my way to the finale to even have a chance at defeating Flame.';
const ZH2 = '他亲手封禁了我们服务器的几百名玩家 自己却从未接近过死亡';
const EN2 = "He's personally banned hundreds of players off our server, without even coming close to death himself once.";
const t0 = '00:00:01,000 --> 00:00:06,000';
const t1 = '00:00:06,500 --> 00:00:11,000';
const SRT_TEXT = `1\r\n${t0}\r\n${ZH1}\r\n${EN1}\r\n\r\n2\r\n${t1}\r\n${ZH2}\r\n${EN2}\r\n\r\n`;
writeFileSync(resolve(TMP, 'sample.srt'), SRT_TEXT, 'utf8');

/* ── 2. 起服务 + 建项目 ── */
const srv = spawn(process.execPath, [resolve(ROOT, 'editor/server.js')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(PORT) },
});
async function waitHttp(url, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}
if (!await waitHttp(BASE + '/editor/index.html')) { console.error('服务没起来'); srv.kill(); process.exit(1); }
const pr = await fetch(BASE + '/api/projects', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '【探针】SRT 就地编辑', video: { path: VIDEO }, subtitle: { name: 'sample.srt', text: SRT_TEXT } })
});
const proj = await pr.json();
if (!pr.ok) { console.error('建项目失败', pr.status, proj); srv.kill(); process.exit(1); }
console.log('projectId =', proj.id);

const subFile = resolve(ROOT, 'projects', proj.id, 'subtitle.srt');
const readSub = () => (existsSync(subFile) ? readFileSync(subFile, 'utf8') : '');

/* ── 3. 浏览器 ── */
const b = await launch({ url: `${BASE}/editor/index.html#/project/${proj.id}`, port: 9334, width: 1600, height: 1000 });
let exitCode = 1;
try {
  const key = async (keyName, vk, modifiers = 0) => {
    const base = { key: keyName, code: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await b.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
    await b.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  };
  /** 打开就地编辑框 = **单击**字幕那一段（手势：单击就地编辑 / 双击整行弹窗）。
   *  必须等过 CUE_CLICK_DELAY(240ms) 那个双击窗口，框才会真的出来。 */
  const openInline = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await b.mouse(type, x, y, { clickCount: 1 });
    await sleep(1200);   // 盖过被节流的 240ms 双击窗口
  };
  /** 页面里量一个纯文本行的"逐字符左边缘"（探针自己的实现，独立于 videoedit.js）。
   *  needle 精确匹配优先，否则前缀匹配 —— 文本被改过之后仍然能定位到同一行。 */
  const charX = (needle) => b.eval(`(() => {
    const st = document.getElementById('video-stage').getBoundingClientRect();
    const all = [...document.querySelectorAll('#srt-overlay .ov-line')];
    const el = all.find(e => e.textContent === ${JSON.stringify(needle)})
      || all.find(e => e.textContent.startsWith(${JSON.stringify(needle)}));
    if (!el) return null;
    const out = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const s = node.nodeValue;
        for (let i = 0; i < s.length; i++) {
          const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
          const bb = r.getBoundingClientRect();
          out.push({ x: bb.left - st.left, y: bb.top + bb.height / 2 - st.top, w: bb.width });
        }
      } else if (node.nodeType === 1) { for (const c of node.childNodes) walk(c); }
    };
    walk(el);
    const r = el.getBoundingClientRect();
    return { chars: out, left: r.left - st.left, right: r.right - st.left,
      top: r.top - st.top, bottom: r.bottom - st.top, stageTop: st.top, stageLeft: st.left,
      text: el.textContent };
  })()`);
  const midOf = (m, from, to) => m.stageLeft + (m.chars[from].x + (m.chars[to].x + m.chars[to].w)) / 2;
  // charX 的 x/y 是 stage 相对（与 _layoutItems 同口径），派发鼠标事件要视口坐标 → 加回去
  const yOf = (m) => (m.top + m.bottom) / 2 + m.stageTop;

  await b.waitFor('!!window.__videoEditor', { timeout: 20000 });
  await b.waitFor('document.querySelectorAll("#cue-list .cue-card").length > 0', { timeout: 20000, label: '字幕列表' });
  await sleep(1500);

  /* ── 4. 加载为 SRT ── */
  console.log('\n=== 加载（SRT 路径） ===');
  const load = await b.eval(`(() => { const v = document.getElementById('video'); v.currentTime = 2; v.pause(); return v.currentTime; })()`);
  await sleep(900);
  const env = await b.eval(`(() => ({
    overlayShown: (() => { const o = document.getElementById('srt-overlay'); return !!o && o.style.display !== 'none'; })(),
    lines: [...document.querySelectorAll('#srt-overlay .ov-line')].map(e => e.textContent),
    cards: document.querySelectorAll('#cue-list .cue-card').length
  }))()`);
  console.log('  t =', load, ' 叠加层行:', JSON.stringify(env.lines), ' 列表卡片数:', env.cards);
  ok(env.overlayShown === true, 'SRT 叠加层已显示（就地编辑的几何来源）', env.overlayShown);
  ok(env.lines.length === 2 && env.lines[0] === ZH1 && env.lines[1] === EN1,
    't=2 时叠加层正好是第 1 句的两行', env.lines);
  ok(env.cards === 2, '右侧列表 2 张卡片（2 条 cue）', env.cards);

  /* ── 5. 几何：程序给的必须与 DOM 真值一致 ── */
  console.log('\n=== 几何（DOM 即真值） ===');
  const lay = await b.eval(`(() => {
    const ed = window.__videoEditor;
    const items = ed._layoutItems().map(it => ({ kind: it.kind, side: it.side, plain: it.plain,
      segs: it.segs.map(s => s.text), top: it.top, bottom: it.bottom, x0: it.x0, x1: it.x0 + it.adv[it.plain.length],
      segX: it.segs.map(s => [it.x0 + it.adv[s.start], it.x0 + it.adv[s.end]]) }));
    return items;
  })()`);
  const zh = lay.find(i => i.kind === 'srt' && i.plain === ZH1);
  const en = lay.find(i => i.kind === 'srt' && i.plain === EN1);
  ok(lay.length === 2 && !!zh && !!en, 't=2 估到 2 行 SRT（中文 / 英文）', lay.map(i => i.side));
  ok(zh && JSON.stringify(zh.segs) === JSON.stringify(['一路打到决赛', '才有机会击败Flame']),
    '中文行按空格切成 2 段，行首 [Wemmbu] 不进片段', zh && zh.segs);
  ok(en && en.segs.length === 14, '英文行按词切（14 个词）', en && en.segs.length);

  const mZh = await charX(ZH1), mEn = await charX(EN1);  ok(!!mZh && !!mEn, '能在叠加层里量到两行的逐字符位置', [!!mZh, !!mEn]);
  const geo = [
    ['中文行', zh, mZh],
    ['英文行', en, mEn],
  ].map(([name, it, m]) => {
    const dTop = Math.abs(it.top - m.top), dBot = Math.abs(it.bottom - m.bottom);
    const dLeft = Math.abs(it.x0 - m.chars[0].x), dRight = Math.abs(it.x1 - (m.chars[m.chars.length - 1].x + m.chars[m.chars.length - 1].w));
    console.log(`  ${name}: 程序 band=[${it.top.toFixed(1)},${it.bottom.toFixed(1)}] x=[${it.x0.toFixed(1)},${it.x1.toFixed(1)}]`,
      ` DOM band=[${m.top.toFixed(1)},${m.bottom.toFixed(1)}] x=[${m.chars[0].x.toFixed(1)},${(m.chars[m.chars.length - 1].x + m.chars[m.chars.length - 1].w).toFixed(1)}]`);
    return { name, dTop, dBot, dLeft, dRight };
  });
  ok(geo.every(g => g.dTop <= 2 && g.dBot <= 2), '两行的竖直范围 = DOM 行矩形（±2px）', geo.map(g => [+g.dTop.toFixed(1), +g.dBot.toFixed(1)]));
  ok(geo.every(g => g.dLeft <= 2 && g.dRight <= 2), '两行的水平范围 = DOM 文本范围（±2px）', geo.map(g => [+g.dLeft.toFixed(1), +g.dRight.toFixed(1)]));

  /* ── 6. 命中：片段 x 由 DOM 逐字符位置算出，不信程序自算的坐标 ── */
  console.log('\n=== 双击 → 就地编辑框 ===');
  const TAG = '[Wemmbu] ';
  const tagLen = TAG.length;                               // 9
  const SEG1 = [tagLen, tagLen + 6];                       // "一路打到决赛" 9..15
  const SEG2 = [tagLen + 7, tagLen + 15];                  // "才有机会击败Flame" 16..24
  const yzh = yOf(mZh);
  const x2 = midOf(mZh, SEG2[0], SEG2[1] - 1);             // 第 2 段的墨迹中点
  console.log('  DOM 逐字符量出：第 2 段中点 x =', x2.toFixed(1), ' 行内文字范围 =',
    `[${mZh.chars[0].x.toFixed(1)},${(mZh.chars[mZh.chars.length - 1].x + mZh.chars[mZh.chars.length - 1].w).toFixed(1)}]`);
  await openInline(x2, yzh);
  const st1 = await b.eval(`(() => {
    const ed = window.__videoEditor;
    const seg = document.getElementById('cue-seg-box').getBoundingClientRect();
    const st = document.getElementById('video-stage').getBoundingClientRect();
    return { open: ed.isOpen, value: document.getElementById('cie-input').value,
      side: ed.open ? ed.open.item.side : null, kind: ed.open ? ed.open.item.kind : null,
      segRect: { left: seg.left - st.left, top: seg.top - st.top, width: seg.width, height: seg.height },
      paused: document.getElementById('video').paused };
  })()`);
  ok(st1.open === true && st1.kind === 'srt', '双击后进入就地编辑（SRT 行）', st1);
  ok(st1.value === '才有机会击败Flame', '预填的是"按 DOM 位置点中的那一段"', st1.value);
  ok(Math.abs(st1.segRect.top - (mZh.top + 2)) <= 3 && st1.segRect.left >= mZh.chars[tagLen].x - 8,
    '高亮框落在该段的真实 DOM 位置上（且没盖住行首角色标签）',
    [st1.segRect.top, mZh.top + 2, st1.segRect.left, mZh.chars[tagLen].x]);
  ok(st1.paused === true, '进入编辑即暂停', st1.paused);
  await b.shot(resolve(OUT, 'videoedit-srt-1-inline.png'));

  /* 点行首角色标签处 → 不该命中任何片段（[角色] 是只读前缀，不参与编辑） */
  await key('Escape', 27);
  await sleep(250);
  await openInline(mZh.chars[1].x + mZh.stageLeft, yzh);
  const stTag = await b.eval(`window.__videoEditor.isOpen`);
  ok(stTag === false, '点行首 [Wemmbu] 标签处不进入编辑（角色标签不参与就地编辑）', stTag);

  /* ── 7. Enter 保存：只替换那一段，时间与其它行一字不动 ── */
  console.log('\n=== Enter 保存（只改那一段） ===');
  const before = readSub();
  await openInline(x2, yzh);
  await b.eval(`(() => { document.getElementById('cie-input').value = '才有机会击败FlameZ'; return 1; })()`);
  await key('Enter', 13);
  await sleep(2600);
  const after = readSub();
  console.log('  toast:', await b.eval(`(document.getElementById('toast')||{}).textContent || ''`));
  ok(after.includes(ZH1.replace('才有机会击败Flame', '才有机会击败FlameZ')), '磁盘 SRT 里该行只换了那一段（其余原文照旧）',
    after.split('\r\n').find(l => l.includes('FlameZ')));
  ok(after.includes(EN1) && after.includes(ZH2) && after.includes(EN2), '同一句的英文行 / 另一条 cue 都没被动', null);
  const times = (s) => (s.match(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/g) || []).join(',');
  ok(times(after) === times(before), '时间戳一个都没变（只改 Text 字段）', [times(before), times(after)]);
  const listHas = await b.eval(`[...document.querySelectorAll('#cue-list *')].map(e => e.textContent).join('|').includes('才有机会击败FlameZ')`);
  ok(listHas === true, '右侧列表同步显示新文本', listHas);
  await b.shot(resolve(OUT, 'videoedit-srt-2-after.png'));

  /* ── 8. 点框外 = 取消（不写盘） ── */
  console.log('\n=== 点框外即取消 ===');
  const before2 = readSub(), mt2 = statSync(subFile).mtimeMs;
  await openInline(x2, yzh);
  await b.eval(`(() => { document.getElementById('cie-input').value = '不该落盘'; return 1; })()`);
  await b.mouse('mousePressed', 20, 20); await b.mouse('mouseReleased', 20, 20);
  await sleep(1200);
  ok(!(await b.eval('window.__videoEditor.isOpen')), '点框外后编辑框关闭', null);
  ok(readSub() === before2 && statSync(subFile).mtimeMs === mt2, '取消没有写盘（内容与 mtime 都没变）', null);

  /* ── 8b. 打字即预览（SRT 走叠加层，只预览不落盘） ── */
  console.log('\n=== 打字即预览（只预览、不落盘） ===');
  const subPv = readSub();
  const ovLine = () => b.eval(`[...document.querySelectorAll('#srt-overlay .ov-line')].map(e => e.textContent)`);
  await openInline(x2, yzh);
  await b.eval(`(() => { const i = document.getElementById('cie-input');
    i.value = '才有机会击败FlameQ'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(300);
  const pv = await ovLine();
  ok(pv.some(l => l.includes('FlameQ')), '打字时叠加层立刻显示草稿', pv);
  ok(readSub() === subPv, '预览没有落盘（磁盘一字未变）', null);
  await key('Escape', 27);
  await sleep(300);
  const back = await ovLine();
  ok(!back.some(l => l.includes('FlameQ')) && back.some(l => l.includes('FlameZ')),
    '取消后叠加层文本还原（预览可逆）', back);

  /* ── 9. 框内打空格 = 拆段（与 ASS 同口径） ── */
  console.log('\n=== 打空格 = 拆成两段 ===');
  // 文本被改过 → 重新量一遍逐字符位置（居中显示会让左边缘跟着变）
  const mA = await charX(TAG);
  console.log('  当前中文行:', mA.text);
  await openInline(midOf(mA, SEG1[0], SEG1[1] - 1), yOf(mA));     // 点第 1 段"一路打到决赛"
  const stSeg = await b.eval(`(() => ({ v: document.getElementById('cie-input').value, side: window.__videoEditor.open && window.__videoEditor.open.item.side }))()`);
  ok(stSeg.v === '一路打到决赛', '点第 1 段 → 预填第 1 段', stSeg);
  await b.eval(`(() => { document.getElementById('cie-input').value = '一路 打进决赛'; return 1; })()`);
  await key('Enter', 13);
  await sleep(2600);
  const after3 = readSub();
  const zhLine = after3.split('\r\n').find(l => l.includes('打进决赛')) || '';
  ok(zhLine === '[Wemmbu] 一路 打进决赛 才有机会击败FlameZ', '打空格即拆段：新文本原样落盘，前后片段不受影响', zhLine);

  /* ── 10. 整行弹窗（片段框内 Ctrl+Enter） ── */
  console.log('\n=== 整行文本弹窗（Ctrl+Enter） ===');
  const mB = await charX(TAG);                             // 现在行首段是"一路"
  console.log('  当前中文行:', mB.text);
  await openInline(midOf(mB, SEG1[0], SEG1[0] + 1), yOf(mB));
  ok((await b.eval(`document.getElementById('cie-input').value`)) === '一路', '拆段后点"一路"仍能命中该段', null);
  await key('Enter', 13, 2);                               // modifiers=2 即 Ctrl
  await sleep(400);
  const dlg = await b.eval(`(() => {
    const ov = document.getElementById('cue-text-overlay');
    return { shown: !ov.hidden, title: ov.querySelector('.rn-title').textContent,
      preview: document.getElementById('ctd-preview').textContent,
      input: document.getElementById('ctd-input').value,
      hint: document.getElementById('ctd-hint').textContent };
  })()`);
  ok(dlg.shown === true, 'Ctrl+Enter 打开整行文本弹窗', dlg.shown);
  ok(dlg.title.includes('仅修改 Text 字段，不改变时间与样式'), '弹窗标题与参考图一致', dlg.title);
  ok(dlg.preview.includes('Wemmbu') && dlg.input === dlg.preview.slice(TAG.length),
    '弹窗预填整行正文，且不含只读的行首角色前缀', { preview: dlg.preview, input: dlg.input });
  ok(/前缀会自动保留/.test(dlg.hint), '弹窗提示里说明"行首前缀会自动保留"', dlg.hint);
  console.log('  提示文案:', dlg.hint);
  await b.shot(resolve(OUT, 'videoedit-srt-3-modal.png'));
  await b.eval(`(() => { document.getElementById('ctd-input').value = '一路 打进决赛内 才有机会击败FlameZ'; return 1; })()`);
  await b.eval(`document.getElementById('ctd-ok').click()`);
  await sleep(2600);
  const after4 = readSub();
  const zhLine2 = after4.split('\r\n').find(l => l.includes('FlameZ')) || '';
  ok(zhLine2 === '[Wemmbu] 一路 打进决赛内 才有机会击败FlameZ',
    '整行保存后行首 [角色] 前缀自动补回、时间不变', zhLine2);
  ok(times(after4) === times(before), '整行编辑同样没动任何时间戳', null);

  /* ── 11. 右键 = 整行弹窗（ASS 路径同样支持，这里只验 SRT 不回归） ── */
  console.log('\n=== 右键字幕 = 整行弹窗 ===');
  await b.mouse('mousePressed', x2, yzh, { button: 'right', buttons: 2 });
  await b.mouse('mouseReleased', x2, yzh, { button: 'right', buttons: 0 });
  await sleep(300);
  const ctx = await b.eval(`!document.getElementById('cue-text-overlay').hidden`);
  ok(ctx === true, '在字幕上右键打开整行文本弹窗', ctx);
  await key('Escape', 27);
  await sleep(200);
  ok(!(await b.eval('window.__videoEditor.isOpen')) && await b.eval(`document.getElementById('cue-text-overlay').hidden`),
    'Esc 关闭弹窗', null);

  /* ── 12. 控制台无异常 ── */
  const bad = b.logs.filter(l => /exception|\[error\]/.test(l));
  ok(bad.length === 0, '页面无 JS 异常', bad.slice(0, 3));
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('探针异常:', e && e.message);
  console.error(b && b.logs ? b.logs.slice(-6).join('\n') : '');
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('截图 → outputs/videoedit-srt-*.png');
  b.close(); srv.kill();
}
process.exit(exitCode);
