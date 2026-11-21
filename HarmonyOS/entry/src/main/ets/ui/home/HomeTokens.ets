/*
 * 主页的视觉令牌与文案工具。
 *
 * 只放「颜色 / 文案」，尺寸一律在 HomeBreakpoints.ets 的 HomeDims 里按断点给，
 * 这样组件里不会出现孤立的数字，改一次断点表就整体变。
 */

import { isLightNow } from '../settings/AppearancePrefs';

/** 玻璃态 + M3 双主题令牌（seed #4C8DFF，与 Web 端 accent 同源）。 */
export class HomeTokens {
  /** 页面最底层兜底色（背景图没加载出来时也不露白）。 */
  static get base(): string {
    return isLightNow() ? '#F2F5FA' : '#0A0E15';
  }

  /** 卡片半透明底：配合 backdropBlur 才有玻璃感。 */
  static get glassFill(): string {
    return isLightNow() ? '#B8FFFFFF' : '#1FFFFFFF';
  }

  static get glassFillStrong(): string {
    return isLightNow() ? '#E0FFFFFF' : '#2EFFFFFF';
  }

  /** 主色容器（强调卡）。 */
  static get accentGlass(): string {
    return isLightNow() ? '#262F6FE0' : '#337FAEFF';
  }

  /** 危险色玻璃（需处理）。 */
  static get dangerGlass(): string {
    return isLightNow() ? '#26D14343' : '#33FF6B6B';
  }

  /** 玻璃边缘的高光描边。 */
  static get glassEdge(): string {
    return isLightNow() ? '#26000000' : '#3DFFFFFF';
  }

  /** 禁用按钮的实色底，避免半透明底透出背景形成一条亮边。 */
  static get disabledFill(): string {
    return isLightNow() ? '#E7EBF2' : '#252B35';
  }

  /** 主色 / 强调。 */
  static get primary(): string {
    return isLightNow() ? '#2F6FE0' : '#8FBAFF';
  }

  /** 主色光晕（按钮、花形）。 */
  static get primaryGlow(): string {
    return isLightNow() ? '#332F6FE0' : '#807FAEFF';
  }

  static get dangerGlow(): string {
    return isLightNow() ? '#33D14343' : '#66FF6B6B';
  }

  /** 第三色（斜置胶囊）。 */
  static get tertiary(): string {
    return isLightNow() ? '#6B5BD2' : '#C9BDFF';
  }

  static get tertiaryGlass(): string {
    return isLightNow() ? '#1F6B5BD2' : '#37C9BDFF';
  }

  /** 文本。 */
  static get text(): string {
    return isLightNow() ? '#172033' : '#F2F5FA';
  }

  static get textDim(): string {
    return isLightNow() ? '#4E5C70' : '#A7B2C4';
  }

  static get textFaint(): string {
    return isLightNow() ? '#7C8797' : '#6F7A8C';
  }

  /** 主色上的文字 / 图标。 */
  static get onPrimary(): string {
    return isLightNow() ? '#FFFFFF' : '#0A0E15';
  }

  /** 危险色（文字/描边）。 */
  static get danger(): string {
    return isLightNow() ? '#D14343' : '#FF8080';
  }

  /** 成功。 */
  static get success(): string {
    return isLightNow() ? '#12805C' : '#5FE0AE';
  }

  /** 卡片内部浅一层的分区底（设置卡片、工作量卡等）。 */
  static get innerFill(): string {
    return isLightNow() ? '#0D0A0E15' : '#14FFFFFF';
  }

  /** 字幕卡片 / 列表项的普通底。 */
  static get cardFill(): string {
    return isLightNow() ? '#CCFFFFFF' : '#14FFFFFF';
  }

  /** 编辑器字幕列表卡片底：深色模式比普通卡片更深，避免整列发灰。 */
  static get cueCardFill(): string {
    return isLightNow() ? '#CCFFFFFF' : '#4D0A0E15';
  }

  /** 弹窗、抽屉、菜单这类实体面板。 */
  static get panelFill(): string {
    return isLightNow() ? '#F2FFFFFF' : '#FF161D26';
  }

  /** 菜单/抽屉的模糊染色。 */
  static get panelTint(): string {
    return isLightNow() ? '#4DFFFFFF' : '#26141A24';
  }

  /** 普通阴影。 */
  static get shadow(): string {
    return isLightNow() ? '#26000000' : '#66000000';
  }

  static get shadowSoft(): string {
    return isLightNow() ? '#1A000000' : '#3D000000';
  }

  /** 对话框遮罩 / 输入备注遮罩。 */
  static get scrim(): string {
    return isLightNow() ? '#66000000' : '#CC000000';
  }

  /** 视频/素材预览占位底：浅色模式不要一块黑板。 */
  static get mediaPlaceholder(): string {
    return isLightNow() ? '#E6EEF7' : '#CC000000';
  }

  /** 主色实心控件上的浅色按压层。 */
  static get pressedOnPrimary(): string {
    return isLightNow() ? '#1FFFFFFF' : '#33FFFFFF';
  }

  /** 普通玻璃按钮/列表项的按压层。 */
  static get pressFill(): string {
    return isLightNow() ? '#14000000' : '#33FFFFFF';
  }

  /** 成功徽标底。 */
  static get successGlass(): string {
    return isLightNow() ? '#1F12805C' : '#225FE0AE';
  }

  /** 玻璃按钮的浅色高光阴影。 */
  static get buttonShadow(): string {
    return isLightNow() ? '#1F2F6FE0' : '#33FFFFFF';
  }

  /** 强调玻璃描边。 */
  static get accentEdge(): string {
    return isLightNow() ? '#4D2F6FE0' : '#4D8FBAFF';
  }

  static get dangerEdge(): string {
    return isLightNow() ? '#4DD14343' : '#4DFF8080';
  }

  /** 玻璃模糊的明暗模式：跟应用外观，不跟系统单独走。 */
  static blurMode(): ThemeColorMode {
    return isLightNow() ? ThemeColorMode.LIGHT : ThemeColorMode.DARK;
  }

  static isLightMode(): boolean {
    return isLightNow();
  }
}

/** 按小时给问候语（与 Web 端 materialGreeting 分档一致）。 */
export function greetingOf(hour: number): string {
  if (hour === 23 || hour === 0) {
    return '该睡啦';
  }
  if (hour >= 1 && hour < 3) {
    return '晚安好梦';
  }
  if (hour >= 3 && hour < 5) {
    return '凌晨好';
  }
  if (hour >= 5 && hour < 8) {
    return '早上好';
  }
  if (hour >= 8 && hour < 11) {
    return '上午好';
  }
  if (hour >= 11 && hour < 13) {
    return '中午好';
  }
  if (hour >= 13 && hour < 17) {
    return '下午好';
  }
  if (hour >= 17 && hour < 19) {
    return '傍晚好';
  }
  if (hour >= 19 && hour < 22) {
    return '晚上好';
  }
  return '夜深了';
}

const WEEKDAYS: string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 「11月16日 星期一」。 */
export function dateLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前。 */
export function relativeLabel(ts: number, now: number): string {
  if (ts <= 0) {
    return '尚未打开';
  }
  const diff = Math.max(0, now - ts);
  const minute: number = 60 * 1000;
  if (diff < minute) {
    return '刚刚';
  }
  if (diff < 60 * minute) {
    return `${Math.floor(diff / minute)} 分钟前`;
  }
  if (diff < 24 * 60 * minute) {
    return `${Math.floor(diff / (60 * minute))} 小时前`;
  }
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}
