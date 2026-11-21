/*
 * 横屏错位主页的「当前正在编辑」宽卡。
 *
 * 参考 Web 端 Material You 主页的 resume 卡：左边是稿件标题/媒体信息，
 * 下方是两枚小药丸按钮。没有当前稿件时，同一张卡变成「新建 / 导入」入口，
 * 不额外占一张卡，也不会出现点了没反应的假按钮。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { AppStore, ProjectMeta } from '../../store/AppStore';
import { HomeDims } from './HomeBreakpoints';
import { HomeTokens, relativeLabel } from './HomeTokens';
import { GlassCard } from './GlassCard';

@Component
export struct ResumeCard {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;

  onAction: (key: string) => void = (): void => {};
  onOpen: (project: ProjectMeta) => void = (): void => {};

  @Builder
  actionPill(label: string, primary: boolean, onTap: () => void) {
    Text(label)
      .fontSize(this.dims.labelSize)
      .fontColor(primary ? HomeTokens.onPrimary : HomeTokens.text)
      .fontWeight(primary ? FontWeight.Medium : FontWeight.Regular)
      .padding({ left: 14, right: 14, top: 7, bottom: 7 })
      .borderRadius(this.dims.radiusPill)
      .backgroundColor(primary ? HomeTokens.primary : HomeTokens.glassFillStrong)
      .border({
        width: 1,
        color: primary ? '#00000000' : HomeTokens.glassEdge
      })
      .onClick((): void => {
        onTap();
      })
  }

  private title(): string {
    const p: ProjectMeta | null = this.store.current;
    return p !== null && p.name.length > 0 ? p.name : '还没有打开稿件';
  }

  private subtitle(current: ProjectMeta | null): string {
    if (current === null) {
      return '从新建项目或导入字幕开始';
    }
    const media: string = current.mediaName.length > 0 ? current.mediaName : '字幕稿件';
    return `${media} · ${current.cueCount} 条 · ${relativeLabel(current.updatedAt, Date.now())}`;
  }

  build() {
    GlassCard({
      dims: this.dims,
      tone: this.store.current !== null ? 'accent' : 'plain',
      interactive: false
    }) {
      Column({ space: 6 }) {
        Text(this.store.current !== null ? '当前正在编辑' : '准备开始')
          .fontSize(this.dims.miniSize)
          .letterSpacing(1)
          .fontColor(HomeTokens.textDim)

        Text(this.title())
          .fontSize(this.dims.titleSize + 6)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Text(this.subtitle(this.store.current))
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Row({ space: 8 }) {
          if (this.store.current !== null) {
            this.actionPill('继续编辑', true, (): void => {
              const p: ProjectMeta | null = this.store.current;
              if (p !== null) {
                this.onOpen(p);
              }
            })
            this.actionPill('全部稿件', false, (): void => {
              this.onAction('all');
            })
          } else {
            this.actionPill('新建稿件', true, (): void => {
              this.onAction('new');
            })
            this.actionPill('导入字幕', false, (): void => {
              this.onAction('import');
            })
          }
        }
        .margin({ top: this.dims.gap / 2 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }
}
