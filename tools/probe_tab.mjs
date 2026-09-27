// 验证行内编辑器的 Tab 快捷键: 英文区 → 中文区, 中文区 → 英文区, 且不误提交。
// 走真实路径: 点卡片文字进入编辑 → 真实键盘事件 Tab。
//
// 用法: node tools/probe_tab.mjs <projectId>
import { launch, sleep, report } from './lib/cdp.mjs';

const PID = process.argv[2];
const BASE = 'http://127.0.0.1:8321';
const br = await launch({ url: `${BASE}/#/project/${PID}` });
await br.goto(`${BASE}/#/project/${PID}`);
await br.waitFor(`document.querySelectorAll('.cue-card').length > 0`, { timeout: 20000, label: '字幕列表' });
await sleep(1200);

/** 真实按键 */
async function key(k, code, keyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await br.send('Input.dispatchKeyEvent', {
      type, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      text: type === 'keyDown' && k === 'Tab' ? '\t' : undefined,
    });
  }
  await sleep(250);
}

/** 当前编辑器状态 */
const state = () => br.eval(`(() => {
  const ed = document.querySelector('.inline-editor');
  if (!ed) return { editing: false };
  const a = document.activeElement;
  const which = a === ed.querySelector('.ie-l1') ? 'zh(ie-l1)'
              : a === ed.querySelector('.ie-l2') ? 'en(ie-l2)'
              : (a ? a.tagName + '.' + a.className : 'none');
  return {
    editing: true,
    focused: which,
    zhText: ed.querySelector('.ie-l1').textContent,
    enText: ed.querySelector('.ie-l2').textContent,
    hint: (ed.querySelector('.ie-hint') || {}).textContent,
  };
})()`);

// 点卡片的中文文字行(cc-l1)进入编辑
const hit = await br.eval(`(() => {
  const el = document.querySelector('.cue-card .cc-l1');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + 15, y: r.y + r.height/2, cls: el.className, text: el.textContent.trim().slice(0,30) };
})()`);
if (!hit) { report('找不到 .cc-l1', await br.eval(`document.querySelector('.cue-card')?.outerHTML.slice(0,400)`)); br.close(); process.exit(1); }
report('点击目标', hit);
await br.click(Math.round(hit.x), Math.round(hit.y));
await sleep(600);

report('① 进入编辑后', await state());

await key('Tab', 'Tab', 9);
report('② 英文区按 Tab 后(期望 → 中文区 zh)', await state());

await key('Tab', 'Tab', 9);
report('③ 中文区再按 Tab 后(期望 → 英文区 en)', await state());

// 关键: 连按 Tab 不能把编辑提交掉(焦点跑到编辑器外会触发 focusout 误提交)
await key('Tab', 'Tab', 9);
await key('Tab', 'Tab', 9);
report('④ 连按多次 Tab 后(编辑器必须还在)', await state());

// Esc 取消
await key('Escape', 'Escape', 27);
report('⑤ Esc 后', await state());

report('控制台异常', br.logs.filter(l => /exception/i.test(l)).join('\n') || '(无)');
br.close();
process.exit(0);
