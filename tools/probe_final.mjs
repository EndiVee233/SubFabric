// 最终验收: Tab 互切 / 回车提交 / Ctrl+回车分句 / Ctrl+退格合并 / 新建落英文区
import { launch, sleep, report } from './lib/cdp.mjs';

const PID = process.argv[2];
const BASE = 'http://127.0.0.1:8321';
const br = await launch({ url: `${BASE}/#/project/${PID}` });
await br.goto(`${BASE}/#/project/${PID}`);
await br.waitFor(`document.querySelectorAll('.cue-card').length > 0`, { timeout: 20000, label: '字幕列表' });
await sleep(1500);

const st = () => br.eval(`(() => {
  const e = document.querySelector('.inline-editor');
  if (!e) return { editing: false };
  const a = document.activeElement;
  return { editing: true,
    focus: a === e.querySelector('.ie-l1') ? '中文' : (a === e.querySelector('.ie-l2') ? '英文' : '其他'),
    zh: e.querySelector('.ie-l1').textContent, en: e.querySelector('.ie-l2').textContent };
})()`);
const cards = () => br.eval(`[...document.querySelectorAll('.cue-card')].map(c=>({zh:(c.querySelector('.cc-l1')||{}).textContent||'',en:(c.querySelector('.cc-l2')||{}).textContent||''}))`);
const words = () => br.eval(`window.__dbg.state.kar.rows.map(r=>r.en&&r.en.words?r.en.words.map(w=>w.w).join('/'):null)`);
async function clickEn(i) {
  const r = await br.eval(`(()=>{const c=document.querySelectorAll('.cue-card')[${i}];c.scrollIntoView({block:'center'});const b=c.querySelector('.cc-l2').getBoundingClientRect();return{x:b.x+12,y:b.y+b.height/2};})()`);
  await br.click(Math.round(r.x), Math.round(r.y)); await sleep(500);
}
const caret = (n) => br.eval(`(()=>{const el=document.querySelector('.inline-editor .ie-l2');el.focus();const r=document.createRange();r.setStart(el.firstChild,Math.min(${n},el.textContent.length));r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r);return true;})()`);
async function key(k, code, kc, mods) {
  for (const type of ['keyDown','keyUp']) await br.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: mods });
  await sleep(700);
}
const CTRL = 2;

report('1) 点英文行进入编辑', await (async () => { await clickEn(0); return st(); })());
report('2) Tab → 中文', await (async () => { await key('Tab','Tab',9,0); return st(); })());
report('3) Tab → 英文', await (async () => { await key('Tab','Tab',9,0); return st(); })());

report('4) Ctrl+回车(词中间) 分句', await (async () => {
  await caret(13);
  await key('Enter','Enter',13,CTRL);
  return { cards: (await cards()).slice(0,3), words: (await words()).slice(0,3), toast: await br.eval(`(document.getElementById('toast')||{}).textContent||null`) };
})());

report('5) Ctrl+退格(英文行最前) 合并', await (async () => {
  // 编辑框已停在前半; 直接点第 2 条并置光标 0
  await clickEn(1);
  await caret(0);
  await key('Backspace','Backspace',8,CTRL);
  return { cards: (await cards()).slice(0,2), words: (await words()).slice(0,2), toast: await br.eval(`(document.getElementById('toast')||{}).textContent||null`) };
})());

report('6) 普通回车 = 提交', await (async () => {
  const wasOpen = (await st()).editing;
  await key('Enter','Enter',13,0);
  return { wasOpen, nowOpen: (await st()).editing, first: (await cards())[0] };
})());

report('7) 新建字幕默认落英文区', await (async () => {
  await br.eval(`window.__dbg.timeline.onCreate(10.2, 11.0); true`);
  await sleep(700);
  return st();
})());

report('控制台异常', br.logs.filter(l=>/exception|error/i.test(l)).join('\n') || '(无)');
br.close();
process.exit(0);
