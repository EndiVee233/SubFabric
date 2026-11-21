/*
 * 应用外观落地：把 AppearancePrefs.MODE 解析成实际的浅/深色。
 *
 * 只改 AppStorage 不够：HdsTabs 的 IMMERSIVE 材质、系统对话框、状态栏图标都跟
 * 应用/系统 ColorMode 走。因此这里同时做三件事：
 *   1. 写 appearance.effectiveLight（HomeTokens 和组件重建读它）
 *   2. getApplicationContext().setColorMode(...)（原生控件/材质跟主题）
 *   3. 更新状态栏/导航条图标颜色（浅色背景用深色图标）
 */

import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { AppearancePrefs, setEffectiveLight } from '../ui/settings/AppearancePrefs';
import { Logger } from '../engine/Logger';

const TAG = 'ThemeManager';

/** light / dark 直接决定；system 读当前 Ability 配置。 */
export function resolveLight(context: common.UIAbilityContext, mode: string): boolean {
  if (mode === 'light') {
    return true;
  }
  if (mode === 'dark') {
    return false;
  }
  const systemLight = AppStorage.get<boolean>(AppearancePrefs.SYSTEM_LIGHT);
  if (systemLight !== undefined) {
    return systemLight;
  }
  try {
    return context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  } catch (err) {
    return false;
  }
}

function colorModeOf(mode: string): ConfigurationConstant.ColorMode {
  if (mode === 'light') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  }
  if (mode === 'dark') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  return ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
}

/** 设置应用级 ColorMode，并同步 effectiveLight。返回是否浅色。 */
export function applyColorMode(context: common.UIAbilityContext, mode: string): boolean {
  const light = resolveLight(context, mode);
  setEffectiveLight(light);
  try {
    context.getApplicationContext().setColorMode(colorModeOf(mode));
  } catch (err) {
    Logger.warn(TAG, '设置应用 ColorMode 失败（忽略）');
  }
  return light;
}

/** 系统栏透明，只换图标颜色：浅色背景用深色图标。 */
export function applySystemBars(context: common.UIAbilityContext, light: boolean): void {
  window.getLastWindow(context).then((win: window.Window) => {
    return win.setWindowSystemBarProperties({
      statusBarColor: '#00000000',
      navigationBarColor: '#00000000',
      statusBarContentColor: light ? '#000000' : '#FFFFFF',
      navigationBarContentColor: light ? '#000000' : '#FFFFFF'
    });
  }).catch((err: BusinessError) => {
    Logger.warn(TAG, `更新系统栏颜色失败（忽略）：${err.message}`);
  });
}

/** 设置页切换明暗时调用：应用 ColorMode + AppStorage + 系统栏一起更新。 */
export function applyTheme(context: common.UIAbilityContext, mode: string): void {
  const light = applyColorMode(context, mode);
  applySystemBars(context, light);
  Logger.info(TAG, `外观已切换：${mode}${light ? '（浅色）' : '（深色）'}`);
}

/** 启动/系统配置变化时用：没有窗口时只改 AppStorage 和 ColorMode。 */
export function applyThemeSilently(context: common.UIAbilityContext, mode: string): void {
  applyColorMode(context, mode);
}
