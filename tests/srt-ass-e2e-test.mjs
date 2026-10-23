/* SRT → 逐词 ASS 的端到端回归（隔离服务 + 假对齐器）: node tests/srt-ass-e2e-test.mjs
 *
 * 为什么要这一条：纯逻辑测试（tests/srt-ass-test.mjs）覆盖了"行 → 对齐目标 → segments"，
 * 但真正把 SRT 变成逐词 ASS 还经过 realign-full 作业、对齐器进程、apply 路由和 writeSubtitle。
 * 这里用一份**只做词时间分配、不加载任何模型**的假 qwen_align.py，把这整条链路跑一遍：
 *   ① POST /realign-full（SRT + 用户确认）→ 作业完成，返回逐词 items；
 *   ② POST /realign-full-apply → 生成 subtitle.ass，项目字幕切到 ASS；
 *   ③ 原 SRT 文件保留，ASS 里有中英双语与逐词高亮切片。
 *
 * 依赖本机有 asr/runtime-python（Qwen 运行时）与 N 卡；没有就打印 SKIP（记 partial），
 * 不加载真实对齐器权重。CI 无 CUDA 环境时会跳过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServer } from './helpers/isolated-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '..');
const PYTHON = process.env.SUBFABRIC_QWEN_PYTHON || path.join(SOURCE, 'asr', 'runtime-python', 'python.exe');
if (!fs.existsSync(PYTHON)) {
  console.log('SKIP: 没有 asr/runtime-python（Qwen 运行时），跳过 SRT→ASS 端到端回归');
  process.exit(0);
}

const PID = 'p-srt-ass-e2e';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const server = await isolatedServer({ env: { SUBFABRIC_QWEN_PYTHON: PYTHON } });
let skipped = '';
try {
  const dir = path.join(server.root, 'projects', PID);
  fs.mkdirSync(dir, { recursive: true });
  const srt = [
    '1', '00:00:00,000 --> 00:00:02,000', '你好 世界', 'Hello world', '',
    '2', '00:00:02,000 --> 00:00:04,000', '第二句', 'Second line', '',
    '3', '00:00:04,000 --> 00:00:06,000', '第三句', 'Third line', '',
    '4', '00:00:06,000 --> 00:00:08,000', '第四句', 'Fourth line', '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'subtitle.srt'), srt, 'utf8');
  fs.writeFileSync(path.join(dir, 'audio.wav'), Buffer.alloc(64));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id: PID, name: 'SRT ASS e2e', createdAt: now, modifiedAt: now, duration: 8,
    subtitle: { format: 'srt', file: 'subtitle.srt', name: 'subtitle.srt' },
    audio: { file: 'audio.wav' }, prepare: { status: 'done' },
    draft: { status: 'done', wordLevel: false, align: false, speakers: false, speakerCount: 0, modelId: null },
  }), 'utf8');

  /* 假对齐器：按 manifest 里每条的 [start,end] 平均分词，不读 --model。 */
  fs.writeFileSync(path.join(server.root, 'asr', '.qwen-runtime-ok.json'),
    JSON.stringify({ transformers: '5.20.2' }), 'utf8');
  const modelDir = path.join(server.root, 'asr', 'models', 'qwen3-forced-aligner-0.6b');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'model.safetensors'), 'fake');
  fs.writeFileSync(path.join(server.root, 'asr', 'qwen_align.py'), [
    'import argparse, json',
    'ap = argparse.ArgumentParser()',
    "ap.add_argument('--model')",
    "ap.add_argument('--manifest')",
    "ap.add_argument('--out')",
    'a = ap.parse_args()',
    "data = json.load(open(a.manifest, encoding='utf-8'))",
    'items = []',
    "for it in data.get('items', []):",
    "    toks = [t for t in str(it.get('text', '')).split() if t]",
    '    s, e = float(it[\"start\"]), float(it[\"end\"])',
    '    words = []',
    '    if toks:',
    '        step = (e - s) / len(toks)',
    '        for i, t in enumerate(toks):',
    '            ws, we = s + i * step, s + (i + 1) * step',
    '            words.append({"word": t, "start": round(ws + 0.01, 3), "end": round(max(ws + 0.02, we - 0.01), 3)})',
    '    items.append({"id": it.get("id"), "words": words})',
    "json.dump({'items': items}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False)",
    '',
  ].join('\n'), 'utf8');

  // ① 用户确认后启动重校对
  const start = await server.call(`/api/projects/${PID}/realign-full`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowSrtToAss: true }),
  });
  assert.equal(start.status, 200);
  let job = null;
  const deadline = Date.now() + 30000;
  for (;;) {
    const got = await (await server.call(`/api/projects/${PID}/realign-full`)).json();
    job = got.job;
    if (job && job.status !== 'running' && job.status !== 'pending') break;
    assert.ok(Date.now() < deadline, '端到端重校对作业超时');
    await sleep(100);
  }
  if (job.status !== 'done') {
    // 没有 N 卡 / CUDA 对齐器不可用时属于环境限制，记 partial 而不是失败
    if (/NVIDIA|对齐模型|对齐器|运行时/.test(job.error || '')) {
      skipped = job.error;
    } else {
      assert.fail('重校对失败：' + job.error);
    }
  }
  if (!skipped) {
    assert.equal(job.sourceFormat, 'srt', '作业应标记来源为 SRT');
    assert.equal(job.total, 4, '四行英文都应成为对齐目标');
    assert.equal(job.usable, 4, '假对齐器应让四行都成功');
    assert.ok(job.items.every(i => i.ok && i.words.length === 2), '每行应得到 2 个词');

    // ② 应用（用户勾选全部对齐项）
    const keys = job.items.map(i => i.targetKey);
    const applied = await server.call(`/api/projects/${PID}/realign-full-apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }),
    });
    const body = await applied.json();
    assert.equal(applied.status, 200, JSON.stringify(body));
    assert.equal(body.format, 'ass');
    assert.equal(body.file, 'subtitle.ass');
    assert.equal(body.applied, 4, '四行都用对齐时间');
    assert.equal(body.total, 4);

    // ③ 项目字幕切到 ASS，原 SRT 保留
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    assert.equal(meta.subtitle.format, 'ass');
    assert.equal(meta.subtitle.file, 'subtitle.ass');
    assert.ok(fs.existsSync(path.join(dir, 'subtitle.srt')), '原 SRT 文件必须保留');
    const ass = fs.readFileSync(path.join(dir, 'subtitle.ass'), 'utf8');
    assert.match(ass, /^; SubFabricWordHighlightColor: #00ff00/m, 'ASS 应带逐词高亮色元数据');
    assert.match(ass, /Style: 中文字幕/, '应保留中文字幕样式');
    for (const zh of ['你好 世界', '第二句', '第三句', '第四句']) {
      assert.ok(ass.includes(zh), '中文行应写入译文轨：' + zh);
    }
    const dialogues = ass.split(/\r?\n/).filter(l => l.startsWith('Dialogue:'));
    // 4 行中文 + 每行 2 个英文词切片 = 12 条事件
    assert.equal(dialogues.length, 12, '中英双轨：4 条中文 + 8 条英文逐词切片');
    for (const w of ['Hello', 'world', 'Second', 'line', 'Third', 'Fourth']) {
      const re = new RegExp('\\{\\\\c&H[0-9A-Fa-f]{6}&\\}' + w + '\\{\\\\c\\}');
      assert.ok(re.test(ass), '逐词高亮切片应包住 ' + w + '；事件：' + dialogues.join(' | '));
    }
    // 时间轴没有越界：每行词在各自 0~8s 区间内
    for (const line of dialogues) {
      const m = /^Dialogue: 0,(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+)/.exec(line);
      if (!m) continue;
      const sec = (t) => { const [hh, mm, ss] = t.split(':'); return +hh * 3600 + +mm * 60 + +ss; };
      assert.ok(sec(m[1]) >= 0 && sec(m[2]) <= 8.001, '事件时间不越出原片区间');
    }
    console.log('srt-ass-e2e-test: ok（4 行 SRT → 12 条逐词 ASS 事件）');
  }
} finally {
  await server.close();
}
if (skipped) {
  console.log('SKIP: 环境没有可用的 CUDA 对齐器：' + String(skipped).slice(0, 200));
}
