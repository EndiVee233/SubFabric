/**
 * 反思纠错的 UI 接线回归。
 *
 * 后端已有 tests/reflect-test.mjs（60 项）覆盖纯逻辑。这里只管**接线**：
 *   · 稿件页有触发按钮，且只在项目模式可用
 *   · 预览弹窗的结构齐全（概览 / 全选 / 清单 / 三个按钮）
 *   · 前端确实调了 /reflect 与 /reidentify
 *   · 前端**自己也要求并区间**再提交（后端还会再求一次，两边都不能漏）
 *   · 全局设置里有纠错配置（含指向本地部署的入口）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HTML = fs.readFileSync(path.join(REPO, 'editor', 'index.html'), 'utf8');
const MJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');
const PJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8');
const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== 1. 稿件页触发按钮 ==');
ok(/id="btn-reflect"/.test(HTML), '有「反思纠错」按钮');
ok(/id="btn-reflect"[^>]*disabled/.test(HTML), '初始是禁用的（要有项目才能用）');
ok(/reflectEls\.btn\.disabled = !state\.project/.test(MJ), '载入字幕时按"是否有项目"解禁');
ok(/if \(reflectEls\.btn\) reflectEls\.btn\.addEventListener\('click', startReflect\);/.test(MJ),
  '点了就调 startReflect');

console.log('\n== 2. 预览弹窗结构 ==');
for (const id of ['reflect-overlay', 'reflect-msg', 'reflect-conf', 'reflect-conf-val',
                  'reflect-conf-note', 'reflect-summary', 'reflect-all-wrap', 'reflect-all',
                  'reflect-list', 'reflect-cancel', 'reflect-reload', 'reflect-apply']) {
  ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
}
ok(/id="reflect-overlay" hidden/.test(HTML), '弹窗默认隐藏');
// 进度已经挪到右下角 #job-card，弹窗里不该再留进度条（留着会让人以为有两处进度）
ok(!/id="reflect-busy"/.test(HTML), '弹窗里不再有进度条（已挪到 #job-card）');
ok(!/\.reflect-busy\s*\{/.test(CSS), '废弃的 .reflect-busy 样式已删除');
// 三按钮的分工：关闭 / 重新反思 / 应用选中
ok(/>关闭</.test(HTML), '有关闭按钮');
ok(/id="reflect-reload"[^>]*hidden/.test(HTML), '「重新反思」默认隐藏（跑完才给）');
ok(/id="reflect-apply"[^>]*disabled/.test(HTML), '「应用选中项」默认禁用（没勾选不能点）');
ok(/\.reflect-box\s*\{/.test(CSS) && /\.reflect-list\s*\{/.test(CSS),
  '样式在（弹窗外壳 + 可滚清单）');
ok(/overflow-y:\s*auto/.test((CSS.match(/\.reflect-list\s*\{[^}]*\}/) || [''])[0]),
  '清单可滚动（建议可能几十条）');

console.log('\n== 2b. 右下角进度卡（反思 / 重识别的统一出口）==');
for (const id of ['job-card', 'jc-title', 'jc-bar-in', 'jc-msg', 'jc-foot', 'jc-close']) {
  ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
}
ok(/id="job-card" hidden/.test(HTML), '默认隐藏');
ok(/function jobCardShow\(/.test(MJ) && /function jobCardDone\(/.test(MJ)
   && /function jobCardHide\(/.test(MJ), '有 show / done / hide 三个出口');
// 反思不再用阻塞弹窗报进度：跑之前不弹窗，跑完才弹
ok(/reflectShow\(false\);[\s\S]{0,600}jobCardShow\('反思纠错/.test(MJ),
  '反思开始时先不弹窗，改用进度卡');
ok(/jobCardDone\('反思纠错 · 完成'[\s\S]{0,200}reflectShow\(true\)/.test(MJ),
  '反思跑完才弹预览');
// 拿不到真实批次进度时用"不确定进度"（条纹动画），至少让人看出还在动
ok(/typeof pct === 'number' && isFinite\(pct\)/.test(MJ), '区分确定/不确定进度');
ok(/\.jc-indet/.test(CSS) && /@keyframes jc-stripe/.test(CSS), '不确定进度用条纹动画');
ok(/\.jc-spin/.test(CSS) && /@keyframes jc-spin/.test(CSS), '有转动指示');
ok(/position: fixed; right: 16px; bottom: 16px/.test(CSS), '固定在右下角');
ok(/\.jc-err/.test(CSS) && /\.jc-done/.test(CSS), '完成/失败有不同配色');
// 重识别批量进度也要接上（否则卡片只对反思生效）
ok(/jobCardShow\(isBatch \? '纠错重识别 · 逐段进行'/.test(MJ), '重识别进度也走同一张卡');
ok(/第 <b>\$\{\(j\.regionIndex \| 0\) \+ 1\}<\/b>\/\$\{j\.regionTotal\} 段/.test(MJ),
  '批量显示"第 N/M 段"');
/* 轮询必须走 /reidentify：它的 GET 会过 jobView()，才带 batch/regions/regionDone；
 * /rerecognize 的 GET 直接回原始 job，前端拿不到这些字段（实测踩过）。
 * 注意 POST 仍然打到 /rerecognize（那才是"发起单区间重识别"的接口），所以这里
 * 只禁 GET 形式的轮询写法。 */
