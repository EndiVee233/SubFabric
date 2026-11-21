/*
 * 沉浸光感背景（三层 + 外观偏好）。
 *
 * 默认「模糊流光」：高模糊光斑图 + 纵向遮罩 + 斜向光带。
 * 纯色：只保留底色和一层很淡的主题色渐变。
 * 自定义图片：用户选择的图片 + 同款压暗遮罩。
 * 流光色彩 / 动效 / 毛玻璃三档滑杆都写 AppStorage，这里用 @StorageProp 订阅。
 */

import { HomeTokens } from './HomeTokens';
import { HomePrefs, lightScale } from './HomePreferences';
import { AppearancePrefs, paletteColors, safeHex, withAlpha } from '../settings/AppearancePrefs';

@Component
export struct ImmersiveBackground {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  /** 0 柔和 / 1 标准 / 2 明亮；改它整页亮度跟着变。 */
  @StorageProp(HomePrefs.LIGHT) light: number = 1;

  @StorageProp(AppearancePrefs.BACKGROUND) @Watch('onMotionPref')
  bgMode: string = 'aurora';
  @StorageProp(AppearancePrefs.PALETTE) palette: string = 'theme';
  @StorageProp(AppearancePrefs.COLOR1) color1: string = '#8FBAFF';
  @StorageProp(AppearancePrefs.COLOR2) color2: string = '#C9BDFF';
  @StorageProp(AppearancePrefs.COLOR3) color3: string = '#5F8FDF';
  @StorageProp(AppearancePrefs.MOTION) @Watch('onMotionPref') motion: string = 'dynamic';
  @StorageProp(AppearancePrefs.SPEED) @Watch('onMotionPref') speed: string = 'normal';
  @StorageProp(AppearancePrefs.REDUCE_MOTION) @Watch('onMotionPref') reduceMotion: boolean = false;
  @StorageProp(AppearancePrefs.GLASS_DIM) glassDim: number = 80;
  @StorageProp(AppearancePrefs.GLASS_BLUR) glassBlur: number = 18;
  @StorageProp(AppearancePrefs.GLASS_OPACITY) glassOpacity: number = 100;
  @StorageProp(AppearancePrefs.ACCENT) accent: string = '#8FBAFF';
  @StorageProp(AppearancePrefs.IMAGE) imagePath: string = '';

  @State private breathe: number = 0;
  private timer: number = -1;

  aboutToAppear(): void {
    this.applyMotion();
  }

