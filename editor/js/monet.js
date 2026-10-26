/* Monet / Material You 取色：从图片像素里挑一个「有代表性又够鲜艳」的种子色。
 *
 * 为什么需要单独一层：Material You 的动态色不是「取平均色」——平均出来通常是一团灰。
 * 真实壁纸取色会先量化颜色，再按色度、明度和像素占比打分，挑一个能生成整套配色的种子。
 * 这里的实现是轻量近似（不引入 HCT 库）：
 *   · 跳过透明、过暗、过亮和接近灰的像素；
 *   · 按 15° 色相分桶，权重 = 像素占比 × 饱和度² × 中等明度偏好；
 *   · 取权重最高的桶（合并左右相邻桶）的加权平均色相/饱和度；
 *   · 把饱和度夹到 0.35~0.75、明度夹到 0.42~0.62，避免取到荧光色或近黑色。
 * 真正生成 Material 配色仍交给 studio-themes.js 的 palette(seed, dark)。
 *
 * 纯函数 seedFromPixels 不碰 DOM，可在 Node 里单测；extractSeedFromImageSrc 才使用 canvas。
 */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 从 RGBA 像素里取一个种子色（#rrggbb）。没有可用像素时返回 null。
 * @param {Uint8ClampedArray|Uint8Array|number[]} data RGBA，长度 = width*height*4
 * @param {number} width
 * @param {number} height
 * @returns {string|null}
 */
export function seedFromPixels(data, width, height) {
  const w = Math.max(0, Number(width) | 0), h = Math.max(0, Number(height) | 0);
  if (!data || !data.length || !w || !h) return null;
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, hx: 0, hy: 0, s: 0, l: 0 }));
  let neutral = { weight: 0, r: 0, g: 0, b: 0 };
  let opaque = 0;
  const total = w * h;
  /* 大图不需要逐像素：采样到约 4k 像素就足够稳定，也让取色保持在 1~2ms 级。 */
  const step = Math.max(1, Math.floor(Math.sqrt(total / 4096)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (i + 3 >= data.length) continue;
      const a = data[i + 3];
      if (a < 128) continue;                       // 透明像素不算
      opaque++;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [hue, sat, lig] = rgbToHsl(r, g, b);
      /* 近黑/近白/灰的像素对「主题色」没有帮助；中性色单独留作兜底。 */
      if (lig < 0.10 || lig > 0.95 || sat < 0.08) {
        const weight = 1;
        neutral.weight += weight; neutral.r += r * weight; neutral.g += g * weight; neutral.b += b * weight;
        continue;
      }
      /* 中等明度、饱和度高的颜色更像 Material 的 seed；暗部/高光都降权。 */
      const mid = 1 - Math.min(1, Math.abs(lig - 0.55) * 1.8);
      const weight = Math.pow(sat, 2.2) * (0.35 + mid) + 0.01;
      const bin = bins[Math.min(23, Math.floor(hue / 15))];
      const rad = hue * Math.PI / 180;
      bin.weight += weight;
      bin.hx += Math.cos(rad) * weight;
      bin.hy += Math.sin(rad) * weight;
      bin.s += sat * weight;
      bin.l += lig * weight;
    }
  }
  if (!opaque) return null;

  let best = -1;
  for (let i = 0; i < bins.length; i++) if (bins[i].weight > 0 && (best < 0 || bins[i].weight > bins[best].weight)) best = i;
  if (best < 0) {
    if (!neutral.weight) return null;
    return hslToHex(0, 0, clamp((neutral.r + neutral.g + neutral.b) / (3 * 255), 0.35, 0.65));
  }
  /* 合并左右相邻桶：同一种颜色恰好跨桶时不会被劈成两半，平均色相也更稳。 */
  let sx = 0, sy = 0, ss = 0, sl = 0, sw = 0;
  for (const d of [-1, 0, 1]) {
    const bin = bins[(best + d + bins.length) % bins.length];
    if (!bin.weight) continue;
    sx += bin.hx; sy += bin.hy; ss += bin.s; sl += bin.l; sw += bin.weight;
  }
  const hue = (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
  const sat = clamp((ss / sw) * 1.15, 0.35, 0.75);
  const lig = clamp(sl / sw, 0.42, 0.62);
  return hslToHex(hue, sat, lig);
}

/** 把 data URL / blob URL 解成小图并取色（仅浏览器）。失败返回 null。 */
export async function extractSeedFromImageSrc(src, opts) {
  const max = Math.max(8, Math.min(256, Number(opts && opts.max) || 96));
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  try {
    if (typeof img.decode === 'function') await img.decode();
    else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
  } catch { return null; }
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  if (!sw || !sh) return null;
  const scale = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return seedFromPixels(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch { return null; }
}
