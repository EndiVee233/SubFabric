/* 快速验证: 服务端新色标格式 + 编辑器 normalize 正则 vs 用户项目实际数据 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const fs = require_('fs');

// 1) 服务端新 assColorFromRgb(server.js 同款)
function assColorFromRgb(hex) {
  const n = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(n)) return 'FFFFFF';
  return n.slice(4, 6) + n.slice(2, 4) + n.slice(0, 2);
}
const tag = (c) => '{\\c&H' + assColorFromRgb(c) + '&}[SPK1] ';
console.log('new tag for #00b0f0:', tag('#00b0f0'));

// 2) 编辑器 normalizeLeadColors 正则 vs 用户项目实际畸形数据
const ass = fs.readFileSync('projects/p-mugzcab2-09f7z/subtitle.ass', 'utf8');
const re = /\{\\c&H&H?([0-9A-Fa-f]{6})&&\}/g;
console.log('malformed lead tags in file:', (ass.match(re) || []).length);
const fixed = ass.replace(re, (all, hex) => '{\\c&H' + hex + '&}');
const line = fixed.split('\n').find(l => l.includes('[SPK2]'));
console.log('sample fixed line:', line && line.slice(0, 86));

// 3) 规整后 karaoke.js 的 LEAD_COLOR_RE 应能解析出颜色(ev.text 是 Dialogue 最后一个逗号后的文本段)
const LEAD = /^\s*\{[^}]*?\\c&H([0-9A-Fa-f]{6})&/;
const textOf = (l) => l.slice(l.indexOf(',,') + 2);
const line2 = textOf(line || '');
const m = LEAD.exec(line2);
console.log('LEAD_COLOR_RE parses:', m ? m[1] + ' → #' + assColorFromRgb('#' + m[1]).toLowerCase() : 'FAIL');

// 4) 旧畸形串在规整前应解析失败(确认 bug 根源)
const oldLine = textOf(ass.split('\n').find(l => l.includes('[SPK2]')) || '');
console.log('old line parses (should be null):', LEAD.exec(oldLine || ''));
