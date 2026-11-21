/*
 * Hero：左边是「花形时钟 + 问候语 + 日期」，右边是两个竖排按钮。
 *
 * 布局要求（2026-11-16）：新建稿件 / 导入字幕 放在时钟与问候语的右侧、上下排布，
 * 所以整体是一个 Row：左块（吃满剩余宽度）+ 右块（固定宽度的竖排按钮列）。
 *
 * 花形与指针的几何来自 Web 端（HomeShapes 由 tools/templates/studio.html 机械提取），
 * 指针每秒重算一次角度；花形背后有一团同色光晕，缓慢明暗呼吸。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { curves, LengthMetrics } from '@kit.ArkUI';
import { Bp, HomeDims } from './HomeBreakpoints';
import { HomeTokens, greetingOf, dateLabel } from './HomeTokens';
import { FLOWER_PATH } from './HomeShapes';
import { GlowButton } from './GlowButton';

@Component
export struct HeroSection {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) @Watch('onThemeChange') private themeLight: boolean = false;
  @Prop dims: HomeDims;
  /** 横屏错位布局的窄钟面卡：只保留花形时钟 + 问候/日期，不渲染右侧按钮。 */
  @Prop compact: boolean = false;
  @State private now: Date = new Date();

  private clock: number = -1;
  private clockCtx: CanvasRenderingContext2D =
    new CanvasRenderingContext2D(new RenderingContextSettings(true));

  onNewProject: () => void = (): void => {};
  onImportSubtitle: () => void = (): void => {};

  aboutToAppear(): void {
    this.now = new Date();
    this.clock = setInterval((): void => {
      this.now = new Date();
      this.drawClock();
    }, 1000);
  }

  aboutToDisappear(): void {
    if (this.clock >= 0) {
      clearInterval(this.clock);
      this.clock = -1;
    }
  }

  onThemeChange(): void {
    this.drawClock();
  }

  /**
   * 花形时钟（Canvas 绘制）。
   *
   * 为什么不用 Shape + Path：`Path().commands()` 的坐标按 **px** 落，不随组件宽高缩放，
   * 而 `Line().startPoint()` 按 vp 落 —— 两者混用实测会变成「33vp 的迷你花 + 96vp 的长指针」。
   * Canvas 里所有坐标都由 dims.flowerSize 现算，尺寸怎么变都对得上。
   */
  @Builder
  flowerClock() {
    Stack() {
      Canvas(this.clockCtx)
        .width(this.dims.flowerSize)
        .height(this.dims.flowerSize)
        .onReady((): void => {
          this.drawClock();
        })
    }
    .width(this.dims.flowerSize)
    .height(this.dims.flowerSize)
  }

  /** 按当前尺寸画一次花形 + 指针；每秒随 now 重画。 */
  private drawClock(): void {
    const s = this.dims.flowerSize;
    const c = s / 2;
    const ctx = this.clockCtx;
    try {
      ctx.clearRect(0, 0, s, s);

      // 13 瓣花形：r = 48 × (1 + .042 cos(13θ + π/2))，作图基准 100，再归一化到 s
      ctx.beginPath();
      for (let i = 0; i <= 144; i++) {
        const t = (i / 144) * Math.PI * 2;
        const r = 48 * (1 + 0.042 * Math.cos(13 * t + Math.PI / 2));
        const x = (50 + r * Math.cos(t)) / 100 * s;
        const y = (50 + r * Math.sin(t)) / 100 * s;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.fillStyle = HomeTokens.primary;
      ctx.fill();

      // 指针：绕中心旋转后画向上的线
      const hand = (angleDeg: number, lenRatio: number, widthRatio: number): void => {
        ctx.save();
        ctx.translate(c, c);
        ctx.rotate(angleDeg * Math.PI / 180);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -s * lenRatio);
        ctx.strokeStyle = HomeTokens.base;
        ctx.lineWidth = s * widthRatio;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      };
      hand((this.now.getHours() % 12) * 30 + this.now.getMinutes() * 0.5, 0.25, 0.055);
      hand(this.now.getMinutes() * 6, 0.37, 0.042);

      // 秒点
      const sec = this.now.getSeconds() * 6 * Math.PI / 180;
      ctx.beginPath();
      ctx.arc(c + Math.sin(sec) * s * 0.43, c - Math.cos(sec) * s * 0.43, s * 0.037, 0, Math.PI * 2);
      ctx.fillStyle = HomeTokens.base;
      ctx.fill();
    } catch (err) {
      // 首帧尺寸为 0 时画不出来，下一次 tick 会补
    }
  }

  build() {
    if (this.compact) {
      // 横屏左上的窄钟面卡：只放时钟 + 问候/日期，按钮交给右侧的继续编辑卡
      Column({ space: this.dims.gap / 2 }) {
        this.flowerClock()

        Column({ space: 2 }) {
          Text(greetingOf(this.now.getHours()))
            .fontSize(this.dims.titleSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          Text(dateLabel(this.now))
            .fontSize(this.dims.labelSize)
            .fontColor(HomeTokens.textDim)
        }
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .justifyContent(FlexAlign.Center)
    } else {
      Row({ space: this.dims.gap }) {
        // 左：时钟 + 问候语 + 日期（占满剩余宽度，靠左对齐）
        Column({ space: this.dims.gap / 2 }) {
          this.flowerClock()

          Column({ space: 2 }) {
            Text(greetingOf(this.now.getHours()))
              .fontSize(this.dims.titleSize)
              .fontWeight(FontWeight.Medium)
              .fontColor(HomeTokens.text)
            Text(dateLabel(this.now))
              .fontSize(this.dims.labelSize)
              .fontColor(HomeTokens.textDim)
          }
          .alignItems(HorizontalAlign.Start)
        }
        .alignItems(HorizontalAlign.Start)
        // sm 用权重吃掉剩余宽度（按钮被推到右边缘）；
        // md/lg 给固定宽度，按钮紧跟在问候语右侧，不会被甩到屏幕另一半
        .layoutWeight(this.dims.bp !== Bp.SM ? 0 : 1)
        .width(this.dims.bp !== Bp.SM ? 280 : '100%')
        // 左块往右挪一点：花形贴边会让整行重心偏左，和右侧按钮不协调
        .padding({ left: this.dims.gap * 0.9 })

        // 右：两个按钮上下排布，与时钟/问候语同一行
        Column({ space: this.dims.gap }) {
          Row() {
            GlowButton({
              label: '新建稿件',
              glyph: '＋',
              dims: this.dims,
              accent: true,
              onTap: (): void => {
                this.onNewProject();
              }
            })
          }
          .width(this.dims.heroButtonWidth)

          Row() {
            GlowButton({
              label: '导入字幕',
              glyph: '⇩',
              dims: this.dims,
              onTap: (): void => {
                this.onImportSubtitle();
              }
            })
          }
          .width(this.dims.heroButtonWidth)
        }
        .alignItems(HorizontalAlign.End)
      }
      // md/lg 行宽 = 左列 280 + 间距 + 按钮 120，刚好把按钮收在问候语旁边
      .width(this.dims.bp !== Bp.SM ? 420 : '100%')
      .alignItems(VerticalAlign.Center)
      .margin({ bottom: this.dims.rowGap })
    }
  }
}
