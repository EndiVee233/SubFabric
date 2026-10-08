/**
 * carryConfidence 的单测：把「分句前」的逐句置信度按**时间重叠**搬到「分句后」。
 *
 * 为什么需要：这段逻辑修的是一个真实断点 —— 语义分句会重建 segments 并丢掉 confidence，
 * 于是 asr.json 分句后没有逐句置信度、ASS 注释也写不出来，**界面完全看不到置信度**。
 * 而它只在"识别 + 分句"这条完整链路上才暴露，光跑单测是发现不了的，
 * 所以这里把映射规则钉死，防止以后有人动 reseg 或写回逻辑时又把它弄丢。
 *
 * 用词序号映射是**错的**：实测 reseg 会在句间挪词（27/11 → 28/10），按序号会错位。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

// 从 server.js 抽函数（它依赖整个服务端环境，没法整体 import）
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
const start = SRC.indexOf('  function carryConfidence(');
if (start < 0) { console.error('抽不到 carryConfidence'); process.exit(1); }
const end = SRC.indexOf('\n  }\n', start) + 4;
const code = SRC.slice(start, end).replace(/^ {2}/gm, '')
  + '\nexport { carryConfidence };\n';
const mod = path.join(HERE, '_carry.mjs');
fs.writeFileSync(mod, code);
const { carryConfidence } = await import(pathToFileURL(mod).href);
fs.unlinkSync(mod);

const seg = (s, e, score, worst = null) => ({ start: s, end: e, text: 'x', confidence: { score, worstWord: worst } });

console.log('== 1:1 直通（分句没改动）==');
let oldSegs = [seg(0, 2, 0.9, 3), seg(2, 5, 0.5, 1)];
let newSegs = [{ start: 0, end: 2 }, { start: 2, end: 5 }];
let n = carryConfidence(oldSegs, newSegs);
ok(n === 2, '两行都拿到了', n);
ok(newSegs[0].confidence.score === 0.9, '第一行沿用 0.9', newSegs[0].confidence.score);
ok(newSegs[1].confidence.low === true, '0.5 < 0.60 → 标低置信度');
ok(newSegs[0].confidence.worstWord === 3, '整句沿用时保留最可疑词下标');
ok(newSegs[0].confidence.from === 'carry', '带来源标记');

console.log('\n== 一句被切成两句：按重叠分摊，两边都拿原句的分 ==');
oldSegs = [seg(0, 10, 0.8)];
newSegs = [{ start: 0, end: 4 }, { start: 4, end: 10 }];
carryConfidence(oldSegs, newSegs);
ok(newSegs[0].confidence.score === 0.8 && newSegs[1].confidence.score === 0.8, '切开后两段同为 0.8');
ok(newSegs[0].confidence.worstWord === null, '被切开的句子不编造最可疑词下标');

console.log('\n== 两句被并成一句：按区间长短加权 ==');
oldSegs = [seg(0, 2, 1.0), seg(2, 10, 0.5)];
newSegs = [{ start: 0, end: 10 }];
carryConfidence(oldSegs, newSegs);
// 权重 2:8 → (2*1.0 + 8*0.5)/10 = 0.6
ok(Math.abs(newSegs[0].confidence.score - 0.6) < 1e-6, '加权得 0.6', newSegs[0].confidence.score);
ok(newSegs[0].confidence.low === false,
  '0.6 恰好落在阈值上：0.6 < 0.60 为假 -> 不算低置信度（边界语义要明确）');
// 真正低于阈值的情况，确认 low 会打开
{
  const o = [seg(0, 1, 0.30), seg(1, 10, 0.30)];
  const nw = [{ start: 0, end: 10 }];
  carryConfidence(o, nw);
  ok(nw[0].confidence.score === 0.3 && nw[0].confidence.low === true,
    '0.3 低于阈值 -> 标低置信度', nw[0].confidence.score);
}

console.log('\n== 边界与健壮性 ==');
oldSegs = [seg(0, 5, 0.7)];
newSegs = [{ start: 100, end: 200 }];                     // 完全不重叠
ok(carryConfidence(oldSegs, newSegs) === 0, '无重叠 → 不赋分', newSegs[0].confidence);
// 无任何置信度来源 → 返回 0，且不动新句子
newSegs = [{ start: 0, end: 5 }];
ok(carryConfidence([{ start: 0, end: 5 }], newSegs) === 0, '来源没有 confidence → 返回 0');
ok(!newSegs[0].confidence, '不伪造 confidence');
ok(carryConfidence(null, [{ start: 0, end: 1 }]) === 0, 'oldSegs 为 null 不炸');
ok(carryConfidence([], []) === 0, '空数组不炸');
// 非法分数应被跳过
oldSegs = [{ start: 0, end: 5, confidence: { score: NaN } }, seg(0, 5, 0.9)];
newSegs = [{ start: 0, end: 5 }];
carryConfidence(oldSegs, newSegs);
ok(newSegs[0].confidence.score === 0.9, 'NaN 分数被跳过，用有效的那条');

console.log('\n== 分数被夹在 0~1、保留 3 位 ==');
oldSegs = [seg(0, 5, 1.5)];
newSegs = [{ start: 0, end: 5 }];
carryConfidence(oldSegs, newSegs);
ok(newSegs[0].confidence.score === 1, '1.5 → 夹到 1', newSegs[0].confidence.score);
oldSegs = [seg(0, 5, 0.1234567)];
newSegs = [{ start: 0, end: 5 }];
carryConfidence(oldSegs, newSegs);
ok(newSegs[0].confidence.score === 0.123, '3 位小数', newSegs[0].confidence.score);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
