/*
 * 最近稿件：Flex 换行。
 *
 * 为什么不用 Grid：这里一行几张纯粹由「基础宽度 + 剩余空间」决定，
 * Flex(wrap) 配 dims.recentItemBasis（手机 100% / 平板 47%）比写死列数更稳，
 * 导航栏被拖宽变窄时也不会出现半格。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { LengthMetrics } from '@kit.ArkUI';
import { AppStore, ProjectMeta } from '../../store/AppStore';
import { HomeDims } from './HomeBreakpoints';
import { HomeTokens, relativeLabel } from './HomeTokens';

@Component
export struct RecentFlex {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;

  @State private now: number = Date.now();

  onOpen: (project: ProjectMeta) => void = (): void => {};

  private items(): ProjectMeta[] {
    const list: ProjectMeta[] = this.store.projects.slice();
    list.sort((a: ProjectMeta, b: ProjectMeta): number => b.updatedAt - a.updatedAt);
    return list.slice(0, 8);
  }

  build() {
    Column({ space: this.dims.gap }) {
      Row() {
        Text('最近稿件')
          .fontSize(this.dims.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
        Blank()
        Text(`${this.store.projects.length} 个`)
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
      }
      .width('100%')

      if (this.store.projects.length === 0) {
        Column() {
          Text('还没有稿件。点上面的「新建稿件」，导入一个视频或字幕文件。')
            .fontSize(this.dims.labelSize)
            .fontColor(HomeTokens.textDim)
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding(this.dims.cardPadding)
        .borderRadius(this.dims.radiusInner)
        .border({ width: 1, color: HomeTokens.glassEdge, style: BorderStyle.Dashed })
        .backgroundColor(HomeTokens.glassFill)
      } else {
        Flex({
          wrap: FlexWrap.Wrap,
          space: { main: LengthMetrics.vp(this.dims.gap), cross: LengthMetrics.vp(this.dims.gap) }
        }) {
          ForEach(this.items(), (p: ProjectMeta) => {
            this.recentCard(p)
          }, (p: ProjectMeta) => p.id)
        }
        .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ top: this.dims.rowGap })
    .onAppear((): void => {
      this.now = Date.now();
    })
  }

  @Builder
  recentCard(p: ProjectMeta) {
    Column({ space: 4 }) {
      Text(`${p.cueCount} 条`)
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.primary)
        .padding({ left: 8, right: 8, top: 2, bottom: 2 })
        .borderRadius(6)
        .backgroundColor(HomeTokens.accentGlass)
      Text(p.name.length > 0 ? p.name : '未命名稿件')
        .fontSize(this.dims.labelSize)
        .fontColor(HomeTokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
      Text(relativeLabel(p.updatedAt, this.now))
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.textFaint)
        .maxLines(1)
    }
    .width(this.dims.recentItemBasis)
    .padding({ left: this.dims.cardPadding, right: this.dims.cardPadding,
      top: this.dims.cardPadding, bottom: this.dims.cardPadding })
    .alignItems(HorizontalAlign.Start)
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(HomeTokens.glassFill)
    .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: HomeTokens.glassEdge })
    .shadow({ radius: 14, color: HomeTokens.shadowSoft, offsetX: 0, offsetY: 8 })
    .onClick((): void => {
      this.onOpen(p);
    })
  }
}
