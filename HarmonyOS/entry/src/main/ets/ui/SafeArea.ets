/*
 * 安全区（避让区）探测与监听。
 *
 * 背景：EntryAbility 里调了 `setWindowLayoutFullScreen(true)` 做沉浸式，
 * 内容会铺到状态栏与底部导航条之下。**沉浸式必须配一个安全区消费者**，
 * 否则顶部文字被状态栏盖住、底部按钮与「小白条」重叠。
 *
 * 已对照 SDK 核实的 API（`@ohos.window.d.ts`）：
 *   - AvoidAreaType: TYPE_SYSTEM(0) 状态栏 / TYPE_CUTOUT(1) 挖孔 /
 *                    TYPE_SYSTEM_GESTURE(2) / TYPE_KEYBOARD(3) /
 *                    TYPE_NAVIGATION_INDICATOR(4) 导航条（底部小白条）
 *   - `Window.getWindowAvoidArea(type): Promise<AvoidArea>`
 *   - `AvoidArea { visible, leftRect, topRect, rightRect, bottomRect }`
 *   - `Rect { left, top, width, height }` —— 单位是 **px**
 *   - `window.on('avoidAreaChange', Callback<AvoidAreaOptions>)` 可在旋转/折叠/分屏时更新
 *
 * 注意 `windowSizeChange` 的回调只带 `Size`，**不含**避让区，必须单独查。
 *
 * 单位换算：避免区是 px，ArkUI 的 `Dimension` 数字默认是 vp。
 * 这里直接用 `UIContext.px2vp()`（与布局系统同一套换算），
 * 而不是反推 densityPixels —— 后者在高密度屏上会差 1~2 vp。
 */

import { window } from '@kit.ArkUI';
import { Logger } from '../engine/Logger';

const TAG = 'SafeArea';

/** 归一化后的安全区，单位 vp（可直接用于 padding）。 */
export class SafeAreaInsets {
  top: number = 0;
  bottom: number = 0;
  left: number = 0;
  right: number = 0;

  /** 是否与另一个实例数值相同（避免无谓的 UI 刷新）。 */
  equals(other: SafeAreaInsets): boolean {
    return this.top === other.top && this.bottom === other.bottom
      && this.left === other.left && this.right === other.right;
  }

  toString(): string {
    return `top=${this.top} bottom=${this.bottom} left=${this.left} right=${this.right}`;
  }
}

/**
 * 读取当前窗口的安全区（px -> vp）。
 */
export async function readSafeArea(win: window.Window,
                                  uiContext: UIContext): Promise<SafeAreaInsets> {
  const insets = new SafeAreaInsets();
  const toVp = (px: number): number => {
    if (!Number.isFinite(px) || px <= 0) {
      return 0;
    }
    try {
      return Math.round(uiContext.px2vp(px));
    } catch (err) {
      return 0;
    }
  };

  // 顶部：状态栏
  try {
    const top = await win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
    if (top !== undefined && top.visible) {
      insets.top = toVp(top.topRect.height);
    }
  } catch (err) {
    Logger.warn(TAG, '读取状态栏避让区失败（忽略）');
  }

  // 底部：导航条 / 手势条，也就是「小白条」
  try {
    const bottom = await win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
    if (bottom !== undefined && bottom.visible) {
      insets.bottom = toVp(bottom.bottomRect.height);
    }
  } catch (err) {
    Logger.warn(TAG, '读取导航条避让区失败（忽略）');
  }

  // 挖孔 / 刘海：横屏时表现为左右两侧，竖屏时可能体现在 topRect
  try {
    const cutout = await win.getWindowAvoidArea(window.AvoidAreaType.TYPE_CUTOUT);
    if (cutout !== undefined && cutout.visible) {
      insets.left = Math.max(insets.left, toVp(cutout.leftRect.width));
      insets.right = Math.max(insets.right, toVp(cutout.rightRect.width));
      insets.top = Math.max(insets.top, toVp(cutout.topRect.height));
    }
  } catch (err) {
    Logger.warn(TAG, '读取挖孔避让区失败（忽略）');
  }

  return insets;
}

/**
 * 监听安全区变化。
 *
 * 旋转、折叠、分屏、状态栏显隐都会改变避让区，所以要持续跟随，
 * 而不是只在启动时读一次。
 */
export class SafeAreaObserver {
  private readonly win: window.Window;
  private readonly uiContext: UIContext;
  private readonly onChanged: (insets: SafeAreaInsets) => void;
  private current: SafeAreaInsets = new SafeAreaInsets();
  private readonly handler: (options: window.AvoidAreaOptions) => void;
  private running: boolean = false;

  constructor(win: window.Window, uiContext: UIContext,
              onChanged: (insets: SafeAreaInsets) => void) {
    this.win = win;
    this.uiContext = uiContext;
    this.onChanged = onChanged;
    this.handler = (options: window.AvoidAreaOptions): void => {
      // 事件只说明「某一类避让区变了」，整体重读最省心也最不容易漏。
      this.refresh();
    };
  }

  /** 先读一次，再挂监听。 */
  async start(): Promise<void> {
    await this.refresh();
    if (this.running) {
      return;
    }
    try {
      this.win.on('avoidAreaChange', this.handler);
      this.running = true;
    } catch (err) {
      Logger.warn(TAG, '注册避让区监听失败（仅启动时读一次）');
    }
  }

  /** 重新读取并回调（数值无变化时不回调）。 */
  async refresh(): Promise<void> {
    const next = await readSafeArea(this.win, this.uiContext);
    if (next.equals(this.current)) {
      return;
    }
    this.current = next;
    Logger.info(TAG, `安全区更新：${next.toString()}`);
    this.onChanged(next);
  }

  get insets(): SafeAreaInsets {
    return this.current;
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    try {
      this.win.off('avoidAreaChange', this.handler);
    } catch (err) {
      Logger.warn(TAG, '取消避让区监听失败（忽略）');
    }
  }
}
