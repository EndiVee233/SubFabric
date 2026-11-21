/*
 * 设置页：两个层级。
 *
 * 手机：一级分类单列成卡片，点进去是二级页（左上角返回）。
 * 折叠屏 / 平板 / 2in1：系统设置式双栏，左栏一级分类，右栏常驻二级内容。
 *
 * 一级顺序与电脑端一致：
 *   个性化 → 语音识别 → 翻译与术语 → 识别与校对 → 下载与登录 → 性能与调度
 * 另按本次要求把「储存空间」也放到一级，排在最后。
 *
 * ⚠️ 动态值不要当 @Builder 参数传（@Builder 参数按值传递，状态变化不会刷新）。
 * 所有会变的行（开关、分段、输入框、值展示）都做成 @Component，通过 @Prop 更新。
 */

import { curves } from '@kit.ArkUI';
import { hdsMaterial, HdsTabs, HdsTabsController } from '@kit.UIDesignKit';
import { fileIo as fs, picker, statfs } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { effectKit } from '@kit.ArkGraphics2D';

import { AppStore } from '../../store/AppStore';
import { NpuHardware, VulkanHardware } from '../../engine/RecognitionHardware';
import { AudioSuiteDenoise } from '../../engine/AudioSuiteDenoise';
import {
  MediaCodecMode, MediaCodecPrefs, setMediaCodecMode
} from '../../engine/MediaBackend';
import { hasAv1Hardware } from '../../engine/FfmpegMedia';
import { TranslateOptions, TranslationService } from '../../engine/TranslationService';
import {
  GlossaryEntry, GlossaryGroup, TRANSLATION_PROVIDERS, TranslationScheme,
  parseTranslationScheme, providerDefaults, providerLabel
} from '../../engine/TranslationScheme';
import { ensureDir, readTextFile, writeTextFile } from '../../platform/FileUtil';
import { Logger } from '../../engine/Logger';
import { Bp, HomeDims } from '../home/HomeBreakpoints';
import { HomeTokens } from '../home/HomeTokens';
import { ImmersiveBackground } from '../home/ImmersiveBackground';
import { BarAutoHide } from '../nav/BarAutoHide';
import {
  projectsPanelWidth, WIDE_DRAWER_GAP, WIDE_DRAWER_MARGIN
} from '../projects/ProjectsDrawer';
import {
  AppearancePrefs, paletteColors, resetAppearance
} from './AppearancePrefs';
import { applyTheme } from '../../platform/ThemeManager';

const CATEGORY_KEYS: string[] = [
  'personal', 'asr', 'translate', 'proof', 'download', 'perf', 'storage'
];

const TAG = 'Settings';

const ACCENT_SWATCHES: string[] = ['#8FBAFF', '#8FD5A6', '#FFB37A', '#FF9DB5', '#C9BDFF'];

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kb: number = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb: number = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
}

function rowFont(dims: HomeDims): number {
  return dims.bodySize + 2;
}

function hintFont(dims: HomeDims): number {
  return dims.labelSize + 1;
}

/** 二级页的通用卡片外壳。 */
@Component
struct SettingsCard {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop title: string = '';
  @Prop note: string = '';
  @BuilderParam content: () => void = this.emptyContent;

  @Builder
  emptyContent() {
  }

  build() {
    Column({ space: 10 }) {
      if (this.title.length > 0 || this.note.length > 0) {
        Column({ space: 2 }) {
          if (this.title.length > 0) {
            Text(this.title)
              .fontSize(this.dims.bodySize + 1)
              .fontWeight(FontWeight.Medium)
              .fontColor(HomeTokens.text)
          }
          if (this.note.length > 0) {
            Text(this.note)
              .fontSize(this.dims.labelSize)
              .fontColor(HomeTokens.textFaint)
              .lineHeight(this.dims.labelSize + 6)
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
      }
      this.content()
    }
    .width('100%')
    .padding(this.dims.cardPadding)
    .alignItems(HorizontalAlign.Start)
    .borderRadius(this.dims.radiusCard)
    .backgroundColor(HomeTokens.glassFill)
    .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: HomeTokens.glassEdge })
  }
}

@Component
struct InfoRow {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop value: string = '';

