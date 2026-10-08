/**
 * 纠错模型「跟随字幕翻译」开关的**行为**回归。
 *
 * 为什么单独写一个：reflect-lock-test.mjs 里那几条只是读源码做正则匹配，
 * 于是漏掉了一个真实 bug —— `correctCfg()` 里算了 `follow` 却**只用它决定 provider**，
 * 地址与模型仍然直接读自定义字段：
 *
 *     const follow = correctUseTranslate(t);
 *     const provider = follow ? '' : (t.provider || '');
 *     baseUrl: pick(t.baseUrl, ...)     // ← 没管 follow
 *     model:   pick(t.model,   ...)     // ← 没管 follow
 *
 * 结果：勾选「用字幕翻译的模型」后，开关状态是对的（useTranslate=true），
 * 但**实际调用的仍是自定义的本地模型**。源码正则看不出这种"半接线"。
 *
 * 所以这里不读代码，直接**问运行中的服务**要 effectiveModel —— 这也是用户看到的那个值。
 * 服务没起就跳过（不让 CI 假失败）。
 */

const BASE = process.env.SUBFABRIC_BASE || 'http://127.0.0.1:8321';
const PROBE = 'http://127.0.0.1:11434/v1';
const PROBE_MODEL = 'qwen3:8b';

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

async function get() {
  const r = await fetch(`${BASE}/api/asr/correct`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function post(patch) {
  const r = await fetch(`${BASE}/api/asr/correct`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

async function main() {
  let start;
  try {
    start = await get();
  } catch (e) {
    console.log('  SKIP 服务未运行（' + BASE + '）：' + e.message);
    console.log('       先启动 editor/server.js 再跑本测试。');
    console.log('\n0 passed, 0 failed（跳过）');
    process.exit(0);
  }
  // 记住原来的配置，测完恢复 —— 不要留下副作用
  const saved = {
    useTranslate: start.useTranslate,
    baseUrl: start.baseUrl,
    model: start.model,
    provider: start.provider,
  };
  // 基准点必须**直接问翻译配置**。
  // 踩过：先前这里读的是 `/api/asr/correct` 的 effectiveModel —— 而当 useTranslate=false 时
  // 那个值是"纠错自定义模型"，不是翻译模型，于是基准点本身就错了、测试反而误报。
  let translateModel = '';
  try {
    const tc = await (await fetch(`${BASE}/api/translate/config`, { signal: AbortSignal.timeout(8000) })).json();
    translateModel = (tc.cfg && tc.cfg.model) || '';
  } catch { /* 取不到就让下面的断言失败得明白些 */ }
  console.log(`  翻译配置里的模型: ${translateModel || '(取不到)'}`);
  console.log(`  原配置: useTranslate=${saved.useTranslate} baseUrl='${saved.baseUrl}' model='${saved.model}'\n`);
  if (!translateModel) {
    console.log('  SKIP 拿不到翻译模型名，无法判定"跟随翻译"是否生效');
    process.exit(0);
  }
  ok(translateModel !== PROBE_MODEL,
    `翻译模型与自定义模型不同（${translateModel} ≠ ${PROBE_MODEL}），本测试才有区分力`);

  try {
    console.log('== 1. 先设成"自定义 = 本地 Qwen3" ==');
    let v = await post({ useTranslate: false, baseUrl: PROBE, model: PROBE_MODEL });
    ok(v.useTranslate === false, 'useTranslate 记为 false');
    ok(v.effectiveModel === PROBE_MODEL, `实际调用 = ${PROBE_MODEL}`, v.effectiveModel);
    ok(v.effectiveBaseUrl === PROBE, `实际地址 = ${PROBE}`, v.effectiveBaseUrl);

    console.log('\n== 2. 勾选「用字幕翻译的模型」——实际调用必须跟着变 ==');
    v = await post({ useTranslate: true });
    ok(v.useTranslate === true, 'useTranslate 记为 true');
    // ★ 这条就是漏掉的 bug：开关为 true，但模型仍是自定义的那个
    ok(v.effectiveModel !== PROBE_MODEL,
      `实际调用不再是被覆盖的 ${PROBE_MODEL}`, v.effectiveModel);
    ok(v.effectiveModel === translateModel,
      `实际调用 = 翻译的模型（${translateModel}）`, v.effectiveModel);
    ok(!String(v.effectiveBaseUrl).includes('11434'),
      '实际地址不再是本地 11434', v.effectiveBaseUrl);
    // 自定义值本身要留着，方便切回去（但不应生效）
    ok(v.baseUrl === PROBE && v.model === PROBE_MODEL,
      '自定义值仍保留在配置里（切回去不用重填）', [v.baseUrl, v.model]);

    console.log('\n== 3. 取消勾选 → 回到自定义，且不用重填 ==');
    v = await post({ useTranslate: false });
    ok(v.useTranslate === false, 'useTranslate 记为 false');
    ok(v.effectiveModel === PROBE_MODEL, `实际调用回到 ${PROBE_MODEL}`, v.effectiveModel);
    ok(v.effectiveBaseUrl === PROBE, '实际地址回到自定义', v.effectiveBaseUrl);

    console.log('\n== 4. 反复切换要稳定（不能出现半生效状态）==');
    const seq = [];
    for (const want of [true, false, true, false, true]) {
      const r = await post({ useTranslate: want });
      seq.push({ want, got: r.useTranslate, model: r.effectiveModel });
    }
    ok(seq.every(s => s.want === s.got), '每次开关状态都正确记录', seq);
    ok(seq.filter(s => s.want).every(s => s.model === translateModel),
      '勾选时每次都走翻译模型', seq.filter(s => s.want).map(s => s.model));
    ok(seq.filter(s => !s.want).every(s => s.model === PROBE_MODEL),
      '取消时每次都走自定义模型', seq.filter(s => !s.want).map(s => s.model));
  } finally {
    // 恢复原状
    try { await post(saved); } catch (e) { console.log('  （恢复原配置失败：' + e.message + '）'); }
    const back = await get().catch(() => null);
    if (back) console.log(`\n  已恢复: useTranslate=${back.useTranslate} model=${back.effectiveModel}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
