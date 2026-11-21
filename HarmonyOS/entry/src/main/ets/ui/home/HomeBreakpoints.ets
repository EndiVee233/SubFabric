/*
 * 断点与断点变量。
 *
 * 用 @ohos.mediaquery 监听 sm / md / lg 三段，**不用设备类型、折叠状态，也不读一次
 * 窗口宽度就算了**：分屏、悬浮窗、2in1 拖拽改宽都会触发 mediaquery 的 change 回调，
 * 布局跟着窗口宽度走。
 *
 * 所有尺寸都从这里取（HomeDims），组件里不写死数字，也不按 deviceType 分支：
 *   sm  (< 600vp)   手机 / 折叠屏折叠态      窄布局
 *   md  [600,840)   折叠屏展开 / 手机横屏    双列
 *   lg  (>= 840vp)  平板 / 2in1 / 宽窗口     宽布局
 */

import mediaquery from '@ohos.mediaquery';
import { Logger } from '../../engine/Logger';

const TAG = 'HomeBp';

/** 断点常量，避免各处的裸字符串写错。 */
export class Bp {
  static readonly SM: string = 'sm';
  static readonly MD: string = 'md';
  static readonly LG: string = 'lg';
}

/** 由窗口宽度归一到 sm / md / lg；所有页面和组件共用这一处阈值。 */
export function breakpointOfWidth(widthVp: number): string {
  if (widthVp >= 840) {
    return Bp.LG;
  }
  if (widthVp >= 600) {
    return Bp.MD;
  }
  return Bp.SM;
}

/**
 * 一个断点下的全部尺寸。
 *
 * 这些都是「断点变量」：组件只读 HomeDims 的字段，不自己乘系数、不自己判断宽度。
 */
export class HomeDims {
  readonly bp: string;
  /** 当前窗口宽度（vp）：胶囊定位、侧栏宽度这类比例计算要用。 */
  readonly widthVp: number;

  /** 是否左右双栏（Navigation Split）。 */
  readonly twoPane: boolean;
  /** 左栏（导航）宽度。 */
  readonly navBarWidth: number;
  /** 右栏最小内容宽度。 */
  readonly minContentWidth: number;

  /** 页面留白。 */
  readonly pagePaddingH: number;
  readonly pagePaddingTop: number;
  readonly pagePaddingBottom: number;

  /** 栅格间距。 */
  readonly gap: number;
  readonly rowGap: number;

  /** 圆角。 */
  readonly radiusCard: number;
  readonly radiusInner: number;
  readonly radiusPill: number;

  /** 卡片。 */
  readonly cardPadding: number;
  readonly cardMinHeight: number;
  readonly quickColumns: number;

  /** 最近稿件：一行几张由这个基础宽度决定（Flex 换行）。 */
  readonly recentItemBasis: string;

  /** hero。 */
  readonly flowerSize: number;
  readonly heroStack: boolean;

  /** 字号。 */
  readonly titleSize: number;
  readonly bigNumberSize: number;
  readonly bodySize: number;
  readonly labelSize: number;
  readonly miniSize: number;

  /** 按钮。 */
  /** 底部导航栏占位高度（内容要给它让出空间）。 */
  readonly navBarHeight: number;
  /** Hero 右侧竖排按钮的固定宽度，保证两枚等宽对齐。 */
  readonly heroButtonWidth: number;
  readonly buttonHeight: number;
  readonly buttonPaddingH: number;
  readonly buttonPaddingX: number;

  /** 玻璃模糊档位（0 = 不模糊，低端机可整体调低）。 */
  readonly glassBlur: BlurStyle;