  build() {
    Row() {
      Text(this.label)
        .fontSize(rowFont(this.dims))
        .fontColor(HomeTokens.textDim)
      Blank()
      Text(this.value)
        .fontSize(rowFont(this.dims))
        .fontColor(HomeTokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(40)
  }
}

@Component
struct ToggleRow {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop hint: string = '';
  @Prop isOn: boolean = false;
  onToggle: (on: boolean) => void = (on: boolean): void => {};

  build() {
    Row({ space: 12 }) {
      Column({ space: 3 }) {
        Text(this.label)
          .fontSize(rowFont(this.dims))
          .fontColor(HomeTokens.text)
        if (this.hint.length > 0) {
          Text(this.hint)
            .fontSize(hintFont(this.dims))
            .fontColor(HomeTokens.textFaint)
            .lineHeight(hintFont(this.dims) + 4)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Toggle({ type: ToggleType.Switch, isOn: this.isOn })
        .selectedColor(HomeTokens.primary)
        .onChange((on: boolean): void => {
          this.onToggle(on);
        })
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
  }
}

@Component
struct SegmentRow {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop hint: string = '';
  @Prop values: string[] = [];
  @Prop labels: string[] = [];
  @Prop current: string = '';
  onPick: (value: string) => void = (value: string): void => {};

  build() {
    Column({ space: 8 }) {
      Row() {
        Text(this.label)
          .fontSize(rowFont(this.dims))
          .fontColor(HomeTokens.text)
        Blank()
        if (this.hint.length > 0) {
          Text(this.hint)
            .fontSize(hintFont(this.dims))
            .fontColor(HomeTokens.textFaint)
        }
      }
      .width('100%')

      Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap }) {
        ForEach(this.values, (value: string, index: number) => {
          Text(this.labels[index])
            .fontSize(hintFont(this.dims) + 1)
            .fontColor(this.current === value ? HomeTokens.onPrimary : HomeTokens.textDim)
            .fontWeight(this.current === value ? FontWeight.Medium : FontWeight.Regular)
            .padding({ left: 14, right: 14, top: 7, bottom: 7 })
            .borderRadius(this.dims.radiusPill)
            .backgroundColor(this.current === value ? HomeTokens.primary : HomeTokens.glassFill)
            .border({
              width: 1,
              color: this.current === value ? '#00000000' : HomeTokens.glassEdge
            })
            .margin({ right: 8, bottom: 6 })
            .onClick((): void => {
              this.onPick(value);
            })
        }, (value: string) => value)
      }
      .width('100%')
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
    .alignItems(HorizontalAlign.Start)
  }
}

@Component
struct FieldRow {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop hint: string = '';
  @Prop value: string = '';
  @Prop placeholder: string = '';
  @Prop password: boolean = false;
  onChangeText: (text: string) => void = (text: string): void => {};

  build() {
    Column({ space: 6 }) {
      Text(this.label)
        .fontSize(rowFont(this.dims))
        .fontColor(HomeTokens.textDim)
      TextInput({ text: this.value, placeholder: this.placeholder })
        .type(this.password ? InputType.Password : InputType.Normal)
        .fontSize(rowFont(this.dims))
        .fontColor(HomeTokens.text)
        .placeholderColor(HomeTokens.textFaint)
        .caretColor(HomeTokens.primary)
        .height(44)
        .padding({ left: 12, right: 12 })
        .backgroundColor(HomeTokens.innerFill)
        .border({ width: 1, color: HomeTokens.glassEdge })
        .borderRadius(this.dims.radiusInner)
        .onChange((text: string): void => {
          this.onChangeText(text);
        })
      if (this.hint.length > 0) {
        SettingsNote({ dims: this.dims, text: this.hint })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

@Component
struct SettingsNote {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop text: string = '';

  build() {
    Text(this.text)
      .fontSize(hintFont(this.dims))
      .fontColor(HomeTokens.textFaint)
      .lineHeight(hintFont(this.dims) + 5)
      .width('100%')
  }
}

@Component
struct PillButton {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop primary: boolean = false;
  @Prop isEnabled: boolean = true;
  onTap: () => void = (): void => {};

  build() {
    Button(this.label, { type: ButtonType.Normal })
      .fontSize(rowFont(this.dims))
      .fontColor(this.primary ? HomeTokens.onPrimary : HomeTokens.primary)
      .backgroundColor(this.primary ? HomeTokens.primary : HomeTokens.accentGlass)
      .border({ width: this.primary ? 0 : 1, color: HomeTokens.glassEdge })
      .borderRadius(this.dims.radiusPill)
      .height(42)
      .padding({ left: 20, right: 20 })
      .opacity(this.isEnabled ? 1 : 0.5)
      .enabled(this.isEnabled)
      .onClick((): void => {
        this.onTap();
      })
  }
}

@Component
struct SliderRow {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop value: number = 0;
  @Prop min: number = 0;
  @Prop max: number = 100;
  @Prop step: number = 1;
  @Prop suffix: string = '';
  onChangeValue: (value: number) => void = (value: number): void => {};

  build() {
    Column({ space: 4 }) {
      Row() {
        Text(this.label)
          .fontSize(rowFont(this.dims))
          .fontColor(HomeTokens.text)
        Blank()
        Text(`${Math.round(this.value)}${this.suffix}`)
          .fontSize(hintFont(this.dims))
          .fontColor(HomeTokens.textFaint)
      }
      .width('100%')

      Slider({
        value: this.value,
        min: this.min,
        max: this.max,
        step: this.step,
        style: SliderStyle.OutSet
      })
        .width('100%')
        .selectedColor(HomeTokens.primary)
        .trackColor(HomeTokens.glassFill)
        .blockColor(HomeTokens.text)
        .onChange((value: number, mode: SliderChangeMode): void => {
          this.onChangeValue(value);
        })
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
    .alignItems(HorizontalAlign.Start)
  }
}

@Component
struct SwatchesRow {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop colors: string[] = [];
  @Prop selected: string = '';
  onPick: (color: string) => void = (color: string): void => {};

  build() {
    Row({ space: this.dims.bp === Bp.LG ? 16 : 12 }) {
      ForEach(this.colors, (color: string) => {
        Stack({ alignContent: Alignment.Center }) {
          Circle()
            .width(this.dims.bp === Bp.LG ? 34 : 30)
            .height(this.dims.bp === Bp.LG ? 34 : 30)
            .fill(color)
          if (this.selected.toUpperCase() === color.toUpperCase()) {
            SymbolGlyph($r('sys.symbol.checkmark'))
              .fontSize(this.dims.bp === Bp.LG ? 16 : 14)
              .fontColor(['#0A0E15'])
          }
        }
        .width(this.dims.bp === Bp.LG ? 38 : 34)
        .height(this.dims.bp === Bp.LG ? 38 : 34)
        .borderRadius(this.dims.radiusPill)
        .border({
          width: this.selected.toUpperCase() === color.toUpperCase() ? 2 : 0,
          color: HomeTokens.text
        })
        .onClick((): void => {
          this.onPick(color);
        })
      }, (color: string) => color)
    }
    .width('100%')
  }
}

/** 设置页术语草稿：按目标语言过滤，保存时再组装成 GlossaryGroup。 */
class GlossaryDraftEntry {
  lang: string = 'zh';
  term: string = '';
  translation: string = '';

  constructor(lang: string = 'zh', term: string = '', translation: string = '') {
    this.lang = lang;
    this.term = term;
    this.translation = translation;
  }
}

@Component
export struct SettingsPane {
  @ObjectLink store: AppStore;
  @Prop @Watch('onDimsChanged') dims: HomeDims;
  @Prop bottomInset: number = 0;
  /** 设置内容滚动时通知入口页收起 / 展开底部 HdsTabs。 */
  onBarCollapse: (hidden: boolean) => void = (): void => {};

  private autoHide: BarAutoHide = new BarAutoHide();

  /** 宽屏右侧共用一个 Scroll：切分类时回到顶部，切页签时保留位置。 */
  private wideScroller: Scroller = new Scroller();

  private handleScroll(offset: number, state: ScrollState): void {
    this.autoHide.handle(offset, state, (hidden: boolean): void => {
      this.onBarCollapse(hidden);
    });
  }

  @State private selected: string = '';
  @State private pageKey: string = 'personal';
  @State private pressedCategory: string = '';

  /** 宽屏右栏的底层页：二级页 push/replace 时保持它可见/可返回。 */
  @State private rootKey: string = 'personal';
  /** 手机 / 窄屏二级页：Navigation 栈负责 push/pop 与滑入滑出动画。 */
  private settingsStack: NavPathStack = new NavPathStack();

  @State private endpointDraft: string = '';
  @State private keyDraft: string = '';
  @State private modelDraft: string = '';
  @State private downloadUrlDraft: string = '';

  /** 翻译方案草稿。 */
  @State private schemeNameDraft: string = '';
  @State private providerDraft: string = 'deepseek';
  @State private temperatureDraft: string = '0.2';
  @State private batchSizeDraft: string = '20';
  @State private contextLinesDraft: string = '1';
  @State private promptDraft: string = '';
  @State private glossaryDraft: GlossaryDraftEntry[] = [];
  @State private glossaryLang: string = 'zh';
  @State private savedSchemes: TranslationScheme[] = [];
  @State private useAfterSave: boolean = true;
  @State private autoTranslateDraft: boolean = true;
  @State private showApiKey: boolean = false;
  @State private clearKeyPending: boolean = false;
  @State private testBusy: boolean = false;
  @State private testResult: string = '';
  @State private testOk: boolean = false;

  @State private modelSize: string = '—';
  @State private projectSize: string = '—';
  @State private exportSize: string = '—';
  @State private freeBytes: number = 0;
  @State private totalBytes: number = 0;

  @StorageProp(AppearancePrefs.BACKGROUND) private bgMode: string = 'aurora';
  @StorageProp(AppearancePrefs.PALETTE) private paletteMode: string = 'theme';
  @StorageProp(AppearancePrefs.COLOR1) private color1: string = '#8FBAFF';
  @StorageProp(AppearancePrefs.COLOR2) private color2: string = '#C9BDFF';
  @StorageProp(AppearancePrefs.COLOR3) private color3: string = '#5F8FDF';
  @StorageProp(AppearancePrefs.MOTION) private motionMode: string = 'dynamic';
  @StorageProp(AppearancePrefs.SPEED) private flowSpeed: string = 'normal';
  @StorageProp(AppearancePrefs.REDUCE_MOTION) private reduceMotion: boolean = false;
  @StorageProp(AppearancePrefs.GLASS_DIM) private glassDim: number = 80;
  @StorageProp(AppearancePrefs.GLASS_BLUR) private glassBlur: number = 18;
  @StorageProp(AppearancePrefs.GLASS_OPACITY) private glassOpacity: number = 100;
  @StorageProp(AppearancePrefs.ACCENT) private accent: string = '#8FBAFF';
  @StorageProp(AppearancePrefs.IMAGE) @Watch('onBackgroundImageChanged') private imagePath: string = '';
  @StorageProp(AppearancePrefs.MODE) private mode: string = 'dark';
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private effectiveLight: boolean = false;
  @StorageProp(MediaCodecPrefs.MODE) private codecMode: string = MediaCodecMode.AVCODEC;
  @State private av1HardwareAvailable: boolean = false;

  /** 莫奈取色：从当前背景图提取的主色；为空时显示取色入口。 */
  @State private monetColors: string[] = [];
  @State private monetBusy: boolean = false;
  @State private monetHint: string = '从当前背景图提取主色，生成可套用的流光配色彩。';

  private backController: HdsTabsController = new HdsTabsController();
  private vulkanHardware: VulkanHardware = new VulkanHardware();
  private npuHardware: NpuHardware = new NpuHardware();

  aboutToAppear(): void {
    this.syncDrafts();
    this.readStorage();
    try {
      this.av1HardwareAvailable = hasAv1Hardware();
    } catch (err) {
      this.av1HardwareAvailable = false;
    }
    if (this.dims.twoPane && this.selected.length === 0) {
      this.selected = 'personal';
    }
    if (this.dims.twoPane) {
      this.rootKey = this.currentKey();
    }
    // 背景图取色是异步解码，不阻塞设置页首帧
    setTimeout((): void => {
      this.extractMonetColors();
    }, 240);
  }

  /** 转屏 / 断点切换：进入双栏后右侧直接按当前分类渲染，并清掉窄屏遗留的导航栈。 */
  onDimsChanged(): void {
    if (this.dims.twoPane) {
      while (this.settingsStack.size() > 0) {
        this.settingsStack.pop(false);
      }
      this.rootKey = this.currentKey();
      this.selected = this.currentKey();
    }
  }

  // ------------------------------------------------------------ 文案与图标

  private catTitle(key: string): string {
    switch (key) {
      case 'asr':
        return '语音识别';
      case 'translate':
        return '翻译与术语';
      case 'proof':
        return '识别与校对';
      case 'download':
        return '下载与登录';
      case 'perf':
        return '性能与调度';
      case 'storage':
        return '储存空间';
      default:
        return '个性化';
    }
  }

  private catDesc(key: string): string {
    switch (key) {
      case 'asr':
        return '识别引擎、模型与静音裁剪。';
      case 'translate':
        return '翻译方案、术语表与连接测试。';
      case 'proof':
        return '初稿质量与校对能力。';
      case 'download':
        return '模型下载与账号状态。';
      case 'perf':
        return '识别硬件、接口与硬件自检。';
      case 'storage':
        return '模型、项目与导出的空间占用。';
      default:
        return '背景、主题与交互反馈。';
    }
  }

  private catIcon(key: string): Resource {
    switch (key) {
      case 'asr':
        return $r('sys.symbol.waveform');
      case 'translate':
        return $r('sys.symbol.translate');
      case 'proof':
        return $r('sys.symbol.doc_text');
      case 'download':
        return $r('sys.symbol.download');
      case 'perf':
        return $r('sys.symbol.memory_module');
      case 'storage':
        return $r('sys.symbol.externaldrive');
      default:
        return $r('sys.symbol.paintpalette');
    }
  }

  private currentKey(): string {
    return this.pageKey.length > 0 ? this.pageKey : 'personal';
  }

  /** 平板左栏高亮：优先当前点击项；转屏后 selected 为空时跟随右栏内容。 */
  private sidebarKey(): string {
    return this.selected.length > 0 ? this.selected : this.currentKey();
  }

  private selectCategory(key: string): void {
    if (key === 'translate' || key === 'download') {
      this.syncDrafts();
    }
    if (key === 'storage') {
      this.readStorage();
    }
    this.pageKey = key;
    this.selected = key;

    if (this.dims.twoPane) {
      // 平板双栏直接换右侧内容，不创建导航页，避免整页重建与黑底闪一下。
      // 新分类从顶部开始看；切页签不动这里，位置会保留。
      this.rootKey = key;
      try {
        this.wideScroller.scrollTo({ xOffset: 0, yOffset: 0, animation: false });
      } catch (err) {
        Logger.warn(TAG, '设置页滚动复位失败');
      }
      return;
    }

    // 窄屏：根页是分类列表，每次点分类都 push 一个新的二级页。
    this.settingsStack.pushPath(new NavPathInfo('settings-detail', key));
  }

  private goBack(): void {
    if (this.dims.twoPane) {
      return;
    }
    if (this.settingsStack.size() > 0) {
      this.settingsStack.pop();
    }
    this.selected = '';
  }

  // ------------------------------------------------------------ 草稿 / 存储

  private syncDrafts(): void {
    this.endpointDraft = this.store.translateEndpoint;
    this.keyDraft = '';
    this.modelDraft = this.store.translateModel.trim().length > 0
      ? this.store.translateModel : providerDefaults(this.store.translateProvider).model;
    this.downloadUrlDraft = this.store.modelDownloadUrl;
    this.schemeNameDraft = this.store.translateSchemeName;
    this.providerDraft = this.store.translateProvider;
    this.temperatureDraft = String(this.store.translateTemperature);
    this.batchSizeDraft = String(this.store.translateBatchSize);
    this.contextLinesDraft = String(this.store.translateContextLines);
    this.promptDraft = this.store.translatePrompt;
    this.savedSchemes = this.store.translateSchemes;
    this.autoTranslateDraft = this.store.autoTranslate;
    this.showApiKey = false;
    this.clearKeyPending = false;
    this.testResult = '';
    this.testOk = false;
    const drafts: GlossaryDraftEntry[] = [];
    const groups = this.store.translateGlossary;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      for (let k = 0; k < group.entries.length; k++) {
        const e = group.entries[k];
        drafts.push(new GlossaryDraftEntry(group.lang, e.term, e.translation));
      }
    }
    this.glossaryDraft = drafts;
  }

  private providerShortLabel(provider: string): string {
    if (provider === 'openai') {
      return 'OpenAI';
    }
    if (provider === 'anthropic') {
      return 'Anthropic';
    }
    if (provider === 'custom') {
      return '自定义';
    }
    return 'DeepSeek';
  }

  private pickProvider(provider: string): void {
    const oldDefault = providerDefaults(this.providerDraft);
    const next = providerDefaults(provider);
    if (this.endpointDraft.trim().length === 0 || this.endpointDraft.trim() === oldDefault.endpoint) {
      this.endpointDraft = next.endpoint;
    }
    if (this.modelDraft.trim().length === 0 || this.modelDraft.trim() === oldDefault.model) {
      this.modelDraft = next.model;
    }
    this.providerDraft = provider;
  }

  private effectiveKey(): string {
    if (this.clearKeyPending) {
      return '';
    }
    if (this.keyDraft.trim().length > 0) {
      return this.keyDraft.trim();
    }
    return this.store.translateApiKey;
  }

  private glossaryEntries(): GlossaryDraftEntry[] {
    const out: GlossaryDraftEntry[] = [];
    for (let i = 0; i < this.glossaryDraft.length; i++) {
      if (this.glossaryDraft[i].lang === this.glossaryLang) {
        out.push(this.glossaryDraft[i]);
      }
    }
    return out;
  }

  private glossaryCount(lang: string): number {
    let n = 0;
    for (let i = 0; i < this.glossaryDraft.length; i++) {
      if (this.glossaryDraft[i].lang === lang) {
        n++;
      }
    }
    return n;
  }

  private buildGlossaryGroups(): GlossaryGroup[] {
    const groups: GlossaryGroup[] = [];
    const langs: string[] = ['zh', 'zh-Hant', 'en'];
    for (let l = 0; l < langs.length; l++) {
      const entries: GlossaryEntry[] = [];
      for (let i = 0; i < this.glossaryDraft.length; i++) {
        const e = this.glossaryDraft[i];
        if (e.lang !== langs[l]) {
          continue;
        }
        const term = e.term.trim();
        const translation = e.translation.trim();
        if (term.length > 0 && translation.length > 0) {
          entries.push(new GlossaryEntry(term, translation));
        }
      }
      if (entries.length > 0) {
        groups.push(new GlossaryGroup(langs[l], entries));
      }
    }
    return groups;
  }

  private translateOptionsFromDrafts(): TranslateOptions {
    const options = new TranslateOptions();
    options.provider = this.providerDraft;
    options.temperature = this.clampNumber(this.temperatureDraft, 0, 2, 0.2);
    options.batchSize = Math.round(this.clampNumber(this.batchSizeDraft, 5, 100, 20));
    options.prompt = this.promptDraft;
    options.glossary = this.buildGlossaryGroups();
    return options;
  }

  private clampNumber(text: string, min: number, max: number, fallback: number): number {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, n));
  }

  private buildSchemeFromDrafts(): TranslationScheme {
    const scheme = new TranslationScheme();
    let existingId = '';
    for (let i = 0; i < this.savedSchemes.length; i++) {
      if (this.savedSchemes[i].name === this.schemeNameDraft.trim()) {
        existingId = this.savedSchemes[i].id;
      }
    }
    scheme.id = existingId.length > 0 ? existingId : `scheme_${Date.now()}`;
    scheme.name = this.schemeNameDraft.trim();
    scheme.provider = this.providerDraft;
    scheme.endpoint = this.endpointDraft.trim();
    scheme.model = this.modelDraft.trim().length > 0
      ? this.modelDraft.trim() : providerDefaults(this.providerDraft).model;
    scheme.temperature = this.clampNumber(this.temperatureDraft, 0, 2, 0.2);
    scheme.batchSize = Math.round(this.clampNumber(this.batchSizeDraft, 5, 100, 20));
    scheme.contextLines = Math.round(this.clampNumber(this.contextLinesDraft, 0, 50, 1));
    scheme.prompt = this.promptDraft;
    scheme.autoTranslate = this.autoTranslateDraft;
    scheme.glossary = this.buildGlossaryGroups();
    scheme.apiKey = this.effectiveKey();
    return scheme;
  }

  private saveTranslationScheme(): void {
    const name = this.schemeNameDraft.trim();
    if (name.length === 0) {
      this.toast('请填写方案名称');
      return;
    }
    const scheme = this.buildSchemeFromDrafts();
    this.store.upsertTranslationScheme(scheme);
    if (this.useAfterSave) {
      this.store.applyTranslationScheme(scheme);
    } else {
      this.store.saveSettings();
    }
    this.savedSchemes = this.store.translateSchemes;
    this.clearKeyPending = false;
    this.showApiKey = false;
    this.toast(this.useAfterSave ? `方案「${name}」已保存并启用` : `方案「${name}」已保存`);
  }

  private loadSchemeIntoDrafts(scheme: TranslationScheme): void {
    this.schemeNameDraft = scheme.name;
    this.providerDraft = scheme.provider;
    this.endpointDraft = scheme.endpoint;
    this.keyDraft = scheme.apiKey;
    this.modelDraft = scheme.model.trim().length > 0
      ? scheme.model : providerDefaults(scheme.provider).model;
    this.temperatureDraft = String(scheme.temperature);
    this.batchSizeDraft = String(scheme.batchSize);
    this.contextLinesDraft = String(scheme.contextLines);
    this.promptDraft = scheme.prompt;
    this.autoTranslateDraft = scheme.autoTranslate;
    this.showApiKey = false;
    this.clearKeyPending = false;
    const drafts: GlossaryDraftEntry[] = [];
    for (let i = 0; i < scheme.glossary.length; i++) {
      const group = scheme.glossary[i];
      for (let k = 0; k < group.entries.length; k++) {
        drafts.push(new GlossaryDraftEntry(group.lang, group.entries[k].term,
          group.entries[k].translation));
      }
    }
    this.glossaryDraft = drafts;
    this.useAfterSave = true;
    this.toast(`已载入方案「${scheme.name}」，确认后保存`);
  }

  private resetTranslationDrafts(): void {
    this.syncDrafts();
    this.toast('已恢复当前生效的翻译方案');
  }

  private async testLlmConnection(): Promise<void> {
    if (this.testBusy) {
      return;
    }
    const key = this.effectiveKey();
    if (key.trim().length === 0) {
      this.toast('请先填写 API Key');
      return;
    }
    this.testBusy = true;
    this.testOk = false;
    this.testResult = '正在测试 LLM 连接…';
    try {
      const service = new TranslationService(this.endpointDraft, key, this.modelDraft,
        this.translateOptionsFromDrafts());
      const reply = await service.testConnection();
      this.testOk = true;
      this.testResult = `连接成功：${reply.length > 0 ? reply : 'OK'}`;
      this.toast('LLM 连接成功');
    } catch (err) {
      const e = err as Error;
      this.testOk = false;
      this.testResult = `连接失败：${e.message}`;
      this.toast(`LLM 连接失败：${e.message}`);
    } finally {
      this.testBusy = false;
    }
  }

  private async importTranslationScheme(): Promise<void> {
    const ctx = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters = ['翻译方案|.json'];
      const uris: string[] = await new picker.DocumentViewPicker(ctx).select(options);
      if (uris.length === 0) {
        return;
      }
      const scheme = parseTranslationScheme(readTextFile(uris[0]), false);
      this.loadSchemeIntoDrafts(scheme);
      this.testResult = '已导入方案；API Key 需要重新填写';
      this.testOk = false;
    } catch (err) {
      const e = err as Error;
      this.toast(`导入方案失败：${e.message}`);
    }
  }

  private async exportTranslationScheme(): Promise<void> {
    const ctx = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    const scheme = this.buildSchemeFromDrafts();
    if (scheme.name.length === 0) {
      this.toast('请先填写方案名称');
      return;
    }
    try {
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [`${scheme.name.replace(/[\\/:*?"<>|]/g, '_')}.json`];
      const uris: string[] = await new picker.DocumentViewPicker(ctx).save(options);
      if (uris.length === 0) {
        return;
      }
      writeTextFile(uris[0], scheme.toJson(false));
      this.toast('方案已导出（不含 API Key）');
    } catch (err) {
      const e = err as Error;
      this.toast(`导出方案失败：${e.message}`);
    }
  }

  private saveTranslationFields(): void {
    // 兼容旧入口：保存当前接口表单到方案并应用。
    this.saveTranslationScheme();
  }

  private providerLabels(): string[] {
    const out: string[] = [];
    for (let i = 0; i < TRANSLATION_PROVIDERS.length; i++) {
      out.push(this.providerShortLabel(TRANSLATION_PROVIDERS[i]));
    }
    return out;
  }

  private glossaryTabLabels(): string[] {
    return [`简体 · ${this.glossaryCount('zh')}`,
      `繁體 · ${this.glossaryCount('zh-Hant')}`,
      `English · ${this.glossaryCount('en')}`];
  }

  private glossaryTargetLabel(): string {
    if (this.glossaryLang === 'zh-Hant') {
      return '繁體';
    }
    return this.glossaryLang === 'en' ? 'English' : '简体';
  }

  private addGlossaryEntry(): void {
    this.glossaryDraft = this.glossaryDraft.concat([
      new GlossaryDraftEntry(this.glossaryLang, '', '')
    ]);
  }

  private removeGlossaryEntry(entry: GlossaryDraftEntry): void {
    this.glossaryDraft = this.glossaryDraft.filter(
      (item: GlossaryDraftEntry): boolean => item !== entry);
  }

  private applyTranslationSchemeFromStore(): void {
    // 兼容旧调用：当前方案已由 AppStore 保存，刷新草稿即可。
    this.syncDrafts();
  }

  private saveDownloadUrl(showToast: boolean): void {
    this.store.modelDownloadUrl = this.downloadUrlDraft.trim();
    this.store.saveSettings();
    if (showToast) {
      this.toast('下载地址已保存');
    }
  }

  private dirSize(path: string): number {
    let total: number = 0;
    try {
      const names: string[] = fs.listFileSync(path);
      for (let i = 0; i < names.length; i++) {
        const child: string = `${path}/${names[i]}`;
        try {
          const st = fs.statSync(child);
          if (st.isDirectory()) {
            total += this.dirSize(child);
          } else {
            total += st.size;
          }
        } catch (err) {
          // 单个文件读不到就跳过，不整页失败
        }
      }
    } catch (err) {
      return total;
    }
    return total;
  }

  private readStorage(): void {
    const root: string = this.store.rootDir();
    if (root.length === 0) {
      return;
    }
    this.modelSize = formatBytes(this.dirSize(`${root}/models`));
    this.projectSize = formatBytes(this.dirSize(`${root}/projects`));
    this.exportSize = formatBytes(this.dirSize(`${root}/exports`));
    try {
      this.freeBytes = statfs.getFreeSizeSync(root);
      this.totalBytes = statfs.getTotalSizeSync(root);
    } catch (err) {
      this.freeBytes = 0;
      this.totalBytes = 0;
    }
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 1800 });
    } catch (err) {
      // 提示失败不影响设置
    }
  }

  // ------------------------------------------------------------ 外观偏好

  private setBackground(mode: string): void {
    AppStorage.setOrCreate<string>(AppearancePrefs.BACKGROUND, mode);
    if (mode === 'image' && this.imagePath.length === 0) {
      this.toast('请选择一张背景图片');
    }
  }

  private setPalette(mode: string): void {
    AppStorage.setOrCreate<string>(AppearancePrefs.PALETTE, mode);
  }

  private setMotion(mode: string): void {
    AppStorage.setOrCreate<string>(AppearancePrefs.MOTION, mode);
  }

  private setFlowSpeed(mode: string): void {
    AppStorage.setOrCreate<string>(AppearancePrefs.SPEED, mode);
  }

  private setReduceMotion(reduce: boolean): void {
    AppStorage.setOrCreate<boolean>(AppearancePrefs.REDUCE_MOTION, reduce);
  }

  // ------------------------------------------------------------ 莫奈取色

  /** 背景图变化后重新取色；默认背景则取内置光斑图。 */
  private onBackgroundImageChanged(): void {
    this.monetColors = [];
    this.extractMonetColors();
  }

  private monetHex(color: effectKit.Color): string {
    const byte = (value: number): string => {
      const clamped: number = Math.max(0, Math.min(255, Math.round(value)));
      const hex: string = clamped.toString(16).toUpperCase();
      return hex.length < 2 ? `0${hex}` : hex;
    };
    return `#${byte(color.red)}${byte(color.green)}${byte(color.blue)}`;
  }

  private monetFallback(): string[] {
    return paletteColors(this.paletteMode, this.accent,
      this.color1, this.color2, this.color3).slice(0, 5);
  }

  private async extractMonetColors(): Promise<void> {
    if (this.monetBusy) {
      return;
    }
    const ctx = this.store.context;
    if (ctx === null) {
      this.monetHint = '应用尚未初始化';
      return;
    }
    this.monetBusy = true;
    this.monetHint = '正在从当前背景图提取主色…';
    let source: image.ImageSource | null = null;
    let pixelMap: image.PixelMap | null = null;
    try {
      if (this.imagePath.length > 0) {
        try {
          source = image.createImageSource(this.imagePath);
        } catch (err) {
          source = null;
        }
      }
      if (source === null) {
        const bytes: Uint8Array =
          ctx.resourceManager.getMediaContentSync($r('app.media.home_glow').id);
        source = image.createImageSource(bytes.buffer as ArrayBuffer);
      }
      pixelMap = await source.createPixelMap();
      const picker = await effectKit.createColorPicker(pixelMap);
      const raw: Array<effectKit.Color | null> = picker.getTopProportionColors(6);
      const colors: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const c: effectKit.Color | null = raw[i];
        if (c === null) {
          continue;
        }
        const max: number = Math.max(c.red, c.green, c.blue);
        const min: number = Math.min(c.red, c.green, c.blue);
        // 跳过纯白/纯黑，避免莫奈色板只剩边框色
        if ((max > 245 && min > 225) || max < 18) {
          continue;
        }
        const hex: string = this.monetHex(c);
        if (!colors.includes(hex)) {
          colors.push(hex);
        }
        if (colors.length >= 5) {
          break;
        }
      }
      if (colors.length >= 3) {
        this.monetColors = colors;
        this.monetHint = `已提取 ${colors.length} 个主色`;
      } else {
        this.monetColors = this.monetFallback();
        this.monetHint = '图片色彩较少，已回退到当前流光配色';
      }
    } catch (err) {
      this.monetColors = this.monetFallback();
      this.monetHint = '取色失败，已回退到当前流光配色';
    } finally {
      this.monetBusy = false;
      if (pixelMap !== null) {
        try {
          pixelMap.release();
        } catch (err) {
          // 释放失败不影响预览
        }
      }
      if (source !== null) {
        try {
          source.release();
        } catch (err) {
          // 释放失败不影响预览
        }
      }
    }
  }

  private applyMonetColors(): void {
    if (this.monetColors.length < 3) {
      this.toast('还没有可用的取色结果');
      return;
    }
    AppStorage.setOrCreate<string>(AppearancePrefs.COLOR1, this.monetColors[0]);
    AppStorage.setOrCreate<string>(AppearancePrefs.COLOR2, this.monetColors[1]);
    AppStorage.setOrCreate<string>(AppearancePrefs.COLOR3, this.monetColors[2]);
    AppStorage.setOrCreate<string>(AppearancePrefs.PALETTE, 'custom');
    AppStorage.setOrCreate<string>(AppearancePrefs.BACKGROUND, 'aurora');
    this.toast('已应用到流光色彩');
  }

  private setMode(mode: string): void {
    AppStorage.setOrCreate<string>(AppearancePrefs.MODE, mode);
    const ctx = this.store.context;
    if (ctx !== null) {
      applyTheme(ctx, mode);
    }
    if (mode === 'light') {
      this.toast('已切换到浅色模式');
    } else if (mode === 'dark') {
      this.toast('已切换到深色模式');
    } else {
      this.toast('已跟随系统外观');
    }
  }

  private setGlassDim(value: number): void {
    AppStorage.setOrCreate<number>(AppearancePrefs.GLASS_DIM, Math.round(value));
  }

  private setGlassBlur(value: number): void {
    AppStorage.setOrCreate<number>(AppearancePrefs.GLASS_BLUR, Math.round(value));
  }

  private setGlassOpacity(value: number): void {
    AppStorage.setOrCreate<number>(AppearancePrefs.GLASS_OPACITY, Math.round(value));
  }

  private pickAccent(color: string): void {
    AppStorage.setOrCreate<string>(AppearancePrefs.ACCENT, color);
    AppStorage.setOrCreate<string>(AppearancePrefs.PALETTE, 'theme');
  }

  private async chooseBackgroundImage(): Promise<void> {
    const ctx = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化，稍后再试');
      return;
    }
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters = ['图片|.png,.jpg,.jpeg,.webp'];
      const viewPicker = new picker.DocumentViewPicker(ctx);
      const uris = await viewPicker.select(options);
      if (uris.length === 0) {
        return;
      }
      const uri: string = uris[0];
      const src = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      try {
        const stat = fs.statSync(src.fd);
        if (stat.size > 2 * 1024 * 1024) {
          this.toast('图片不能超过 2 MB');
          return;
        }
        const dir: string = `${this.store.rootDir()}/appearance`;
        ensureDir(dir);
        const clean: string = uri.split('?')[0];
        const dot: number = clean.lastIndexOf('.');
        let ext: string = dot >= 0 ? clean.slice(dot).toLowerCase() : '.png';
        if (['.png', '.jpg', '.jpeg', '.webp'].indexOf(ext) < 0) {
          ext = '.png';
        }
        const dest: string = `${dir}/background${ext}`;
        const dst = fs.openSync(dest,
          fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
        try {
          fs.copyFileSync(src.fd, dst.fd);
        } finally {
          fs.closeSync(dst);
        }
        AppStorage.setOrCreate<string>(AppearancePrefs.IMAGE, dest);
        AppStorage.setOrCreate<string>(AppearancePrefs.BACKGROUND, 'image');
        this.toast('背景图片已更新');
      } finally {
        fs.closeSync(src);
      }
    } catch (err) {
      const e = err as Error;
      this.toast(`选择图片失败：${e.message}`);
    }
  }

