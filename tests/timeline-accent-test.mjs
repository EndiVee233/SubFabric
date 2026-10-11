/* 时间轴的强调色必须跟着界面主题色走 —— node tests/timeline-accent-test.mjs
 *
 * 用户可换主题色（设置 → 外观）。canvas 里读不到 CSS 变量，所以 Timeline 在构造时把
 * `--accent` 缓存进 `this.accent`，并在 `ss-accent` 事件里刷新。
 *
 * 但批量选区框、拖拽预览框、胶片时间标签、选区提示条这四处曾经直接用**常量** `C.accent`
 * （写死的默认橙 #ff7a45）—— 用户换成蓝色主题后，选中环会跟着变、这几个框却仍是橙的，
 * 同一屏里两种强调色。
 *
 * 这里用一个"记录型 ctx"直接调绘图方法，断言它取的是主题色、而不是常量。
 * （浏览器像素级验证在 headless 下难以稳定合成 canvas 手势，这个单测是更可靠的钉子。）
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');
{
  const marker = path.join(JSMOD, 'package.json');
  fs.mkdirSync(JSMOD, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(b, a);
  }
  fs.writeFileSync(marker, '{"type":"module"}\n');
}

const { Timeline } = await import('./jsmod/timeline.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};

/** 记录所有被写过的颜色（fillStyle / strokeStyle）。
 *  ⚠ 不要在 restore 里"还原"记录数组 —— 那样会把刚记下的颜色丢掉。
 *  这里只关心"用过哪些颜色"，不还原。 */
function recorder() {
  const seen = { fill: [], stroke: [] };
  const ctx = {
    lineWidth: 1, font: '', textAlign: '',
    set fillStyle(v) { seen.fill.push(v); },
    set strokeStyle(v) { seen.stroke.push(v); },
    get fillStyle() { return seen.fill[seen.fill.length - 1]; },
    get strokeStyle() { return seen.stroke[seen.stroke.length - 1]; },
    save() {}, restore() {},
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    setLineDash() {}, measureText: () => ({ width: 40 }), fillText() {}, clip() {}, rect() {},
  };
  return { ctx, seen };
}

/** 最小 stub：_drawRangeSel 只用这些。 */
function stub(accent) {
  return {
    accent,
    rangeSel: { a: 10, b: 20 },
    _rangeDragging: false,
    t2x: (t) => t * 10,
    _cssW: () => 800,
    _cssH: () => 300,
    _laneTop: () => 60,
    _lanesBottom: () => 260,
    _roundRect() {},
  };
}

console.log('== 批量选区框：描边/底色都跟主题色 ==');
{
  const { ctx, seen } = recorder();
  Timeline.prototype._drawRangeSel.call(stub('#00ff00'), ctx);
  ok(seen.stroke.includes('#00ff00'), '★ 描边用主题色（不是写死的橙）', seen.stroke);
  ok(!seen.stroke.includes('#ff7a45'), '★ 没有用到默认橙常量');
  ok(seen.fill.some(v => /^rgba\(0,255,0,/.test(String(v))), '底色是主题色的半透明版', seen.fill);
  ok(!seen.fill.some(v => /^rgba\(255,122,69,/.test(String(v))), '底色不是写死的橙');
}

console.log('\n== 没拿到主题色时退回默认橙（行为不变）==');
{
  const { ctx, seen } = recorder();
  Timeline.prototype._drawRangeSel.call(stub(undefined), ctx);
  ok(seen.stroke.includes('#ff7a45'), '无主题色 → 退回 C.accent 默认橙', seen.stroke);
}

console.log('\n== 换主题色后跟着变（不是只在构造时取一次）==');
{
  const s = stub('#00ff00');
  const r1 = recorder();
  Timeline.prototype._drawRangeSel.call(s, r1.ctx);
  s.accent = '#4fd1a5';                       // 模拟 ss-accent 事件刷新了缓存
  const r2 = recorder();
  Timeline.prototype._drawRangeSel.call(s, r2.ctx);
  ok(r2.seen.stroke.includes('#4fd1a5'), '★ 第二次绘制用了新主题色', r2.seen.stroke);
}

console.log('\n== 源码里不该再有裸的 C.accent 绘图调用 ==');
{
  const src = fs.readFileSync(path.join(SRC, 'timeline.js'), 'utf8');
  const bad = src.split(/\r?\n/)
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(x => /(fillStyle|strokeStyle|shadowColor)\s*=\s*C\.accent\b/.test(x.l));
  ok(bad.length === 0, '★ 没有 fillStyle/strokeStyle = C.accent 的裸用法', bad.map(b => b.n));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
