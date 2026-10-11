/**
 * ASS 双语样式预设：导出 / 导入（稿件编辑页 → 设置 → ASS 双语样式）。
 *
 * 覆盖纯逻辑（editor/js/ass.js 的三个导出函数）：
 *   ① 导出 → 导入回同一份稿件，两条样式逐字段不变（含面板没暴露的 Alignment/MarginV/Outline/Shadow）
 *   ② 导入到**另一份稿件**：按字段名搬运，两边 Format 顺序不同也不错位；样式名不被覆盖
 *   ③ 面板暴露的字段（字体/字号/粗斜/颜色）确实换成了预设的值
 *   ④ 坏文件一律拒绝且给出可读原因（kind 不对 / 缺字段 / format 与 values 数量不符 / 非 JSON）
 *   ⑤ 稿件里认不出中英样式时明确失败，不静默乱改
 *   ⑥ format 缺少某个字段时跳过它，不动目标样式的该字段（老 SSA 稿件的 V4 字段集更少）
 */
import { AssDoc, assStylePresetOf, parseAssStylePreset, applyAssStylePreset, findStyleForLang,
  ASS_STYLE_PRESET_KIND } from './jsmod/ass.js';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name, extra == null ? '' : '   ' + extra); }
}

/** 与 main.js 的 assHexToBgr / assBgrToHex 同款（测试里独立实现一遍，避免"用被测代码验被测代码"） */
function hexToBgr(hex) {
  const rgb = String(hex || '').replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(rgb)) return null;
  return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}
function bgrToHex(raw, fallback) {
  const m = /&H([0-9A-Fa-f]{6,8})/i.exec(String(raw || ''));
  if (!m) return fallback;
  const h = m[1].slice(-6).toUpperCase();
  return '#' + (h[4] + h[5] + h[2] + h[3] + h[0] + h[1]).toLowerCase();
}

const FMT_V4P = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
  + 'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
  + 'Alignment, MarginL, MarginR, MarginV, Encoding';

