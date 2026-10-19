/* 压制的加速方案选择（GPU 优先）+ ffmpeg 定位与自动下载的纯逻辑测试。
 *
 * 不打桩、不联网、不写盘（下载相关只测"决策"，真下载由人工/端到端验证）：
 *   · pickAccel：GPU 优先于 CPU、按"编码格式"逐项判断、显式指定不可用时的降级
 *   · checkTools：ffmpeg/ffprobe 是否真的能跑
 *   · 垫背事件：hardsub 的核心不变量（事件多时首条不被吞）
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hardsub = require('../editor/hardsub.js');
const ffmpegTool = require('../editor/ffmpeg-tool.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
}

/* ─────────── pickAccel：GPU 优先 ─────────── */
console.log('== ① GPU 优先于 CPU ==');
{
  // 构造"GPU 可用"的能力表
  const p = {
    tools: { ok: true },
    encoders: {
      nvidia: { h264: { encoder: 'h264_nvenc', usable: false }, h265: { encoder: 'hevc_nvenc', usable: false }, av1: { encoder: 'av1_nvenc', usable: false } },
      amd: { h264: { encoder: 'h264_amf', usable: true }, h265: { encoder: 'hevc_amf', usable: true }, av1: { encoder: 'av1_amf', usable: false } },
      intel: { h264: { encoder: 'h264_qsv', usable: true }, h265: { encoder: 'hevc_qsv', usable: true }, av1: { encoder: 'av1_qsv', usable: false } },
    },
    cpu: { h264: { encoder: 'libx264', usable: true }, h265: { encoder: 'libx265', usable: true }, av1: { encoder: 'libsvtav1', usable: true } },
  };
  const r1 = hardsub.pickAccel(p, 'h264', 'auto');
  ok(r1.accel === 'amd', 'auto + h264 选到 GPU（AMD）而不是 CPU', r1);
  ok(r1.fallback === false, 'auto 选中 GPU 时不算降级');
  const r2 = hardsub.pickAccel(p, 'h265', 'auto');
  ok(r2.accel === 'amd', 'auto + h265 选到 GPU');
  // AV1：AMD/Intel 都压不了 → 才落 CPU
  const r3 = hardsub.pickAccel(p, 'av1', 'auto');
  ok(r3.accel === 'cpu', 'auto + av1 在 GPU 不支持时落 CPU', r3);

  console.log('== ② 按编码格式判断，不是按厂商 ==');
  // 只有 Intel 能压 av1 的情形
  const p2 = JSON.parse(JSON.stringify(p));
  p2.encoders.intel.av1 = { encoder: 'av1_qsv', usable: true };
  const r4 = hardsub.pickAccel(p2, 'av1', 'auto');
  ok(r4.accel === 'intel', '只有 Intel 支持 av1 时应选 Intel 而非 CPU', r4);

  console.log('== ③ 显式指定不可用组合要降级到其它 GPU，而不是直接 CPU ==');
  const r5 = hardsub.pickAccel(p, 'h264', 'nvidia');
  ok(r5.accel === 'amd', '指定 nvidia（不可用）→ 降到其它 GPU', r5);
  ok(r5.fallback === true, '降级要标 fallback');
  const r6 = hardsub.pickAccel(p, 'av1', 'amd');
  ok(r6.accel === 'cpu' && r6.fallback === true, '指定 amd+av1（压不了）→ 降 CPU 且标 fallback', r6);
  const r7 = hardsub.pickAccel(p, 'h264', 'cpu');
  ok(r7.accel === 'cpu' && r7.fallback === false, '用户显式选 CPU 不算降级');
  const r8 = hardsub.pickAccel(p, 'h264', 'amd');
  ok(r8.accel === 'amd' && r8.fallback === false, '显式选可用 GPU 不算降级');

  console.log('== ④ 工具不可用时不能假装能压 ==');
  const pBad = { tools: { ok: false }, encoders: {}, cpu: {} };
  const r9 = hardsub.pickAccel(pBad, 'h264', 'auto');
  ok(r9.usable === false, 'ffmpeg 不可用时 pickAccel 必须报不可用', r9);
  ok(typeof r9.reason === 'string' && r9.reason.length > 0, '要给出原因');
}

