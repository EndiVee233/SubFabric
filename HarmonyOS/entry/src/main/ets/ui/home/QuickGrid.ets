/*
 * 竖屏快捷卡栅格：GridRow + GridCol。
 *
 * 列数完全由断点变量给（dims.quickColumns）：手机 1 列、平板 2 列。
 * 第一张「处理中」横跨整行，其余按 1 格排，所以两种列数下都不会出现半格。
 * 横屏不再走这里；HomePane 会用同一个处理中/快捷卡组件做 3/4 列错位布局。
 */

import { HomeDims } from './HomeBreakpoints';
import { HomeSummary, QuickAction } from './HomeData';
import { ProcessingCard, QuickActionCard } from './QuickCards';

@Component
export struct QuickGrid {
  @Prop dims: HomeDims;
  @Prop summary: HomeSummary;

  /** 点哪张卡由页面决定怎么导航。 */
  onAction: (key: string) => void = (): void => {};

  build() {
    GridRow({
      columns: this.dims.quickColumns,
      gutter: { x: this.dims.gap, y: this.dims.rowGap }
    }) {
      GridCol({ span: this.dims.quickColumns }) {
        ProcessingCard({
          dims: this.dims,
          summary: this.summary,
          onTap: (): void => this.onAction('processing')
        })
      }
      ForEach(this.summary.actions(), (action: QuickAction) => {
        GridCol({ span: 1 }) {
          QuickActionCard({
            dims: this.dims,
            action: action,
            onTap: (): void => this.onAction(action.key)
          })
        }
      }, (action: QuickAction) => action.key)
    }
    .width('100%')
  }
}
