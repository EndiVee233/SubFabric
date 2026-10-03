/**
 * 下载本地渲染依赖 (首次克隆后运行一次):
 *   node editor/scripts/fetch-vendor.js
 *
 * 拉取内容:
 *   - libass-wasm (subtitles-octopus): js / worker.js / worker.wasm
 *   - Noto Sans CJK SC 字体: 供 libass 渲染中文
 * 这些文件体积较大(约 19MB)未入库, 因此需要在本地生成。
 *
 * 下载完还会给 worker 打一个**必须的补丁**(setTrack 后强制重绘),
 * 否则删除/修改字幕后视频区会停留在旧画面 —— 详见下面 patchWorkerSetTrack()。
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

/* ── worker 补丁: setTrack 之后强制重绘 ────────────────────────────────────
 * 上游 worker 里 setTrack() 重建完 libass 轨后调用 self.getRenderMethod()()，
 * **不带 force 参数**；而渲染函数只在
 *     renderResult.changed != 0 || force
 * 时才把这一帧 postMessage 回主线程。
 *
 * 问题出在 createTrack：它重建 libass track，渲染器里"上一帧"的比较状态随之
 * 失效，libass 的 detect_change 于是返回 0（它只在存在上一帧时才置位）——
 * 新帧被静默丢弃，主线程 canvas 继续显示**重建之前**的画面。
 * 实测：5000 条事件的稿件里删掉一条正在显示的字幕，数据、轨道都已更新
 * （worker 里 createTrack 后事件数确实少了 1），但画面 20 多秒不动，
 * 再点一次刷新也没用；只有把整轨删空时才偶然正常（空轨走 libass 的提前
 * 返回分支，那个分支会置位）。
 *
 * 修法：让 setTrack 走强制渲染。force 是**数值标志位**、不是指针
 * （binding 里 renderBlend(tm, force) 把 force 直接按值传给 wasm），
 * 所以传 true 是安全的，不会写成野地址。
 * 幂等：已打过补丁就跳过。
 * ─────────────────────────────────────────────────────────────────────── */
const SET_TRACK_HEAD = 'self.setTrack=function(content){';
const SET_TRACK_TAIL = 'self.getRenderMethod()()};';
const SET_TRACK_PATCHED = 'self.getRenderMethod()(true)};';

function patchWorkerSetTrack() {
  const dest = path.join(VENDOR, 'subtitles-octopus-worker.js');
  let src;
  try {
    // latin1 = 字节级往返，保证不破坏文件里的非 ASCII 字节
    src = fs.readFileSync(dest, 'latin1');
  } catch (e) {
    console.error(`✗ 读不到 worker，无法打补丁: ${dest}`);
    return false;
  }
  if (src.includes(SET_TRACK_PATCHED)) {
    console.log('✓ worker 补丁已存在(setTrack 强制重绘)');
    return true;
  }
  const head = src.indexOf(SET_TRACK_HEAD);
  if (head === -1) {
    console.error('✗ worker 里找不到 setTrack —— 上游结构变了，请人工核对后再改本补丁');
    return false;
  }
  const tail = src.indexOf(SET_TRACK_TAIL, head);
  if (tail === -1) {
    console.error('✗ worker 的 setTrack 末尾结构与预期不符，补丁未打');
    return false;
  }
  const out = src.slice(0, tail) + SET_TRACK_PATCHED + src.slice(tail + SET_TRACK_TAIL.length);
  fs.writeFileSync(dest, out, 'latin1');
  console.log('✓ 已给 worker 打补丁: setTrack 后强制重绘');
  console.log('  (否则删除/修改字幕后视频区可能一直停留在旧画面)');
  return true;
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
  // 补丁必须在下载之后无条件执行(已存在的大文件会被跳过, 但补丁不能跟着跳)
  if (!patchWorkerSetTrack()) process.exit(1);
  console.log('\n全部就绪, 现在可以运行: node editor/server.js');
})().catch(e => {
  console.error('下载出错:', e && e.message || e);
  process.exit(1);
});
