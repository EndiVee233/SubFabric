/**
 * 钉住「时间轴块内逐词文字不能被块的裁剪区切掉」这条修复。
 *
 * 用户报（截图里 `Home` 显示成 `ome`）：块内文字被 `_drawBlockText()` 裁在
 * `ctx.rect(x1 + TEXT_PAD, …)`，而逐词文字按词的真实时间位置画 —— 首词起点等于块起点时
 * （实测：块 5.80 起、首词 Home 也是 5.80），文字起点 x1 落在裁剪左界左侧 6px，左脚被切。
 *
 * 这里只测纯函数 `wordTextX()`（与绘制同一口径），不依赖 canvas：
 *   wordTextX(wx, x1, pad) = max(wx, x1 + pad)
 */
import { wordTextX, hasVisibleWordMark } from './jsmod/timeline.js';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name, extra == null ? '' : '   ' + extra); }
}

const PAD = 6;

console.log('\n── ① 首词起点 == 块起点（用户截图那种，实测块 5.80 / 词 5.80）──');
{
  const x1 = 205;                 // 块的左边缘
  const wx = 205;                 // 首词的真实位置 = 块起点
  const got = wordTextX(wx, x1, PAD);
  check('文字起点被推进到裁剪左界内', got === x1 + PAD, `得到 ${got}，期望 ${x1 + PAD}`);
  check('不会画到裁剪区左侧（否则左脚被裁）', got >= x1 + PAD);
}

console.log('\n── ② 首词起点在块起点左侧（词比块早开始）──');
{
  const x1 = 400, wx = 388;       // 词早 12px
  const got = wordTextX(wx, x1, PAD);
  check('仍然夹回裁剪左界', got === x1 + PAD, `得到 ${got}`);
}

console.log('\n── ③ 词起点明显在块内：保持原位（不能把所有词都推右）──');
{
  const x1 = 100, wx = 260;
  const got = wordTextX(wx, x1, PAD);
  check('保持词的真实位置', got === wx, `得到 ${got}，期望 ${wx}`);
}

console.log('\n── ④ 边界：正好落在裁剪左界上 ──');
{
  const x1 = 50;
  check('wx == x1+pad → 原位', wordTextX(x1 + PAD, x1, PAD) === x1 + PAD);
  check('wx == x1 → 夹到 x1+pad', wordTextX(x1, x1, PAD) === x1 + PAD);
  check('wx = x1+pad-0.4 → 夹到 x1+pad', wordTextX(x1 + PAD - 0.4, x1, PAD) === x1 + PAD);
  check('wx = x1+pad+0.4 → 原位（夹取不能把词往回拉）', wordTextX(x1 + PAD + 0.4, x1, PAD) === x1 + PAD + 0.4);
}

console.log('\n── ⑤ 与"首词不画标记"的既有约定一起成立 ──');
{
  check('首词不画逐词标记', hasVisibleWordMark(0) === false);
  check('后续词保留标记', hasVisibleWordMark(1) === true && hasVisibleWordMark(7) === true);
  check('非法索引当首词处理（不画标记）', hasVisibleWordMark(undefined) === false);
}

console.log('\n── ⑥ 夹取之后仍要放得下才画文字（口径与绘制一致）──');
{
  // 用户那份稿件：块 x1=205、首词 Home、下一个词 x=219（间隔 14px）
  const x1 = 205, nextX = 219, textW = 39;
  const textX = Math.round(wordTextX(x1, x1, PAD));
  const avail = nextX - textX - 3;
  check('该缩放下放不下 → 不画文字（只留标记），不会画出框',
    textW > avail, `textX=${textX} avail=${avail} textW=${textW}`);
  // 放大后间隔变宽 → 应当画得出来，且起点在裁剪区内
  const wideNextX = 205 + 120;
  const availWide = wideNextX - textX - 3;
  check('放大后放得下 → 画文字，起点在裁剪区内',
    textW <= availWide && textX >= x1 + PAD, `textX=${textX} avail=${availWide}`);
}

console.log('');
if (failed) { console.log(`✗ ${failed} 项失败`); process.exit(1); }
console.log('全部通过');
