/*
 * 断点与设备形态适配（一次开发多端部署）。
 *
 * ⚠️ 当前 UI **不引用本文件**：入口页与所有组件统一消费 HomeBreakpoints 的
 * sm / md / lg（@ohos.mediaquery 监听）。这里的 LayoutObserver / LayoutSpec
 * 保留作历史实现，不要再把布局分支接回 deviceType 或 xl 五段断点。
 *
 * 官方约定（HarmonyOS 5.x/6.x）：
 *
 *   断点     宽度(vp)        典型形态
 *   XS       (0, 320)        折叠态外屏 / 穿戴
 *   SM       [320, 600)      直板手机
 *   MD       [600, 840)      折叠屏展开 / 手机横屏
 *   LG       [840, 1440)     平板
 *   XL       [1440, +∞)      PC / 2in1
 *
 * **布局必须由窗口宽度驱动，而不是折叠状态。** 官方明确不建议用
 * `display.on('foldStatusChange')` 来做响应式布局，因为「窗口变了但折叠状态没变」
 * （分屏、悬浮窗、2in1 自由窗口）时布局不会更新。折叠状态只用来决定
 * 「功能开关」（例如悬停态要不要分上下半屏）。
 *
 * 因此本文件：
 *   - 用 `uiContext.getWindowWidthBreakpoint()` 做一次主动校准；
 *   - 用 `window.on('windowSizeChange')` 做持续跟随；
 *   - 把结果归一化成自己的 `LayoutSpec`，供 UI 直接消费。
 */

import { window, display, mediaquery } from '@kit.ArkUI';
import { SafeAreaObserver, SafeAreaInsets } from './SafeArea';
import { Logger } from '../engine/Logger';

const TAG = 'Breakpoint';

/** 归一化的形态枚举。 */
export class FormFactor {
  static readonly PHONE: string = 'phone';
  static readonly FOLDABLE: string = 'foldable';
  static readonly TABLET: string = 'tablet';
  static readonly DESKTOP: string = 'desktop';
}

/**
 * 一个断点下的布局决策。UI 只读这些布尔/数值，不再自己判断宽度。
 */
export class LayoutSpec {
  /** 'xs' | 'sm' | 'md' | 'lg' | 'xl' */
  breakpoint: string = 'sm';
  /** 窗口宽度（vp）。 */
  widthVp: number = 360;
  /** 窗口高度（vp）。 */
  heightVp: number = 780;
  /** 形态：phone / foldable / tablet / desktop */
  form: string = FormFactor.PHONE;

  /** 是否采用双栏（左列表 + 右编辑）。 */
  get twoPane(): boolean {
    return this.widthVp >= 600;
  }

  /** 是否显示侧边导航栏（否则用底部 Tab）。 */
  get showSideNav(): boolean {
    return this.widthVp >= 600;
  }

  /** 字幕表格是否显示逐词列。 */
  get showWordColumn(): boolean {
    return this.widthVp >= 840;
  }

  /** 时间轴是否常驻显示（窄屏时收起到抽屉里）。 */
  get alwaysShowTimeline(): boolean {
    return this.heightVp >= 560 && this.widthVp >= 600;
  }

  /** 播放器区域建议高度（vp）。 */
  get playerHeight(): number {
    if (this.widthVp >= 1440) {
      return 420;
    }
    if (this.widthVp >= 840) {
      return 340;
    }
    if (this.widthVp >= 600) {
      return 260;
    }
    // 手机上按 16:9 估算，但不超过高度的 32%
    const byRatio = Math.round(this.widthVp * 9 / 16);
    return Math.max(160, Math.min(byRatio, Math.round(this.heightVp * 0.32)));
  }

  /** 侧栏宽度。 */
  get sideNavWidth(): number {
    return this.widthVp >= 1440 ? 300 : 260;
  }

  /** 内容最大宽度（超宽屏时居中，避免行太长）。 */
  get contentMaxWidth(): number {
    return this.widthVp >= 1440 ? 1280 : 100000;
  }

  /** 网格列数（项目卡片等）。 */
  get gridColumns(): number {
    if (this.widthVp >= 1440) {
      return 4;
    }
    if (this.widthVp >= 840) {
      return 3;
    }
    if (this.widthVp >= 600) {
      return 2;
    }
    return 1;
  }

  /** 字号缩放系数：平板/PC 上适当放大正文。 */
  get fontScale(): number {
    if (this.widthVp >= 1440) {
      return 1.15;
    }
    if (this.widthVp >= 840) {
      return 1.08;
    }
    return 1.0;
  }
}

/** 由宽度推导断点。 */
export function breakpointOf(widthVp: number): string {
  if (widthVp < 320) {
    return 'xs';
  }
  if (widthVp < 600) {
    return 'sm';
  }
  if (widthVp < 840) {
    return 'md';
  }
  if (widthVp < 1440) {
    return 'lg';
  }
  return 'xl';
}

/** 由断点 + 设备类型推导形态。 */
function formOf(breakpoint: string, deviceType: string): string {
  if (deviceType === '2in1') {
    return FormFactor.DESKTOP;
  }
  if (deviceType === 'tablet') {
    return breakpoint === 'xl' ? FormFactor.DESKTOP : FormFactor.TABLET;
  }
  // 折叠屏展开时 deviceType 仍报 phone（或 default），所以用断点判定。
  if (breakpoint === 'md' || breakpoint === 'lg') {
    return FormFactor.FOLDABLE;
  }
  return FormFactor.PHONE;
}

