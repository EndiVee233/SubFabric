/**
 * 首页「可编辑稿件」统计胶囊：45° 倾斜 + 文字水平。
 *
 * Material You 的胶囊用按钮自身 rotate(45deg)、内部文字 rotate(-45deg) 抵消；
 * 其它主题不倾斜（Studio/Classic 4px 圆角矩形，UWP 也保持直角），文字同样不能带旋转。
 * 45° 的包围盒比原 26° 宽，CSS 里按视口分档缩小并右移，避免压到稿件卡/撑出视口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, '..', 'editor', 'css', 'studio.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

console.log('== 45° 胶囊与反向文字 ==');
ok(/\.sf-orbit \{[^}]*transform:rotate\(45deg\)/.test(CSS), '基础按钮旋转 45°');
ok(/\.sf-orbit>span \{[^}]*rotate\(-45deg\)/.test(CSS), '基础文字反向旋转 -45°（净角度 0）');
ok(!CSS.includes('rotate(20deg)') && !CSS.includes('rotate(26deg)'), '旧的 20°/26° 旋转已移除');
ok(/\.sf-orbit:hover \{[^}]*rotate\(45deg\) scale\(1\.04\)/.test(CSS), '悬停保持 45° 并轻微放大');
ok(/\.sf-orbit:active \{[^}]*rotate\(45deg\) scale\(\.96\)/.test(CSS), '按下保持 45° 并轻微缩小');

console.log('\n== Material You 专用布局 ==');
ok(/\.sf-studio\[data-design=material\] \.sf-orbit \{\s*--orbit-x: 8px;[\s\S]*?width:92px; height:140px;[\s\S]*?rotate\(45deg\)/.test(CSS),
  '桌面尺寸 92×140、右移 8px、旋转 45°');
ok(/\.sf-studio\[data-design=material\] \.sf-orbit>span,[\s\S]{0,400}?rotate\(-45deg\)/.test(CSS),
  'Material 的悬停/按下文字仍反向旋转 -45°');
ok(CSS.includes('width:88px; height:132px;'), '短视口（max-height:800）缩到 88×132');
ok(CSS.includes('width:70px; height:108px;'), '窄视口（max-width:1150）缩到 70×108');

console.log('\n== 其它主题：不倾斜，文字水平 ==');
ok(/\.sf-studio\[data-design\]:not\(\[data-design=material\]\)[^{]*\{[^}]*transform:none!important/.test(CSS),
  '非 Material 的胶囊按钮不旋转');
ok(/\.sf-studio\[data-design\]:not\(\[data-design=material\]\):not\(\[data-design=uwp\]\) \.sf-orbit>span \{\s*transform:translate\(-3px,-4px\);/.test(CSS),
  '非 Material（且非 UWP）的文字只平移、不带旋转');
ok(/\.sf-studio\[data-design=uwp\] \.sf-orbit>span \{ transform:none; \}/.test(CSS),
  'UWP 保持 transform:none');

console.log('\n== 几何粗算：45° 包围盒 ==');
const box = (w, h) => (w + h) / Math.SQRT2;
const cases = [
  { name: '1600 桌面', w: 92, h: 140, available: 193 },
  { name: '1280×720', w: 88, h: 132, available: 181 },
  { name: '1024×768', w: 70, h: 108, available: 137 },
];
for (const c of cases) {
  const b = box(c.w, c.h);
  ok(b <= c.available - 10, `${c.name}: 包围盒 ${b.toFixed(1)}px ≤ 可用 ${c.available}px - 10px`, b.toFixed(1));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
