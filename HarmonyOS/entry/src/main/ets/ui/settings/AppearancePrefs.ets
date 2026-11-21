/*
 * 外观与体验偏好（AppStorage）。
 *
 * 与电脑端「外观与体验」对齐：背景材质、流光色彩/效果、明暗模式、动效、
 * 毛玻璃三档滑杆、主题包与主题色。HarmonyOS 端实际驱动 ImmersiveBackground；
 * 浅色主题与主题包文件暂未迁移，界面里会明确说明。
 */

export class AppearancePrefs {
  static readonly BACKGROUND: string = 'appearance.background';   // solid / aurora / image
  static readonly PALETTE: string = 'appearance.palette';         // theme / sage / ocean / sunset / custom
  static readonly COLOR1: string = 'appearance.color1';
  static readonly COLOR2: string = 'appearance.color2';
  static readonly COLOR3: string = 'appearance.color3';
  /** 流光呼吸速度：slow / normal / fast。 */
  static readonly SPEED: string = 'appearance.speed';
  static readonly MOTION: string = 'appearance.motion';           // dynamic / static
  static readonly REDUCE_MOTION: string = 'appearance.reduceMotion';
  static readonly MODE: string = 'appearance.mode';               // light / dark / system
  /** 解析后的实际明暗：由 ThemeManager 在启动/切换/系统配置变化时写入。 */
  static readonly EFFECTIVE_LIGHT: string = 'appearance.effectiveLight';
  /** 系统本身的明暗（不受应用 setColorMode 覆盖影响），供“跟随系统”使用。 */
  static readonly SYSTEM_LIGHT: string = 'appearance.systemLight';
  static readonly GLASS_DIM: string = 'appearance.glassDim';
  static readonly GLASS_BLUR: string = 'appearance.glassBlur';
  static readonly GLASS_OPACITY: string = 'appearance.glassOpacity';
  static readonly ACCENT: string = 'appearance.accent';
  static readonly IMAGE: string = 'appearance.imagePath';
}

const DEFAULT_ACCENT: string = '#8FBAFF';
const DEFAULT_COLOR1: string = '#8FBAFF';
const DEFAULT_COLOR2: string = '#C9BDFF';
const DEFAULT_COLOR3: string = '#5F8FDF';

/** 首次启动写入外观默认值；已有用户值不覆盖。 */
export function ensureAppearanceDefaults(): void {
  PersistentStorage.persistProp<string>(AppearancePrefs.BACKGROUND, 'aurora');
  PersistentStorage.persistProp<string>(AppearancePrefs.PALETTE, 'theme');
  PersistentStorage.persistProp<string>(AppearancePrefs.COLOR1, DEFAULT_COLOR1);
  PersistentStorage.persistProp<string>(AppearancePrefs.COLOR2, DEFAULT_COLOR2);
  PersistentStorage.persistProp<string>(AppearancePrefs.COLOR3, DEFAULT_COLOR3);
  PersistentStorage.persistProp<string>(AppearancePrefs.SPEED, 'normal');
  PersistentStorage.persistProp<string>(AppearancePrefs.MOTION, 'dynamic');
  PersistentStorage.persistProp<boolean>(AppearancePrefs.REDUCE_MOTION, false);
  PersistentStorage.persistProp<string>(AppearancePrefs.MODE, 'dark');
  PersistentStorage.persistProp<number>(AppearancePrefs.GLASS_DIM, 80);
  PersistentStorage.persistProp<number>(AppearancePrefs.GLASS_BLUR, 18);
  PersistentStorage.persistProp<number>(AppearancePrefs.GLASS_OPACITY, 100);
  PersistentStorage.persistProp<string>(AppearancePrefs.ACCENT, DEFAULT_ACCENT);
  PersistentStorage.persistProp<string>(AppearancePrefs.IMAGE, '');
}

/** 当前是否浅色：优先读解析后的值；旧安装没有该值时按 mode 兜底。 */
export function isLightNow(): boolean {
  const effective = AppStorage.get<boolean>(AppearancePrefs.EFFECTIVE_LIGHT);
  if (effective !== undefined) {
    return effective;
  }
  return AppStorage.get<string>(AppearancePrefs.MODE) === 'light';
}

/** 由 ThemeManager 写入解析结果；HomeTokens 和所有订阅组件读同一份值。 */
export function setEffectiveLight(light: boolean): void {
  AppStorage.setOrCreate<boolean>(AppearancePrefs.EFFECTIVE_LIGHT, light);
}

/** 只接受 #RRGGBB，#AARRGGBB 也允许；非法值回退。 */export function safeHex(value: string, fallback: string): string {
  const text: string = value.trim();
  if (text.length === 7 && text.startsWith('#')) {
    return text.toUpperCase();
  }
  if (text.length === 9 && text.startsWith('#')) {
    return text.toUpperCase();
  }
  return fallback;
}

/** #RRGGBB + AA → #AARRGGBB。 */
export function withAlpha(hex: string, alpha: string): string {
  const color: string = safeHex(hex, DEFAULT_ACCENT);
  const rgb: string = color.length === 9 ? color.slice(3) : color.slice(1);
  return `#${alpha}${rgb}`.toUpperCase();
}

/** 流光配色。 */
export function paletteColors(mode: string, accent: string,
                              color1: string, color2: string, color3: string): string[] {
  if (mode === 'sage') {
    return ['#5C7560', '#8FD5A6', '#B8E0C2'];
  }
  if (mode === 'ocean') {
    return ['#4C8DFF', '#7FD3E8', '#B3E8F5'];
  }
  if (mode === 'sunset') {
    return ['#FF7A45', '#FFB37A', '#FFD9A0'];
  }
  if (mode === 'custom') {
    return [safeHex(color1, DEFAULT_COLOR1), safeHex(color2, DEFAULT_COLOR2),
      safeHex(color3, DEFAULT_COLOR3)];
  }
  return [safeHex(accent, DEFAULT_ACCENT), '#C9BDFF', '#5F8FDF'];
}

/** 恢复默认外观（不含主题包文件）。 */
export function resetAppearance(): void {
  AppStorage.setOrCreate<string>(AppearancePrefs.BACKGROUND, 'aurora');
  AppStorage.setOrCreate<string>(AppearancePrefs.PALETTE, 'theme');
  AppStorage.setOrCreate<string>(AppearancePrefs.COLOR1, DEFAULT_COLOR1);
  AppStorage.setOrCreate<string>(AppearancePrefs.COLOR2, DEFAULT_COLOR2);
  AppStorage.setOrCreate<string>(AppearancePrefs.COLOR3, DEFAULT_COLOR3);
  AppStorage.setOrCreate<string>(AppearancePrefs.SPEED, 'normal');
  AppStorage.setOrCreate<string>(AppearancePrefs.MOTION, 'dynamic');
  AppStorage.setOrCreate<boolean>(AppearancePrefs.REDUCE_MOTION, false);
  AppStorage.setOrCreate<string>(AppearancePrefs.MODE, 'dark');
  AppStorage.setOrCreate<boolean>(AppearancePrefs.EFFECTIVE_LIGHT, false);
  AppStorage.setOrCreate<number>(AppearancePrefs.GLASS_DIM, 80);
  AppStorage.setOrCreate<number>(AppearancePrefs.GLASS_BLUR, 18);
  AppStorage.setOrCreate<number>(AppearancePrefs.GLASS_OPACITY, 100);
  AppStorage.setOrCreate<string>(AppearancePrefs.ACCENT, DEFAULT_ACCENT);
  AppStorage.setOrCreate<string>(AppearancePrefs.IMAGE, '');
}