ok(/fetch\(`\/api\/projects\/\$\{pid\}\/reidentify`\)/.test(MJ),
  '轮询 /reidentify（走 jobView，才有批量字段）');
ok(!/await \(await fetch\(`\/api\/projects\/\$\{pid\}\/rerecognize`\)\)/.test(MJ),
  '轮询不再用 /rerecognize（那条路由不做 jobView 加工）');

console.log('\n== 2c. 置信度档位跟随全局设置 ==');
ok(/const CONF_MODES = \['off', 'fast', 'full'\];/.test(MJ),
  'main.js 里声明了档位常量（project.js 那个是模块作用域，跨模块看不见）');
ok(/function reflectShowConfMode\(/.test(MJ), '有取档位并显示的入口');
ok(/CONF_MODES\.includes\(meta\.confidence\)/.test(MJ), '项目级设过就显示项目级');
ok(/fetch\('\/api\/asr\/confidence'/.test(MJ), '没设过就跟随全局（读服务端）');
ok(/跟随全局设置/.test(MJ) && /全局设置 → 识别增强/.test(MJ),
  '文案说明来源与去哪改（只读展示，不在预览里改档位）');

console.log('\n== 3. 前端调用了正确接口 ==');
ok(/\/api\/projects\/\$\{state\.project\.id\}\/reflect/.test(MJ), '调 /reflect');
ok(/\/api\/projects\/\$\{state\.project\.id\}\/reidentify/.test(MJ), '调 /reidentify');
ok(/regions:\s*uniq/.test(MJ), '提交时带 regions 数组');

console.log('\n== 4. 前端自己也求并区间（后端还会再求一次）==');
// 这段等价于 planRegions / 服务端的合并规则
ok(/const uniq = \[\];/.test(MJ), '有 uniq 合并结果');
ok(/if \(last && r\.start <= last\.end \+ 0\.001\) last\.end = Math\.max\(last\.end, r\.end\);/.test(MJ),
  '重叠/相接的区间合并（"同稿只跑一遍"的前端一侧）');
ok(/\.sort\(\(a, b\) => a\.start - b\.start\)/.test(MJ), '先按起点排序再合并');

console.log('\n== 5. 预览优先：默认勾选保守、全选可切换 ==');
ok(/f\.confidence >= 0\.8 \? i : -1/.test(MJ),
  '默认勾选"置信度≥0.8"的条目（不无脑全选）');
ok(!/f\.kind !== 'gap' && f\.confidence >= 0\.8/.test(MJ),
  'gap 不再被排除在默认勾选之外（它现在是可执行项）');
ok(/reflectEls\.all\.addEventListener\('change'/.test(MJ), '全选框可切换');
ok(!/如果 \(note\)/.test(MJ), '旧的 is-note 分支已移除');
ok(/isGap \? ' is-gap' : ''/.test(MJ), 'gap 用单独样式类 is-gap 区分');

console.log('\n== 5b. gap（补漏识别）可执行 ==');
/* gap 的语义变过一次，必须钉住现在的行为：
 * 早期是"仅提示、勾选框禁用"（因为只能靠模型报）；
 * 现在由 findTimeGaps 确定性检出，**可执行** —— 补识别那段空档，把漏掉的内容找回来。 */
ok(!/const dis = note \? ' disabled' : ''/.test(MJ), 'gap 的勾选框不再被禁用');
ok(/f\.kind === 'gap'[\s\S]{0,200}Number\.isFinite\(f\.start\)/.test(MJ),
  'gap 用服务端给的精确时间取区间');
ok(/const picked = \[\.\.\.reflectPicked\]\.map\(i => d\.findings\[i\]\)\.filter\(Boolean\)/.test(MJ),
  'applyReflect 不再过滤掉 gap');
ok(/new Set\(\(d\.findings \|\| \[\]\)\.map\(\(f, i\) => i\)\)/.test(MJ),
  '「全选」把 gap 也一起选上');
ok(/补漏识别/.test(MJ), 'gap 的标签改成"补漏识别"（说清是补内容，不是改错词）');
ok(/reflectEsc\(f\.reason\)/.test(MJ), '清单里显示模型给的理由');
ok(/\.reflect-item\.is-gap/.test(CSS), '样式里有 is-gap（不再弱化/禁用）');
ok(!/\.reflect-item\.is-note/.test(CSS), '旧的 is-note 样式已移除');

console.log('\n== 6. 复用现有轮询与写回（不另起一套）==');
ok(/startRerecogPoll\(state\.project\.id\)/.test(MJ), '复用 startRerecogPoll');
ok(/setReRecogRegion\(a0, b0/.test(MJ), '时间轴上画出正在跑的跨度');

console.log('\n== 7. 全局设置里的纠错配置 ==');
for (const id of ['st-correct-mode', 'st-correct-pad', 'st-correct-max', 'st-correct-batch',
                  'st-correct-usetranslate', 'st-correct-provider', 'st-correct-baseurl',
                  'st-correct-model', 'st-correct-key', 'st-correct-eff', 'st-correct-note']) {
  ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
}
ok(/value="preview">预览优先/.test(HTML), '默认档是「预览优先」');
ok(/value="off">关闭/.test(HTML) && /value="auto">/.test(HTML), '另有 关闭 / 自动 两档');
ok(/127\.0\.0\.1/.test(HTML), '提示里给了本地部署的地址写法');
ok(/correctLoad\(\)/.test(PJ), '设置页加载时读取纠错配置');
ok(/correctSave\(/.test(PJ), '改动即时保存');
ok(/实际调用：/.test(PJ), '显示"最终会调哪个模型"（跟随翻译时要让用户知道）');

console.log('\n== 8. 服务端两处必须都在（防单侧实现）==');
ok(/action === 'reflect' && req\.method === 'GET'/.test(SRV), '服务端有 GET /reflect');
ok(/action === 'reidentify' && req\.method === 'POST'/.test(SRV), '服务端有 POST /reidentify');
ok(/action === 'reidentify' && req\.method === 'GET'/.test(SRV), '服务端有 GET /reidentify（轮询）');
ok(/pathname === '\/api\/asr\/correct'/.test(SRV), '服务端有 /api/asr/correct');
// 服务端也要自己求并一次，不只信前端
ok(/ranges\.sort\(\(x, y\) => x\.start - y\.start\);/.test(SRV)
   && /r\.start <= last\.end \+ 0\.001/.test(SRV),
  '服务端再求一次并（不只靠前端自觉）');
// 本地部署免 Key
ok(/127\\\.0\\\.0\\\.1\|localhost/.test(SRV) || /127\.0\.0\.1\|localhost/.test(SRV),
  'correctReady 对本机地址免 API Key');
ok(/const reflectMod = require\('\.\/reflect\.js'\)/.test(SRV), '引入了 reflect.js');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
