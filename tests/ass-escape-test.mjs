/* ASS 转义/明文往返测试: node tests/ass-escape-test.mjs */
'use strict';
import { AssDoc, assPlainText, isAssSubtitle } from '../editor/js/ass.js';
import { replaceWordHighlightColor, speakerColorOf } from '../editor/js/karaoke.js';
import { AssPlayer } from '../editor/js/assplayer.js';

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); } };

const escAss = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

/* ASS/SSA 自动识别与特效兼容 */
const detectedAss = `[Script Info]\nTitle: test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\move(0,0,100,100)\\fad(200,300)}text`;
const detectedSsa = `[V4 Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,\\pos(10,20)text`;
ok(isAssSubtitle(detectedAss, 'renamed.txt'), '按 ASS 结构识别改名字幕');
ok(isAssSubtitle(detectedSsa, 'legacy.ssa'), '识别经典 SSA 样式头');
const srtLikeText = ['1', '00:00:01,000 --> 00:00:02,000', '[Script Info]', '[Events]', '纯文本'].join('\n');
ok(!isAssSubtitle(srtLikeText, 'caption.txt'), '避免把普通文本字幕误判为 ASS');
const legacySsa = new AssDoc(`[V4 Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\move(0,0,100,100)\\t(0,500,\\fscx120)}moving text`);
ok(legacySsa.styleNames.includes('Default'), '经典 SSA 样式可识别');
ok(legacySsa.serialize().includes('{\\move(0,0,100,100)\\t(0,500,\\fscx120)}moving text'), 'ASS 动画覆盖标签往返保留');

/* 渲染器初始化期间收到样式更新时，只缓存最新轨道；worker 首条 stdout 不等于 libass ready。 */
const originalOctopus = globalThis.SubtitlesOctopus;
let mockOctopus;
globalThis.SubtitlesOctopus = class {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.workerActive = false;
    this.workerListeners = new Set();
    this.worker = {
      addEventListener: (type, fn) => { if (type === 'message') this.workerListeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'message') this.workerListeners.delete(fn); }
    };
    mockOctopus = this;
  }
  emit(target) {
    if (!this.workerActive) { this.workerActive = true; this.options.onReady(); }
    for (const fn of this.workerListeners) fn({ data: { target } });
  }
  setTrack(content) { this.calls.push({ type: 'track', content }); }
  setCurrentTime(time) { this.calls.push({ type: 'time', time }); }
  dispose() {}
};
const previewVideo = {
  videoWidth: 1920, currentTime: 12.34, paused: true,
  addEventListener() {}, removeEventListener() {}
};
const previewPlayer = new AssPlayer(previewVideo);
previewPlayer.load('old ASS');
previewPlayer.updateNow('first style edit');
previewPlayer.updateNow('latest style edit');
ok(mockOctopus.calls.length === 0, 'libass 初始化中不提前发 setTrack');
mockOctopus.emit('stdout');
ok(!previewPlayer.ready && mockOctopus.calls.length === 0, 'worker 首条 stdout 不会误报就绪或丢更新');
mockOctopus.emit('ready');
ok(previewPlayer.ready && mockOctopus.calls.length === 2 && mockOctopus.calls[0].content === 'latest style edit'
  && mockOctopus.calls[1].time === 12.34, '精确 ready 后应用最新字幕并强制重绘暂停帧');
previewPlayer.dispose();
if (originalOctopus === undefined) delete globalThis.SubtitlesOctopus;
else globalThis.SubtitlesOctopus = originalOctopus;

