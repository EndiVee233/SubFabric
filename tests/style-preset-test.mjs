/**
 * 字幕样式预设（样式 + 后处理特效）：命名库 / 导入 / 导出
 *
 * 覆盖纯逻辑（editor/js/style-preset.js）：
 *   ① 组装一条预设：样式轨 + 特效整份 + 顺序 + 字号缩放都能带住，且被归一化
 *   ② 旧版「ASS 双语样式预设」文件（只有 tracks）能当预设导入，不会被 kind 挡住
 *   ③ 导入文件：单条 / 整库 / 坏 JSON / kind 不对 / 缺轨 —— 该收的收、该拒的拒且原因可读
 *   ④ 导出文件：单条导出就是单条，多条导出成整库，往返后内容一致
 *   ⑤ 本机库：新增 / 覆盖（同 id）/ 删除 / 重命名（重名自动加后缀）/ 读坏数据不炸
 *   ⑥ 预设里的样式部分**真的能用**：交给 ass.js 的 applyAssStylePreset 能落到另一份稿件
 *   ⑦ 摘要把字体字号与特效开关说清楚（下拉框直接用这句）
 */
import {
  makeStylePreset, normalizeStylePreset, presetSummary, parsePresetFile, serializePresetFile,
  loadPresetLibrary, savePresetLibrary, uniquePresetName, upsertPreset, removePresetById,
  renamePresetById, newPresetId, cleanPresetName,
  STYLE_PRESET_KIND, STYLE_PRESET_BUNDLE_KIND, PRESET_STORE_KEY,
} from './jsmod/style-preset.js';
import { AssDoc, assStylePresetOf, applyAssStylePreset, ASS_STYLE_PRESET_KIND } from './jsmod/ass.js';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name, extra == null ? '' : '   ' + extra); }
}

/* ── 素材：与 ass-style-preset-test.mjs 同一份最小双语 ASS ── */
const FMT = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
  + 'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
  + 'Alignment, MarginL, MarginR, MarginV, Encoding';

function assText(opts = {}) {
  const zhStyle = opts.zhStyle || 'Default';
  const enStyle = opts.enStyle || 'EN';
  const zh = (opts.zh || `${zhStyle},微软雅黑,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1`);
  const en = (opts.en || `${enStyle},Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2,1,2,10,10,60,1`);
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080',
    '; SubFabricWordHighlightColor: #00ff00', '',
    '[V4+ Styles]', FMT, `Style: ${zh}`, `Style: ${en}`, '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:01.00,0:00:03.00,${zhStyle},,0,0,0,,中文一行`,
    `Dialogue: 0,0:00:01.00,0:00:03.00,${enStyle},,0,0,0,,{\\c&H00FF00&}English{\\c} words`,
    '',
  ].join('\n');
}

const TARGETS = { zh: 'Default', en: 'EN' };
const META = { wordColor: '#ffcc00', kBase: '#ffffff', kSweep: true };
const doc = new AssDoc(assText());
const stylePart = assStylePresetOf(doc, TARGETS, META);

/** 与 main.js 里 state.postProcessConfig 同形的一份配置 */
function fxConfig() {
  return {
    enabled: true,
    glow: {
      enabled: true, target: 'all', followRole: true,
      zh: { enabled: true, channel: 'both', color: '#ff3366', radius: 7.5, intensity: 80 },
      en: { enabled: false, channel: 'outline', color: '#00ff88', radius: 3, intensity: 55 },
    },
    grow: { enabled: false, scale: 100 },
    fadein: { enabled: true, target: 'zh', from: 20, duration: 480, ratio: 60 },
  };
}

