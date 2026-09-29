/* 首页项目卡片进度条一致性探针:
 *   ① 条的宽度百分比 == 右边那个数字 == 服务端给的 draft.progress（动画结束后）
 *   ② 动画期间两者也不能离谱地不一致（半边天: 采样几个时刻, 差值 <= 12 个百分点）
 *   ③ 各种状态(running / paused / done / error)下都成立
 * 做法: 直接用 API 建 4 个项目, 把 project.json 里的 draft 改写成指定状态, 重启服务让它生效。 */
import { launch, sleep } from './lib/cdp.mjs';
import { readFileSync, writeFileSync, readdirSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8356';
const ROOT = process.env.REPO_DIR || 'D:/Vibe Coding/SubFabric';
const PROJ = process.env.PROJ_DIR || (ROOT + '/projects');
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const STATES = [
  { key: 'running', name: '进度探针-running', draft: { status: 'running', stage: 'ASR识别中', progress: 37, message: '识别中 …', lines: 0, words: 0 } },
  { key: 'paused', name: '进度探针-paused', draft: { status: 'paused', stage: '翻译中', progress: 86, message: '待翻译', lines: 1231, pendingTranslate: 1231, needTranslate: true } },
  { key: 'done2', name: '进度探针-done2-名字明显更长一些', draft: { status: 'done', stage: '完毕', progress: 100, message: '初稿已生成: 1331 行（含中文译文）这一条副标题也长得多', lines: 1331, translated: true } },
  { key: 'done', name: '进度探针-done', draft: { status: 'done', stage: '完毕', progress: 100, message: '初稿已生成: 1231 行（含中文译文）', lines: 1231, translated: true } },
  { key: 'error', name: '进度探针-error', draft: { status: 'error', stage: 'ASR识别中', failedStage: 'ASR识别中', progress: 42, message: '识别失败', error: '测试用' } },
];

const MIN_ASS = [
  '[Script Info]', 'ScriptType: v4.00+', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1', '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,hi',
].join('\n');

const created = [];
for (const st of STATES) {
  const r = await (await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: st.name, video: { path: process.env.DEMO_VIDEO || 'D:/Vibe Coding/_t/demo.mp4' }, subtitle: { name: 'subtitle.ass', text: MIN_ASS } }),
  })).json();
  if (!r || !r.id) { console.log('建项目失败:', JSON.stringify(r).slice(0, 160)); process.exit(1); }
  created.push({ id: r.id, ...st });
  // 直接改写 project.json 里的 draft（服务端可能缓存 meta, 所以稍后重启）
  const f = `${PROJ}/${r.id}/project.json`;
  const meta = JSON.parse(readFileSync(f, 'utf8'));
  meta.draft = st.draft;
  writeFileSync(f, JSON.stringify(meta, null, 2));
}
console.log('已建 4 个状态项目:', created.map(c => c.key + '=' + c.id).join(' '));
console.log('（需要重启服务让 draft 生效 —— 由调用方负责）');
writeFileSync('D:/Vibe Coding/_t/progress_ids.json', JSON.stringify(created));
