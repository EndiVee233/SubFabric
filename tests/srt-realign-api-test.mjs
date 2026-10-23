/* 隔离服务回归：SRT 稿件的「全片逐词重校对」入口与「说话人分离」补跑接口。
 *
 * 这里不加载对齐器/分离模型（隔离副本里没有模型），只验证接口与状态机：
 *   · SRT 默认不会被自动改成 ASS —— 没带 allowSrtToAss 时必须给出"点按钮并确认"的原因；
 *   · 用户确认后（allowSrtToAss:true）才进入对齐准备，模型缺失时如实报错；
 *   · 没有可应用的重校对结果时，realign-full-apply 拒绝写入；
 *   · 说话人分离：没有音频 / 模型没装时给出明确原因，后台作业能正常收敛。
 * 不连接默认 8321、不写用户设置或真实稿件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server = await isolatedServer();
const PID = 'p-srt-api-test';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitJob(url, label) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const got = await (await server.call(url)).json();
    const job = got.job;
    if (job && job.status !== 'running' && job.status !== 'pending') return job;
    assert.ok(Date.now() < deadline, label + ' 作业在 15s 内没有收敛：' + JSON.stringify(got).slice(0, 300));
    await sleep(120);
  }
}

try {
  const dir = path.join(server.root, 'projects', PID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'subtitle.srt'), [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    '你好 世界',
    'Hello world',
    '',
    '2',
    '00:00:02,000 --> 00:00:04,000',
    '第二句',
    'Second line',
    '',
  ].join('\r\n'), 'utf8');
  // realignPrep / diarize 都先检查音频文件是否存在；这里只需一个占位文件。
  fs.writeFileSync(path.join(dir, 'audio.wav'), Buffer.alloc(64));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id: PID, name: 'SRT API test', createdAt: now, modifiedAt: now,
    duration: 4,
    subtitle: { format: 'srt', file: 'subtitle.srt', name: 'subtitle.srt' },
    audio: { file: 'audio.wav' },
    prepare: { status: 'done' },
    draft: { status: 'done', wordLevel: false, align: false, speakers: false, speakerCount: 0, modelId: null },
  }), 'utf8');

  // 1) 不带确认：SRT 必须被拦下，且原因指向"点按钮并确认"
  const r1 = await server.call(`/api/projects/${PID}/realign-full`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r1.status, 200, '重校对接口先返回后台作业');
  const j1 = await waitJob(`/api/projects/${PID}/realign-full`, 'realign(no-confirm)');
  assert.equal(j1.status, 'error');
  assert.match(j1.error, /SRT.*确认|确认.*SRT|逐词 ASS/,
    'SRT 未被确认时不得静默转换：' + j1.error);

  // 2) 带确认：放行到对齐准备（隔离副本没有对齐模型 → 如实报缺模型/运行时）
  const r2 = await server.call(`/api/projects/${PID}/realign-full`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowSrtToAss: true }),
  });
  assert.equal(r2.status, 200);
  const j2 = await waitJob(`/api/projects/${PID}/realign-full`, 'realign(confirmed)');
  assert.equal(j2.status, 'error', '隔离副本没有对齐模型，作业应失败而不是假装成功');
  assert.match(j2.error, /对齐模型|对齐器|运行时|下载|N 卡/,
    '确认后应走到对齐准备并报出模型原因：' + j2.error);
  assert.notEqual(j2.error, j1.error, '确认前后走的是不同分支');
  // 失败作业也不能被当成可应用结果
  const apply0 = await server.call(`/api/projects/${PID}/realign-full-apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['x'] }),
  });
  assert.equal(apply0.status, 409, '没有 done 状态的重校对结果时拒绝写入');

  // 3) 说话人分离：作业状态机与缺模型提示
  const d0 = await (await server.call(`/api/projects/${PID}/diarize`)).json();
  assert.equal(d0.job, null, '初始应没有分离作业');
  const r3 = await server.call(`/api/projects/${PID}/diarize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r3.status, 200);
  const d1 = await waitJob(`/api/projects/${PID}/diarize`, 'diarize');
  assert.equal(d1.status, 'error');
  assert.match(d1.error, /分离模型|没有已保存的音频|音频/,
    '缺模型/音频时给出可操作的原因：' + d1.error);

  // 4) 项目字幕没有被前面的失败作业改写（SRT 仍是权威文件）
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.equal(meta.subtitle.format, 'srt', '失败的重校对/分离不得把项目字幕改成 ASS');
  assert.ok(fs.existsSync(path.join(dir, 'subtitle.srt')), '原 SRT 文件保留');
  assert.equal(fs.existsSync(path.join(dir, 'subtitle.ass')), false, '失败时不应生成半成品 ASS');

  console.log('srt-realign-api-test: ok');
} finally {
  await server.close();
}
