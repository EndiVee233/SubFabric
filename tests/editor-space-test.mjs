// Run the production capture/bubble handlers, including Studio's route gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { shortcuts, comboFromEvent } from '../editor/js/shortcuts.js';

const main = fs.readFileSync(new URL('../editor/js/main.js', import.meta.url), 'utf8');
const studio = fs.readFileSync(new URL('../editor/js/studio.js', import.meta.url), 'utf8');
const start = main.indexOf('const actionCooldown = { playPause: 0 };');
const end = main.indexOf('/* ─────────── 设置 Tab:', start);
const gate = studio.slice(studio.indexOf("for (const event of ['keydown', 'keyup']) document.addEventListener"), studio.indexOf('applyTheme(); renderFolders(); syncPlayer();'));
assert.ok(start > 0 && end > start && gate.includes("workspace !== 'editor'"));
let now = 100, toggles = 0, nativeActions = 0, targetKeys = 0;
const handlers = [];
const document = {
  body: { dataset: { workspace: 'editor' } },
  getElementById: () => null,
  addEventListener(type, fn, capture = false) { handlers.push({ type, fn, capture }); },
};
vm.runInNewContext(gate + '\n' + main.slice(start, end), {
  document, performance: { now: () => now }, shortcuts, comboFromEvent, cueEditOpen: false,
  actions: { playPause() { toggles++; } },
});
function element(tagName, type = '', editable = false) {
  return { tagName, type, isContentEditable: editable,
    closest() { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || editable ? this : null; } };
}
function dispatch(type, target, props = {}) {
  const event = { key: ' ', code: 'Space', target, repeat: false, defaultPrevented: false,
    stop: false, preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stop = true; }, stopImmediatePropagation() { this.stop = true; }, ...props };
  for (const handler of handlers.filter(h => h.type === type && h.capture)) {
    handler.fn(event); if (event.stop) break;
  }
  // An existing target handler can stop bubbling or activate a custom menu.
  if (!event.stop) {
    targetKeys++;
    if (target.onKey) target.onKey(event);
    for (const handler of handlers.filter(h => h.type === type && !h.capture)) {
      if (event.stop) break;
      handler.fn(event);
    }
  }
  if (!event.defaultPrevented && type === 'keyup') nativeActions++;
  return event;
}
function press(target, props) {
  now += 100;
  return [dispatch('keydown', target, props), dispatch('keyup', target, props)];
}
for (const target of [element('INPUT', 'range'), element('INPUT', 'checkbox'), element('INPUT', 'radio'),
  element('INPUT', 'color'), element('INPUT', 'file'), element('SELECT'), element('BUTTON'),
  element('VIDEO'), element('CANVAS'), element('SPAN')]) {
  const before = toggles, nativeBefore = nativeActions, keysBefore = targetKeys;
  const events = press(target);
  assert.equal(toggles, before + 1, target.tagName + '/' + target.type + ': exactly one playback toggle');
  assert.ok(events.every(e => e.defaultPrevented), 'suppress both keydown and keyup defaults');
  assert.equal(nativeActions, nativeBefore, 'do not click/toggle the focused control');
  assert.equal(targetKeys, keysBefore, 'capture precedes target handlers');
}
const choice = element('BUTTON');
choice.onKey = e => { nativeActions++; e.stopPropagation(); };
const oldToggles = toggles;
press(choice);
assert.equal(toggles, oldToggles + 1, 'custom dropdown cannot steal Space before playback');

for (const target of [element('INPUT', 'text'), element('INPUT', 'search'), element('INPUT', 'number'),
  element('INPUT', 'password'), element('INPUT', 'email'), element('INPUT', 'time'),
  element('TEXTAREA'), element('DIV', '', true), element('SPAN', '', true)]) {
  const before = toggles;
  assert.ok(press(target).every(e => !e.defaultPrevented), 'typing keeps Space');
  assert.equal(toggles, before, 'text editing must not toggle playback');
}
{
  const before = toggles, target = element('BUTTON');
  press(target, { isComposing: true });
  assert.equal(toggles, before, 'IME composition is not a playback command');
  for (const key of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) press(target, { [key]: true });
  assert.equal(toggles, before, 'modified combinations retain their existing behavior');
  press(target);
  const first = toggles;
  dispatch('keydown', target, { repeat: true }); dispatch('keyup', target);
  assert.equal(toggles, first, 'holding Space does not repeatedly toggle');
  now += 120; dispatch('keydown', target); dispatch('keyup', target);
  assert.equal(toggles, first + 1, 'quick next press still toggles');
}
document.body.dataset.workspace = 'dashboard';
{
  const before = toggles, target = element('BUTTON');
  assert.ok(press(target).every(e => !e.defaultPrevented), 'outside editor native Space remains available');
  assert.equal(toggles, before, 'outside editor playback stays unchanged');
  assert.equal(dispatch('keydown', element('INPUT', 'text')).defaultPrevented, false, 'outside editor typing remains available');
}
console.log('editor-space: focused controls, custom dropdown, text/IME exceptions, keyup defaults, repeat/rapid presses and route boundaries passed');
