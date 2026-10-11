/* 统一测试入口：串行跑 tests/ 下所有独立测试，汇总通过率。
 *
 * 为什么需要它：以前每个测试各自 `node tests/xxx.mjs`，没有总入口 ——
 *   CI 里没法"一条命令跑全部"，也就没人能一眼看出整体是否健康
 *   （第二轮审查把"无统一测试入口"列为工程化缺口）。
 *
 * 约定（沿用项目既有惯例，不要改）：
 *   · 生成器不是测试：gen-fixture.mjs（生成 fixture.ass）、gen-lang.mjs（重写 i18n 词典）
 *   · ass-fixture.mjs 是被别的测试 import 的**辅助模块**，不是测试
 *   · 需要本机夹具 / 内嵌 Python 的测试自己会 skip 并以 exit 0 结束，缺了不算失败
 *   · 有的测试（parse/rows-timeline-test）是**诊断脚本**：无断言、恒 exit 0，留着无害
 *
 * ⚠ 全新克隆里 tests/fixture.ass **不存在**（*.ass 不入库），而 karaoke-exhaustive
 *   直接 read 它 —— 所以这里必须**先跑一遍 gen-fixture.mjs** 作为前置步骤，
 *   否则全新克隆 / CI 上会报 ENOENT 假失败。
 *
 * 用法：node tests/run-all.mjs
 * 退出码：全通过 0；有失败 1（CI 直接用它判定）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PER_TEST_TIMEOUT_MS = 180000;      // 单个测试上限 3 分钟（CI 上比本机慢）
const MAX_BUF = 64 * 1024 * 1024;        // 见下面 spawnSync 的注释

/** 不是测试、要跳过的文件 */
const SKIP = new Set(['gen-lang.mjs', 'gen-fixture.mjs', 'ass-fixture.mjs', 'run-all.mjs']);
/** 前置生成步骤（幂等）：夹具不入库，全新克隆里没有 */
const SETUP = ['gen-fixture.mjs'];

const run = (args) => spawnSync(process.execPath, args, {
  encoding: 'utf8', timeout: PER_TEST_TIMEOUT_MS, maxBuffer: MAX_BUF,
  env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
});

/* ── 前置步骤 ── */
for (const s of SETUP) {
  const r = run([path.join(HERE, s)]);
  if (r.error || r.status !== 0) {
    console.error(`前置步骤失败：${s}`
      + (r.error ? '（' + r.error.message + '）' : '')
      + '\n' + String((r.stderr || r.stdout || '')).trim().split('\n').slice(-10).join('\n'));
    process.exit(1);
  }
  console.log(`  · 前置完成：${s}`);
}

const files = fs.readdirSync(HERE)
  .filter(f => f.endsWith('.mjs') && !SKIP.has(f))
  .sort();

console.log(`\n跑 ${files.length} 个测试（串行）…\n`);

const passed = [], failed = [], skipped = [];
const t0 = Date.now();

for (const f of files) {
  /* ⚠ maxBuffer 必须放大：karaoke-exhaustive 会打 2.8 万条断言，
   *   用默认 1MB 会 ENOBUFS → 子进程被杀 → status=null，看起来像"测试全挂"。 */
  const r = run([path.join(HERE, f)]);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.error) {                        // spawn 本身失败（找不到 node / 超时被杀）
    failed.push({ f, status: 'spawn-error', out: out + '\n' + String((r.error && r.error.message) || r.error) });
    console.log(`  ★ ${f}  spawn-error: ${String((r.error && r.error.message) || r.error)}`);
    continue;
  }
  // "跳过"的测试以 exit 0 结束，但输出里会写"跳过" —— 单独归类，便于一眼看清
  const isSkip = r.status === 0 && /跳过/.test(out);
  if (r.status === 0) {
    (isSkip ? skipped : passed).push(f);
    console.log(`  ✓ ${f}${isSkip ? '（含跳过项）' : ''}`);
  } else {
    failed.push({ f, status: r.status, signal: r.signal, out });
    console.log(`  ★ ${f}  exit=${r.status}${r.signal ? ' signal=' + r.signal : ''}`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n通过 ${passed.length} · 跳过项 ${skipped.length} · 失败 ${failed.length}（${secs}s）`);

if (failed.length) {
  console.log('\n══════ 失败详情 ══════');
  for (const x of failed) {
    console.log(`\n───── ${x.f} (exit=${x.status}) ─────`);
    // 只打尾部：断言失败的现场通常就在最后几十行
    console.log(x.out.trim().split('\n').slice(-25).join('\n'));
  }
  process.exit(1);
}
