/*
 * 玻璃卡片：整个主页所有卡片的唯一外壳。
 *
 * 视觉三件套在这里一次配齐：
 *   · 半透明底 backgroundColor(#1FFFFFFF/#2EFFFFFF)
 *   · backdropBlur → backgroundBlurStyle(dims.glassBlur)
 *   · 边缘高光描边 + 阴影（悬停加深）
 *
 * 交互也收在这里：按下缩 0.97、悬停抬 2vp，都用 springMotion 回弹，
 * 这样每个业务卡片不用各写一遍。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { curves } from '@kit.ArkUI';
import { HomeDims } from './HomeBreakpoints';
import { HomeTokens } from './HomeTokens';
import { HomePrefs, lightScale, scaleAlpha } from './HomePreferences';

@Component
export struct GlassCard {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  /** 断点变量：圆角、内边距、最小高度全从这里取。 */
  @Prop dims: HomeDims;
  /** 底色档位：plain / accent / danger。 */
  @Prop tone: string = 'plain';
  /** 是否响应点击（纯展示卡传 false）。 */
  @Prop interactive: boolean = true;

  @StorageProp(HomePrefs.LIGHT) light: number = 1;

  @State private pressed: boolean = false;
  @State private hovered: boolean = false;

  onTap: () => void = (): void => {};

  /** 卡片内容由调用方用尾随闭包给。 */
  @BuilderParam content: () => void = this.emptyContent;

  @Builder
  emptyContent() {
  }

  /** 底色：光感越强，同样的半透明白透出来的比例越高（只改 alpha，不换色）。 */
  private fill(): string {
    const k = 0.72 + 0.28 * lightScale(this.light);
    if (this.tone === 'accent') {
      return scaleAlpha(HomeTokens.accentGlass, k);
    }
    if (this.tone === 'danger') {
      return scaleAlpha(HomeTokens.dangerGlass, k);
    }
    return scaleAlpha(this.hovered ? HomeTokens.glassFillStrong : HomeTokens.glassFill, k);
  }

  private edge(): string {
    if (this.tone === 'accent') {
      return HomeTokens.accentEdge;
    }
    if (this.tone === 'danger') {
      return HomeTokens.dangerEdge;
    }
    return this.hovered ? HomeTokens.primary : HomeTokens.glassEdge;
  }

  private press(on: boolean): void {
    if (!this.interactive) {
      return;
    }
    this.getUIContext().animateTo({
      duration: on ? 110 : 260,
      curve: curves.springMotion(on ? 0.28 : 0.38, on ? 0.72 : 0.86)
    }, (): void => {
      this.pressed = on;
    });
  }

  build() {
    Column() {
      this.content()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(this.dims.cardPadding)
    .constraintSize({ minHeight: this.dims.cardMinHeight })
    .borderRadius(this.dims.radiusCard)
    // 半透明底：让光感背景从卡片下面透出来
    .backgroundColor(this.fill())
    // backdropBlur：模糊卡片「背后」的光斑与内容，玻璃质感来自这里
    .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: this.edge() })
    .shadow({
      radius: this.hovered ? 28 : 16,
      color: this.hovered ? HomeTokens.shadow : HomeTokens.shadowSoft,
      offsetX: 0,
      offsetY: this.hovered ? 16 : 8
    })
    .scale({ x: this.pressed ? 0.97 : 1, y: this.pressed ? 0.97 : 1 })
    .translate({ y: this.hovered && !this.pressed ? -2 : 0 })
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        this.press(true);
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.press(false);
      }
    })
    .onHover((on: boolean): void => {
      if (!this.interactive) {
        return;
      }
      this.getUIContext().animateTo({
        duration: 220,
        curve: curves.springMotion(0.38, 0.86)
      }, (): void => {
        this.hovered = on;
      });
    })
    .onClick((): void => {
      if (this.interactive) {
        this.onTap();
      }
    })
  }
}
