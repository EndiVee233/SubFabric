'use strict';
/* 生成沉浸光感背景图：深色底 + 三团径向光 + 一条斜向高光。
 * 纯 zlib 手写 PNG，不依赖任何三方库。
 * 用法：node tools/make-home-glow.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 900;
const H = 1200;

// 光团：[cx, cy, 半径(相对短边), 颜色, 强度]
const BLOBS = [
  [0.78, 0.10, 0.55, [0x6F, 0xA2, 0xFF], 1.00],  // 主色：右上
  [0.10, 0.46, 0.48, [0x8E, 0x7C, 0xFF], 0.72],  // 第三色：左中
  [0.52, 0.92, 0.60, [0x2F, 0xC8, 0xA8], 0.42],  // 冷绿：底部
];
const BASE = [0x0a, 0x0e, 0x15];                  // 底色

function clamp(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

const px = Buffer.alloc(W * H * 4);
const short = Math.min(W, H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // 底色带一点自上而下的明度衰减，避免纯平
    const shade = 1 + 0.25 * (1 - y / H);
    let r = BASE[0] * shade;
    let g = BASE[1] * shade;
    let b = BASE[2] * shade;
    for (const [cx, cy, rad, color, power] of BLOBS) {
      const dx = (x / W - cx) * (W / short);
      const dy = (y / H - cy) * (H / short);
      const d = Math.sqrt(dx * dx + dy * dy) / rad;
      if (d >= 1) continue;
      // 平滑衰减：1 在中心，0 在边缘
      const fall = Math.pow(1 - d, 2.2) * power;
      r += (color[0] - r) * fall;
      g += (color[1] - g) * fall;
      b += (color[2] - b) * fall;
    }
    // 斜向高光：一条从左下到右上的柔光带
    const band = (x / W) * 0.65 + (1 - y / H) * 0.35;
    const streak = Math.max(0, 1 - Math.abs(band - 0.62) * 6) * 0.16;
    r += 255 * streak * 0.5;
    g += 255 * streak * 0.55;
    b += 255 * streak * 0.6;
    const i = (y * W + x) * 4;
    px[i] = clamp(Math.round(r));
    px[i + 1] = clamp(Math.round(g));
    px[i + 2] = clamp(Math.round(b));
    px[i + 3] = 255;
  }
}

// ── PNG 封装 ──
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// 每行前置 filter byte 0
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, '..',
  'entry', 'src', 'main', 'resources', 'base', 'media', 'home_glow.png');
fs.writeFileSync(out, png);
console.log(`${out}  ${(png.length / 1024).toFixed(1)} KB  ${W}x${H}`);
