/* 全片逐词重校对「停止」接口回归（隔离服务 + 假长任务 worker）: node tests/realign-cancel-api-test.mjs
 *
 * 用户实测：4 小时稿件点了对齐后进度不动，关闭界面/退出应用后 Python 还在跑。
 * 这条测试验证：
 *   · 作业跑起来后 POST /realign-full-cancel 能把状态收成 canceled；
 *   · 服务端确实杀掉了 worker（不只是改状态），Python 进程不再存活。
 *
 * 缺 Python / N 卡时打印 SKIP（partial），不加载真实模型。
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
  console.log('SKIP: 没有 asr/runtime-python（Qwen 运行时），跳过停止接口回归');
  process.exit(0);
}

const PID = 'p-realign-cancel';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = await isolatedServer({ env: { SUBFABRIC_QWEN_PYTHON: PYTHON } });
let skipped = '';
try {
  const dir = path.join(server.root, 'projects', PID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'subtitle.srt'), [
    '1', '00:00:00,000 --> 00:00:02,000', '你好', 'Hello world', '',
    '2', '00:00:02,000 --> 00:00:04,000', '第二句', 'Second line', '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'audio.wav'), Buffer.alloc(64));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id: PID, name: 'Cancel API test', createdAt: now, modifiedAt: now, duration: 4,
    subtitle: { format: 'srt', file: 'subtitle.srt', name: 'subtitle.srt' },
    audio: { file: 'audio.wav' }, prepare: { status: 'done' },
    draft: { status: 'done', wordLevel: false, align: false, speakers: false, speakerCount: 0, modelId: null },
  }), 'utf8');

  const asr = path.join(server.root, 'asr');
  fs.writeFileSync(path.join(asr, '.qwen-runtime-ok.json'), JSON.stringify({ transformers: '5.20.2' }), 'utf8');
  const modelDir = path.join(asr, 'models', 'qwen3-forced-aligner-0.6b');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'model.safetensors'), 'fake');
  const pidFile = path.join(asr, 'worker.pid');
  /* 假 worker：记录 PID、发一条进度，然后睡 60 秒。被 taskkill 时不会有输出文件。 */
  fs.writeFileSync(path.join(asr, 'qwen_align.py'), [
    'import argparse, json, os, sys, time',
    "ap=argparse.ArgumentParser(); ap.add_argument('--model'); ap.add_argument('--manifest'); ap.add_argument('--out')",
    'a=ap.parse_args()',
    "open(os.path.join(os.path.dirname(__file__), 'worker.pid'), 'w').write(str(os.getpid()))",
    "sys.stderr.write(json.dumps({'type':'progress','pct':5,'msg':'开始对齐…'}) + '\\n'); sys.stderr.flush()",
    'time.sleep(60)',
    "json.dump({'items': []}, open(a.out, 'w'))",
    '',
  ].join('\n'), 'utf8');

  const start = await server.call(`/api/projects/${PID}/realign-full`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowSrtToAss: true }),
  });
  assert.equal(start.status, 200);
  // 等 worker 真起来（模型/对齐器准备在隔离副本里很快）
  let job = null, pid = 0;
  const deadline = Date.now() + 15000;
  for (;;) {
    const got = await (await server.call(`/api/projects/${PID}/realign-full`)).json();
    job = got.job;
    if (fs.existsSync(pidFile)) { try { pid = Number(fs.readFileSync(pidFile, 'utf8')) || 0; } catch {} }
    if (job && job.status !== 'running' && job.status !== 'pending') break;
    if (pid) break;
    assert.ok(Date.now() < deadline, 'worker 在 15s 内没有启动：' + JSON.stringify(got).slice(0, 300));
    await sleep(100);
  }
  if (!pid) {
    // 没有 N 卡/对齐器时 realignPrep 会先失败；环境限制，记 partial
    if (/NVIDIA|对齐模型|对齐器|运行时/.test(job && job.error || '')) skipped = job.error;
    else assert.fail('对齐 worker 没有启动：' + JSON.stringify(job).slice(0, 300));
  }
  if (!skipped) {
    // worker 发的 progress JSON 必须被服务端解析进 job.pct（否则界面只会停在 3%）
    const pctUntil = Date.now() + 5000;
    do {
      const got = await (await server.call(`/api/projects/${PID}/realign-full`)).json();
      job = got.job;
      if (job && Number(job.pct) > 3) break;
      await sleep(100);
    } while (Date.now() < pctUntil);
    assert.ok(job && Number(job.pct) > 3, 'worker 进度没有传到 job.pct：' + JSON.stringify(job).slice(0, 200));

    const cancel = await server.call(`/api/projects/${PID}/realign-full-cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).ok, true);
    // 等作业收成 canceled
    const until = Date.now() + 10000;
    for (;;) {
      const got = await (await server.call(`/api/projects/${PID}/realign-full`)).json();
      job = got.job;
      if (job && job.status === 'canceled') break;
      assert.ok(Date.now() < until, '取消后作业没有变成 canceled：' + JSON.stringify(job).slice(0, 300));
      await sleep(100);
    }
    // worker 必须真的死掉
    let alive = true;
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await sleep(100);
    }
    assert.equal(alive, false, '取消后 Python worker 仍在运行（PID ' + pid + '）');
    assert.equal(fs.existsSync(path.join(dir, 'subtitle.ass')), false, '取消不得生成半成品 ASS');
    console.log('realign-cancel-api-test: ok（作业 canceled，worker 已结束）');
  }
} finally {
  await server.close();
}
if (skipped) console.log('SKIP: 环境没有可用的 CUDA 对齐器：' + String(skipped).slice(0, 200));