function assText(opts = {}) {
  // ⚠ 这里必须同时改 **Style 声明行的名字** 和 Dialogue 的引用 —— 只改后者的话文档里
  //   根本没有那个样式（踩过：测试以为自己造了 "ZH"，实际 Style 行还是 "Default"）。
  const zhStyle = opts.zhStyle || 'Default';
  const enStyle = opts.enStyle || 'EN';
  const fmt = opts.fmt || FMT_V4P;
  const zh = (opts.zh || 'Default,微软雅黑,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,'
    + '-1,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1').replace(/^Default,/, zhStyle + ',');
  const en = (opts.en || 'EN,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,'
    + '0,-1,0,0,100,100,0,0,1,2,1,2,10,10,60,1').replace(/^EN,/, enStyle + ',');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '; SubFabricWordHighlightColor: #00ff00',
    '',
    '[V4+ Styles]',
    fmt,
    `Style: ${zh}`,
    `Style: ${en}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,' + zhStyle + ',,0,0,0,,中文一行',
    'Dialogue: 0,0:00:01.00,0:00:03.00,' + enStyle + ',,0,0,0,,{\\c&H00FF00&}English{\\c} words',
    '',
  ].join('\n');
}

const TARGETS = { zh: 'Default', en: 'EN' };
const META = { wordColor: '#ffffff', kBase: '#cccccc', kSweep: true };

console.log('\n── ① 同稿件往返：两条样式逐字段不变 ──');
{
  const doc = new AssDoc(assText());
  const preset = assStylePresetOf(doc, TARGETS, META);
  check('导出得到预设对象', !!preset && preset.kind === ASS_STYLE_PRESET_KIND);
  check('预设带两条轨', !!(preset && preset.tracks.zh && preset.tracks.en));
  check('元数据入预设', preset.wordColor === '#ffffff' && preset.kBase === '#cccccc' && preset.kSweep === true);

  const before = {
    zh: doc.getStyle('Default'), en: doc.getStyle('EN'),
  };
  const same = new AssDoc(assText());
  const res = applyAssStylePreset(same, preset, TARGETS);
  check('导入成功', res.ok === true, JSON.stringify(res));
  check('落点正确', res.applied.zh === 'Default' && res.applied.en === 'EN', JSON.stringify(res.applied));
  check('中文样式逐字段不变', JSON.stringify(same.getStyle('Default')) === JSON.stringify(before.zh));
  check('英文样式逐字段不变', JSON.stringify(same.getStyle('EN')) === JSON.stringify(before.en));

  // 面板没暴露的字段也要真的在（否则"导出丢了它们"这种 bug 测不出来）
  check('保留了面板没暴露的 Alignment/MarginV/Outline/Shadow',
    same.getStyle('EN').alignment === '2' && same.getStyle('EN').marginv === '60'
    && same.getStyle('EN').outline === '2' && same.getStyle('EN').shadow === '1',
    JSON.stringify({ a: same.getStyle('EN').alignment, mv: same.getStyle('EN').marginv }));

  // JSON 往返（真实路径就是写文件再读回来）
  const round = parseAssStylePreset(JSON.stringify(preset));
  check('JSON 往返可解析', round.ok === true, round.error);
  const third = new AssDoc(assText());
  check('往返后再导入仍成功', applyAssStylePreset(third, round.preset, TARGETS).ok === true);
}

console.log('\n── ② 导到"另一份稿件"：字段名搬运 + 不覆盖样式名 ──');
{
  const doc = new AssDoc(assText());
  const preset = assStylePresetOf(doc, TARGETS, META);

  // 目标稿件：样式名不同（中文/English）、且 Format 顺序**打乱**（把 MarginV 与 Alignment 对调）
  const shuffled = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
    + 'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
    + 'MarginV, MarginL, MarginR, Alignment, Encoding';
  const other = new AssDoc(assText({
    fmt: shuffled, zhStyle: '中文', enStyle: 'English',
    zh: '中文,思源黑体,52,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1',
    en: 'English,Times New Roman,36,&H00202020,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2,1,2,10,10,60,1',
  }));
  const res = applyAssStylePreset(other, preset, { zh: '中文', en: 'English' });
  check('导入成功', res.ok === true, JSON.stringify(res));
  check('样式名没被预设里的 Default/EN 覆盖',
    !!other.getStyle('中文') && !!other.getStyle('English'),
    other.styleNames.join(','));
  check('字体按预设改了（中文轨）', other.getStyle('中文').fontname === '微软雅黑',
    other.getStyle('中文').fontname);
  check('字体按预设改了（英文轨）', other.getStyle('English').fontname === 'Arial',
    other.getStyle('English').fontname);
  check('字号也跟过来了', other.getStyle('中文').fontsize === '48' && other.getStyle('English').fontsize === '40');
  check('Format 顺序不同也不串位：MarginV 仍是各轨自己的值'
    + '（预设 zh marginv=30 / en marginv=60）',
    other.getStyle('中文').marginv === '30' && other.getStyle('English').marginv === '60',
    JSON.stringify({ zh: other.getStyle('中文').marginv, en: other.getStyle('English').marginv }));
  check('颜色按预设改了（中文轨白）', bgrToHex(other.getStyle('中文').primarycolour, '') === '#ffffff',
    other.getStyle('中文').primarycolour);
  check('粗斜按预设改了（英文轨斜体）', other.getStyle('English').italic === '-1',
    other.getStyle('English').italic);
  check('事件文本一个字没动',
    other.serialize().includes('{\\c&H00FF00&}English{\\c} words')
    && other.serialize().includes('中文一行'));
}

console.log('\n── ③ 中英样式的识别兜底 ──');
{
  const doc = new AssDoc(assText({ zhStyle: 'ZH', enStyle: 'English' }));
  check('findStyleForLang 认中文轨', findStyleForLang(doc, 'zh') === 'ZH', findStyleForLang(doc, 'zh'));
  // ⚠ 这一条钉的是一个真 bug：线索正则原来写的是 (^|[-_])zh([-_]|$)，而 "English" 里
  //   恰好含 "zh"（En-gli-zh），于是**英文样式被认成中文轨**。必须用单词边界。
  check('findStyleForLang 不会把 English 当中文轨', findStyleForLang(doc, 'zh') !== 'English',
    findStyleForLang(doc, 'zh'));
  check('findStyleForLang 认英文轨', findStyleForLang(doc, 'en') === 'English', findStyleForLang(doc, 'en'));

  const preset = assStylePresetOf(doc, { zh: 'ZH', en: 'English' }, {});
  check('preset 里记了原样式名', preset.tracks.zh.styleName === 'ZH' && preset.tracks.en.styleName === 'English');
  check('没有可选元数据时就不写进预设',
    preset.wordColor === undefined && preset.kBase === undefined && preset.kSweep === undefined);

  // 目标稿件里样式名换了、targets 也给不出时，靠线索兜底也要落对轨
  const other = new AssDoc(assText({ zhStyle: 'ZH', enStyle: 'English' }));
  const res = applyAssStylePreset(other, preset, null);
  check('targets 为空时靠线索兜底导入成功', res.ok === true, JSON.stringify(res));
  check('兜底落点正确（zh→ZH / en→English）',
    res.applied.zh === 'ZH' && res.applied.en === 'English', JSON.stringify(res.applied));
  check('兜底时中英没被对调（中文字体来自预设 zh 轨）',
    other.getStyle('ZH').fontname === '微软雅黑' && other.getStyle('English').fontname === 'Arial',
    JSON.stringify({ zh: other.getStyle('ZH').fontname, en: other.getStyle('English').fontname }));
}

console.log('\n── ④ 坏文件必须被拒绝，且原因可读 ──');
{
  const cases = [
    ['不是 JSON', 'not json at all', /JSON/],
    ['kind 不对', JSON.stringify({ kind: 'something.else', tracks: {} }), /kind/],
    ['缺 tracks', JSON.stringify({ kind: ASS_STYLE_PRESET_KIND }), /tracks/],
    ['缺英文轨', JSON.stringify({ kind: ASS_STYLE_PRESET_KIND, tracks: { zh: { format: ['Name', 'Fontname'], values: ['a', 'b'] } } }), /tracks\.en/],
    ['format 与 values 数量不符', JSON.stringify({
      kind: ASS_STYLE_PRESET_KIND,
      tracks: { zh: { format: ['Name', 'Fontname'], values: ['a'] }, en: { format: ['Name', 'Fontname'], values: ['a', 'b'] } },
    }), /数量/],
    ['没有 fontname 字段', JSON.stringify({
      kind: ASS_STYLE_PRESET_KIND,
      tracks: { zh: { format: ['Name', 'Fontsize'], values: ['a', '48'] }, en: { format: ['Name', 'Fontname'], values: ['a', 'b'] } },
    }), /fontname/],
  ];
  for (const [label, text, re] of cases) {
    const r = parseAssStylePreset(text);
    check(`拒绝：${label}`, r.ok === false && re.test(String(r.error)), `ok=${r.ok} err=${r.error}`);
  }
  // 空/undefined 也不能炸
  check('空串安全', parseAssStylePreset('').ok === false);
  check('undefined 安全', parseAssStylePreset(undefined).ok === false);
}

console.log('\n── ⑤ 稿件里认不出中英样式时明确失败 ──');
{
  // 只有一条样式 → 无法分辨两条轨
  const oneStyle = assText().replace('Style: EN,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2,1,2,10,10,60,1\n', '');
  const doc = new AssDoc(oneStyle);
  const preset = {
    kind: ASS_STYLE_PRESET_KIND,
    tracks: {
      zh: { styleName: 'Default', format: ['Name', 'Fontname'], values: ['Default', 'X'] },
      en: { styleName: 'EN', format: ['Name', 'Fontname'], values: ['EN', 'Y'] },
    },
  };
  const res = applyAssStylePreset(doc, preset, null);
  check('单样式稿件导入失败', res.ok === false, JSON.stringify(res));
  check('失败时不改任何东西（changed=0）', res.changed === 0);
  check('失败原因指向找不到的轨道', /找不到/.test(String(res.error)), res.error);

  const doc2 = new AssDoc(assText());
  const empty = applyAssStylePreset(doc2, null, TARGETS);
  check('预设为空时安全失败', empty.ok === false && empty.changed === 0);
}

console.log('\n── ⑥ 字段集更小（老 SSA 风格 V4）时跳过缺字段，不写坏样式 ──');
{
  const shortFmt = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
    + 'Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
  const doc = new AssDoc(assText({ fmt: shortFmt }));
  const preset = {
    kind: ASS_STYLE_PRESET_KIND,
    tracks: {
      // 预设里多带一个目标没有的 spacing 字段
      zh: { styleName: 'Default', format: ['Name', 'Fontname', 'Spacing'], values: ['Default', '思源黑体', '5'] },
      en: { styleName: 'EN', format: ['Name', 'Fontname', 'Spacing'], values: ['EN', 'Consolas', '5'] },
    },
  };
  const res = applyAssStylePreset(doc, preset, TARGETS);
  check('导入成功（缺字段被跳过）', res.ok === true, JSON.stringify(res));
  check('已有字段照常写入', doc.getStyle('Default').fontname === '思源黑体' && doc.getStyle('EN').fontname === 'Consolas');
  check('目标没有的 spacing 不在样式里', doc.getStyle('Default').spacing === undefined);
  // 字段数必须与**这条稿件自己的 Format 声明**一致。别写死数字：
  // 夹具里的 Style 值是照 V4+ 的 23 个位置写的，换成 17 字段的 Format 后行里仍留着 23 个位置
  // （解析器按 Format 取前 17 个，多的不参与）。写死数字只会让断言自己算错。
  const wantN = shortFmt.replace(/^Format:\s*/i, '').split(',').length;
  const gotLines = doc.serialize().match(/^Style: .+$/gm) || [];
  const gotN = gotLines.map(l => l.replace(/^Style:\s*/, '').split(',').length);
  check('两条样式行都还在、且字段数不少于 Format 声明',
    gotLines.length === 2 && gotN.every(n => n >= wantN),
    `want>=${wantN} got=${gotN.join('/')}`);
  check('解析器只认 Format 声明的前 N 个字段（spacing 不在其中）',
    Object.keys(doc.getStyle('Default')).length === wantN
    && !Object.keys(doc.getStyle('Default')).includes('spacing'),
    `keys=${Object.keys(doc.getStyle('Default')).length}`);
}

console.log('');
if (failed) { console.log(`✗ ${failed} 项失败`); process.exit(1); }
console.log('全部通过');