  private clearBackgroundImage(): void {
    AppStorage.setOrCreate<string>(AppearancePrefs.IMAGE, '');
    AppStorage.setOrCreate<string>(AppearancePrefs.BACKGROUND, 'aurora');
    this.toast('已清除自定义图片');
  }

  private resetAppearanceSettings(): void {
    resetAppearance();
    const ctx = this.store.context;
    if (ctx !== null) {
      applyTheme(ctx, 'dark');
    }
    this.toast('外观已恢复默认');
  }

  private themePackUnavailable(): void {
    this.toast('端上暂未接入主题包文件');
  }

  private fsTitle(): number {
    return this.dims.titleSize + 6;
  }

  private fsRow(): number {
    return this.dims.bodySize + 2;
  }

  private fsHint(): number {
    return this.dims.labelSize + 1;
  }

  // ------------------------------------------------------------ 一级列表

  @Builder
  levelOneHeader() {
    Row() {
      Text('设置')
        .fontSize(this.fsTitle())
        .fontWeight(FontWeight.Medium)
        .fontColor(HomeTokens.text)
    }
    .width('100%')
  }

  @Builder
  categoryCard(key: string) {
    Row({ space: 14 }) {
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph(this.catIcon(key))
          .fontSize(this.dims.bp === Bp.LG ? 25 : 22)
          .fontColor([HomeTokens.textDim])
      }
      .width(this.dims.bp === Bp.LG ? 46 : 40)
      .height(this.dims.bp === Bp.LG ? 46 : 40)
      .borderRadius(this.dims.radiusInner)
      .backgroundColor(HomeTokens.glassFill)

      Column({ space: 3 }) {
        Text(this.catTitle(key))
          .fontSize(this.fsRow())
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
        Text(this.catDesc(key))
          .fontSize(this.fsHint())
          .fontColor(HomeTokens.textFaint)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(this.dims.bp === Bp.LG ? 21 : 19)
        .fontColor([HomeTokens.textFaint])
    }
    .width('100%')
    .height(this.dims.bp === Bp.LG ? 82 : 72)
    .padding({ left: this.dims.cardPadding, right: this.dims.cardPadding })
    .borderRadius(this.dims.radiusCard)
    .backgroundColor(this.pressedCategory === key ? HomeTokens.glassFillStrong : HomeTokens.glassFill)
    .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: HomeTokens.glassEdge })
    .scale({
      x: this.pressedCategory === key ? 0.98 : 1,
      y: this.pressedCategory === key ? 0.98 : 1
    })
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        this.getUIContext().animateTo({
          duration: 100,
          curve: curves.springMotion(0.3, 0.72)
        }, (): void => {
          this.pressedCategory = key;
        });
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.getUIContext().animateTo({
          duration: 200,
          curve: curves.springMotion(0.38, 0.86)
        }, (): void => {
          if (this.pressedCategory === key) {
            this.pressedCategory = '';
          }
        });
      }
    })
    .onClick((): void => {
      this.selectCategory(key);
    })
  }

  @Builder
  levelOneList() {
    Scroll() {
      Column({ space: this.dims.gap }) {
        this.levelOneHeader()
        Column({ space: 8 }) {
          ForEach(CATEGORY_KEYS, (key: string) => {
            this.categoryCard(key)
          }, (key: string) => key)
        }
        .width('100%')
      }
      .width('100%')
      .padding({
        left: this.dims.pagePaddingH,
        right: this.dims.pagePaddingH,
        top: this.dims.pagePaddingTop,
        bottom: this.dims.pagePaddingBottom
      })
    }
    .width('100%')
    .height('100%')
    .align(Alignment.TopStart)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .onDidScroll((x: number, y: number, state: ScrollState): void => {
      this.handleScroll(y, state);
    })
    .onReachStart((): void => {
      this.autoHide.reset();
      this.onBarCollapse(false);
    })
  }

  // ------------------------------------------------------------ 二级页头

  private backSize(): number {
    return this.dims.bp === Bp.LG ? 48 : 44;
  }

  @Builder
  backTab() {
    Column() {
      SymbolGlyph($r('sys.symbol.chevron_left'))
        .fontSize(this.backSize() * 0.52)
        .fontColor([HomeTokens.text])
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .accessibilityText('返回设置')
  }

  /** 二级页返回键：HdsTabs 单 Tab 沉浸材质，与项目页 ☰ 同款。 */
  @Builder
  backButton() {
    HdsTabs({ controller: this.backController }) {
      TabContent() {
        // 空内容：只借用 HdsTabs 底栏的沉浸材质。
      }
      .tabBar(this.backTab())
    }
    .vertical(false)
    .scrollable(false)
    .barHeight(this.backSize())
    .barOverlap(true)
    .barPosition(BarPosition.End)
    .barFloatingStyle({
      barWidth: {
        smallWidth: this.backSize(),
        mediumWidth: this.backSize(),
        largeWidth: this.backSize()
      },
      barBottomMargin: 0,
      barSideMargin: 0,
      gradientMask: { maskColor: Color.Transparent },
      lightColor: HomeTokens.primary,
      systemMaterialEffect: {
        materialType: hdsMaterial.MaterialType.IMMERSIVE,
        materialLevel: hdsMaterial.MaterialLevel.EXQUISITE
      }
    })
    .onTabBarClick((): void => {
      this.goBack();
    })
    .width(this.backSize())
    .height(this.backSize())
    .borderRadius(this.backSize() / 2)
    .clip(true)
  }

  @Builder
  detailHeader() {
    if (!this.dims.twoPane) {
      Row({ space: 12 }) {
        this.backButton()
        Column({ space: 2 }) {
          Text(this.catTitle(this.currentKey()))
            .fontSize(this.fsTitle() - 2)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          Text(this.catDesc(this.currentKey()))
            .fontSize(this.fsHint())
            .fontColor(HomeTokens.textFaint)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
    } else {
      Column({ space: 4 }) {
        Text(this.catTitle(this.currentKey()))
          .fontSize(this.fsTitle() - 2)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
        Text(this.catDesc(this.currentKey()))
          .fontSize(this.fsHint())
          .fontColor(HomeTokens.textFaint)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  // ------------------------------------------------------------ 二级内容

  @Builder
  modePreview() {
    Row({ space: 12 }) {
      Stack({ alignContent: Alignment.TopStart }) {
        Column()
          .width('100%')
          .height(64)
          .borderRadius(16)
          .backgroundColor(this.effectiveLight ? '#E9F0FB' : '#101822')
          .border({ width: 1, color: this.effectiveLight ? '#22000000' : '#33FFFFFF' })

        Row({ space: 8 }) {
          Column()
            .width(28)
            .height(28)
            .borderRadius(10)
            .backgroundColor(this.effectiveLight ? '#2F6FDB' : '#8FBAFF')
          Column({ space: 5 }) {
            Column()
              .width(56)
              .height(5)
              .borderRadius(3)
              .backgroundColor(this.effectiveLight ? '#20344D' : '#EAF0FB')
            Column()
              .width(36)
              .height(4)
              .borderRadius(2)
              .backgroundColor(this.effectiveLight ? '#7B8BA0' : '#8B96A8')
          }
          .alignItems(HorizontalAlign.Start)
        }
        .padding(10)
      }
      .width(142)

      Column({ space: 4 }) {
        Text(this.effectiveLight ? '浅色模式' : '深色模式')
          .fontSize(this.fsRow())
          .fontColor(HomeTokens.text)
        Text(this.mode === 'system'
          ? (this.effectiveLight ? '跟随系统 · 当前为浅色' : '跟随系统 · 当前为深色')
          : (this.effectiveLight ? '浅底 + 深色文字' : '深底 + 浅色文字'))
          .fontSize(this.fsHint())
          .fontColor(HomeTokens.textFaint)
          .maxLines(2)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .padding(12)
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(HomeTokens.glassFill)
    .border({ width: 1, color: HomeTokens.glassEdge })
  }

  @Builder
  personalPage() {
    Column({ space: this.dims.gap }) {
      SettingsCard({ dims: this.dims, title: '背景与材质',
        note: '让工作空间成为你的空间；背景留在内容之下，清晰阅读优先。' }) {
        SegmentRow({
          dims: this.dims,
          label: '背景材质',
          values: ['solid', 'aurora', 'image'],
          labels: ['纯色', '模糊流光', '自定义图片'],
          current: this.bgMode,
          onPick: (value: string): void => {
            this.setBackground(value);
          }
        })

        if (this.bgMode === 'image') {
          InfoRow({ dims: this.dims, label: '自定义图片',
            value: this.imagePath.length > 0 ? '已选择' : '未选择' })
          Row({ space: 10 }) {
            PillButton({
              dims: this.dims,
              label: '选择图片',
              primary: true,
              onTap: (): void => {
                this.chooseBackgroundImage();
              }
            })
            PillButton({
              dims: this.dims,
              label: '清除图片',
              isEnabled: this.imagePath.length > 0,
              onTap: (): void => {
                this.clearBackgroundImage();
              }
            })
          }
          .width('100%')
          SettingsNote({ dims: this.dims, text: '支持 PNG / JPEG / WebP，单张不超过 2 MB。图片会复制到应用沙箱。' })
          Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        }

        if (this.bgMode === 'aurora') {
          SegmentRow({
            dims: this.dims,
            label: '流光色彩',
            values: ['theme', 'sage', 'ocean', 'sunset', 'custom'],
            labels: ['主题', '苔绿', '海蓝', '暮霞', '自定义'],
            current: this.paletteMode,
            onPick: (value: string): void => {
              this.setPalette(value);
            }
          })
          Text('流光色彩预览')
            .fontSize(this.fsHint())
            .fontColor(HomeTokens.textFaint)
            .width('100%')
            .margin({ top: 2 })
          Row({ space: 8 }) {
            ForEach(paletteColors(this.paletteMode, this.accent,
              this.color1, this.color2, this.color3).slice(0, 3),
              (color: string, index: number) => {
                Column()
                  .layoutWeight(1)
                  .height(36)
                  .borderRadius(13)
                  .backgroundColor(color)
              }, (color: string, index: number) => `${index}-${color}`)
          }
          .width('100%')

          if (this.paletteMode === 'custom') {
            FieldRow({
              dims: this.dims,
              label: '流光色 1',
              value: this.color1,
              placeholder: '#8FBAFF',
              onChangeText: (text: string): void => {
                AppStorage.setOrCreate<string>(AppearancePrefs.COLOR1, text);
              }
            })
            FieldRow({
              dims: this.dims,
              label: '流光色 2',
              value: this.color2,
              placeholder: '#C9BDFF',
              onChangeText: (text: string): void => {
                AppStorage.setOrCreate<string>(AppearancePrefs.COLOR2, text);
              }
            })
            FieldRow({
              dims: this.dims,
              label: '流光色 3',
              value: this.color3,
              placeholder: '#5F8FDF',
              onChangeText: (text: string): void => {
                AppStorage.setOrCreate<string>(AppearancePrefs.COLOR3, text);
              }
            })
            SettingsNote({ dims: this.dims, text: '输入 #RRGGBB；格式不正确时回退到默认色。' })
          }

          Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
          SegmentRow({
            dims: this.dims,
            label: '流光效果',
            values: ['dynamic', 'static'],
            labels: ['动态流光', '静态流光'],
            current: this.motionMode,
            onPick: (value: string): void => {
              this.setMotion(value);
            }
          })
          if (this.motionMode === 'dynamic') {
            SegmentRow({
              dims: this.dims,
              label: '流光速度',
              values: ['slow', 'normal', 'fast'],
              labels: ['慢', '标准', '快'],
              current: this.flowSpeed,
              onPick: (value: string): void => {
                this.setFlowSpeed(value);
              }
            })
            SettingsNote({ dims: this.dims,
              text: '速度控制光斑呼吸周期：慢 24 秒 / 标准 14 秒 / 快 8 秒。' })
          }
          Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        }

        SegmentRow({
          dims: this.dims,
          label: '明暗模式',
          values: ['light', 'dark', 'system'],
          labels: ['浅色', '深色', '跟随系统'],
          current: this.mode,
          onPick: (value: string): void => {
            this.setMode(value);
          }
        })
        this.modePreview()
        SettingsNote({ dims: this.dims,
          text: '浅色 / 深色会立即切换整页、系统 Material、对话框与状态栏图标；跟随系统会随系统外观实时更新。' })

        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        SegmentRow({
          dims: this.dims,
          label: '界面动效',
          values: ['on', 'reduce'],
          labels: ['开启', '减少动效'],
          current: this.reduceMotion ? 'reduce' : 'on',
          onPick: (value: string): void => {
            this.setReduceMotion(value === 'reduce');
          }
        })
      }

      SettingsCard({ dims: this.dims, title: '毛玻璃',
        note: '控制沉浸背景的压暗、模糊与透光，调整后立即生效。' }) {
        SliderRow({
          dims: this.dims,
          label: '毛玻璃压暗',
          value: this.glassDim,
          min: 72,
          max: 92,
          step: 1,
          suffix: '%',
          onChangeValue: (value: number): void => {
            this.setGlassDim(value);
          }
        })
        SliderRow({
          dims: this.dims,
          label: '毛玻璃模糊度',
          value: this.glassBlur,
          min: 0,
          max: 32,
          step: 1,
          suffix: 'px',
          onChangeValue: (value: number): void => {
            this.setGlassBlur(value);
          }
        })
        SliderRow({
          dims: this.dims,
          label: '毛玻璃透明度',
          value: this.glassOpacity,
          min: 20,
          max: 100,
          step: 1,
          suffix: '%',
          onChangeValue: (value: number): void => {
            this.setGlassOpacity(value);
          }
        })
      }

      SettingsCard({ dims: this.dims, title: '项目页',
        note: '控制项目页侧边栏的展开方式。' }) {
        ToggleRow({
          dims: this.dims,
          label: '侧边栏常驻展开',
          hint: '仅宽屏生效：进入项目页时左侧栏保持展开，打开稿件后也不会收起。',
          isOn: this.store.projectsDrawerPinned,
          onToggle: (on: boolean): void => {
            this.store.projectsDrawerPinned = on;
            this.store.saveSettings();
            this.toast(on ? '项目页侧栏将常驻展开' : '项目页侧栏恢复可收起');
          }
        })
      }

      SettingsCard({ dims: this.dims, title: '主题包与色彩', note: '' }) {
        InfoRow({ dims: this.dims, label: '当前主题包', value: 'SubFabric 深色' })
        Row({ space: 10 }) {
          PillButton({
            dims: this.dims,
            label: '导入主题包',
            onTap: (): void => {
              this.themePackUnavailable();
            }
          })
          PillButton({
            dims: this.dims,
            label: '导出主题包',
            onTap: (): void => {
              this.themePackUnavailable();
            }
          })
        }
        .width('100%')

        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        Text('自定义主题色')
          .fontSize(this.fsRow())
          .fontColor(HomeTokens.text)
        SwatchesRow({
          dims: this.dims,
          colors: ACCENT_SWATCHES,
          selected: this.accent,
          onPick: (color: string): void => {
            this.pickAccent(color);
          }
        })
        Row() {
          PillButton({
            dims: this.dims,
            label: '恢复默认',
            onTap: (): void => {
              this.resetAppearanceSettings();
            }
          })
        }
        .width('100%')
        SettingsNote({ dims: this.dims,
          text: '主题色用于「跟随主题」流光配色；全局界面换色与主题包文件暂未迁移。' })
      }

      SettingsCard({ dims: this.dims, title: '莫奈取色预览',
        note: '从当前背景图提取主色，生成可套用的流光配色彩。' }) {
        if (this.monetColors.length > 0) {
          Row({ space: 8 }) {
            ForEach(this.monetColors, (color: string, index: number) => {
              Column()
                .layoutWeight(1)
                .height(44)
                .borderRadius(14)
                .backgroundColor(color)
            }, (color: string, index: number) => `${index}-${color}`)
          }
          .width('100%')
        } else {
          Column({ space: 6 }) {
            Text(this.monetBusy ? '正在取色…' : '还没有取色结果')
              .fontSize(this.fsRow())
              .fontColor(this.monetBusy ? HomeTokens.primary : HomeTokens.textDim)
              .width('100%')
            Text(this.monetHint)
              .fontSize(this.fsHint())
              .fontColor(HomeTokens.textFaint)
              .width('100%')
          }
          .width('100%')
          .padding({ top: 4, bottom: 4 })
        }

        Row({ space: 10 }) {
          PillButton({
            dims: this.dims,
            label: this.monetBusy ? '正在取色…' : '重新取色',
            isEnabled: !this.monetBusy,
            onTap: (): void => {
              this.extractMonetColors();
            }
          })
          PillButton({
            dims: this.dims,
            label: '应用到流光色彩',
            primary: true,
            isEnabled: this.monetColors.length >= 3 && !this.monetBusy,
            onTap: (): void => {
              this.applyMonetColors();
            }
          })
        }
        .width('100%')

        SettingsNote({ dims: this.dims,
          text: this.monetColors.length > 0
            ? this.monetHint + ' 应用后会切到「模糊流光」并使用前三个主色。'
            : this.monetHint })
      }

      SettingsCard({ dims: this.dims, title: '交互', note: '' }) {
        InfoRow({ dims: this.dims, label: '底部导航', value: 'HdsTabs · 跟随握姿' })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: '项目抽屉', value: '左侧默认 · 支持握姿推断' })
      }
    }
    .width('100%')
  }

  @Builder
  asrPage() {
    Column({ space: this.dims.gap }) {
      SettingsCard({ dims: this.dims, title: '引擎', note: 'Parakeet + MindSpore Lite' }) {
        InfoRow({ dims: this.dims, label: '当前后端', value: this.store.backendLabel })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: 'NPU', value: this.npuHardware.interfaceNote() })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: 'GPU（Vulkan）',
          value: this.vulkanHardware.interfaceNote() })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: '模型状态',
          value: this.store.hasModels() ? '已就绪' : '缺少模型文件' })
      }

      SettingsCard({ dims: this.dims, title: '识别行为', note: '' }) {
        ToggleRow({
          dims: this.dims,
          label: '语音活动检测（VAD）',
          hint: '跳过静音段，适合访谈与课程；纯音乐素材建议关闭。',
          isOn: this.store.useVad,
          onToggle: (on: boolean): void => {
            this.store.useVad = on;
            this.store.saveSettings();
          }
        })
      }

      SettingsCard({ dims: this.dims, title: '模型与硬件', note: '' }) {
        SettingsNote({ dims: this.dims, text: '识别硬件提供 NPU 与 GPU（Vulkan）接口；'
          + 'Vulkan 目前仅预留，尚未接入推理。' })
        SettingsNote({ dims: this.dims, text: '模型文件存放在应用沙箱，卸载应用会一起删除。'
          + 'NPU 推理由引擎按 NPU-only 策略执行。' })
        SettingsNote({ dims: this.dims, text: this.store.modelStatus() })
        InfoRow({ dims: this.dims, label: '模型目录', value: '应用沙箱 / models' })
      }
    }
    .width('100%')
  }

  @Builder
  glossaryRow(entry: GlossaryDraftEntry) {
    Row({ space: 7 }) {
      TextInput({ text: entry.term, placeholder: '原文' })
        .fontSize(this.dims.miniSize + 1)
        .fontColor(HomeTokens.text)
        .placeholderColor(HomeTokens.textFaint)
        .height(36)
        .layoutWeight(1)
        .padding({ left: 9, right: 9 })
        .backgroundColor(HomeTokens.glassFill)
        .borderRadius(this.dims.radiusInner)
        .onChange((value: string): void => {
          entry.term = value;
        })
      TextInput({ text: entry.translation, placeholder: `译法 · ${this.glossaryTargetLabel()}` })
        .fontSize(this.dims.miniSize + 1)
        .fontColor(HomeTokens.text)
        .placeholderColor(HomeTokens.textFaint)
        .height(36)
        .layoutWeight(1)
        .padding({ left: 9, right: 9 })
        .backgroundColor(HomeTokens.glassFill)
        .borderRadius(this.dims.radiusInner)
        .onChange((value: string): void => {
          entry.translation = value;
        })
      SymbolGlyph($r('sys.symbol.trash'))
        .fontSize(15)
        .fontColor([HomeTokens.danger])
        .padding(4)
        .onClick((): void => {
          this.removeGlossaryEntry(entry);
        })
    }
    .width('100%')
  }

  @Builder
  schemeChip(scheme: TranslationScheme) {
    Text(scheme.name)
      .fontSize(this.dims.miniSize)
      .fontColor(HomeTokens.primary)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
      .padding({ left: 10, right: 10, top: 5, bottom: 5 })
      .borderRadius(this.dims.radiusPill)
      .backgroundColor(HomeTokens.accentGlass)
      .border({ width: 1, color: HomeTokens.glassEdge })
      .onClick((): void => {
        this.loadSchemeIntoDrafts(scheme);
      })
  }

  @Builder
  translatePage() {
    Column({ space: this.dims.gap }) {
      SettingsCard({ dims: this.dims, title: '翻译行为', note: '目标语言决定术语表分组。' }) {
        SegmentRow({
          dims: this.dims,
          label: '目标语言',
          values: ['zh', 'zh-Hant', 'en', 'ja', 'ko'],
          labels: ['简体中文', '繁體中文', 'English', '日本語', '한국어'],
          current: this.store.targetLang,
          onPick: (value: string): void => {
            this.store.targetLang = value;
            this.store.saveSettings();
          }
        })
      }

      SettingsCard({ dims: this.dims, title: '方案与服务商',
        note: '方案保存在本机；导出 JSON 不包含 API Key。' }) {
        if (this.savedSchemes.length > 0) {
          Text('已保存方案')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textDim)
            .width('100%')
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.savedSchemes, (scheme: TranslationScheme) => {
              this.schemeChip(scheme)
            }, (scheme: TranslationScheme) => scheme.id)
          }
          .width('100%')
        }

        Row({ space: 10 }) {
          PillButton({
            dims: this.dims,
            label: '导入方案',
            onTap: (): void => {
              this.importTranslationScheme();
            }
          })
          PillButton({
            dims: this.dims,
            label: '导出方案',
            onTap: (): void => {
              this.exportTranslationScheme();
            }
          })
          Blank()
        }
        .width('100%')

        FieldRow({
          dims: this.dims,
          label: '方案名称',
          hint: '用于本地方案列表与导出文件名。',
          value: this.schemeNameDraft,
          placeholder: '例如：Unstable SMP · 简体 20261109',
          onChangeText: (text: string): void => {
            this.schemeNameDraft = text;
          }
        })

        SegmentRow({
          dims: this.dims,
          label: '服务商',
          hint: 'Anthropic 使用 Messages API，其余为 OpenAI 兼容。',
          values: TRANSLATION_PROVIDERS,
          labels: this.providerLabels(),
          current: this.providerDraft,
          onPick: (value: string): void => {
            this.pickProvider(value);
          }
        })

        FieldRow({
          dims: this.dims,
          label: 'API 接口地址',
          hint: '留空使用服务商默认地址。',
          value: this.endpointDraft,
          placeholder: 'https://api.deepseek.com/v1',
          onChangeText: (text: string): void => {
            this.endpointDraft = text;
          }
        })

        FieldRow({
          dims: this.dims,
          label: 'API Key',
          hint: '只保存在本机，界面默认不回显。',
          value: this.showApiKey
            ? (this.keyDraft.length > 0 ? this.keyDraft : this.store.translateApiKey)
            : this.keyDraft,
          placeholder: this.store.translateApiKey.length > 0
            ? '已保存（留空不修改）' : 'sk-…',
          password: !this.showApiKey,
          onChangeText: (text: string): void => {
            this.keyDraft = text;
          }
        })

        Row({ space: 12 }) {
          Text(this.clearKeyPending
            ? '保存方案后将清除已存 Key'
            : (this.store.translateApiKey.length > 0
              ? '已保存 API Key（仅本机）' : '尚未保存 API Key'))
            .fontSize(this.dims.miniSize)
            .fontColor(this.clearKeyPending ? HomeTokens.danger : HomeTokens.textFaint)
            .layoutWeight(1)
            .maxLines(2)
          Text(this.showApiKey ? '隐藏' : '显示')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.primary)
            .onClick((): void => {
              if (this.showApiKey) {
                if (this.keyDraft === this.store.translateApiKey) {
                  this.keyDraft = '';
                }
                this.showApiKey = false;
              } else {
                this.showApiKey = true;
              }
            })
          if (this.store.translateApiKey.length > 0) {
            Text('清除已存 Key')
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.danger)
              .onClick((): void => {
                this.clearKeyPending = true;
                this.keyDraft = '';
                this.showApiKey = false;
                this.toast('保存方案后清除已存 API Key');
              })
          }
        }
        .width('100%')

        SettingsNote({ dims: this.dims,
          text: '接口地址留空时使用服务商默认地址；API Key 只存在这台设备，'
            + '导出方案不会包含 Key。' })
      }

      SettingsCard({ dims: this.dims, title: '模型', note: '模型名称参考对应服务商的 API 文档。' }) {
        FieldRow({
          dims: this.dims,
          label: 'LLM 模型',
          value: this.modelDraft,
          placeholder: 'deepseek-chat',
          onChangeText: (text: string): void => {
            this.modelDraft = text;
          }
        })
        FieldRow({
          dims: this.dims,
          label: '采样温度',
          hint: '0–2，字幕翻译建议 0.1–0.3。',
          value: this.temperatureDraft,
          placeholder: '0.1',
          onChangeText: (text: string): void => {
            this.temperatureDraft = text;
          }
        })
        SettingsNote({ dims: this.dims,
          text: '数值越高越自由；字幕翻译建议 0.1–0.3，Anthropic 接口同样支持。' })
      }

      SettingsCard({ dims: this.dims, title: '调用参数', note: '' }) {
        FieldRow({
          dims: this.dims,
          label: '每批行数',
          hint: '5–100',
          value: this.batchSizeDraft,
          placeholder: '30',
          onChangeText: (text: string): void => {
            this.batchSizeDraft = text;
          }
        })
        FieldRow({
          dims: this.dims,
          label: '上下文行数',
          hint: '0 = 不送上下文',
          value: this.contextLinesDraft,
          placeholder: '10',
          onChangeText: (text: string): void => {
            this.contextLinesDraft = text;
          }
        })
        SettingsNote({ dims: this.dims,
          text: '每批行数越大请求越少，但行数对不上时整批要重来；'
            + '上下文行数会把前面 N 行原文 + 已定译文作为参考，不参与译法行数校验。' })
      }

      SettingsCard({ dims: this.dims, title: '术语表',
        note: '按目标语言分组，翻译时只应用当前组。' }) {
        SegmentRow({
          dims: this.dims,
          label: '分组',
          values: ['zh', 'zh-Hant', 'en'],
          labels: this.glossaryTabLabels(),
          current: this.glossaryLang,
          onPick: (value: string): void => {
            this.glossaryLang = value;
          }
        })

        Row() {
          Text('＋ 添加词条')
            .fontSize(this.dims.miniSize + 1)
            .fontColor(HomeTokens.primary)
            .width('100%')
            .textAlign(TextAlign.Center)
            .padding({ top: 10, bottom: 10 })
        }
        .width('100%')
        .borderRadius(this.dims.radiusInner)
        .backgroundColor(HomeTokens.accentGlass)
        .border({ width: 1, color: HomeTokens.primary, style: BorderStyle.Dashed })
        .onClick((): void => {
          this.addGlossaryEntry();
        })

        Row({ space: 8 }) {
          Text('原文')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textDim)
            .layoutWeight(1)
          Text(`译法 · ${this.glossaryTargetLabel()}`)
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textDim)
            .layoutWeight(1)
          Text('')
            .width(23)
        }
        .width('100%')

        if (this.glossaryEntries().length === 0) {
          Text('当前分组还没有词条。')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textFaint)
            .width('100%')
            .padding({ top: 4, bottom: 4 })
        } else {
          List({ space: 6 }) {
            ForEach(this.glossaryEntries(), (entry: GlossaryDraftEntry, index: number) => {
              ListItem() {
                this.glossaryRow(entry)
              }
            }, (entry: GlossaryDraftEntry, index: number) => `${this.glossaryLang}-${index}`)
          }
          .width('100%')
          .height(260)
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
        }
      }

      SettingsCard({ dims: this.dims, title: 'LLM 提示词', note: '随方案保存。' }) {
        TextArea({
          text: this.promptDraft,
          placeholder: '例如：你是……字幕译者。只根据英文台词与前文翻译，保留对象、否定、条件、程度、数量和说话者态度……'
        })
          .fontSize(this.dims.miniSize + 1)
          .fontColor(HomeTokens.text)
          .placeholderColor(HomeTokens.textFaint)
          .height(170)
          .width('100%')
          .padding(10)
          .backgroundColor(HomeTokens.glassFill)
          .borderRadius(this.dims.radiusInner)
          .onChange((value: string): void => {
            this.promptDraft = value;
          })
        SettingsNote({ dims: this.dims,
          text: '提示词会作为 system prompt 发送；留空使用内置字幕翻译提示。' })
      }

      SettingsCard({ dims: this.dims, title: '保存与测试', note: '' }) {
        Flex({ wrap: FlexWrap.Wrap }) {
          Row({ space: 6 }) {
            Toggle({ type: ToggleType.Switch, isOn: this.useAfterSave })
              .selectedColor(HomeTokens.primary)
              .switchPointColor(HomeTokens.onPrimary)
              .width(38)
              .height(20)
              .onChange((on: boolean): void => {
                this.useAfterSave = on;
              })
            Text('保存后使用此方案')
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.textDim)
          }
          .margin({ right: 16, bottom: 6 })

          Row({ space: 6 }) {
            Toggle({ type: ToggleType.Switch, isOn: this.autoTranslateDraft })
              .selectedColor(HomeTokens.primary)
              .switchPointColor(HomeTokens.onPrimary)
              .width(38)
              .height(20)
              .onChange((on: boolean): void => {
                this.autoTranslateDraft = on;
              })
            Text('创建稿件后自动翻译')
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.textDim)
          }
          .margin({ bottom: 6 })
        }
        .width('100%')

        Row({ space: 10 }) {
          PillButton({
            dims: this.dims,
            label: '取消',
            onTap: (): void => {
              this.resetTranslationDrafts();
            }
          })
          PillButton({
            dims: this.dims,
            label: this.testBusy ? '测试中…' : '测试 LLM 连接',
            isEnabled: !this.testBusy,
            onTap: (): void => {
              this.testLlmConnection();
            }
          })
          PillButton({
            dims: this.dims,
            label: '保存方案',
            primary: true,
            onTap: (): void => {
              this.saveTranslationScheme();
            }
          })
        }
        .width('100%')

        if (this.testResult.length > 0) {
          Text(this.testResult)
            .fontSize(this.dims.miniSize)
            .fontColor(this.testOk ? HomeTokens.success : HomeTokens.danger)
            .width('100%')
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
    }
    .width('100%')
  }

  @Builder
  proofPage() {
    Column({ space: this.dims.gap }) {
      SettingsCard({ dims: this.dims, title: '初稿', note: '' }) {
        InfoRow({ dims: this.dims, label: '逐句时间戳', value: '识别时自动生成' })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: '逐句置信度', value: '跟随识别引擎' })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: '校对建议', value: '端上暂未接入' })
      }

      SettingsCard({ dims: this.dims, title: '校对能力', note: '' }) {
        SettingsNote({ dims: this.dims, text: '电脑端的反思纠错、逐词时间重排与热词挖掘尚未迁移到 HarmonyOS。'
          + '当前可在稿件页直接修改字幕文本，修改会随项目保存。' })
      }
    }
    .width('100%')
  }

  @Builder
  downloadPage() {
    Column({ space: this.dims.gap }) {
      SettingsCard({ dims: this.dims, title: '模型下载', note: '地址指向一个 manifest.json 清单。' }) {
        InfoRow({ dims: this.dims, label: '模型状态',
          value: this.store.hasModels() ? '已就绪' : '缺少模型文件' })
        FieldRow({
          dims: this.dims,
          label: '下载清单地址',
          hint: '留空表示不提供应用内下载。',
          value: this.downloadUrlDraft,
          placeholder: 'https://…/manifest.json',
          onChangeText: (text: string): void => {
            this.downloadUrlDraft = text;
          }
        })
        SettingsNote({ dims: this.dims, text: this.store.modelStatus() })
        Row({ space: 10 }) {
          PillButton({
            dims: this.dims,
            label: this.store.isDownloading() ? '正在下载…' : '开始下载',
            primary: true,
            isEnabled: !this.store.isDownloading(),
            onTap: (): void => {
              this.saveDownloadUrl(false);
              this.store.downloadModel();
            }
          })
          PillButton({
            dims: this.dims,
            label: this.store.isDownloading() ? '取消下载' : '保存地址',
            onTap: (): void => {
              if (this.store.isDownloading()) {
                this.store.cancelModelDownload();
              } else {
                this.saveDownloadUrl(true);
              }
            }
          })
        }
        .width('100%')

        if (this.store.downloadStage.length > 0) {
          Column({ space: 6 }) {
            Progress({
              value: this.store.downloadRatio * 100,
              total: 100,
              type: ProgressType.Linear
            })
              .width('100%')
              .color(HomeTokens.primary)
              .backgroundColor(HomeTokens.glassFill)
            Text(this.store.downloadText)
              .fontSize(this.fsHint())
              .fontColor(HomeTokens.textDim)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
        }
      }

      SettingsCard({ dims: this.dims, title: '登录', note: '' }) {
        InfoRow({ dims: this.dims, label: '账号', value: '未登录' })
        SettingsNote({ dims: this.dims, text: 'HarmonyOS 端暂未接入云端账号；项目、字幕与模型都保存在本机。' })
      }
    }
    .width('100%')
  }

  private runAudioSuiteSelfTest(): void {
    if (!AudioSuiteDenoise.supported()) {
      this.toast('当前设备不支持 AudioSuite 降噪节点');
      return;
    }
    const samples = 16000;
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
      const t = i / 16000;
      const tone = Math.sin(2 * Math.PI * 440 * t) * 0.28;
      const noise = ((i % 7) - 3) * 0.012;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round((tone + noise) * 32767)));
    }
    try {
      const out = AudioSuiteDenoise.denoise(pcm.buffer as ArrayBuffer);
      this.toast(`AudioSuite 降噪自检通过：${samples} → ${out.byteLength / 2} 样本`);
    } catch (err) {
      const e = err as Error;
      this.toast(`AudioSuite 降噪自检失败：${e.message}`);
    }
  }

  @Builder
  mediaCodecCard() {
    SettingsCard({ dims: this.dims, title: '媒体编解码',
      note: '选择媒体处理链路：AVCodec 优先或 FFmpeg 优先。' }) {
      SegmentRow({
        dims: this.dims,
        label: '处理后端',
        values: [MediaCodecMode.AVCODEC, MediaCodecMode.FFMPEG],
        labels: ['AVCodec + FFmpeg', '全流程 FFmpeg'],
        current: this.codecMode,
        onPick: (value: string): void => {
          setMediaCodecMode(value);
          this.toast(value === MediaCodecMode.FFMPEG
            ? '已切到全流程 FFmpeg：AV1 处理将强制走软件链路'
            : '已切到 AVCodec + FFmpeg：优先系统硬解，FFmpeg 兜底');
        }
      })

      Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
      InfoRow({ dims: this.dims, label: '视频预览',
        value: '系统 Video · AVCodec' })
      InfoRow({ dims: this.dims, label: '音频提取',
        value: 'AVTranscoder · AVCodec' })
      InfoRow({ dims: this.dims, label: 'AV1 代理',
        value: this.codecMode === MediaCodecMode.FFMPEG
          ? '强制 FFmpeg 软解 + H.264'
          : (this.av1HardwareAvailable ? '优先 AV1 硬解' : '无硬解，走 FFmpeg') })
      InfoRow({ dims: this.dims, label: 'AV1 硬解',
        value: this.av1HardwareAvailable ? '当前设备可用' : '当前设备不可用' })
      InfoRow({ dims: this.dims, label: '视频压制 / 导出',
        value: 'AVCodec 硬编路线待接入' })

      SettingsNote({ dims: this.dims,
        text: this.codecMode === MediaCodecMode.FFMPEG
          ? '当前：全流程 FFmpeg。AV1 即使有系统硬解也走 FFmpeg，功耗更高，适合复现兼容性/画质问题。'
          : '当前：AVCodec + FFmpeg。播放、音频提取和可用硬解优先交给系统，FFmpeg 只做 AV1 无硬解时的兜底。' })
      SettingsNote({ dims: this.dims,
        text: '“全流程 FFmpeg”不会替换系统 Video 播放器；FFmpeg 播放器尚未接入。'
          + 'OH_VideoDecoder → NativeWindow/Canvas 合成 → OH_VideoEncoder 的硬编导出路线见 '
          + 'docs/MEDIA_PIPELINE.md §5。' })
      SettingsNote({ dims: this.dims,
        text: '切换后重新打开稿件生效；正在播放的视频不会中途切换解码后端。' })
    }
  }

  @Builder
  perfPage() {
    Column({ space: this.dims.gap }) {
      this.mediaCodecCard()
      SettingsCard({ dims: this.dims, title: '识别硬件',
        note: 'GPU（Vulkan）与 NPU 先只保留接口；Vulkan 尚未接入推理。' }) {
        InfoRow({ dims: this.dims, label: 'NPU', value: this.npuHardware.interfaceNote() })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: 'GPU（Vulkan）',
          value: this.vulkanHardware.interfaceNote() })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: '当前后端', value: this.store.backendLabel })
        SettingsNote({ dims: this.dims,
          text: 'NPU 推理由 MindSpore Lite 按 NPU-only 策略执行；Vulkan 仅预留 prepare/release 接口，尚未接入推理。' })
        // CPU 线程设置已按需求注释：CPU 不再作为识别硬件暴露。
        // 引擎内部仍把 cpuThreads 作为 MindSpore Lite 上下文参数使用。
      }

      SettingsCard({ dims: this.dims, title: '硬件自检', note: '加载 encoder 读取张量，确认 NPU 通路可用。' }) {
        Row({ space: 10 }) {
          PillButton({
            dims: this.dims,
            label: '运行 NPU 自检',
            onTap: (): void => {
              this.store.runNpuSelfTest();
            }
          })
          PillButton({
            dims: this.dims,
            label: 'Vulkan 接口自检',
            onTap: (): void => {
              this.toast(this.vulkanHardware.interfaceNote());
            }
          })
        }
        .width('100%')
        SettingsNote({ dims: this.dims, text: this.store.statusText })
      }

      SettingsCard({ dims: this.dims, title: '人声降噪',
        note: '华为 AudioSuite 系统降噪节点；输入 16 kHz / S16LE / 单声道 PCM。' }) {
        InfoRow({ dims: this.dims, label: '降噪节点',
          value: AudioSuiteDenoise.supported() ? '可用' : '当前设备不可用' })
        Row({ space: 10 }) {
          PillButton({
            dims: this.dims,
            label: '运行降噪自检',
            onTap: (): void => {
              this.runAudioSuiteSelfTest();
            }
          })
        }
        .width('100%')
        SettingsNote({ dims: this.dims,
          text: '自检会生成 1 秒带噪正弦波，经系统降噪节点处理后返回样本数；不写文件、不上传。' })
      }
    }
    .width('100%')
  }

  @Builder
  storagePage() {
    Column({ space: this.dims.gap }) {
      SettingsCard({ dims: this.dims, title: '应用数据', note: '模型、项目与导出都在应用沙箱内。' }) {
        InfoRow({ dims: this.dims, label: '模型', value: this.modelSize })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: '项目', value: this.projectSize })
        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        InfoRow({ dims: this.dims, label: '导出', value: this.exportSize })
        Row() {
          PillButton({
            dims: this.dims,
            label: '重新计算',
            onTap: (): void => {
              this.readStorage();
              this.toast('已重新计算');
            }
          })
        }
        .width('100%')
        .margin({ top: 2 })
      }

      SettingsCard({ dims: this.dims, title: '本机空间', note: '' }) {
        if (this.totalBytes > 0) {
          Progress({
            value: this.totalBytes > 0 ? (this.totalBytes - this.freeBytes) / this.totalBytes * 100 : 0,
            total: 100,
            type: ProgressType.Linear
          })
            .width('100%')
            .color(HomeTokens.primary)
            .backgroundColor(HomeTokens.glassFill)
          InfoRow({ dims: this.dims, label: '已用 / 总空间',
            value: `${formatBytes(this.totalBytes - this.freeBytes)} / ${formatBytes(this.totalBytes)}` })
          InfoRow({ dims: this.dims, label: '可用空间', value: formatBytes(this.freeBytes) })
        } else {
          SettingsNote({ dims: this.dims, text: '暂时无法读取本机空间信息。' })
        }
      }
    }
    .width('100%')
  }

  @Builder
  detailBody() {
    Scroll(this.dims.twoPane ? this.wideScroller : undefined) {
      Column({ space: this.dims.gap }) {
        this.detailHeader()
        if (this.currentKey() === 'asr') {
          this.asrPage()
        } else if (this.currentKey() === 'translate') {
          this.translatePage()
        } else if (this.currentKey() === 'proof') {
          this.proofPage()
        } else if (this.currentKey() === 'download') {
          this.downloadPage()
        } else if (this.currentKey() === 'perf') {
          this.perfPage()
        } else if (this.currentKey() === 'storage') {
          this.storagePage()
        } else {
          this.personalPage()
        }
      }
      .width('100%')
      .padding({
        left: this.dims.pagePaddingH,
        right: this.dims.pagePaddingH,
        top: this.dims.pagePaddingTop,
        bottom: this.dims.pagePaddingBottom
      })
    }
    .width('100%')
    .height('100%')
    .align(Alignment.TopStart)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .onDidScroll((x: number, y: number, state: ScrollState): void => {
      this.handleScroll(y, state);
    })
    .onReachStart((): void => {
      this.autoHide.reset();
      this.onBarCollapse(false);
    })
  }

  // ------------------------------------------------------------ 双栏

  /** lg 复用项目页侧栏宽度；md 折叠屏保持紧凑的 288vp。 */
  private sidebarWidth(): number {
    return this.dims.bp === Bp.LG ? projectsPanelWidth(this.dims) : 288;
  }

  @Builder
  leftPane() {
    Column({ space: 6 }) {
      Row() {
        Text('设置')
          .fontSize(this.fsTitle() - 4)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: WIDE_DRAWER_MARGIN + 4, bottom: 10 })

      Scroll() {
        Column({ space: 6 }) {
          ForEach(CATEGORY_KEYS, (key: string) => {
            Row({ space: 12 }) {
              SymbolGlyph(this.catIcon(key))
                .fontSize(21)
                .fontColor([this.sidebarKey() === key ? HomeTokens.primary : HomeTokens.textDim])
              Text(this.catTitle(key))
                .fontSize(this.fsRow())
                .fontColor(this.sidebarKey() === key ? HomeTokens.primary : HomeTokens.text)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
            }
            .width('100%')
            .height(50)
            .padding({ left: 12, right: 12 })
            .borderRadius(this.dims.radiusInner)
            .backgroundColor(this.sidebarKey() === key ? HomeTokens.accentGlass : '#00000000')
            .onClick((): void => {
              this.selectCategory(key);
            })
          }, (key: string) => key)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.TopStart)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .padding(12)
    .alignItems(HorizontalAlign.Start)
    .borderRadius(this.dims.radiusCard)
    .backgroundColor(HomeTokens.glassFill)
    .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: HomeTokens.glassEdge })
    .shadow({
      radius: 34,
      color: HomeTokens.shadow,
      offsetX: 0,
      offsetY: 18
    })
  }

  @Builder
  settingsDestination(name: string, param: object) {
    if (name === 'settings-detail') {
      NavDestination() {
        Stack({ alignContent: Alignment.TopStart }) {
          if (!this.dims.twoPane) {
            ImmersiveBackground()
          }
          this.detailBody()
        }
        .width('100%')
        .height('100%')
      }
      .hideTitleBar(true)
      // 双栏右栏需要不透明底色，避免 replace 动画时旧页从新页下面透出来；
      // 窄屏有 ImmersiveBackground 覆盖，底色只作为兜底。
      .backgroundColor(HomeTokens.base)
      .onBackPressed((): boolean => {
        if (this.dims.twoPane) {
          // 平板双栏不需要展开/收起动画：直接无动画 pop 回底层页。
          this.pageKey = this.rootKey;
          this.selected = this.rootKey;
          this.settingsStack.pop(false);
          return true;
        }
        // 窄屏返回 false 交给 Navigation 执行带默认动画的 pop。
        this.selected = '';
        return false;
      })
    }
  }

  build() {
    if (this.dims.twoPane) {
      Row({ space: WIDE_DRAWER_GAP }) {
        // 与项目页侧栏同一套几何：左右与底部 10vp、顶部让卡片伸到状态栏下，
        // 高度与项目页抽屉一致；标题用内部补白留在安全区内。
        Column() {
          this.leftPane()
        }
        .width(this.sidebarWidth() + WIDE_DRAWER_MARGIN * 2)
        .height('100%')
        .padding({
          left: WIDE_DRAWER_MARGIN,
          right: WIDE_DRAWER_MARGIN,
          bottom: WIDE_DRAWER_MARGIN
        })

        // 二级内容直接按当前分类渲染：平板双栏本来就不需要展开动画，
        // 不走 Navigation 可避免每次切页新叠一层不透明底色，也保留滚动位置。
        Column() {
          this.detailBody()
        }
        .layoutWeight(1)
        .height('100%')
      }
      .width('100%')
      .height('100%')
      .alignItems(VerticalAlign.Top)
    } else {
      // 窄屏：根页是设置分类列表，二级页由 NavPathStack push。
      // 默认 Stack 模式会从右滑入、pop 时滑出，不再手写 transition。
      Navigation(this.settingsStack) {
        this.levelOneList()
      }
      .mode(NavigationMode.Stack)
      .hideTitleBar(true)
      .hideToolBar(true)
      .navDestination(this.settingsDestination)
      .backgroundColor(Color.Transparent)
      .width('100%')
      .height('100%')
    }
  }
}
