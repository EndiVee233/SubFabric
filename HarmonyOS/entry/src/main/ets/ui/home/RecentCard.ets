/*
 * 横屏错位主格的「最近稿件」卡：一张玻璃卡里放最多三条最近稿件。
 *
 * 竖屏仍用 RecentFlex（小小卡片换行）；横屏空间更宽，改成卡内列表，
 * 这样 2 列跨度不会变成「一个没有卡片的悬空区块」，也能和同排动作卡保持同一张卡的语言。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { AppStore, ProjectMeta } from '../../store/AppStore';
import { Bp, HomeDims } from './HomeBreakpoints';
import { HomeTokens, relativeLabel } from './HomeTokens';
import { GlassCard } from './GlassCard';

@Component
export struct RecentCard {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;

  @State private now: number = Date.now();

  onOpen: (project: ProjectMeta) => void = (): void => {};

  private items(): ProjectMeta[] {
    const list: ProjectMeta[] = this.store.projects.slice();
    list.sort((a: ProjectMeta, b: ProjectMeta): number => b.updatedAt - a.updatedAt);
    return list.slice(0, 3);
  }

  @Builder
  recentRow(p: ProjectMeta) {
    Row({ space: 10 }) {
      Text(`${p.cueCount} 条`)
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.primary)
        .padding({ left: 6, right: 6, top: 1, bottom: 1 })
        .borderRadius(5)
        .backgroundColor(HomeTokens.accentGlass)
      Text(p.name.length > 0 ? p.name : '未命名稿件')
        .fontSize(this.dims.labelSize)
        .fontColor(HomeTokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Text(relativeLabel(p.updatedAt, this.now))
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.textFaint)
    }
    .width('100%')
    .height(this.dims.bp === Bp.LG ? 40 : 32)
    .onClick((): void => {
      this.onOpen(p);
    })
  }

  build() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 4 }) {
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

        if (this.items().length === 0) {
          Text('还没有稿件。点上面的「新建稿件」，导入一个视频或字幕文件。')
            .fontSize(this.dims.labelSize)
            .fontColor(HomeTokens.textDim)
            .maxLines(2)
            .margin({ top: 6 })
        } else {
          ForEach(this.items(), (p: ProjectMeta) => {
            this.recentRow(p)
          }, (p: ProjectMeta) => p.id)
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}
