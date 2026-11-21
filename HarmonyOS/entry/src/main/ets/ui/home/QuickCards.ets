/*
 * 主页卡片：处理中 + 快捷动作。
 *
 * 竖屏的 QuickGrid 和横屏的多列错位布局共用这两个组件，避免两套卡片内容
 * 各自漂移；这里只负责卡片内部，栅格跨度由外层 GridCol 决定。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { Bp, HomeDims } from './HomeBreakpoints';
import { HomeTokens } from './HomeTokens';
import { GlassCard } from './GlassCard';
import { HomeSummary, QuickAction } from './HomeData';

@Component
export struct ProcessingCard {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop summary: HomeSummary;
  onTap: () => void = (): void => {};

  build() {
    GlassCard({ dims: this.dims, onTap: this.onTap }) {
      Column({ space: 6 }) {
        Row() {
          Text('PROCESSING')
            .fontSize(this.dims.miniSize)
            .letterSpacing(1)
            .fontColor(HomeTokens.textDim)
          Blank()
          Text(this.summary.busy ? `${this.summary.processingPct}%` : '空闲')
            .fontSize(this.dims.miniSize)
            .fontColor(this.summary.busy ? HomeTokens.primary : HomeTokens.textFaint)
        }
        .width('100%')

        Text(this.summary.processingName)
          .fontSize(this.dims.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        // 进度条：整条是半透明主色，填充是实主色 + 外发光
        Stack({ alignContent: Alignment.Start }) {
          Row()
            .width(`${this.summary.processingPct}%`)
            .height('100%')
            .borderRadius(this.dims.radiusPill)
            .backgroundColor(HomeTokens.primary)
            .shadow({ radius: 12, color: HomeTokens.primaryGlow, offsetX: 0, offsetY: 0 })
          Text(this.summary.processingHint)
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.text)
            .padding({ left: 12 })
        }
        .width('100%')
        .height(this.dims.bp === Bp.LG ? 36 : 30)
        .borderRadius(this.dims.radiusPill)
        .backgroundColor(HomeTokens.accentGlass)
        .clip(true)
        .margin({ top: 8 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}

@Component
export struct QuickActionCard {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop action: QuickAction;
  onTap: () => void = (): void => {};

  build() {
    GlassCard({
      dims: this.dims,
      tone: this.action.tone,
      onTap: this.onTap
    }) {
      Column({ space: 4 }) {
        Text(this.action.kicker)
          .fontSize(this.dims.miniSize)
          .letterSpacing(1)
          .fontColor(this.action.tone === 'accent' ? HomeTokens.primary : HomeTokens.textDim)
        Text(this.action.title)
          .fontSize(this.action.key === 'all' || this.action.key === 'ready'
            || this.action.key === 'attention'
            ? this.dims.bigNumberSize : this.dims.titleSize)
          .fontWeight(this.action.key === 'all' || this.action.key === 'ready'
            || this.action.key === 'attention'
            ? FontWeight.Regular : FontWeight.Medium)
          .fontColor(HomeTokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.action.hint)
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}
