/* 浅色主题 + 高毛玻璃压暗时的前景色检测（纯逻辑，可单测）。
 *
 * 浅色模式的玻璃面板背景是 `rgb(0 0 0 / alpha)`，alpha 一高，最终合成色会变深；
 * 但主题 token 里的 --text 仍是深色，于是出现“深灰字压深灰底”。这里把
 * 背景色与页面底色/背景图平均色做 alpha 合成，算相对亮度，超过阈值就切浅色字。
 */

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
const RGB_RE = /^rgba?\(([^)]+)\)$/i;
const SRGB_RE = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i;

/** 解析 #RGB/#RRGGBB/#RRGGBBAA、rgb()/rgba()、color(srgb ...)。失败返回 null。 */
export function parseCssColor(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const h = s.match(HEX_RE);
  if (h) {
    let x = h[1];
    if (x.length === 3 || x.length === 4) x = x.split('').map(ch => ch + ch).join('');
    if (x.length === 6 || x.length === 8) {
      return {
        r: parseInt(x.slice(0, 2), 16),
        g: parseInt(x.slice(2, 4), 16),
        b: parseInt(x.slice(4, 6), 16),
        a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const m = s.match(RGB_RE);
  if (m) {
    const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
    const p = parts.slice(0, 3).map(Number);
    if (p.length >= 3 && p.every(Number.isFinite)) {
      let alpha = 1;
      if (parts[3] != null) {
        const raw = String(parts[3]);
        const value = raw.endsWith('%') ? parseFloat(raw) / 100 : Number(raw);
        if (Number.isFinite(value)) alpha = Math.max(0, Math.min(1, value));
      }
      return { r: p[0], g: p[1], b: p[2], a: alpha };
    }
    return null;
  }
  const c = s.match(SRGB_RE);
  if (c) {
    return {
      r: Number(c[1]) * 255, g: Number(c[2]) * 255, b: Number(c[3]) * 255,
      a: c[4] == null ? 1 : Math.max(0, Math.min(1, Number(c[4]))),
    };
  }
  return null;
}

/** top 叠在 bottom 上，按 alpha 合成，返回不透明色。 */
export function compositeColor(top, bottom) {
  const t = top || { r: 0, g: 0, b: 0, a: 0 };
  const b = bottom || { r: 255, g: 255, b: 255, a: 1 };
  const ta = Math.max(0, Math.min(1, t.a == null ? 1 : t.a));
  const ba = Math.max(0, Math.min(1, b.a == null ? 1 : b.a));
  const a = ta + ba * (1 - ta);
  if (a <= 0) return { r: 255, g: 255, b: 255, a: 1 };
  return {
    r: (t.r * ta + b.r * ba * (1 - ta)) / a,
    g: (t.g * ta + b.g * ba * (1 - ta)) / a,
    b: (t.b * ta + b.b * ba * (1 - ta)) / a,
    a: 1,
  };
}

/** WCAG 相对亮度，输入 0–255。 */
export function relativeLuminance(color) {
  const c = color || { r: 0, g: 0, b: 0 };
  const f = (v) => {
    const x = Math.max(0, Math.min(255, v)) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 背景亮度低于约 0.30，且浅色字至少 3:1 时使用浅色前景。
 *  30% 黑压在浅底上约 #b3（亮度 .45），不会误切；压到 #8d 以下才切。 */
export function shouldUseLightText({ background, lightText = '#f8f8f3' } = {}) {
  if (!background) return false;
  const bgL = relativeLuminance(background);
  const light = parseCssColor(lightText) || { r: 248, g: 248, b: 243, a: 1 };
  return bgL < 0.30 && contrastRatio(light, background) >= 3;
}
