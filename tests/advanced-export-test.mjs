/* 高级导出：按说话人筛选字幕。纯逻辑在 karaoke.js，弹窗/导出接线在 main.js。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AssDoc } from './jsmod/ass.js';
import { analyzeKaraoke, sentenceSpeakerNames, filterSentencesBySpeakers, buildSpeakerAss, buildLangAss } from './jsmod/karaoke.js';

const root = path.resolve(import.meta.dirname, '..');
const head = '[Script Info]\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize\nStyle: Default,Arial,40\nStyle: EN,Arial,40\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n';
const row = (start, end, style, name, text) => `Dialogue: 0,${start},${end},${style},${name},0,0,0,,${text}\n`;
const doc = new AssDoc(head
  + row('0:00:01.00', '0:00:03.00', 'Default', '', '[译者注] 这一句是注释')
  + row('0:00:01.00', '0:00:03.00', 'EN', '译者注', 'Note line')
  + row('0:00:04.00', '0:00:06.00', 'Default', '', '[Alice] 普通台词')
  + row('0:00:04.00', '0:00:06.00', 'EN', 'Alice', 'Normal line')
  + row('0:00:07.00', '0:00:09.00', 'Default', '', '没有角色名的行'));
const kar = analyzeKaraoke(doc);
const sentences = kar.sentences;
assert.ok(sentences.length >= 5);
const translator = sentences.filter(s => sentenceSpeakerNames(s).includes('译者注'));
assert.equal(translator.length, 2, '中英两行都识别为译者注');
const onlyTranslator = filterSentencesBySpeakers(sentences, ['译者注'], false);
assert.equal(onlyTranslator.length, 2, '只保留译者注');
assert.ok(onlyTranslator.every(s => sentenceSpeakerNames(s).includes('译者注')));
const withoutTranslator = filterSentencesBySpeakers(sentences, ['Alice'], false);
assert.equal(withoutTranslator.length, 2, '去掉译者注后只剩 Alice');
assert.ok(withoutTranslator.every(s => !sentenceSpeakerNames(s).includes('译者注')));
const allNamed = filterSentencesBySpeakers(sentences, ['Alice', '译者注'], false);
assert.equal(allNamed.length, 4, '两个角色都选时保留各自行');
const withUnassigned = filterSentencesBySpeakers(sentences, ['Alice'], true);
assert.ok(withUnassigned.some(s => !sentenceSpeakerNames(s).length), '无角色行可单独控制');
assert.equal(filterSentencesBySpeakers(sentences, [], false).length, 0);

/* 颜色逐词形态：一句由多条切片事件组成；导出必须保留每一条，而不是只写 events[0]。 */
const outDoc = new AssDoc(head);
const slice = (start, end, text) => ({ start, end, text });
const multi = [{
  style: 'EN', start: 1, end: 3, text: 'one two',
  proto: { layer: 0, name: 'Alice', effect: '', margins: { marginl: 0, marginr: 0, marginv: 0 } },
  events: [slice(1, 1.5, 'one'), slice(1.5, 2.2, 'two'), slice(2.2, 3, 'one two')],
}];
const exported = buildSpeakerAss(outDoc, multi).split(/\r?\n/).filter(l => l.startsWith('Dialogue:'));
assert.equal(exported.length, 3, '三条词级切片都导出');
assert.match(exported[0], /0:00:01\.00,0:00:01\.50/);
assert.match(exported[2], /0:00:02\.20,0:00:03\.00/);
assert.match(exported[2], /one two$/);
const langExported = buildLangAss(outDoc, multi, 'EN', 'en').split(/\r?\n/).filter(l => l.startsWith('Dialogue:'));
assert.equal(langExported.length, 3, '仅英文导出同样保留全部切片');

const studio = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');
const template = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'editor/js/main.js'), 'utf8');
assert.match(template, /id="btn-export-advanced"/, '导出设置里有高级导出入口');
assert.match(template, /id="adv-export-overlay"/, '高级导出弹窗存在');
assert.match(template, /id="adv-role-list"/, '说话人勾选区存在');
assert.match(template, /id="adv-export-format"/, '高级导出可选格式');
assert.equal(studio, template, 'studio.html 与模板一致');
const karaoke = fs.readFileSync(path.join(root, 'editor/js/karaoke.js'), 'utf8');
assert.match(main, /filterSentencesBySpeakers\(state\.kar\.sentences/, '导出使用说话人筛选');
assert.match(main, /buildSpeakerAss, buildLangAss/, '原始字幕导出保留选中角色');
assert.match(karaoke, /flatMap\(sent =>/, '一句的全部词级事件都导出，不只 events[0]');
assert.match(karaoke, /ev\.start != null \? ev\.start : sent\.start/, '逐词切片保留各自起止时间');
assert.match(main, /adv-export-ok/, '弹窗导出按钮接线');
console.log('advanced-export: 角色识别/筛选/译者注排除/弹窗入口通过');

const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
assert.match(css, /#sf-choice-menu:not\(\[hidden\]\) \{ z-index:100010; \}/, '编码/加速下拉菜单高于导出弹窗');
