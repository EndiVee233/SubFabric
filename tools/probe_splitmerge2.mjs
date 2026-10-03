// 验证: ① 分句保留逐词时间 ② Ctrl+退格合并 ③ 边界(第一条/普通回车)
// 用窗口内坐标点击(列表是虚拟滚动), 并对每步做断言式输出。
import { launch, sleep, report } from './lib/cdp.mjs';

const PID = process.argv[2];
const BASE = 'http://127.0.0.1:8321';
const br = await launch({ url: `${BASE}/#/project/${PID}` });
await br.goto(`${BASE}/#/project/${PID}`);
await br.waitFor(`document.querySelectorAll('.cue-card').length > 0`, { timeout: 20000, label: '字幕列表' });
await sleep(1500);

const cards = () => br.eval(`[...document.querySelectorAll('.cue-card')].map(c => ({
  zh: (c.querySelector('.cc-l1')||{}).textContent || '',
  en: (c.querySelector('.cc-l2')||{}).textContent || '',
  onScreen: (() => { const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()
}))`);

/** 行内编辑器的逐词时间(经 __dbg.state 读 karaoke 行) */
const wordInfo = () => br.eval(`(() => {
  const st = window.__dbg.state;
  return st.kar.rows.map(r => ({
    zh: r.zh ? r.zh.text : null, en: r.en ? r.en.text : null,
    enWords: r.en && r.en.words ? r.en.words.map(w => w.w + '@' + w.s.toFixed(2) + '-' + w.e.toFixed(2)) : null,
    zhWords: r.zh && r.zh.words ? r.zh.words.length : 0,
    span: r.start.toFixed(2) + '→' + r.end.toFixed(2),
  }));
})()`);

/** 真实点击某卡片英文行(按窗口坐标), 失败返回 false */
async function clickEnText(idx) {
  const r = await br.eval(`(() => {
    const c = [...document.querySelectorAll('.cue-card')][${idx}];
    if (!c) return null;
    const el = c.querySelector('.cc-l2'); if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    if (b.bottom < 0 || b.top > window.innerHeight) return null;
    return { x: b.x + 12, y: b.y + b.height/2, text: el.textContent };
  })()`);
  if (!r) return null;
  await br.click(Math.round(r.x), Math.round(r.y));
  await sleep(500);
  return r.text;
}
const caret = (n) => br.eval(`(() => {
  const el = document.querySelector('.inline-editor .ie-l2');
  if (!el || !el.firstChild) return 'no-editor';
  el.focus();
  const r = document.createRange();
  r.setStart(el.firstChild, Math.min(${n}, el.textContent.length)); r.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return { text: el.textContent, offset: s.anchorOffset };
})()`);
async function press(key, code, kc, mods) {
  for (const type of ['keyDown', 'keyUp']) {
    await br.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: mods });
  }
  await sleep(800);
}
const CTRL = 2;

/* ── 用第 1 条(有逐词)做分句 ── */
report('分句前(逐词时间)', (await wordInfo()).slice(0, 2));
const t0 = await clickEnText(0);
report('进入编辑', { clicked: t0, caret: await caret(13) });
await press('Enter', 'Enter', 13, CTRL);
report('分句后(逐词时间必须两半都有, 且不重算)', (await wordInfo()).slice(0, 3));
report('分句后(卡片)', (await cards()).slice(0, 3));

/* ── Ctrl+退格 把第 2 条并回第 1 条 ── */
const clicked2 = await clickEnText(1);
const c2 = await caret(0);
report('准备合并', { clicked: clicked2, caret: c2 });
await press('Backspace', 'Backspace', 8, CTRL);
report('合并后(期望: 两条变一条, 文本与时间都并起来)', {
  toast: await br.eval(`(document.getElementById('toast')||{}).textContent||null`),
  cards: (await cards()).slice(0, 3),
  words: (await wordInfo()).slice(0, 2),
});

/* ── 边界: 第一条 Ctrl+退格 ── */
await clickEnText(0);
await caret(0);
await press('Backspace', 'Backspace', 8, CTRL);
report('第一条 Ctrl+退格(应提示且不删东西)', {
  toast: await br.eval(`(document.getElementById('toast')||{}).textContent||null`),
  count: (await cards()).length,
});

/* ── 边界: 普通回车 → 提交 ── */
await clickEnText(0);
await br.send('Input.insertText', { text: 'X' });
await sleep(200);
await press('Enter', 'Enter', 13, 0);
report('普通回车(应已提交, 编辑器关闭)', {
  editing: await br.eval(`!!document.querySelector('.inline-editor')`),
  first: (await cards())[0],
});

report('控制台异常', br.logs.filter(l => /exception|error/i.test(l)).join('\n') || '(无)');
br.close();
process.exit(0);
