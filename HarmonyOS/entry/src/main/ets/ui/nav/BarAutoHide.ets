/*
 * 页面滚动 ↔ 底部 HdsTabs 自动收起 / 展开。
 *
 * 约定与主页一致：
 *   · 内容向上滚（手指上滑，offset > 0）累计超过 48vp：收起底栏；
 *   · 内容向下滚（手指下滑，offset < 0）累计超过 32vp：展开底栏；
 *   · 回到顶部（onReachStart）强制展开。
 *
 * 只负责累积和阈值判断，真正的底栏状态由入口页 Index 统一持有；
 * 这样切换 Tab 时不会出现各页面各自记一套 hidden 状态。
 */

export class BarAutoHide {
  private accum: number = 0;

  /** WaterFlow / Scroll 的纵向滚动回调。 */
  handle(offset: number, state: ScrollState, onCollapse: (hidden: boolean) => void): void {
    if (state !== ScrollState.Scroll) {
      return;
    }
    if (offset > 0) {
      this.accum = Math.max(0, this.accum) + offset;
      if (this.accum > 48) {
        this.accum = 0;
        onCollapse(true);
      }
    } else if (offset < 0) {
      this.accum = Math.min(0, this.accum) + offset;
      if (this.accum < -32) {
        this.accum = 0;
        onCollapse(false);
      }
    }
  }

  /** 回到顶部 / 切页时清空累计值。 */
  reset(): void {
    this.accum = 0;
  }
}