const styleDoc = new AssDoc(`[Script Info]\nTitle: style test\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,36,&H00FFFFFF,&H0000FF00,&H00000000,&H64000000,-1,0,1,2,0,2,10,10,20,1\nStyle: 中文字幕,Arial,36,&H00FFFFFF,&H0000FF00,&H00000000,&H64000000,0,0,1,2,0,2,10,10,20,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\c&H00FF00&}Hello{\\c} {\\c&H00FF00&}world{\\c}\nDialogue: 0,0:00:00.00,0:00:01.00, 中文字幕,,0,0,0,,{\\c&H0000FF&}[角色] 你好`);
ok(styleDoc.getStyle('Default').fontname === 'Arial' && styleDoc.getStyle('Default').fontsize === '36', '读取 ASS 样式字段');
ok(styleDoc.setStyleFields('Default', { fontname: 'Noto Sans', fontsize: 52, bold: 0, italic: -1 }), '更新指定 ASS 样式字段');
const styleAfter = styleDoc.getStyle('Default');
ok(styleAfter.fontname === 'Noto Sans' && styleAfter.fontsize === '52' && styleAfter.bold === '0' && styleAfter.italic === '-1'
  && styleAfter.primarycolour === '&H00FFFFFF', '样式更新保留未修改字段');
ok(replaceWordHighlightColor(styleDoc, 'Default', '#ff44aa') === 1, '逐词颜色仅更新英文样式事件');
ok(styleDoc.events[0].text.includes('{\\c&HA A44FF&}'.replace(/ /g, ''))
  && styleDoc.events[0].text.includes('world{\\c}'), '逐词颜色按 ASS BGR 顺序写入');
ok(styleDoc.events[1].text.includes('{\\c&H0000FF&}'), '角色颜色不被逐词改色影响');
const customHighlight = '{\\c&HA A44FF&}'.replace(/ /g, '') + 'word{\\c}';
ok(speakerColorOf({ events: [{ text: customHighlight }], words: [{ w: 'word' }] }) === null, '自定义逐词色不误判为说话人色');
ok(speakerColorOf({ events: [{ text: '{\\c&HA A44FF&}'.replace(/ /g, '') + '[Spoke] 文本' }] }) === '#ff44aa', '与逐词颜色同色的角色标记仍保留');
styleDoc.setScriptInfoComment('SubFabricWordHighlightColor', '#ff44aa');
styleDoc.setEventText(styleDoc.events[0], styleDoc.events[0].text + '!');
styleDoc.setStyleFields('Default', { fontsize: 53 });
ok(styleDoc.serialize().includes('world{\\c}!') && styleDoc.getStyle('Default').fontsize === '53', '插入私有设置后文档行索引仍可编辑');
const styleReloaded = new AssDoc(styleDoc.serialize());
ok(styleReloaded.getScriptInfoComment('SubFabricWordHighlightColor') === '#ff44aa', '逐词颜色偏好写入 ASS 私有注释');
ok(styleReloaded.events.length === 2 && styleReloaded.getStyle('Default').fontname === 'Noto Sans', '样式和对话在保存重载后完整');

/* 基础: 标签剥离 */
ok(assPlainText('{\\c&H00ff00&}word{\\c}') === 'word', '剥离高亮标签', assPlainText('{\\c&H00ff00&}word{\\c}'));
ok(assPlainText('{\\c&Hf0b000&}[SPK2] 是的') === '[SPK2] 是的', '剥离行首色标保留可见标签', assPlainText('{\\c&Hf0b000&}[SPK2] 是的'));

/* 新增: 被转义的花括号要还原并保留(不能整段被当标签吞掉) */
ok(assPlainText(escAss('{音效}')) === '{音效}', '转义花括号往返还原', assPlainText(escAss('{音效}')));
ok(assPlainText('\\{音效\\}') === '{音效}', '转义文本明文正确');
ok(assPlainText('a\\\\b') === 'a\\b', '转义反斜杠还原', assPlainText('a\\\\b'));

/* 换行 */
ok(assPlainText('第一行\\N第二行') === '第一行 第二行', '\\N → 空格');
ok(!assPlainText(escAss('换\n行')).includes('\n'), '真实换行被转义成 \\N 而非裸换行');

/* 往返: escAss → assPlainText 应等于原文(对含特殊字符的文本) */
const samples = ['{音效}', 'C:\\path\\to', '他说：{笑}', 'a}b', '普通文本', '{\\c&H...&}'];
for (const s of samples) {
  ok(assPlainText(escAss(s)) === s.replace(/\r?\n/g, ' ').trim(), `往返一致: ${JSON.stringify(s)}`, JSON.stringify(assPlainText(escAss(s))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
