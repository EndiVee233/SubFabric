/* 说话人分离补跑接口的端到端回归（隔离服务 + 假 diarize.py）: node tests/diarize-api-test.mjs
 *
 * 用一份**不加载模型**的假 diarize.py 验证「高级字幕操作 → 说话人分离」的服务端链路：
 *   · 作业状态机（POST 立即返回 → GET 轮询到 done）；
 *   · regions / speakers 原样带回，供编辑器按重叠写 [SPKn]；
 *   · 创建时没填人数（speakerCount=0）按 0（自动判断）下发；填过则沿用；
 *   · 分离过程写项目 draft.log、不改字幕文件。
 *
 * 依赖本机 Python（asr/runtime-python 或 asr/.venv）；没有就打印 SKIP（partial）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServer } from './helpers/isolated-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '..');
const CANDIDATES = [
  process.env.SUBFABRIC_TEST_PYTHON,
  path.join(SOURCE, 'asr', 'runtime-python', 'python.exe'),
  path.join(SOURCE, 'asr', 'runtime-python', 'bin', 'python'),
].filter(Boolean);
const PYTHON = CANDIDATES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!PYTHON) {
  console.log('SKIP: 没有可用的 Python（asr/runtime-python），跳过说话人分离接口回归');
  process.exit(0);
}

const PID = 'p-diarize-api';
const ARGS = path.join('asr', 'diarize-args.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = await isolatedServer({
  prepare(root) {
    const asr = path.join(root, 'asr');
    fs.writeFileSync(path.join(asr, 'settings.json'), JSON.stringify({ pythonExe: PYTHON }));
    const dz = path.join(asr, 'models', 'diarize');
    fs.mkdirSync(dz, { recursive: true });
    for (const f of ['model.onnx', 'speaker-embedding.onnx']) fs.writeFileSync(path.join(dz, f), Buffer.alloc(2048));
    /* 假分离器：记录参数、发两条进度，输出 2 人 / 2 段。不读音频、不加载模型。 */
    fs.writeFileSync(path.join(asr, 'diarize.py'), [
      'import argparse, json, os, sys, time',
      'ap = argparse.ArgumentParser()',
      "ap.add_argument('--segmentation'); ap.add_argument('--embedding')",
      "ap.add_argument('--audio'); ap.add_argument('--out')",
      "ap.add_argument('--speakers', type=int, default=6)",
      'a = ap.parse_args()',
      "open(os.path.join(os.path.dirname(__file__), 'diarize-args.json'), 'w', encoding='utf-8').write(json.dumps({'speakers': a.speakers}, ensure_ascii=False))",
      "slow = os.path.exists(os.path.join(os.path.dirname(__file__), 'slow.flag'))",
      "if slow:",
      "    open(os.path.join(os.path.dirname(__file__), 'diarize-worker.pid'), 'w').write(str(os.getpid()))",
      "    sys.stderr.write(json.dumps({'type': 'progress', 'pct': 30, 'msg': '区分说话人中 …'}) + '\\n'); sys.stderr.flush()",
      '    time.sleep(60)',
      '    sys.exit(0)',
      "sys.stderr.write(json.dumps({'type': 'progress', 'pct': 30, 'msg': '加载分离模型 …'}) + '\\n')",
      "sys.stderr.write(json.dumps({'type': 'progress', 'pct': 80, 'msg': '区分说话人中 …'}) + '\\n')",
      "json.dump({'speakers': 2, 'regions': [",
      "  {'start': 0.0, 'end': 1.9, 'speaker': 0},",
      "  {'start': 2.1, 'end': 3.9, 'speaker': 1},",
      "]}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False)",
      '',
    ].join('\n'), 'utf8');
  },
});

async function waitJob() {
  const deadline = Date.now() + 30000;
  for (;;) {
    const got = await (await server.call(`/api/projects/${PID}/diarize`)).json();
    const job = got.job;
    if (job && job.status !== 'running' && job.status !== 'pending') return job;
    assert.ok(Date.now() < deadline, '分离作业在 30s 内没有收敛：' + JSON.stringify(got).slice(0, 300));
    await sleep(100);
  }
}