  aboutToDisappear(): void {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  onMotionPref(): void {
    this.applyMotion();
  }

  private applyMotion(): void {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
    const dynamic: boolean = this.motion === 'dynamic' && !this.reduceMotion
      && this.bgMode === 'aurora';
    if (!dynamic) {
      this.getUIContext().animateTo({ duration: 360, curve: Curve.EaseOut }, (): void => {
        this.breathe = 0;
      });
      return;
    }
    // 速度只改变呼吸周期，不改变动效形状；slow 24s / normal 14s / fast 8s
    const loop: number = this.speed === 'slow' ? 24000 : (this.speed === 'fast' ? 8000 : 14000);
    this.timer = setInterval((): void => {
      this.getUIContext().animateTo({ duration: loop, curve: Curve.EaseInOut }, (): void => {
        this.breathe = this.breathe > 0 ? 0 : 1;
      });
    }, loop);
  }

  private k(): number {
    return lightScale(this.light);
  }

  private colors(): string[] {
    return paletteColors(this.palette, this.accent, this.color1, this.color2, this.color3);
  }

  private glowOpacity(): number {
    const base: number = Math.min(1, 0.22 + 0.55 * this.k());
    const glass: number = 0.2 + 0.8 * Math.max(0, Math.min(100, this.glassOpacity)) / 100;
    return base * glass;
  }

  private imageBlur(): number {
    return Math.max(0, Math.min(80, 46 * Math.max(0, Math.min(32, this.glassBlur)) / 18));
  }

  private alphaByte(value: number): string {
    const clamped: number = Math.max(0, Math.min(255, Math.round(value)));
    const hex: string = clamped.toString(16).toUpperCase();
    return hex.length < 2 ? `0${hex}` : hex;
  }

  private dimColor(): string {
    const ratio: number = Math.max(0, Math.min(20, this.glassDim - 72)) / 20;
    if (this.themeLight) {
      // 浅色模式用一层白色柔光，而不是继续压黑；强度也比深色低。
      return `#${this.alphaByte(ratio * 0.08 * 255)}FFFFFF`;
    }
    return `#${this.alphaByte(ratio * 0.30 * 255)}000000`;
  }

  private customImageReady(): boolean {
    return this.bgMode === 'image' && this.imagePath.length > 0;
  }

  build() {
    Stack() {
      if (this.bgMode === 'solid') {
        Column()
          .width('100%')
          .height('100%')
          .linearGradient({
            angle: 155,
            colors: this.themeLight
              ? [
                [withAlpha(this.colors()[0], '14'), 0.0],
                ['#00000000', 0.55],
                [withAlpha(this.colors()[1], '0A'), 1.0]
              ]
              : [
                [withAlpha(this.colors()[0], '1F'), 0.0],
                ['#00000000', 0.55],
                [withAlpha(this.colors()[1], '12'), 1.0]
              ]
          })
      } else if (this.customImageReady()) {
        Image(this.imagePath)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
          .blur(Math.min(28, this.imageBlur() * 0.35))
          .opacity(this.themeLight ? 0.72 : 0.9)
        Column()
          .width('100%')
          .height('100%')
          .linearGradient({
            angle: 180,
            colors: this.themeLight
              ? [
                ['#B3F7FAFF', 0.0],
                ['#66F7FAFF', 0.4],
                ['#CCF2F5FA', 1.0]
              ]
              : [
                ['#B30A0E15', 0.0],
                ['#4D0A0E15', 0.4],
                ['#CC0A0E15', 1.0]
              ]
          })
      } else {
        Image($r('app.media.home_glow'))
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
          .blur(this.imageBlur())
          .scale({ x: 1.18 + this.breathe * 0.02, y: 1.18 + this.breathe * 0.02 })
          .translate({ x: this.breathe * 12, y: this.breathe * -8 })
          .opacity(this.glowOpacity() * (this.themeLight ? 0.28 : 1))

        // 流光色彩：用当前配色的低透明叠层给光斑染色
        Column()
          .width('100%')
          .height('100%')
          .linearGradient({
            angle: 145,
            colors: [
              [withAlpha(this.colors()[0], this.themeLight ? '1A' : '26'), 0.0],
              [withAlpha(this.colors()[1], this.themeLight ? '0D' : '14'), 0.45],
              ['#00000000', 1.0]
            ]
          })
          .opacity(this.themeLight ? 0.45 : 0.72)

        // 纵向遮罩：深色顶暗/中透/底暗；浅色反过来用白雾保住文字对比度
        Column()
          .width('100%')
          .height('100%')
          .linearGradient({
            angle: 180,
            colors: this.themeLight
              ? [
                ['#E6F7FAFF', 0.0],
                ['#B3F7FAFF', 0.38],
                ['#4DF7FAFF', 0.62],
                ['#F2F2F5FA', 1.0]
              ]
              : [
                ['#CC0A0E15', 0.0],
                ['#590A0E15', 0.38],
                ['#1A0A0E15', 0.62],
                ['#E60A0E15', 1.0]
              ]
          })

        // 斜向光带：颜色跟着流光配色，强度跟光感档位
        Column()
          .width('100%')
          .height('100%')
          .linearGradient({
            angle: 145,
            colors: [
              [withAlpha(this.colors()[0], this.themeLight ? '26' : '4D'), 0.0],
              [withAlpha(this.colors()[1], this.themeLight ? '0D' : '1A'), 0.28],
              ['#00000000', 0.62]
            ]
          })
          .opacity(Math.min(1, 0.35 + 0.50 * this.k())
            * Math.max(0.2, this.glassOpacity / 100)
            * (this.themeLight ? 0.52 : 1))
      }

      // 毛玻璃压暗：整张背景再压一层用户指定的暗度
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.dimColor())
    }
    .width('100%')
    .height('100%')
    .backgroundColor(HomeTokens.base)
    .hitTestBehavior(HitTestMode.None)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
