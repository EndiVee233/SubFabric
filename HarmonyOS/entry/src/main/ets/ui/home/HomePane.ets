/*
 * 主页：固定 Hero + 卡片瀑布流（WaterFlow）。
 *
 * 卡片不再按横竖屏分成两套栅格：同一组卡片在瀑布流里按窗口宽度自适应列数：
 *   手机 2 列 / 折叠屏 3 列 / 平板或 800vp 以上 4 列。
 * Hero（花形时钟 + 新建/导入）保持在顶部整宽，不参与瀑布流。
 *
 * 底部 HdsTabs 是 barOverlap 浮动栏；瀑布流直接铺到屏幕底部，由浮栏覆盖。
 */

import { AppStore, ProjectMeta } from '../../store/AppStore';
import { Bp, HomeDims } from './HomeBreakpoints';
import { HomeSummary, QuickAction } from './HomeData';
import { HeroSection } from './HeroSection';
import { RecentCard } from './RecentCard';
import { ProcessingCard, QuickActionCard } from './QuickCards';
import { BarAutoHide } from '../nav/BarAutoHide';

@Component
export struct HomePane {
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;
  @Prop summary: HomeSummary;
  /** 底部给浮动标签栏让出的高度。 */
  @Prop bottomInset: number = 0;
  onAction: (key: string) => void = (): void => {};
  onOpenProject: (project: ProjectMeta) => void = (): void => {};
  onOpenStudio: () => void = (): void => {};
  /** 首页滚动时通知入口页收起 / 展开底部 HdsTabs。 */
  onBarCollapse: (hidden: boolean) => void = (hidden: boolean): void => {};

  private autoHide: BarAutoHide = new BarAutoHide();

  private handleScroll(offset: number, state: ScrollState): void {
    this.autoHide.handle(offset, state, (hidden: boolean): void => {
      this.onBarCollapse(hidden);
    });
  }

  /**
   * 瀑布流列数：只按 sm / md / lg 断点。
   *   sm 手机 2 列；md 折叠屏/横屏 3 列；lg 平板/宽窗口 4 列。
   */
  private waterfallColumns(): number {
    if (this.dims.bp === Bp.LG) {
      return 4;
    }
    if (this.dims.bp === Bp.MD) {
      return 3;
    }
    return 2;
  }

  private columnsTemplate(): string {
    const n: number = this.waterfallColumns();
    if (n >= 4) {
      return '1fr 1fr 1fr 1fr';
    }
    if (n === 3) {
      return '1fr 1fr 1fr';
    }
    return '1fr 1fr';
  }

  build() {
    Column() {
      HeroSection({
        dims: this.dims,
        onNewProject: (): void => {
          this.onAction('new');
        },
        onImportSubtitle: (): void => {
          this.onAction('import');
        }
      })

      WaterFlow() {
        FlowItem() {
          ProcessingCard({
            dims: this.dims,
            summary: this.summary,
            onTap: (): void => this.onAction('processing')
          })
        }
        .width('100%')

        ForEach(this.summary.actions(), (action: QuickAction) => {
          FlowItem() {
            QuickActionCard({
              dims: this.dims,
              action: action,
              onTap: (): void => this.onAction(action.key)
            })
          }
          .width('100%')
        }, (action: QuickAction) => action.key)

        FlowItem() {
          RecentCard({
            store: this.store,
            dims: this.dims,
            onOpen: (p: ProjectMeta): void => {
              this.onOpenProject(p);
            }
          })
        }
        .width('100%')
      }
      .columnsTemplate(this.columnsTemplate())
      .columnsGap(this.dims.gap)
      .rowsGap(this.dims.rowGap)
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
      .onDidScroll((offset: number, state: ScrollState): void => {
        this.handleScroll(offset, state);
      })
      .onReachStart((): void => {
        this.autoHide.reset();
        this.onBarCollapse(false);
      })
    }
    .width('100%')
    .height('100%')
    .padding({
      left: this.dims.pagePaddingH,
      right: this.dims.pagePaddingH,
      top: this.dims.pagePaddingTop
    })
  }
}
