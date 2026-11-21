/*
 * 横屏错位主页的统计环卡。
 *
 * 参考 Web 端「一周内更新」的圆环：用 DataPanel 画可编辑 / 需处理两段，
 * 中心放稿件总数。数据只来自 HomeSummary，不伪造操作日志或远端统计。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { HomeDims } from './HomeBreakpoints';
import { HomeTokens } from './HomeTokens';
import { HomeSummary } from './HomeData';
import { GlassCard } from './GlassCard';

@Component
export struct StatsRingCard {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop summary: HomeSummary;

  onTap: () => void = (): void => {};

  private ringSize(): number {
    return Math.max(72, this.dims.flowerSize * 0.78);
  }

  private values(): number[] {
    return [Math.max(0, this.summary.editable), Math.max(0, this.summary.attention)];
  }

  private maxValue(): number {
    return Math.max(1, this.summary.projectCount);
  }

  build() {
    GlassCard({ dims: this.dims, onTap: this.onTap }) {
      Column({ space: 4 }) {
        Text('WORKSPACE')
          .fontSize(this.dims.miniSize)
          .letterSpacing(1)
          .fontColor(HomeTokens.textDim)

        Row() {
          Stack({ alignContent: Alignment.Center }) {
            DataPanel({
              values: this.values(),
              max: this.maxValue(),
              type: DataPanelType.Circle
            })
              .valueColors([HomeTokens.primary, HomeTokens.danger])
              .trackBackgroundColor(HomeTokens.glassFillStrong)
              .strokeWidth(10)
              .closeEffect(true)
              .width(this.ringSize())
              .height(this.ringSize())

            Column({ space: 0 }) {
              Text(`${this.summary.projectCount}`)
                .fontSize(this.dims.bigNumberSize)
                .fontWeight(FontWeight.Regular)
                .fontColor(HomeTokens.text)
              Text('全部稿件')
                .fontSize(this.dims.miniSize)
                .fontColor(HomeTokens.textDim)
            }
          }
          .width(this.ringSize())
          .height(this.ringSize())
        }
        .width('100%')
        .justifyContent(FlexAlign.Center)

        Text(`可编辑 ${this.summary.editable} · 需处理 ${this.summary.attention}`)
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .maxLines(1)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}