  constructor(bp: string, widthVp: number = 360, compact: number = 1) {
    this.bp = bp;
    this.widthVp = widthVp;
    if (bp === Bp.LG) {
      this.twoPane = true;
      this.navBarWidth = 460;
      this.minContentWidth = 520;

      this.pagePaddingH = 30;
      this.pagePaddingTop = 26;
      this.pagePaddingBottom = 34;

      this.gap = 18;
      this.rowGap = 22;

      this.radiusCard = 30;
      this.radiusInner = 22;
      this.radiusPill = 999;

      this.cardPadding = 24;
      this.cardMinHeight = 148;
      this.quickColumns = 2;
      this.recentItemBasis = '47%';

      this.flowerSize = 136;
      this.heroStack = false;

      this.titleSize = 24;
      this.bigNumberSize = 42;
      this.bodySize = 16;
      this.labelSize = 13;
      this.miniSize = 12;

      this.navBarHeight = 80;
      this.heroButtonWidth = 136;
      this.buttonHeight = 48;
      this.buttonPaddingH = 20;
      this.buttonPaddingX = 20;
      this.glassBlur = BlurStyle.COMPONENT_THICK;
    } else if (bp === Bp.MD) {
      this.twoPane = true;
      this.navBarWidth = 360;
      this.minContentWidth = 380;

      this.pagePaddingH = 24;
      this.pagePaddingTop = 20;
      this.pagePaddingBottom = 28;

      this.gap = 14;
      this.rowGap = 18;

      this.radiusCard = 26;
      this.radiusInner = 18;
      this.radiusPill = 999;

      this.cardPadding = 18;
      this.cardMinHeight = 124;
      this.quickColumns = 2;
      this.recentItemBasis = '47%';

      this.flowerSize = 114;
      this.heroStack = false;

      this.titleSize = 21;
      this.bigNumberSize = 34;
      this.bodySize = 14;
      this.labelSize = 12;
      this.miniSize = 11;

      this.navBarHeight = 72;
      this.heroButtonWidth = 120;
      this.buttonHeight = 44;
      this.buttonPaddingH = 16;
      this.buttonPaddingX = 16;
      this.glassBlur = BlurStyle.COMPONENT_THICK;
    } else {
      this.twoPane = false;
      this.navBarWidth = 0;
      this.minContentWidth = 360;

      this.pagePaddingH = 16;
      this.pagePaddingTop = 12;
      this.pagePaddingBottom = 20;

      this.gap = 10;
      this.rowGap = 14;

      this.radiusCard = 22;
      this.radiusInner = 16;
      this.radiusPill = 999;

      this.cardPadding = 12;
      this.cardMinHeight = 100;
      this.quickColumns = 2;
      this.recentItemBasis = '47%';

      this.flowerSize = 96;
      this.heroStack = true;

      this.titleSize = 16;
      this.bigNumberSize = 26;
      this.bodySize = 12;
      this.labelSize = 10;
      this.miniSize = 9;

      this.buttonHeight = 38;
      this.navBarHeight = 62;
      this.heroButtonWidth = 104;
      this.buttonPaddingX = 12;
      this.buttonPaddingH = 12;
      this.glassBlur = BlurStyle.COMPONENT_REGULAR;
    }

    // lg 宽屏侧栏展开时：内容区宽度已经变窄，再把留白/间距/卡片内边距轻收一档，
    // 让卡片、圆角和元素间距一起缩小，而不是只把右边缘裁掉。
    if (compact > 0 && compact !== 1) {
      this.pagePaddingH = Math.max(10, Math.round(this.pagePaddingH * compact));
      this.pagePaddingTop = Math.max(8, Math.round(this.pagePaddingTop * compact));
      this.pagePaddingBottom = Math.max(10, Math.round(this.pagePaddingBottom * compact));
      this.gap = Math.max(8, Math.round(this.gap * compact));
      this.rowGap = Math.max(10, Math.round(this.rowGap * compact));
      this.cardPadding = Math.max(10, Math.round(this.cardPadding * compact));
      this.cardMinHeight = Math.max(80, Math.round(this.cardMinHeight * compact));
      this.radiusCard = Math.max(14, Math.round(this.radiusCard * compact));
      this.radiusInner = Math.max(10, Math.round(this.radiusInner * compact));
    }
  }

  /** 按断点名取一套变量。 */
  static of(bp: string, widthVp: number = 360, compact: number = 1): HomeDims {
    return new HomeDims(bp, widthVp, compact);
  }

  /** 最近稿件：一行几张（与 quickColumns 同一套判断依据）。 */
  get recentColumns(): number {
    return this.twoPane ? 2 : 1;
  }
}

/**
 * 用 @ohos.mediaquery 的 MediaQueryListener 监听 sm / md / lg 三段断点。
 *
 * 用法（页面 aboutToAppear）：
 *   this.watcher = new BreakpointObserver(this.getUIContext(), (bp) => { this.bp = bp; });
 *   this.watcher.start();
 * 离开时 stop()，否则 mediaquery 的监听会一直挂在进程上。
 */
export class BreakpointObserver {
  private readonly uiContext: UIContext;
  private readonly onChange: (bp: string) => void;
  private sm: mediaquery.MediaQueryListener | null = null;
  private md: mediaquery.MediaQueryListener | null = null;
  private lg: mediaquery.MediaQueryListener | null = null;
  private current: string = '';
  private readonly handle: (result: mediaquery.MediaQueryResult) => void;

  constructor(uiContext: UIContext, onChange: (bp: string) => void) {
    this.uiContext = uiContext;
    this.onChange = onChange;
    // 三个监听共用一个回调：谁变化都重新判一次，避免重复派发。
    this.handle = (result: mediaquery.MediaQueryResult): void => {
      const next = this.detect();
      if (next !== this.current) {
        this.current = next;
        this.onChange(next);
      }
    };
  }

  start(): void {
    try {
      // 用 UIContext 上的 MediaQuery 实例：同样是 @ohos.mediaquery 的 MediaQueryListener，
      // 但走的是未废弃入口，且与当前 UI 实例绑定（多窗口时不会串）。
      const mq = this.uiContext.getMediaQuery();
      this.sm = mq.matchMediaSync('(width<600vp)');
      this.md = mq.matchMediaSync('(width>=600vp) and (width<840vp)');
      this.lg = mq.matchMediaSync('(width>=840vp)');
      this.sm.on('change', this.handle);
      this.md.on('change', this.handle);
      this.lg.on('change', this.handle);
      this.current = this.detect();
      this.onChange(this.current);
      Logger.info(TAG, `断点监听已启动：${this.current}`);
    } catch (err) {
      const e = err as Error;
      Logger.warn(TAG, `mediaquery 不可用，退回 sm：${e.message}`);
      this.current = Bp.SM;
      this.onChange(Bp.SM);
    }
  }

  stop(): void {
    try {
      if (this.sm !== null) {
        this.sm.off('change', this.handle);
      }
      if (this.md !== null) {
        this.md.off('change', this.handle);
      }
      if (this.lg !== null) {
        this.lg.off('change', this.handle);
      }
    } catch (err) {
      Logger.warn(TAG, '取消断点监听失败（忽略）');
    }
    this.sm = null;
    this.md = null;
    this.lg = null;
  }

  /** 当前断点。 */
  value(): string {
    return this.current.length > 0 ? this.current : Bp.SM;
  }

  private detect(): string {
    if (this.lg !== null && this.lg.matches) {
      return Bp.LG;
    }
    if (this.md !== null && this.md.matches) {
      return Bp.MD;
    }
    return Bp.SM;
  }
}
