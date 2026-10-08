/**
 * 逐句置信度「三档」的回归。
 *
 * 置信度由三个信号融合（asr/confidence.py）：token 概率、音频质量、稳定性。
 *   · token 概率 / 音频质量 —— 解码时白送，**零额外开销**
 *   · 稳定性 —— 把音频加噪**重跑 tta 遍**，唯一的真开销
 * 实测 236 秒音频：tta=2 → 20.8s，tta=0 → 10.7s（稳定性占 10.1s，近乎翻倍）。
 *
 * 所以分三档（不是布尔开关 —— "关"和"不重跑但保留置信度"是两回事）：
 *   off  —— --tta 0，且服务端把逐句 confidence 摘掉（不写 ASS 注释、界面无徽标）
 *   fast —— --tta 0，但保留 token+音频 两路融合出的置信度
 *   full —— --tta 2，三路齐全（默认）
 *
 * 优先级：项目级（project.json 的 draft.confidence）→ 全局（asr/settings.json
 * 的 confidence.mode）→ 默认 full。项目级没表态（null/undefined）时**跟随全局**。
 *
 * 这些语义最容易写错（尤其"跟随全局"与"兼容旧的布尔值"），所以把纯函数从源码
 * 抽出来跑真实取值，而不是只做字符串断言。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO, 'editor', 'index.html'), 'utf8');
const PJS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

const grab = (name) => {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let d = 0, started = false;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') { d++; started = true; }
    else if (SRC[k] === '}') { d--; if (started && d === 0) return SRC.slice(i, k + 1); }
  }
  return null;
};
const CONF_TTA = Number((/const CONFIDENCE_TTA = (\d+)/.exec(SRC) || [])[1]);
const MODES_LIT = (/const CONFIDENCE_MODES = (\[[^\]]+\])/.exec(SRC) || [])[1];
ok(Number.isFinite(CONF_TTA), `读到 CONFIDENCE_TTA = ${CONF_TTA}`);
ok(!!MODES_LIT, `读到 CONFIDENCE_MODES = ${MODES_LIT}`);

const harness = `
  let __settings = {};
  function readAsrSettings() { return __settings; }
  const CONFIDENCE_MODES = ${MODES_LIT};
  const CONFIDENCE_TTA = ${CONF_TTA};
  ${grab('normConfMode')}
  ${grab('asrConfidenceDefault')}
  ${grab('asrConfidenceFor')}
  ${grab('ttaArgs')}
  ${grab('stripConfidence')}
  function setSettings(s) { __settings = s; }
  export { normConfMode, asrConfidenceDefault, asrConfidenceFor, ttaArgs, stripConfidence, setSettings };
`;
const tmp = path.join(HERE, '_confmod.mjs');
fs.writeFileSync(tmp, harness);
const M = await import('file://' + tmp.replace(/\\/g, '/'));
fs.unlinkSync(tmp);
const { asrConfidenceDefault, asrConfidenceFor, ttaArgs, stripConfidence, setSettings } = M;

console.log('\n== 全局默认：没设置过 = full ==');
setSettings({});
ok(asrConfidenceDefault() === 'full', '空设置 → full');
setSettings({ confidence: {} });
ok(asrConfidenceDefault() === 'full', 'confidence 段存在但没 mode → full');
setSettings({ confidence: { mode: 'off' } });
ok(asrConfidenceDefault() === 'off', 'mode:off → off');
setSettings({ confidence: { mode: 'fast' } });
ok(asrConfidenceDefault() === 'fast', 'mode:fast → fast');
setSettings({ confidence: { mode: 'turbo' } });
ok(asrConfidenceDefault() === 'full', '非法档位 → 退回 full');
setSettings({ confidence: { mode: 123 } });
ok(asrConfidenceDefault() === 'full', '非字符串 → 退回 full');

console.log('\n== 兼容早期的布尔写法 { enabled: bool } ==');
setSettings({ confidence: { enabled: false } });
ok(asrConfidenceDefault() === 'off', 'enabled:false → off（老设置文件不会被当成 full）');
setSettings({ confidence: { enabled: true } });
ok(asrConfidenceDefault() === 'full', 'enabled:true → full');

console.log('\n== 项目级覆盖 ==');
setSettings({ confidence: { mode: 'off' } });
ok(asrConfidenceFor({ draft: { confidence: 'full' } }) === 'full', '全局 off + 项目 full → full');
ok(asrConfidenceFor({ draft: { confidence: 'fast' } }) === 'fast', '全局 off + 项目 fast → fast');
setSettings({ confidence: { mode: 'full' } });
ok(asrConfidenceFor({ draft: { confidence: 'off' } }) === 'off', '全局 full + 项目 off → off');
ok(asrConfidenceFor({ draft: { confidence: null } }) === 'full', '项目 null → 跟随全局');
ok(asrConfidenceFor({ draft: {} }) === 'full', '项目没这字段 → 跟随全局');
ok(asrConfidenceFor({}) === 'full', '连 draft 都没有 → 跟随全局');
ok(asrConfidenceFor(null) === 'full', 'meta 为 null 不炸');
// 老项目里可能存的是布尔
ok(asrConfidenceFor({ draft: { confidence: true } }) === 'full', '老项目存 true → full');
ok(asrConfidenceFor({ draft: { confidence: false } }) === 'off', '老项目存 false → off');
setSettings({ confidence: { mode: 'fast' } });
ok(asrConfidenceFor({ draft: { confidence: 'nonsense' } }) === 'fast',
  '项目值是垃圾 → 退回跟随全局（不是退回默认 full）');

console.log('\n== 档位 → --tta ==');
ok(JSON.stringify(ttaArgs('full')) === JSON.stringify(['--tta', String(CONF_TTA)]),
  `full → --tta ${CONF_TTA}`, JSON.stringify(ttaArgs('full')));
ok(JSON.stringify(ttaArgs('fast')) === JSON.stringify(['--tta', '0']), 'fast → --tta 0', JSON.stringify(ttaArgs('fast')));
ok(JSON.stringify(ttaArgs('off')) === JSON.stringify(['--tta', '0']), 'off → --tta 0', JSON.stringify(ttaArgs('off')));
ok(JSON.stringify(ttaArgs(undefined)) === JSON.stringify(['--tta', '0']),
  'undefined → 0（只认 full 才重跑，避免误开）', JSON.stringify(ttaArgs(undefined)));

console.log('\n== stripConfidence：off 档把逐句置信度摘干净 ==');
let segs = [
  { text: 'a', confidence: { score: 0.9 }, words: [{ word: 'a', _p: [0.9] }] },
  { text: 'b', words: [{ word: 'b' }] },
  { text: 'c', confidence: { score: 0.5 } },
];
let n = stripConfidence(segs);
ok(n === 2, '返回摘掉的行数 = 2', n);
ok(segs.every(s => !s.confidence), '所有 confidence 都没了');
ok(segs[0].words[0]._p === undefined, '词级 _p 中间产物也清掉了');
ok(segs[1].words[0].word === 'b', '不动其它字段');
ok(stripConfidence([]) === 0, '空数组不炸');
ok(stripConfidence(null) === 0, 'null 不炸');

console.log('\n== 源码接线 ==');
const spread = (SRC.match(/\.\.\.\(ea\.extra \|\| \[\]\), \.\.\.ea\.hotwords, \.\.\.ttaArgs\(confMode\)\]/g) || []).length;
ok(spread === 3, `三处 spawn 都接 ttaArgs(confMode)（找到 ${spread}）`);
ok(/const confMode = asrConfidenceFor\(meta0\)/.test(SRC), 'startDraftAsr 里算出 confMode');
ok(/tta: \(confMode === 'full' \? CONFIDENCE_TTA : 0\)/.test(SRC), '常驻服务模式也按档位传');
ok(/if \(confMode === 'off'\)/.test(SRC), 'off 档有专门分支');
ok(/const n = stripConfidence\(d\.segments\)/.test(SRC), 'off 档调用 stripConfidence');
// 必须在 finishAsr（= 所有识别路径的汇合点）里，且早于语义分句
const iFinish = SRC.indexOf('const finishAsr = () =>');
const iStrip = SRC.indexOf('if (confMode === \'off\')');
const iResegCall = SRC.indexOf('runDraftReseg(id)', iFinish);
ok(iFinish > 0 && iStrip > iFinish, 'strip 在 finishAsr 内部');
ok(iStrip < iResegCall, 'strip 早于语义分句（否则 ASS 注释已经写进去了）');
ok(/CONFIDENCE_MODES\.includes\(data\.confidence\) \? data\.confidence : null/.test(SRC),
  '建项目接口按三档解析（非三档存 null = 跟随全局）');

console.log('\n== UI：两处都是三档下拉 ==');
ok(/id="st-conf-mode"/.test(HTML), '全局设置有 st-conf-mode');
ok(/id="np-confidence"/.test(HTML), '建稿页有 np-confidence');
ok(/id="dt-set-confidence"/.test(HTML), '项目详情回显项在');
// 只数那三个**置信度**下拉里的选项。
// 早期版本直接全局匹配 <option value="off|fast|full">；后来加了「自动纠错」下拉
// （也有 value="off"）就多算了 1 个 —— 断言必须限定在具体的 select 内。
const confSelects = [...HTML.matchAll(/<select id="(st-conf-mode|np-confidence|dt-set-confidence)"[\s\S]*?<\/select>/g)];
const optsPer = confSelects.map(m => (m[0].match(/<option value="(off|fast|full)">/g) || []).length);
ok(confSelects.length === 3, `找到三个置信度下拉（实得 ${confSelects.length}）`, confSelects.length);
ok(optsPer.every(n => n === 3), `三个下拉各有 3 档（分别 ${optsPer.join('/')}）`, optsPer);
ok(!/id="st-conf-enabled"/.test(HTML), '旧的复选框已移除（不留两套控件）');
ok(/CONF_MODES = \['off', 'fast', 'full'\]/.test(PJS), '前端也有档位表');
ok(/payload\.confidence = \(\$\('#np-confidence'\) \|\| \{\}\)\.value/.test(PJS), '本地视频建稿带档位');
ok(/confidence: \(\$\('#np-confidence'\) \|\| \{\}\)\.value/.test(PJS), '链接下载建稿带档位');
ok(/npConfSyncedByUser/.test(PJS), '用户手动改过就不再被全局默认覆盖');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
