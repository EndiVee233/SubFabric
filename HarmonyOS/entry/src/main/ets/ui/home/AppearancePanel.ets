/*
 * 外观与握姿面板：光感强度三档 + 握姿三档。
 *
 * 改完立刻生效：背景、卡片透光、导航栏都读同一份 AppStorage 值，这里写进去就完了。
 *
 * ⚠ 踩过的坑：一开始把 `tap: () => void` 当 @Builder 的参数传，结果点上去毫无反应
 * （按钮在真机上不响应，但页面里其它按钮正常）。改成「只传档位值、闭包写在 Builder 内部」，
 * 点击就正常了。@Builder 的参数适合传值，不适合传回调。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { Bp, HomeDims } from './HomeBreakpoints';
import { HomeTokens } from './HomeTokens';
import { HomePrefs } from './HomePreferences';

@Component
export struct AppearancePanel {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;

  @StorageProp(HomePrefs.LIGHT) light: number = 1;

  /** 光感强度的一枚药丸。 */
  @Builder
  lightPill(value: number, label: string) {
    Text(label)
      .fontSize(this.dims.labelSize)
      .fontColor(this.light === value || (value >= 2 && this.light >= 2)
        ? HomeTokens.onPrimary : HomeTokens.textDim)
      .fontWeight(this.light === value || (value >= 2 && this.light >= 2)
        ? FontWeight.Medium : FontWeight.Regular)
      .padding({
        left: this.dims.bp === Bp.LG ? 16 : 12,
        right: this.dims.bp === Bp.LG ? 16 : 12,
        top: 7,
        bottom: 7
      })
      .borderRadius(this.dims.radiusPill)
      .backgroundColor(this.light === value || (value >= 2 && this.light >= 2)
        ? HomeTokens.primary : HomeTokens.glassFill)
      .border({
        width: 1,
        color: this.light === value || (value >= 2 && this.light >= 2)
          ? '#00000000' : HomeTokens.glassEdge
      })
      .onClick((): void => {
        AppStorage.setOrCreate<number>(HomePrefs.LIGHT, value);
      })
  }

  /** 档位文案（在 Builder 内部调用，才能随状态刷新）。 */
  private lightHint(): string {
    return this.light <= 0 ? '柔和' : (this.light >= 2 ? '明亮' : '标准');
  }

  @Builder
  lightTitle() {
    Row() {
      Text('光感强度')
        .fontSize(this.dims.bodySize)
        .fontColor(HomeTokens.text)
      Blank()
      Text(this.lightHint())
        .fontSize(this.dims.labelSize)
        .fontColor(HomeTokens.textFaint)
    }
    .width('100%')
  }

  build() {
    Column({ space: this.dims.gap }) {
      // 光感强度
      this.lightTitle()
      Row({ space: 8 }) {
        this.lightPill(0, '柔和')
        this.lightPill(1, '标准')
        this.lightPill(2, '明亮')
      }
      .width('100%')

      Text('光感只影响背景亮度与卡片透光，改完立即生效；底部导航的握姿适配已交给 HdsTabs 的 adaptToHandedness。')
        .fontSize(this.dims.labelSize)
        .fontColor(HomeTokens.textFaint)
        .maxLines(2)
    }
    .width('100%')
    .padding(this.dims.cardPadding)
    .alignItems(HorizontalAlign.Start)
    .borderRadius(this.dims.radiusCard)
    .backgroundColor(HomeTokens.glassFill)
    .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: HomeTokens.glassEdge })
    .margin({ top: this.dims.rowGap })
  }
}