/**
 * 监听窗口尺寸并产出 `LayoutSpec`。
 *
 * 用法（在页面 aboutToAppear 里）：
 *   this.observer = new LayoutObserver(uiContext, (spec) => { this.spec = spec; });
 *   this.observer.start();
 * 并在 aboutToDisappear 里 `this.observer.stop()`。
 */
export class LayoutObserver {
  private win: window.Window | null = null;
  private readonly uiContext: UIContext;
  private readonly onChanged: (spec: LayoutSpec) => void;
  private readonly deviceType: string;

  /** 安全区变化回调（可选）。沉浸式窗口必须有人消费安全区，否则内容被状态栏遮挡。 */
  private readonly onSafeArea: ((insets: SafeAreaInsets) => void) | null;
  private safeArea: SafeAreaObserver | null = null;
  private running: boolean = false;
  private foldStatus: number = -1;
  private readonly sizeHandler: (size: window.Size) => void;

  constructor(uiContext: UIContext, deviceType: string, 
              onChanged: (spec: LayoutSpec) => void,
              onSafeArea?: (insets: SafeAreaInsets) => void) {
    this.uiContext = uiContext;
    this.deviceType = deviceType;

    this.onChanged = onChanged;
    this.onSafeArea = onSafeArea ?? null;
    this.sizeHandler = (size: window.Size): void => {
      this.publish(size.width, size.height);
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const win = await window.getLastWindow(this.uiContext.getHostContext()!);
      this.win = win;
      const props = win.getWindowProperties();
      this.publish(props.windowRect.width, props.windowRect.height);
      win.on('windowSizeChange', this.sizeHandler);
      Logger.info(TAG, `窗口监听已启动（${this.deviceType}）`);

      // 沉浸式窗口必须消费安全区：状态栏（顶部）与导航条（底部小白条）。
      if (this.onSafeArea !== null) {
        const cb = this.onSafeArea;
        const observer = new SafeAreaObserver(win, this.uiContext,
          (insets: SafeAreaInsets): void => cb(insets));
        this.safeArea = observer;
        await observer.start();
      }
    } catch (err) {
      const e = err as Error;
      Logger.warn(TAG, `窗口监听启动失败，使用默认断点：${e.message}`);
      // 兜底：用媒体查询拿一次宽度。
      this.publishFromMediaQuery();
    }
    this.watchFoldStatus();
  }

  /** 重新读取安全区（例如从后台回到前台、或用户改了系统栏设置）。 */
  async refreshSafeArea(): Promise<void> {
    const sa = this.safeArea;
    if (sa !== null) {
      await sa.refresh();
    }
  }

  /**
   * 折叠状态只用于**功能开关**，不参与布局；这里仅记录一次，便于 UI 做悬停态处理。
   *
   * 注意：Display 对象上**没有** foldStatus 属性，官方提供的是
   * display.getFoldStatus() 函数（以及 display.on('foldStatusChange') 事件）。
   * 再次强调：折叠状态不能用来驱动响应式布局，官方明确不推荐。
   */
  private watchFoldStatus(): void {
    try {
      this.foldStatus = display.getFoldStatus();
    } catch (err) {
      this.foldStatus = -1;
    }
  }

  /** 当前折叠状态（-1 表示设备不支持/未知）。 */
  currentFoldStatus(): number {
    return this.foldStatus;
  }

  private publishFromMediaQuery(): void {
    let spec = new LayoutSpec();
    try {
      const listener = mediaquery.matchMediaSync('(width>=600vp)');
      const wide = listener.matches;
      spec.widthVp = wide ? 840 : 360;
    } catch (err) {
      Logger.warn(TAG, 'mediaquery 也不可用，按手机布局');
    }
    spec.breakpoint = breakpointOf(spec.widthVp);
    spec.form = formOf(spec.breakpoint, this.deviceType);
    this.onChanged(spec);
  }

  private publish(widthPx: number, heightPx: number): void {
    // windowSizeChange 给的是 px，需要换算成 vp。
    const density = getDensity(this.uiContext);
    const widthVp = density > 0 ? widthPx / density : widthPx;
    const heightVp = density > 0 ? heightPx / density : heightPx;
    const spec = new LayoutSpec();
    spec.widthVp = Math.round(widthVp);
    spec.heightVp = Math.round(heightVp);
    spec.breakpoint = breakpointOf(spec.widthVp);
    spec.form = formOf(spec.breakpoint, this.deviceType);
    this.onChanged(spec);
  }

  stop(): void {
    const sa = this.safeArea;
    this.safeArea = null;
    if (sa !== null) {
      sa.stop();
    }
    const win = this.win;
    this.win = null;
    this.running = false;
    if (win !== null) {
      try {
        win.off('windowSizeChange', this.sizeHandler);
      } catch (err) {
        Logger.warn(TAG, '取消窗口监听失败（忽略）');
      }
    }
  }
}

/** 取屏幕密度（px -> vp 的除数）。 */
function getDensity(uiContext: UIContext): number {
  try {
    const host = uiContext.getHostContext();
    if (host !== undefined && host !== null) {
      const d = display.getDefaultDisplaySync();
      const density = d.densityPixels;
      if (density > 0) {
        return density;
      }
    }
  } catch (err) {
    // 忽略，退化到 1:1
  }
  return 1;
}
