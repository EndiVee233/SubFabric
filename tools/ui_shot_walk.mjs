/* 界面走查截图（开发用，不进安装包）: node tools/ui_shot_walk.mjs [phase]
 *   phase = empty → 只截"没有项目"的空状态（调用方需先把 projects/ 挪走）
 *   phase = full  → 截其余全部界面（默认）
 * 产出: _t/shots/NN-name.png + _t/shots/manifest.json（含每张图的说明，供审评用）
 * 前提: 服务在 8321（可用 BASE 覆盖）；演示项目已建好（见 _t/demo_pid.txt）
 */
import { launch, sleep } from './lib/cdp.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8321';
const OUT = 'D:/Vibe Coding/_t/shots';
const PORT = Number(process.env.CDP_PORT || 9390);
const phase = process.argv[2] || 'full';
mkdirSync(OUT, { recursive: true });

const manifest = [];
const shot = async (b, name, desc) => {
  const file = `${OUT}/${name}.png`;
  await b.shot(file);
  manifest.push({ name, file, desc });
  console.log('  shot', name, '—', desc);
};

const projects = await (await fetch(BASE + '/api/projects')).json();
const list = projects.projects || [];
const pidMain = list.find(p => !p.draft)?.id || list[0]?.id;
const pidDraft = list.find(p => p.draft && p.draft.status === 'paused')?.id || list[0]?.id;

const b = await launch({ port: PORT, width: 1440, height: 900 });