/** 内存版 localStorage：模拟真实 API（只实现用到的那几个） */
function memStorage(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

console.log('\n── ① 组装一条预设：样式 / 特效 / 顺序 / 字号缩放都带住 ──');
{
  const p = makeStylePreset({ name: '  双语·暖光  ', style: stylePart, order: 'en-top', fx: fxConfig(), overlayFontScale: 1.25 });
  check('kind 正确', p.kind === STYLE_PRESET_KIND);
  check('名字去空白', p.name === '双语·暖光', JSON.stringify(p.name));
  check('自动生成 id', /^p[0-9a-z]+$/.test(p.id), p.id);
  check('带住两条轨', p.style.tracks.zh.styleName === 'Default' && p.style.tracks.en.styleName === 'EN');
  check('特效整份带住（含中英各自参数）',
    p.fx.enabled === true && p.fx.glow.zh.radius === 7.5 && p.fx.glow.en.intensity === 55
    && p.fx.fadein.duration === 480 && p.fx.glow.followRole === true);
  check('顺序与字号缩放带住', p.order === 'en-top' && p.overlayFontScale === 1.25);
  check('非法顺序被丢掉', makeStylePreset({ name: 'x', order: 'top' }).order === undefined);
  check('字号缩放夹到 0.6~1.8', makeStylePreset({ name: 'x', overlayFontScale: 9 }).overlayFontScale === 1.8);

  // 不给 fx → 用默认配置（不是 undefined，套用后不会把特效配置写成空对象）
  const bare = makeStylePreset({ name: 'only-style', style: stylePart });
  check('缺 fx 时落默认配置', bare.fx && bare.fx.enabled === false && !!bare.fx.glow.zh);

  const noStyle = makeStylePreset({ name: 'fx-only', fx: fxConfig() });
  check('可以只有特效（SRT 稿件保存时就是这个形状）', noStyle.style === undefined && noStyle.fx.enabled === true);
  check('名称兜底不为空', makeStylePreset({ name: '   ' }).name === '未命名预设', makeStylePreset({}).name);
  check('名称超长截断', cleanPresetName('あ'.repeat(200)).length === 60);
  const idA = newPresetId(), idB = newPresetId();
  check('id 不重复', idA !== idB, `${idA} / ${idB}`);
}

console.log('\n── ② 旧版纯样式预设能当预设导入 ──');
{
  const legacy = JSON.parse(JSON.stringify(stylePart));   // kind = subfabric.ass-style-preset
  check('素材确实是旧格式', legacy.kind === ASS_STYLE_PRESET_KIND);
  const r = normalizeStylePreset(legacy);
  check('旧格式被接受', r.ok === true, r.error);
  check('样式落到 style 字段', !!r.preset.style && r.preset.style.tracks.en.styleName === 'EN');
  check('旧格式没有特效 → 落默认（关闭）', r.preset.fx.enabled === false);
  check('元数据保留', r.preset.style.wordColor === '#ffcc00' && r.preset.style.kSweep === true);
  check('名字取自中文样式名', r.preset.name === 'Default', r.preset.name);
}

console.log('\n── ③ 导入文件：该收的收，该拒的拒 ──');
{
  const p1 = makeStylePreset({ name: 'A', style: stylePart, fx: fxConfig() });
  const p2 = makeStylePreset({ name: 'B', fx: fxConfig() });

  const one = parsePresetFile(serializePresetFile([p1]));
  check('单条文件解析成功', one.ok === true && one.presets.length === 1, one.error);
  check('单条内容一致', one.presets[0].name === 'A' && one.presets[0].fx.glow.zh.radius === 7.5);

  const bundle = parsePresetFile(serializePresetFile([p1, p2]));
  check('整库文件解析成功', bundle.ok === true && bundle.presets.length === 2, bundle.error);
  check('整库 kind 正确', JSON.parse(serializePresetFile([p1, p2])).kind === STYLE_PRESET_BUNDLE_KIND);

  const legacyFile = parsePresetFile(JSON.stringify(stylePart));
  check('旧版样式文件也能直接导入', legacyFile.ok === true && !!legacyFile.presets[0].style, legacyFile.error);

  const mixed = parsePresetFile(JSON.stringify({
    kind: STYLE_PRESET_BUNDLE_KIND,
    presets: [p1, { kind: 'nope' }, p2],
  }));
  check('整库里坏的那条跳过、其余照收', mixed.ok === true && mixed.presets.length === 2 && mixed.skipped === 1,
    JSON.stringify({ n: mixed.presets && mixed.presets.length, s: mixed.skipped }));

  const bad = [
    ['不是 JSON', 'not json', /JSON/],
    ['空对象', '{}', /kind/],
    ['kind 不对', JSON.stringify({ kind: 'x.y', tracks: {} }), /kind/],
    ['缺英文轨', JSON.stringify({ kind: STYLE_PRESET_KIND, style: { tracks: { zh: { format: ['Fontname'], values: ['a'] } } } }), /tracks\.en/],
    ['format 与 values 数量不符', JSON.stringify({
      kind: STYLE_PRESET_KIND,
      style: {
        tracks: {
          zh: { format: ['Name', 'Fontname'], values: ['a'] },
          en: { format: ['Name', 'Fontname'], values: ['a', 'b'] },
        },
      },
    }), /数量/],
    ['没有 fontname', JSON.stringify({
      kind: STYLE_PRESET_KIND,
      style: { tracks: { zh: { format: ['Name'], values: ['a'] }, en: { format: ['Name'], values: ['b'] } } },
    }), /fontname/],
    ['整库为空', JSON.stringify({ kind: STYLE_PRESET_BUNDLE_KIND, presets: [] }), /没有预设/],
  ];
  for (const [label, text, re] of bad) {
    const r = parsePresetFile(text);
    check(`拒绝：${label}`, r.ok === false && re.test(String(r.error)), `ok=${r.ok} err=${r.error}`);
  }
  check('只有特效的预设能导入', parsePresetFile(JSON.stringify(p2)).ok === true);
  check('undefined 安全', parsePresetFile(undefined).ok === false);
}

console.log('\n── ④ 本机预设库：增 / 覆盖 / 删 / 改名 ──');
{
  let lib = [];
  const a = makeStylePreset({ name: 'A', fx: fxConfig() });
  lib = upsertPreset(lib, a);
  check('新增一条', lib.length === 1 && lib[0].id === a.id);

  const a2 = { ...a, name: 'A-改', fx: { ...fxConfig(), enabled: false } };
  lib = upsertPreset(lib, a2);
  check('同 id 是覆盖而不是新增', lib.length === 1 && lib[0].name === 'A-改' && lib[0].fx.enabled === false);

  const b = makeStylePreset({ name: 'B', fx: fxConfig() });
  lib = upsertPreset(lib, b);
  check('不同 id 才新增', lib.length === 2);
  check('upsert 不改入参', lib !== upsertPreset(lib, makeStylePreset({ name: 'C' })));

  check('重名加后缀', uniquePresetName(lib, 'A-改') === 'A-改（2）', uniquePresetName(lib, 'A-改'));
  check('重名后缀可叠加', uniquePresetName([...lib, makeStylePreset({ name: 'A-改（2）' })], 'A-改') === 'A-改（3）');
  check('改名时自己不算重名', uniquePresetName(lib, 'A-改', a.id) === 'A-改');

  const ren = renamePresetById(lib, b.id, 'A-改');
  check('重命名自动避开重名', ren.name === 'A-改（2）', ren.name);
  check('重命名后列表已更新', ren.list.find(p => p.id === b.id).name === 'A-改（2）');
  check('重命名不存在的 id 安全', renamePresetById(lib, 'nope', 'x').name === '');

  lib = removePresetById(ren.list, b.id);
  check('删除按 id', lib.length === 1 && lib[0].id === a.id);
  check('删不存在的 id 不影响列表', removePresetById(lib, 'nope').length === 1);

  // 存储往返
  const st = memStorage();
  check('写库成功', savePresetLibrary(lib, st) === true);
  const back = loadPresetLibrary(st);
  check('读回来内容一致', back.length === 1 && back[0].name === 'A-改' && back[0].fx.enabled === false);
  check('库键名固定', Object.keys(st.dump())[0] === PRESET_STORE_KEY);

  check('坏 JSON 读成空库', loadPresetLibrary(memStorage({ [PRESET_STORE_KEY]: '{oops' })).length === 0);
  check('不是数组读成空库', loadPresetLibrary(memStorage({ [PRESET_STORE_KEY]: '{"a":1}' })).length === 0);
  check('库里混着坏条目时只留好的', loadPresetLibrary(memStorage({
    [PRESET_STORE_KEY]: JSON.stringify([{ kind: 'x' }, a]),
  })).length === 1);
  const throwing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
  check('存储写不进去时返回 false（调用方要提示，不能静默丢）', savePresetLibrary(lib, throwing) === false);
}

console.log('\n── ⑤ 预设里的样式部分真的能落到另一份稿件 ──');
{
  const preset = makeStylePreset({ name: '整套', style: stylePart, fx: fxConfig() });
  const parsed = parsePresetFile(serializePresetFile([preset]));
  check('文件往返后仍可解析', parsed.ok === true, parsed.error);
  const other = new AssDoc(assText({ zhStyle: '中文', enStyle: 'English',
    zh: '中文,思源黑体,52,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1',
    en: 'English,Times New Roman,36,&H00202020,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2,1,2,10,10,60,1' }));
  const res = applyAssStylePreset(other, parsed.presets[0].style, { zh: '中文', en: 'English' });
  check('套用成功', res.ok === true, JSON.stringify(res));
  check('中文字体换成预设的', other.getStyle('中文').fontname === '微软雅黑', other.getStyle('中文').fontname);
  check('英文字体换成预设的', other.getStyle('English').fontname === 'Arial', other.getStyle('English').fontname);
  check('样式名不被预设覆盖', !!other.getStyle('中文') && !!other.getStyle('English'));
  check('事件文本一个字没动', other.serialize().includes('{\\c&H00FF00&}English{\\c} words'));
}

console.log('\n── ⑥ 摘要说清楚字体字号与特效开关 ──');
{
  const s1 = presetSummary(makeStylePreset({ name: 'x', style: stylePart, fx: fxConfig() }));
  check('含中文轨字体字号', s1.includes('微软雅黑 48'), s1);
  check('含英文轨字体字号', s1.includes('Arial 40'), s1);
  check('列出开着的特效', s1.includes('微光') && s1.includes('淡入') && !s1.includes('生长'), s1);

  const s2 = presetSummary(makeStylePreset({ name: 'x', fx: { enabled: false } }));
  check('只有特效且总开关关着时写明', s2.includes('仅特效') && s2.includes('特效关'), s2);

  const s3 = presetSummary(makeStylePreset({ name: 'x', fx: { ...fxConfig(), enabled: true,
    glow: { enabled: false }, grow: { enabled: false }, fadein: { enabled: false } } }));
  check('特效开着但都关了 → 说明「特效全关」', s3.includes('特效全关'), s3);
}

console.log('');
if (failed) { console.log(`✗ ${failed} 项失败`); process.exit(1); }
console.log('全部通过');
