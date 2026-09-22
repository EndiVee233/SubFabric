/**
 * 下载本地渲染依赖 (首次克隆后运行一次):
 *   node editor/scripts/fetch-vendor.js
 *
 * 拉取内容:
 *   - libass-wasm (subtitles-octopus): js / worker.js / worker.wasm
 *   - Noto Sans CJK SC 字体: 供 libass 渲染中文
 * 这些文件体积较大(约 19MB)未入库, 因此需要在本地生成。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VENDOR = path.resolve(__dirname, '..', 'vendor');
const FONTS = path.join(VENDOR, 'fonts');
const BASE = 'https://cdn.jsdelivr.net/npm/libass-wasm@4.1.0/dist/js';
const FONT_URL = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf';

const FILES = [
  { url: `${BASE}/subtitles-octopus.js`, dest: path.join(VENDOR, 'subtitles-octopus.js'), min: 50000 },
  { url: `${BASE}/subtitles-octopus-worker.js`, dest: path.join(VENDOR, 'subtitles-octopus-worker.js'), min: 300000 },
  { url: `${BASE}/subtitles-octopus-worker.wasm`, dest: path.join(VENDOR, 'subtitles-octopus-worker.wasm'), min: 2000000 },
  { url: FONT_URL, dest: path.join(FONTS, 'NotoSansCJKsc-Regular.otf'), min: 10000000 }
];

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (e) { return -1; }
}

async function download(f) {
  const existing = sizeOf(f.dest);
  if (existing >= f.min) {
    console.log(`✓ 已存在, 跳过: ${path.relative(process.cwd(), f.dest)} (${(existing / 1048576).toFixed(1)}MB)`);
    return true;
  }
  process.stdout.write(`↓ 下载 ${path.basename(f.dest)} … `);
  const resp = await fetch(f.url);
  if (!resp.ok) {
    console.log(`失败 (HTTP ${resp.status})`);
    return false;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < f.min) {
    console.log(`失败 (体积异常: ${buf.length} 字节)`);
    return false;
  }
  fs.mkdirSync(path.dirname(f.dest), { recursive: true });
  fs.writeFileSync(f.dest, buf);
  console.log(`完成 (${(buf.length / 1048576).toFixed(1)}MB)`);
  return true;
}

(async () => {
  fs.mkdirSync(FONTS, { recursive: true });
  let ok = true;
  for (const f of FILES) ok = (await download(f)) && ok;
  if (!ok) {
    console.error('\n部分依赖下载失败, 可手动下载后放入对应目录:');
    for (const f of FILES) console.error(`  ${f.url}  →  ${f.dest}`);
    process.exit(1);
  }
  console.log('\n全部就绪, 现在可以运行: node editor/server.js');
})().catch(e => {
  console.error('下载出错:', e && e.message || e);
  process.exit(1);
});
