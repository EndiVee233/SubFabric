/*
 * 主页的可调项：光感强度 + 握姿模式。
 *
 * 都放 AppStorage（`@StorageProp` 订阅），这样背景、卡片、导航栏三处读的是同一份值，
 * 调一次全页跟着变，不需要层层传参。
 */

export class HomePrefs {
  /** 光感强度：0 柔和 / 1 标准 / 2 明亮。 */
  static readonly LIGHT: string = 'homeLightLevel';
}

/** 光感强度 → 系数（背景亮度、卡片透光度、光带强度都乘它）。 */
export function lightScale(level: number): number {
  if (level <= 0) {
    return 0.62;
  }
  if (level >= 2) {
    return 1.38;
  }
  return 1.0;
}

/** 强度档位名，给 UI 用。 */
export function lightLabel(level: number): string {
  if (level <= 0) {
    return '柔和';
  }
  if (level >= 2) {
    return '明亮';
  }
  return '标准';
}

/**
 * 把 `#AARRGGBB` 的 alpha 乘一个系数。
 *
 * 卡片底色是半透明白，光感越强就让它透出来越多 —— 不是换颜色，只改透明度，
 * 这样三档之间是连续过渡，不会突然换一个色板。
 */
export function scaleAlpha(color: string, k: number): string {
  const hex: string = color.startsWith('#') ? color.slice(1) : color;
  if (hex.length !== 8) {
    return color;
  }
  const base: number = parseInt(hex.slice(0, 2), 16);
  if (Number.isNaN(base)) {
    return color;
  }
  let next: number = Math.round(base * k);
  if (next < 0) {
    next = 0;
  }
  if (next > 255) {
    next = 255;
  }
  const head: string = next.toString(16).toUpperCase();
  return '#' + (head.length < 2 ? '0' + head : head) + hex.slice(2).toUpperCase();
}

/** 当前光感系数（组件里直接用）。 */
export function currentLightScale(): number {
  const level = AppStorage.get<number>(HomePrefs.LIGHT);
  return lightScale(level === undefined ? 1 : level);
}
