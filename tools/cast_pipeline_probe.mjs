/* 功能 B 真机端到端探针（真下载 + 真识别 + 真分离 + 假 LLM 分角色）
 *
 * 做一次完整的下载初稿: bilibili 链接 → 下载 → whisper 识别 → 说话人分离 → LLM 分角色 → 写字幕。
 * LLM 用本进程里的**假服务**(返回固定 JSON), 这样可以断言:
 *   ① 阵容推断真的发生了, 并且拿它的人数当 SPK 数（用户填的是 6, 期望被改成 3）
 *   ② 日志里能看到"说话人分离按 3 人" —— 即数量**真的传给了 diarize.py**
 *   ③ SPK 台词样本真的喂给了第二个请求（假服务收到两次调用, 内容含标题与 SPK 样本）
 *   ④ 字幕里出现**真实角色名**（[Rick Astley]）
 *   ⑤ 没映射上的说话人保留编号（[SPK3]）
 * 用完删项目 + 恢复翻译配置。
 * 前置: 仓库里能跑起来识别与分离（模型/运行时由联接指到装机版, 见 asr/models、asr/whisper.cpp）。 */
import http from 'http';
import { existsSync, readFileSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8360';
const PROJ = process.env.PROJ_DIR || 'D:/Vibe Coding/SubFabric/projects';
const VIDEO = process.env.VIDEO_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7';
const LLM_PORT = Number(process.env.FAKE_LLM_PORT || 8791);
const TIMEOUT_MIN = Number(process.env.CAST_TIMEOUT_MIN || 20);

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const one = async (id) => await (await fetch(BASE + '/api/projects/' + id)).json();

/* ── 假 LLM ── */
const FAKE_CAST = { characters: [{ name: 'Rick Astley', aliases: ['Rick'] }, { name: '主唱' }, { name: '旁白' }] };
const FAKE_MAP = { mapping: { SPK1: 'Rick Astley', SPK2: '主唱', SPK3: null } };
const seen = [];   // 每次请求的类型与内容（分句/阵容/对应）
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const msgs = j.messages || [];
    const sys = String((msgs[0] && msgs[0].content) || '');
    const usr = String((msgs[1] && msgs[1].content) || '');
    const isCast = sys.includes('说话的角色');
    const isMap = sys.includes('说话人编号');
    const isReseg = /标点/.test(sys) || /词序号/.test(sys);
    let content = '[]';
    let kind = 'other';
    if (isCast) { kind = 'cast'; content = JSON.stringify(FAKE_CAST); }
    else if (isMap) { kind = 'map'; content = JSON.stringify(FAKE_MAP); }
    else if (isReseg) {
      // 语义分句: 期望 [[词序号, 标点], …]；从用户消息里把"编号 词"清单解析出来, 每 ~8 个词给一个句号
      kind = 'reseg';
      const idx = (usr.match(/^\s*(\d+)\s+\S/gm) || []).map((x) => parseInt(x.trim(), 10));
      const pairs = [];
      for (let k = 7; k < idx.length; k += 8) pairs.push([idx[k], '.']);
      content = JSON.stringify(pairs);
    }
    seen.push({ kind, sys: sys.slice(0, 50), usr: usr.slice(0, 400) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'fake-cast', object: 'chat.completion', model: 'fake-cast',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
});
await new Promise((r) => srv.listen(LLM_PORT, '127.0.0.1', r));
console.log('假 LLM 已启动: http://127.0.0.1:' + LLM_PORT + '/v1');

let id = '', orig = null;
try {
  /* 备份并改指翻译配置（分角色复用这份 LLM 配置） */
  const c0 = await (await fetch(BASE + '/api/translate/config')).json();
  orig = c0.cfg || {};
  const set = await (await fetch(BASE + '/api/translate/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'custom', baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1', apiKey: 'fake-key', model: 'fake-cast', autoTranslate: false }),
  })).json();
  ok(set && set.cfg && set.cfg.baseUrl.includes(String(LLM_PORT)), '翻译配置已临时指向假 LLM', set && set.cfg && set.cfg.baseUrl);

  /* 建项目: 用户填 6 个说话人, 期望被 LLM 推断的 3 个覆盖 */
  const body = JSON.stringify({
    name: '', draft: true, wordLevel: true, speakers: true, speakerCount: 6,
    fetch: { url: VIDEO, quality: process.env.QUALITY || '360' },
  });
  const r = await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const created = await r.json();
  id = created.id || '';
  ok(!!id, '建项目（下载初稿 + 说话人分离）', JSON.stringify(created).slice(0, 120));
  if (!id) throw new Error('没创建出项目');

  /* 等流水线跑完（下载 → 提取 → 识别 → 分离 → 分角色 → 写字幕 → 等翻译） */
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < TIMEOUT_MIN * 60000) {
    await sleep(4000);
    const m = await one(id);
    const d = m.draft || {};
    const line = [d.status, d.stage, d.progress, d.message].join(' | ');
    if (line !== last) { console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] ' + line); last = line; }
    if (d.status && d.status !== 'running') break;
  }
  const meta = await one(id);
  const d = meta.draft || {};
  const log = (await (await fetch(BASE + '/api/projects/' + id + '/draft')).json()).log || '';
  console.log('  最终:', JSON.stringify({ status: d.status, stage: d.stage, progress: d.progress, msg: d.message, err: d.error }).slice(0, 220));

  /* ① 阵容推断 */
  const chars = (d.cast && d.cast.characters) || [];
  ok(chars.length === 3, '① 阵容推断拿到 3 个人物', chars.map((c) => c.name));
  ok(chars[0] && chars[0].name === 'Rick Astley', '① 第一个人物是假 LLM 给的', chars[0]);

  /* ② 用推断出的人数作为 SPK 数 */
  ok(Number(d.speakerCount) === 3, '② 说话人数量被改成 3（用户填的是 6）', d.speakerCount);
  ok(log.includes('说话人分离按 3 人'), '② 日志证明数量传给了分离器', log.split('\n').filter((l) => l.includes('分离')).slice(-2));

  /* ③ 两次调用 + 内容 */
  const casts = seen.filter((x) => x.kind === 'cast');
  const maps = seen.filter((x) => x.kind === 'map');
  const resegs = seen.filter((x) => x.kind === 'reseg');
  console.log('  模型调用构成:', JSON.stringify({ 分句: resegs.length, 阵容: casts.length, 对应: maps.length }));
  ok(casts.length === 1, '③ 阵容推断调了一次', casts.length);
  ok(maps.length === 1, '③ 角色对应调了一次', maps.length);
  ok(resegs.length >= 1, '③ 语义分句也走了同一个模型（说明共用配置）', resegs.length);
  ok(casts[0] && /Rick Astley|Never Gonna|索尼|Unstable/.test(casts[0].usr), '③ 阵容请求带上了视频信息', casts[0] && casts[0].usr.slice(0, 80));
  ok(maps[0] && maps[0].usr.includes('SPK1'), '③ 对应请求带上了 SPK 样本', maps[0] && maps[0].usr.slice(0, 120));
  ok(maps[0] && maps[0].usr.includes('Rick Astley'), '③ 对应请求带上了候选角色');

  /* ④⑤ 字幕里的角色名 */
  const mp = (d.cast && d.cast.map) || {};
  ok(mp.SPK1 === 'Rick Astley' && mp.SPK2 === '主唱', '④ 映射结果已存进 meta', mp);
  ok(Array.isArray(d.cast && d.cast.extra) && d.cast.extra.includes('SPK3'), '⑤ 没映射上的 SPK3 记进 extra', d.cast && d.cast.extra);
  const subFile = (meta.subtitle && meta.subtitle.file) || '';
  const subPath = subFile ? (PROJ + '/' + id + '/' + subFile) : '';   // 文件名为空时别去读目录（否则 EISDIR）
  ok(!!subPath && existsSync(subPath), '④ 字幕文件存在', subPath);
  if (subPath && existsSync(subPath)) {
    const text = readFileSync(subPath, 'utf8');
    // ASS 的 Dialogue 行: Dialogue: layer,start,end,Style,Name,... —— 角色名在第 5 列(Name)
    const evs = text.split('\n').filter((l) => l.startsWith('Dialogue:'));
    const names = evs.map((l) => l.split(',')[4]).filter((x) => x !== undefined);
    const uniq = Array.from(new Set(names.filter(Boolean)));
    console.log('  字幕里的角色名(Name 栏):', JSON.stringify(uniq));
    ok(uniq.includes('Rick Astley'), '④ 字幕里出现真实角色名 Rick Astley', uniq);
    ok(uniq.includes('主唱'), '④ 字幕里出现角色名 主唱', uniq);
    ok(uniq.includes('SPK3'), '⑤ 没映射上的说话人保留 SPK3', uniq);
    ok(!uniq.includes('SPK1') && !uniq.includes('SPK2'), '④ 被映射的编号不再出现', uniq);
    ok(evs.length > 0, '④ 字幕里有 Dialogue 事件', evs.length);
  } else {
    fail += 5; console.log('FAIL  字幕文件读不到, 跳过 5 项字幕断言');
  }
  ok(/识别|ASR|分离|分角色/.test(log), '跑过了识别与分离阶段');

  /* ── 诊断（KEEP=1 时保留现场） ── */
  try {
    const asrPath = PROJ + '/' + id + '/asr.json';
    const asr = existsSync(asrPath) ? JSON.parse(readFileSync(asrPath, 'utf8')) : null;
    const hist = {};
    for (const g of ((asr && asr.segments) || [])) { const k = String(g.speaker); hist[k] = (hist[k] || 0) + 1; }
    console.log('  [诊断] draft 字段:', Object.keys(d).join(','));
    console.log('  [诊断] wordLevel=' + d.wordLevel + ' speakers=' + d.speakers + ' speakerCount=' + d.speakerCount + ' 分离区数=' + ((asr && asr.regions) || []).length);
    console.log('  [诊断] asr.json segment 说话人分布:', JSON.stringify(hist), ' 段落数=' + ((asr && asr.segments) || []).length);
    console.log('  [诊断] meta.subtitle=' + JSON.stringify(meta.subtitle || {}));
    if (subPath && existsSync(subPath)) {
      const ev = readFileSync(subPath, 'utf8').split('\n').filter((l) => l.startsWith('Dialogue:')).slice(0, 3);
      console.log('  [诊断] ASS 前 3 条事件:', JSON.stringify(ev).slice(0, 300));
    }
    console.log('  [诊断] 日志尾部:');
    console.log(log.split('\n').slice(-14).map((l) => '      ' + l).join('\n'));
  } catch (e) { console.log('  [诊断] 失败: ' + e.message); }
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  if (id && !process.env.KEEP) { try { await fetch(BASE + '/api/projects/' + id, { method: 'DELETE' }); console.log('已删除测试项目'); } catch {} }
  else if (id) { console.log('KEEP=1: 保留项目 ' + id + ' 供人工查看'); }
  if (orig) {
    try {
      await fetch(BASE + '/api/translate/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: orig.provider, baseUrl: orig.baseUrl, apiKey: orig.apiKey, model: orig.model, autoTranslate: !!orig.autoTranslate }),
      });
      console.log('翻译配置已恢复');
    } catch {}
  }
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
