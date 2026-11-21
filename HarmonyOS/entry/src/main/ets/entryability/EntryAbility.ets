/*
 * 应用入口 Ability。
 *
 * 职责：
 *   1. 选择主窗口的布局断点（一多适配的起点）；
 *   2. 初始化 AppStore（目录、NPU 探测、设置、项目索引）；
 *   3. 保存/恢复状态。
 */

import { AbilityConstant, ConfigurationConstant, UIAbility, Want, Configuration } from '@kit.AbilityKit';
import { window, display } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { AppStore } from '../store/AppStore';
import { Logger } from '../engine/Logger';
import { AppearancePrefs } from '../ui/settings/AppearancePrefs';
import { applyColorMode, applySystemBars } from '../platform/ThemeManager';

const TAG = 'EntryAbility';

/** 全局唯一的应用状态实例，页面通过 AppStorage 取到。 */
export const STORE_KEY: string = 'appStore';

export default class EntryAbility extends UIAbility {
  private store: AppStore = new AppStore();

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    Logger.info(TAG, 'onCreate');
    // 记录系统明暗（此时应用还没套用 light/dark 覆盖），供“跟随系统”解析。
    try {
      AppStorage.setOrCreate<boolean>(AppearancePrefs.SYSTEM_LIGHT,
        this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
    } catch (err) {
      AppStorage.setOrCreate<boolean>(AppearancePrefs.SYSTEM_LIGHT, false);
    }
    // PersistentStorage 必须在 UI 实例（loadContent 回调）之后初始化；
    // 外观恢复统一放到 Index.aboutToAppear，避免过早调用把上次的浅色覆盖成默认深色。
    AppStorage.setOrCreate<AppStore>(STORE_KEY, this.store);
    // 初始化是异步的；页面侧会 await store.init()，这里先启动不阻塞 UI。
    this.store.init(this.context).catch((err: BusinessError) => {
      Logger.error(TAG, `初始化失败：${err.message}`);
    });
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    Logger.info(TAG, 'onWindowStageCreate');
    windowStage.loadContent('pages/Index', (err: BusinessError) => {
      if (err.code !== 0) {
        Logger.error(TAG, `加载首页失败：${err.code} ${err.message}`);
        return;
      }
      Logger.info(TAG, '首页已加载');
    });

    // 沉浸光感的前提：内容铺到状态栏/导航栏之下，并且系统栏本身透明。
    // 少任何一步都会「光只在内容矩形里」，状态栏那条深色带会切断画面。
    try {
      const win = windowStage.getMainWindowSync();

      win.setWindowLayoutFullScreen(true).then(() => {
        // 2in1 没有系统状态栏/导航条，这套属性在它上面不可用，直接跳过
        if (this.deviceType() === '2in1') {
          return;
        }
        // 系统栏透明 + 图标颜色跟随当前明暗（浅色背景必须用深色图标）
        const light = AppStorage.get<boolean>(AppearancePrefs.EFFECTIVE_LIGHT) ?? false;
        return win.setWindowSystemBarProperties({
          statusBarColor: '#00000000',
          navigationBarColor: '#00000000',
          statusBarContentColor: light ? '#000000' : '#FFFFFF',
          navigationBarContentColor: light ? '#000000' : '#FFFFFF'
        });
      }).then(() => {
        // 把安全区高度交给页面消费：背景自己 expandSafeArea，内容按这个下移
        this.publishInsets(win);
      }).catch((e: BusinessError) => {
        Logger.warn(TAG, `设置沉浸式失败（可忽略）：${e.message}`);
      });
    } catch (err) {
      Logger.warn(TAG, '获取主窗口失败（可忽略）');
    }
  }

  private deviceType(): string {
    try {
      return deviceInfo.deviceType;
    } catch (err) {
      return 'phone';
    }
  }

  /** 跟随系统模式时，系统深浅色变化要重新解析并刷新系统栏。 */
  onConfigurationUpdate(newConfig: Configuration): void {
    try {
      AppStorage.setOrCreate<boolean>(AppearancePrefs.SYSTEM_LIGHT,
        newConfig.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
    } catch (err) {
      // 忽略
    }
    const mode = AppStorage.get<string>(AppearancePrefs.MODE) ?? 'dark';
    if (mode !== 'system') {
      return;
    }
    const light = applyColorMode(this.context, 'system');
    applySystemBars(this.context, light);
  }

  /** 读取状态栏与导航条占位，换算成 vp 放进 AppStorage。 */
  private publishInsets(win: window.Window): void {
    try {
      const density = display.getDefaultDisplaySync().densityPixels;
      const scale = density > 0 ? density : 1;
      const top = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height;
      const bottom = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR).bottomRect.height;
      AppStorage.setOrCreate('statusBarHeight', top / scale);
      AppStorage.setOrCreate('navIndicatorHeight', bottom / scale);
      Logger.info(TAG, `安全区：状态栏 ${(top / scale).toFixed(1)}vp，导航条 ${(bottom / scale).toFixed(1)}vp`);
    } catch (err) {
      Logger.warn(TAG, '读取安全区失败（按 0 处理）');
      AppStorage.setOrCreate('statusBarHeight', 0);
      AppStorage.setOrCreate('navIndicatorHeight', 0);
    }
  }

  onWindowStageDestroy(): void {
    Logger.info(TAG, 'onWindowStageDestroy');
  }

  onForeground(): void {
    Logger.info(TAG, 'onForeground');
  }

  onBackground(): void {
    // 保存一次，避免进程被回收时丢失编辑内容。
    Logger.info(TAG, 'onBackground：保存当前项目');
    this.store.saveCurrent().catch((err: BusinessError) => {
      Logger.warn(TAG, `后台保存失败：${err.message}`);
    });
    this.store.saveSettings();
  }

  onDestroy(): void {
    Logger.info(TAG, 'onDestroy');
    this.store.releaseEngine().catch((err: BusinessError) => {
      Logger.warn(TAG, `释放引擎失败：${err.message}`);
    });
  }
}