try {
  const dir = path.join(server.root, 'projects', PID);
  fs.mkdirSync(dir, { recursive: true });
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,30,1',
    'Style: 中文字幕,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,2,2,10,10,60,1',
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:02.00,中文字幕,,0,0,0,,第一句',
    'Dialogue: 0,0:00:02.00,0:00:04.00,中文字幕,,0,0,0,,第二句', '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'subtitle.ass'), ass, 'utf8');
  fs.writeFileSync(path.join(dir, 'audio.wav'), Buffer.alloc(64));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id: PID, name: 'Diarize API test', createdAt: now, modifiedAt: now, duration: 4,
    subtitle: { format: 'ass', file: 'subtitle.ass', name: 'subtitle.ass' },
    audio: { file: 'audio.wav' }, prepare: { status: 'done' },
    draft: { status: 'done', wordLevel: true, align: false, speakers: false, speakerCount: 0, modelId: null },
  }), 'utf8');

  // 创建时没勾/没填人数 → 以 0（自动判断）下发
  const r1 = await server.call(`/api/projects/${PID}/diarize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r1.status, 200);
  const j1 = await waitJob();
  assert.equal(j1.status, 'done', j1.error);
  assert.equal(j1.speakers, 2);
  assert.equal(j1.regions.length, 2);
  assert.deepEqual(j1.regions[0], { start: 0, end: 1.9, speaker: 0 });
  assert.deepEqual(j1.regions[1], { start: 2.1, end: 3.9, speaker: 1 });
  const a1 = JSON.parse(fs.readFileSync(path.join(server.root, ARGS), 'utf8'));
  assert.equal(a1.speakers, 0, '创建时没填人数应传 0，让聚类自动判断');
  assert.match(fs.readFileSync(path.join(dir, 'draft.log'), 'utf8'), /\[说话人分离\] 开始/,
    '分离过程应写项目日志');

  // 字幕文件不被服务端直接改写（角色标注由编辑器写入）
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.ass'), 'utf8'), ass, '服务端不直接改字幕');

  // 创建时填过人数 → 沿用
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  meta.draft.speakerCount = 3;
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(meta), 'utf8');
  const r2 = await server.call(`/api/projects/${PID}/diarize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r2.status, 200);
  const j2 = await waitJob();
  assert.equal(j2.status, 'done', j2.error);
  const a2 = JSON.parse(fs.readFileSync(path.join(server.root, ARGS), 'utf8'));
  assert.equal(a2.speakers, 3, '项目里填过 3 人时应传 3');

  // 长任务必须能停止：慢 worker 记录 PID，cancel 后作业 canceled 且进程结束
  fs.writeFileSync(path.join(server.root, 'asr', 'slow.flag'), '1');
  const pidFile = path.join(server.root, 'asr', 'diarize-worker.pid');
  const r3 = await server.call(`/api/projects/${PID}/diarize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r3.status, 200);
  let wpid = 0;
  const until = Date.now() + 15000;
  for (;;) {
    if (fs.existsSync(pidFile)) { try { wpid = Number(fs.readFileSync(pidFile, 'utf8')) || 0; } catch {} }
    if (wpid) break;
    assert.ok(Date.now() < until, '慢 worker 没有启动');
    await sleep(100);
  }
  const c = await server.call(`/api/projects/${PID}/diarize-cancel`, { method: 'POST' });
  assert.equal(c.status, 200);
  assert.equal((await c.json()).ok, true);
  const j3 = await waitJob();
  assert.equal(j3.status, 'canceled', '取消后作业应为 canceled');
  let alive = true;
  for (let i = 0; i < 30; i++) {
    try { process.kill(wpid, 0); } catch { alive = false; break; }
    await sleep(100);
  }
  assert.equal(alive, false, '取消后分离 worker 仍在运行（PID ' + wpid + '）');
  fs.unlinkSync(path.join(server.root, 'asr', 'slow.flag'));

  console.log('diarize-api-test: ok（job done / regions / 人数沿用 / 不改字幕 / 可取消）');
} finally {
  await server.close();
}
