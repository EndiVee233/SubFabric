/* 热词挖掘单测: node tests/hotwords-test.mjs
 *
 * 钉住的约定：
 *   1. 只挖**旧文本里根本没有**的新词（对齐上的、两边都有的绝不能算）
 *   2. 小写普通词（the/and/home）不算热词；专名/术语/缩写/带数字的算
 *   3. 整句重写的跳过（对齐没意义）
 *   4. 已有的热词不重复推荐（exclude）
 *   5. 越常被改、越近被改的排越前
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  let stale = !fs.existsSync(marker);
  if (!stale) for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || fs.statSync(a).mtimeMs < fs.statSync(b).mtimeMs) { stale = true; break; }
  }
  if (stale) {
    fs.rmSync(JSMOD, { recursive: true, force: true }); fs.mkdirSync(JSMOD, { recursive: true });
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
    fs.writeFileSync(marker, '{"type":"module"}\n');
  }
}
ensureJsmod();
const { mineHotwords, mineFromDetail, parseEditPairs, looksLikeTerm } = await import('./jsmod/hotwords.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w), n, { got: g, want: w });

console.log('== ① detail 解析 ==');
eq(parseEditPairs('中文「A」→「B」'), [{ old: 'A', new: 'B' }], '单段中文');
eq(parseEditPairs('英文「a b」→「a c」'), [{ old: 'a b', new: 'a c' }], '单段英文');
eq(parseEditPairs('中文「A」→「B」；英文「x」→「y」'),
  [{ old: 'A', new: 'B' }, { old: 'x', new: 'y' }], '两段（中英各一）');
eq(parseEditPairs('只改了时间'), [], '没有「」→「」就返回空');
eq(parseEditPairs(''), [], '空串安全');

console.log('\n== ② 什么算热词 ==');
for (const t of ['Spock', 'B-Dubs', "O'Brien", 'S3', '3D', 'Docm77', '你好', 'Unstable'])
  ok(looksLikeTerm(t) === true, `${JSON.stringify(t)} 算热词`);
for (const t of ['the', 'and', 'home', 'x', '好', '123', '', 'a'])
  ok(looksLikeTerm(t) === false, `${JSON.stringify(t)} 不算热词`);

console.log('\n== ③ 单条 detail 挖掘 ==');
{
  const d = '中文「Spoke从中只得出一个结论」→「Spock从中只得出一个结论」';
  const r = mineFromDetail(d);
  eq(r.map(x => x.term), ['Spock'], '★ 抽出 Spock');
  ok(/Spoke/.test(r[0].replaced), '记下了"原来被听成 Spoke"', r[0]);
}
{
  // 英文本：对齐上的词（takes away from it）绝不能算新词
  const d = '英文「Spoke takes away from it」→「Spock takes away from it」';
  const r = mineFromDetail(d);
  eq(r.map(x => x.term), ['Spock'], '★ 只抽出 Spock，takes/away/from/it 不算', r.map(x => x.term));
}
{
  const d = '英文「and then they went」→「and then they went home」';
  const r = mineFromDetail(d);
  eq(r.map(x => x.term), [], '★ 新增的小写普通词 home 不算热词', r);
}
{
  const d = '英文「Bdubs is here」→「B-Dubs is here」';
  eq(mineFromDetail(d).map(x => x.term), ['B-Dubs'], '带连字符的专名能抽出来');
}
{
  const d = '中文「这是Docm的故事」→「这是Docm77的故事」';
  eq(mineFromDetail(d).map(x => x.term), ['Docm77'], '带数字的专名能抽出来');
}
{
  // 整句重写 → 跳过
  const big = 'a b c d e f g h i j k l m n o p q r s t u v w x y z';
  const d = `英文「${big}」→「完全换了一整句别的英文内容 nothing in common」`;
  eq(mineFromDetail(d).map(x => x.term), [], '★ 整句重写跳过（对齐没意义）');
}

console.log('\n== ④ 汇总与排序 ==');
{
  const fake = [
    { t: '2026-10-01T00:00:00Z', action: 'edit', target: '第 3 条', detail: '英文「Bdubs is here」→「B-Dubs is here」' },
    { t: '2026-10-02T00:00:00Z', action: 'edit', target: '第 7 条', detail: '英文「I saw Bdubs」→「I saw B-Dubs」' },
    { t: '2026-10-03T00:00:00Z', action: 'edit', target: '第 9 条', detail: '英文「the Etho farm」→「the Itho farm」' },
    { t: '2026-10-04T00:00:00Z', action: 'edit', target: '第 11 条', detail: '中文「这是Docm的故事」→「这是Docm77的故事」' },
    { t: '2026-10-05T00:00:00Z', action: 'edit', target: '第 12 条', detail: '英文「and then they went」→「and then they went home」' },
    { t: '2026-10-06T00:00:00Z', action: 'realign', target: '第 2 条', detail: '重排 5 个词' },
  ];
  const r = mineHotwords(fake);
  // 排序规则：改得多的在前（B-Dubs ×2 稳居第一），其余按"最近改的更相关"
  // → Docm77（10-04）比 Itho（10-03）新，所以排在前面
  eq(r.candidates.map(c => c.term), ['B-Dubs', 'Docm77', 'Itho'], '★ 只留 3 个专名，home 被排除，B-Dubs 排最前');
  eq(r.candidates[0].count, 2, 'B-Dubs 出现 2 次');
  // fake 里有 5 条 edit（realign 那条不算）
  eq(r.stats.editEntries, 5, '统计到 5 条 edit（realign 不算）');
  ok(r.candidates[0].samples.length >= 2, '带样本（让用户能判断）', r.candidates[0].samples.length);
}

console.log('\n== ⑤ exclude（已在热词表里的不重复推荐）==');
{
  const fake = [
    { t: '2026-10-01T00:00:00Z', action: 'edit', target: 'a', detail: '英文「Bdubs is here」→「B-Dubs is here」' },
    { t: '2026-10-02T00:00:00Z', action: 'edit', target: 'b', detail: '英文「the Etho farm」→「the Itho farm」' },
  ];
  eq(mineHotwords(fake, { exclude: ['B-Dubs'] }).candidates.map(c => c.term), ['Itho'],
    '★ 排除已有的 B-Dubs（大小写不敏感）');
  eq(mineHotwords(fake, { exclude: ['b-dubs', 'ITHO'] }).candidates.map(c => c.term), [],
    '★ 忽略大小写');
}

console.log('\n== ⑥ 健壮性 ==');
for (const [name, input] of [['null', null], ['空数组', []], ['无 edit', [{ action: 'note' }]],
  ['缺 detail', [{ action: 'edit' }]], ['空「」→「」', [{ action: 'edit', detail: '「」→「」' }]],
  ['非数组', 'x'], ['条目是 null', [null, { action: 'edit', detail: '「a」→「B」' }]]]) {
  let r = null, err = null;
  try { r = mineHotwords(input); } catch (e) { err = String(e && e.message); }
  ok(!err && r && Array.isArray(r.candidates), `${name} 不炸且返回候选数组`, err);
}

console.log('\n== ⑦ 界面接线：挖掘按钮与候选区的 id 都在 ==');
{
  const REPO = path.resolve(HERE, '..');
  const HTML = fs.readFileSync(path.join(REPO, 'editor', 'index.html'), 'utf8');
  const PJS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');
  const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8');
  for (const id of ['ah-mine', 'ah-mine-hint', 'ah-mine-list', 'ah-mine-foot',
                    'ah-mine-all', 'ah-mine-none', 'ah-mine-apply', 'ah-mine-count']) {
    ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
  }
  ok(/\/api\/projects\/\$\{pid\}\/hotword-candidates/.test(PJS), 'project.js 调用了挖掘接口');
  ok(/hotword-candidates/.test(SRV), 'server.js 有 hotword-candidates 路由');
  ok(/require\('\.\/hotwords\.js'\)/.test(SRV), 'server.js 引入了 hotwords.js');
  ok(/\.hw-mine-list\s*\{/.test(CSS), '候选区有样式（否则会挤成一坨）');
  // **只能用户勾选后才加** —— 界面上不能出现"自动应用"的路径
  ok(/cb\.checked = true/.test(PJS) && /dataset\.term/.test(PJS),
    '候选带复选框、默认全勾（用户可取消）');
}

console.log('\n== ⑧ LLM 分析这条链路的接线（踩过的坑都钉住）==');
{
  const REPO = path.resolve(HERE, '..');
  const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
  const HTML = fs.readFileSync(path.join(REPO, 'editor', 'index.html'), 'utf8');
  const PJS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');

  // llmChat 必须在**模块作用域** —— 嵌在 handleRequest 里会让模块级的分析函数报
  // `llmChat is not defined`（实测踩过）
  const iChat = SRV.indexOf('async function llmChat');
  const iHandle = SRV.indexOf('function handleRequest');
  ok(iChat > 0 && iHandle > 0 && iChat < iHandle,
    '★ llmChat 在 handleRequest **之前**（= 模块作用域）', { iChat, iHandle });
  ok(/^const LlmError = llmText\.LlmError;$/m.test(SRV), '★ LlmError 也在模块作用域');

  // 分析不能用 jsonMode：Ollama 收到 response_format:json_object 会回空对象 {}
  const iFn = SRV.indexOf('async function analyzeHotwordsWithLlm');
  const seg = SRV.slice(iFn, iFn + 3000);
  ok(/jsonMode: false/.test(seg), '★ 分析这条不用 jsonMode（Ollama 会回空对象）', 'jsonMode');
  ok(/\/no_think/.test(seg), '★ 带 /no_think（否则推理模型思考吃光预算、正文为空）');
  ok(/timeoutMs/.test(seg) && /analyzeTimeoutMs/.test(SRV),
    '★ 分析有自己的超时（推理模型比翻译慢得多）');
  ok(/analyzeUseTranslate|useTranslate/.test(SRV), '★ 有「跟随翻译」的显式开关');

  // 路由与界面
  ok(/pathname === '\/api\/analyze\/config'/.test(SRV), '有 /api/analyze/config 路由');
  for (const id of ['ah-use-llm', 'an-use-translate', 'an-provider', 'an-baseurl', 'an-key', 'an-model', 'an-maxedits']) {
    ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
  }
  ok(/llm=1/.test(PJS), 'project.js 会按开关带 ?llm=1');
  ok(/hw-mine-tag/.test(PJS) && /hw-mine-tag/.test(
    fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8')),
    '候选带「模型」来源标记（有样式）');
}

console.log('\n== ⑨ 「模型管理」状态卡不能误报（三个实测撞到的坑）==');
{
  const REPO = path.resolve(HERE, '..');
  const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
  const PJS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');

  /* ① NeMo 预检要 `import torch`，首次 30 秒起步。这期间后端回 ok:false/msg:'预检中…'，
   *    前端原来直接落到"未安装 · 约 5GB"分支 —— 用户明明装了却被告知没装，
   *    还给他一个「安装」按钮（点下去白下 5GB）。 */
  const nemoStateLine = PJS.split('\n').find(l => /nemoState = `/.test(l)) || '';
  ok(!/未安装/.test(nemoStateLine), '★ NeMo 卡的"未安装"文案已去掉（不再误报）', nemoStateLine.trim().slice(0, 90));
  ok(/nemoPending/.test(PJS) && /预检中/.test(PJS),
    '★ NeMo 卡区分「检测中」与「未安装」');
  ok(/nemoPollTimer/.test(PJS) && /clearInterval\(nemoPollTimer\)/.test(PJS),
    '★ 预检期间会轮询，出结果自动重画（不用手动刷页）');

  /* ② GPU 探测是异步的（spawn nvidia-smi）。状态接口原来直接读缓存 nvidiaCache.name，
   *    服务器刚起来的第一次查询就回 gpu:null —— 前端当成"没有 N 卡"，
   *    给 Multitalker 卡打上「当前没检测到 N 卡，无法下载」的误报。 */
  ok(/gpu: await nvidiaGpu\(\)/.test(SRV), '★ 状态接口等 GPU 探测完再回（原来读缓存 → 首查是 null）');
  ok(/gpuNameForDl = await nvidiaGpu\(\)/.test(SRV),
    '★ 下载接口也 await（原来"打后台 + 立刻读缓存"会误拦下载）');
  ok(/gpuPending/.test(SRV) && /gpuPending/.test(PJS),
    '★ 有 gpuPending 信号，前端能区分"没卡"与"还在查"');
  ok(/gpuUnknown/.test(PJS) && /正在查显卡/.test(PJS),
    '★ Multitalker 卡探测期间显示「检测中」，不说"没检测到 N 卡"');

  /* ③ nvidiaCache.name 在**业务代码**里只该剩三处，且都说得通：
   *      · nvidiaGpu() 内部两处（读缓存 / 写回后返回）
   *      · gpuPending 一处（它就在 `gpu: await nvidiaGpu()` **之后**，用来判断探测结果空不空）
   *    任何"打后台 + 立刻读缓存"的写法都会在冷启动时读到 null → 误报。 */
  const bizCacheReads = SRV.split('\n')
    .map(l => l.trim())
    .filter(t => /nvidiaCache\.name/.test(t) && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//'));
  ok(bizCacheReads.length === 3,
    `★ 业务代码里读缓存只剩 3 处（实际 ${bizCacheReads.length}）`, bizCacheReads);
  ok(bizCacheReads.filter(t => !/gpuPending|return nvidiaCache\.name|nvidiaCache\.at/.test(t)).length === 0,
    '★ 那 3 处都说得通（nvidiaGpu 内部 ×2 + gpuPending ×1）', bizCacheReads);
}

console.log('\n== ⑩ 「自动纠错」卡：不能选做不了纠错的模型、报错要指向真原因 ==');
{
  const REPO = path.resolve(HERE, '..');
  const PJS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');
  const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');

  /* ① 服务商下拉必须滤掉本地引擎（NLLB）。
   * NLLB 是翻译专用的编码器-解码器模型，不做自由文本生成，
   * 所以「通读全片找语句不通顺」它干不了；correctCfg 也没为它分流。
   * 实测踩过：用户选了它，baseUrl 是空的 → 卡片永远"不可用"。 */
  const provLine = PJS.split('\n').find(l => /const usable = \(v\.presets/.test(l)) || '';
  ok(/filter\(p => !p\.local\)/.test(provLine),
    '★ 纠错的服务商下拉滤掉了 local 预设（NLLB）', provLine.trim().slice(0, 90));
  ok(/prov\._presets = usable/.test(PJS),
    '★ 存下过滤后的列表，change 时用它填地址');
  ok(/if \(prov\.value !== \(v\.provider \|\| ''\)\) prov\.value = '';/.test(PJS),
    '★ 旧配置里存的 local 预设值会被清掉，不显示成空白');

  /* ② 选服务商时要**连带填地址与模型名**。
   * 原来只发 provider —— 选了 DeepSeek 地址栏还是空的，卡片继续报不可用。 */
  const chgSeg = PJS.slice(PJS.indexOf("const prov = document.getElementById('st-correct-provider')"),
                           PJS.indexOf("const ut = document.getElementById('st-correct-usetranslate')"));
  ok(/patch\.baseUrl = p\.baseUrl/.test(chgSeg) && /patch\.model = p\.model/.test(chgSeg),
    '★ 选预设时把 baseUrl/model 一起填并保存');

  /* ③ 报错要指向**真正缺的那个东西**。
   * 原来不管什么原因都写"非本机地址必须填 API Key" —— 地址明明是空的时候也这么说。 */
  const noteSeg = PJS.slice(PJS.indexOf("const note = document.getElementById('st-correct-note')"),
                           PJS.indexOf('async function correctLoad'));
  ok(/!v\.effectiveBaseUrl \|\| !v\.effectiveModel/.test(noteSeg),
    '★ 先判"地址/模型名是否为空"');
  ok(/还没填「接口地址」与「模型名」/.test(noteSeg),
    '★ 缺地址时说"还没填接口地址与模型名"');
  ok(/非本机地址，必须填 API Key/.test(noteSeg),
    '★ 只有地址存在、Key 缺失时才说 Key 的事');
  ok(/127\.0\.0\.1/.test(noteSeg), '★ 顺带告诉用户本机地址免 Key');

  /* ④ 跟随翻译时自定义区要 disable，不能只是 hidden。
   * 只 hidden 的话输入框仍参与焦点，用户会以为"填了能生效"（服务端整段忽略）。 */
  ok(/box\.querySelectorAll\('input,select'\)\.forEach\(el => \{ el\.disabled = !!v\.useTranslate; \}\)/.test(PJS),
    '★ 跟随状态下把自定义区输入框一并 disable');
  ok(/box\.querySelectorAll\('input,select'\)\.forEach\(el => \{ el\.disabled = ut\.checked; \}\)/.test(PJS),
    '★ 切换勾选框时同步 disable 状态');

  // ⑤ 服务端确实有 local 标记可供过滤
  ok(/local: !!p\.local/.test(SRV) || /local: !!/i.test(SRV),
    '★ 服务端 presets 里带 local 标记（前端靠它过滤）');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