/* ── 空状态（先把 projects/ 挪走再跑） ── */
if (phase === 'empty') {
  await b.goto(BASE + '/#/home');
  await sleep(2500);
  await shot(b, '01-home-empty', '首页 · 一个项目都没有时的空状态（图标 + 标题 + 说明 + 新建按钮）');
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length} 张 → ${OUT}`);
  b.close();
  process.exit(0);
}

/* ── 1. 无项目的编辑器（只有提示卡） ── */
await b.goto(BASE + '/#/editor');
await sleep(2500);
await shot(b, '20-editor-no-project', '编辑器 · 没打开项目：#/editor 的视频区提示卡 + 空时间轴 + 空列表');

/* ── 2. 首页 + 项目列表 ── */
await b.goto(BASE + '/#/home');
await sleep(2200);
await shot(b, '02-home-list', '首页 · 三个项目卡片（名称/视频/字幕/修改时间/角标/按钮）');

/* 卡片右键菜单 */
{
  const pos = await b.eval("(() => { const c = document.querySelector('.proj-card'); const r = c.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 120), y: Math.round(r.top + 30) }); })()");
  const p = JSON.parse(pos);
  await b.mouse('mousePressed', p.x, p.y, { button: 'right', buttons: 2 });
  await b.mouse('mouseReleased', p.x, p.y, { button: 'right', buttons: 0 });
  await sleep(500);
  await shot(b, '03-home-card-menu', '首页 · 项目卡片右键菜单');
  await b.eval("document.body.click()");
  await sleep(200);
}

/* 新建项目弹窗 */
await b.eval("document.getElementById('btn-new-project').click()");
await sleep(700);
await shot(b, '04-dialog-new-project', '新建项目弹窗 · 项目名称/两种模式卡片/视频与字幕选择/底部按钮与说明');
await b.eval("document.getElementById('np-overlay').hidden = true");
await sleep(200);

/* ── 3. 编辑器四个页签 ── */
await b.goto(BASE + '/#/project/' + pidMain);
await b.send('Page.reload', {});
await sleep(3200);
await shot(b, '05-editor-subs', '编辑器 · 字幕页签（列表卡片：时间/时长/层级角标/角色/中英文本）');
for (const [tab, name, desc] of [
  ['roles', '06-editor-roles', '编辑器 · 角色页签（角色卡片、颜色、添加角色）'],
  ['settings', '07-editor-settings-top', '编辑器 · 设置页签上半（时间轴/字幕显示/角色）'],
  ['logs', '09-editor-logs', '编辑器 · 日志页签（工具栏 + 实时日志）'],
]) {
  await b.eval(`document.querySelector('.ptab[data-tab="${tab}"]').click()`);
  await sleep(600);
  await shot(b, name, desc);
}
/* 设置页签滚到底（导入与音频 / 外观 / 导出 / 底部说明） */
await b.eval("document.querySelector('.ptab[data-tab=\"settings\"]').click()");
await sleep(400);
await b.eval("(() => { const p = document.querySelector('.st-panel:not([hidden])'); if (p) p.scrollTop = p.scrollHeight; })()");
await sleep(600);
await shot(b, '08-editor-settings-bottom', '编辑器 · 设置页签下半（导入与音频、外观主题色、导出、底部说明文字）');

/* toast（用外观的「恢复默认」触发） */
await b.eval("document.getElementById('theme-reset').click()");
await sleep(250);
await shot(b, '19-toast', 'Toast 提示（右下角浮出的那条）');
await sleep(600);

/* ── 4. 全局设置弹窗三个页签 ── */
await b.eval("document.getElementById('btn-settings-ed').click()");
await sleep(800);
await shot(b, '10-dialog-settings-models', '全局设置 · 识别模型页签（模型管理卡片 + 服务商设置 + 说话人分离）');
for (const [stp, name, desc] of [
  ['translate', '11-dialog-settings-translate', '全局设置 · 字幕翻译页签（服务商/接口/Key/模型/每批行数/提示词/术语表）'],
  ['enhance', '12-dialog-settings-enhance', '全局设置 · 识别增强页签（热词 + 热词强度）'],
]) {
  await b.eval(`document.querySelector('.st-tab[data-stp="${stp}"]').click()`);
  await sleep(600);
  await shot(b, name, desc);
}
await b.eval("document.getElementById('st-close').click()");
await sleep(400);

/* ── 5. 查找与批量替换（两个页签） ── */
await b.eval("document.getElementById('btn-search').click()");
await sleep(700);
await shot(b, '13-dialog-find', '查找与批量替换 · 正文页签（范围/大小写/全词、两个输入框、说明文字、底部按钮）');
await b.eval("document.getElementById('fr-tab-role').click()");
await sleep(500);
await shot(b, '14-dialog-find-role', '查找与批量替换 · 角色页签');
await b.eval("document.getElementById('fr-overlay').hidden = true");
await sleep(300);

/* ── 6. 时间轴右键菜单 + 批量选区浮条 ── */
{
  const c = await b.eval("(() => { const cv = document.getElementById('timeline'); const r = cv.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width * 0.35), y: Math.round(r.top + r.height * 0.55), x2: Math.round(r.left + r.width * 0.75) }); })()");
  const p = JSON.parse(c);
  await b.mouse('mousePressed', p.x, p.y, { button: 'right', buttons: 2 });
  await b.mouse('mouseReleased', p.x, p.y, { button: 'right', buttons: 0 });
  await sleep(500);
  await shot(b, '18-timeline-menu', '时间轴 · 字幕块右键菜单（修复字幕/重新翻译/删除字幕块）');
  await b.eval("document.getElementById('tl-menu').hidden = true");
  await sleep(200);
  await b.dragWithCtrl(p.x, p.y, p.x2, p.y, { steps: 10 });
  await sleep(500);
  await shot(b, '21-range-bar', '时间轴 · Ctrl 拖出选区后的批量操作浮条');
  await b.eval("document.getElementById('range-bar').hidden = true");
  await sleep(200);
}

/* ── 7. 确认框（删项目） ── */
await b.goto(BASE + '/#/home');
await sleep(1600);
await b.eval("document.querySelector('.proj-card .pc-del').click()");
await sleep(700);
await shot(b, '15-dialog-confirm', '确认弹窗 · 删除项目（标题/正文/两个按钮）');
await b.eval("document.getElementById('confirm-overlay').hidden = true");
await sleep(200);

/* ── 8. 查看进度浮层（初稿暂停的那张卡） ── */
{
  await b.eval(`(() => { const cards = Array.from(document.querySelectorAll('.proj-card')); const c = cards.find(x => x.querySelector('.pc-prog')); if (c) c.querySelector('.pc-prog').click(); })()`);
  await sleep(900);
  await shot(b, '17-dialog-progress', '初稿进度浮层（步骤条/进度条/阶段文案/重试与跳过/日志区）');
  await b.eval("document.getElementById('dp-overlay').hidden = true");
  await sleep(300);
}

/* ── 9. 修复字幕弹窗（需要一条"缺逐词"的英文行） ── */
let tmpProjectId = '';
{
  const noKaraoke = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 中文字幕,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1
Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:03.00,中文字幕,wato,0,0,0,,{\\c&Hd000ff&}[wato] 我在这个频道创建过很多密室逃脱
Dialogue: 0,0:00:00.00,0:00:03.00,Default,wato,0,0,0,,Dear player of the Unstable SMP,I plan.to nuke Capital City,
`;
  const body = JSON.stringify({ name: '界面审评 · 待修复', video: { path: 'D:/Vibe Coding/_t/demo.mp4' }, subtitle: { name: 'fix.ass', text: noKaraoke } });
  const r = await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
  tmpProjectId = r.id;
  await b.goto(BASE + '/#/project/' + r.id);
  await sleep(3200);
  const pos = await b.eval("(() => { const c = document.querySelector('.cue-card'); const r = c.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 150), y: Math.round(r.top + 40) }); })()");
  const p = JSON.parse(pos);
  await b.mouse('mousePressed', p.x, p.y, { button: 'right', buttons: 2 });
  await b.mouse('mouseReleased', p.x, p.y, { button: 'right', buttons: 0 });
  await sleep(600);
  await b.eval("(() => { const v = Array.from(document.querySelectorAll('[data-act=\"fix\"]')).filter(e => e.offsetParent !== null); if (v.length) v[v.length - 1].click(); })()");
  await sleep(800);
  await shot(b, '16-dialog-fix', '修复字幕弹窗（问题清单/建议文本/一键修复与取消）');
  await b.eval("document.getElementById('fix-overlay').hidden = true");
}

/* 走查用的临时项目用完就删（否则每跑一次首页就多留一张卡） */
if (tmpProjectId) {
  try {
    await fetch(BASE + '/api/projects/' + tmpProjectId, { method: 'DELETE' });
    console.log('  已删除临时项目 ' + tmpProjectId);
  } catch {}
}

writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} 张 → ${OUT}`);
b.close();