/* ─────────── 全集都为 false 时不能默认 CPU 可用 ─────────── */
console.log('== ⑤ CPU 也必须逐项验证 ==');
{
  const p = {
    tools: { ok: true },
    encoders: {
      nvidia: { h264: { usable: false }, h265: { usable: false }, av1: { usable: false } },
      amd: { h264: { usable: false }, h265: { usable: false }, av1: { usable: false } },
      intel: { h264: { usable: false }, h265: { usable: false }, av1: { usable: false } },
    },
    cpu: { h264: null, h265: null, av1: null },
  };
  const r = hardsub.pickAccel(p, 'h264', 'auto');
  ok(r.usable === false, '没有任何可用编码器时报不可用（不能默认 CPU 可用）', r);
}

/* ─────────── 垫背事件 ─────────── */
console.log('== ⑥ 垫背事件（首条字幕不被吞的核心） ==');
{
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', '',
    '[V4+ Styles]', 'Format: Name, Fontname', 'Style: Default,Arial', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,第一条',
    'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,第二条, 带逗号',
  ].join('\n');
  const r = hardsub.injectSacrificialEvent(ass);
  ok(r.inserted === true, '应注入垫背事件');
  const lines = r.text.split('\n');
  const fmtIdx = lines.findIndex(l => l.startsWith('Format: Layer'));
  const injected = lines[fmtIdx + 1];
  ok(injected.startsWith('Dialogue: 0,0:00:00.00,0:00:00.01,Default'), '垫背事件紧随 Format 行、用首条样式', injected);
  // Text 是最后一列（可能自带逗号，所以按"去掉 Dialogue: 前缀后最后一个字段"判断）
  const textField = injected.slice('Dialogue: '.length).split(',').pop();
  ok(textField === '', '垫背事件文本为空（画面上不出现任何东西）', textField);
  ok(lines.filter(l => l.startsWith('Dialogue:')).length === 3, '原两条 + 垫背 = 3 条');
  ok(r.text.includes('第二条, 带逗号'), '正文里的逗号不被切坏');
  // 无 [Events] 时安全跳过
  const r2 = hardsub.injectSacrificialEvent('[Script Info]\n');
  ok(r2.inserted === false && r2.text === '[Script Info]\n', '没有 [Events] 时原样返回');
}

/* ─────────── 滤镜路径转义 ─────────── */
console.log('== ⑦ Windows 路径进 -vf 的转义 ==');
{
  ok(hardsub.escapeFilterPath('D:\\a b\\x.ass') === "'D\\:/a b/x.ass'",
    '反斜杠转正斜杠 + 冒号转义 + 单引号包裹', hardsub.escapeFilterPath('D:\\a b\\x.ass'));
  ok(hardsub.escapeFilterPath('/tmp/x.ass') === "'/tmp/x.ass'", 'POSIX 路径同样被引号包裹');
}

/* ─────────── ffmpeg 定位 ─────────── */
console.log('== ⑧ ffmpeg/ffprobe 定位 ==');
{
  const loc = ffmpegTool.locate();
  ok(typeof loc.ok === 'boolean', 'locate() 返回 ok 布尔值');
  ok(loc.ffmpeg && typeof loc.ffmpeg.source === 'string', 'ffmpeg 带来源标记');
  ok(['env', 'bundled', 'common', 'path', 'missing'].includes(loc.ffmpeg.source),
    '来源标记是已知枚举', loc.ffmpeg.source);
  ok(!!loc.toolDir, '给出自动下载的落点目录');
  // 本机装了 ffmpeg，应当能找到；没有就是环境问题，不在这里判失败
  if (loc.ok) {
    ok(loc.ffmpeg.source !== 'missing', 'ok=true 时来源不能是 missing');
    console.log(`       （本机 ffmpeg 来源：${loc.ffmpeg.source} · ffprobe：${loc.ffprobe.source}）`);
  } else {
    console.log('       （本机没有 ffmpeg，跳过可用性断言）');
  }
}

/* ─────────── checkTools ─────────── */
console.log('== ⑨ checkTools 区分"不可用"与"只有 CPU" ==');
{
  const bad = hardsub.checkTools('definitely-not-a-real-ffmpeg-binary', 'nope-ffprobe');
  ok(bad.ok === false, '假路径应判为不可用');
  ok(bad.missing.includes('ffmpeg') && bad.missing.includes('ffprobe'), '缺失项要列全');
  const loc = ffmpegTool.locate();
  if (loc.ok) {
    const good = hardsub.checkTools(loc.ffmpeg.bin, loc.ffprobe.bin);
    ok(good.ok === true, '真实路径应判为可用');
    ok(typeof good.version === 'string' && good.version.length > 0, '可用时要带版本号');
  }
}

console.log(`\nGPU 优先与 ffmpeg 定位: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
