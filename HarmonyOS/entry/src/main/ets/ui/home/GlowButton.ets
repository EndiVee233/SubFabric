/*
 * 光晕按钮：主页上所有按钮都用它。
 *
 * 「光晕」= 主色在按钮外侧散开的一圈影子（shadow 用带 alpha 的主色），
 * 按下时光晕收紧、按钮缩一点，抬起回弹，和 GlassCard 用同一组弹簧参数。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { curves } from '@kit.ArkUI';
import { HomeDims } from './HomeBreakpoints';
import { HomeTokens } from './HomeTokens';

@Component
export struct GlowButton {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop label: string = '';
  /** 前置字形（这里不引图标资源，用少量符号，避免额外依赖）。 */
  @Prop glyph: string = '';
  @Prop dims: HomeDims;
  /** true = 主色实心（页面唯一主操作），false = 玻璃描边。 */
  @Prop accent: boolean = false;

  @State private pressed: boolean = false;
  @State private hovered: boolean = false;

  onTap: () => void = (): void => {};

  private press(on: boolean): void {
    this.getUIContext().animateTo({
      duration: on ? 100 : 240,
      curve: curves.springMotion(on ? 0.26 : 0.38, on ? 0.7 : 0.86)
    }, (): void => {
      this.pressed = on;
    });
  }

  build() {
    Row({ space: 6 }) {
      if (this.glyph.length > 0) {
        Text(this.glyph)
          .fontSize(this.dims.bodySize)
          .fontColor(this.accent ? HomeTokens.onPrimary : HomeTokens.primary)
      }
      Text(this.label)
        .fontSize(this.dims.bodySize)
        .fontWeight(this.accent ? FontWeight.Medium : FontWeight.Regular)
        .fontColor(this.accent ? HomeTokens.onPrimary : HomeTokens.text)
        .maxLines(1)
    }
    .height(this.dims.buttonHeight)
    .padding({ left: this.dims.buttonPaddingH, right: this.dims.buttonPaddingH })
    .borderRadius(this.dims.radiusPill)
    .backgroundColor(this.accent ? HomeTokens.primary : HomeTokens.glassFillStrong)
    .backgroundBlurStyle(this.accent ? BlurStyle.NONE : this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({
      width: 1,
      color: this.accent ? '#00000000' : (this.hovered ? HomeTokens.primary : HomeTokens.glassEdge)
    })
    // 光晕：主色 alpha 影子；悬停时更大更亮
    .shadow({
      radius: this.pressed ? 10 : (this.hovered ? 26 : 18),
      color: this.accent ? HomeTokens.primaryGlow : HomeTokens.buttonShadow,
      offsetX: 0,
      offsetY: this.pressed ? 3 : 8
    })
    .scale({ x: this.pressed ? 0.96 : 1, y: this.pressed ? 0.96 : 1 })
    .translate({ y: this.hovered && !this.pressed ? -1 : 0 })
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        this.press(true);
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.press(false);
      }
    })
    .onHover((on: boolean): void => {
      this.getUIContext().animateTo({
        duration: 200,
        curve: curves.springMotion(0.38, 0.86)
      }, (): void => {
        this.hovered = on;
      });
    })
    .onClick((): void => {
      this.onTap();
    })
  }
}
