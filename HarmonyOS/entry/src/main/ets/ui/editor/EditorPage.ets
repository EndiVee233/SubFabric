/*
 * 稿件编辑页（原生控件示意版）。
 *
 * 平板 / lg：三块 GridRow 布局
 *   左 8/12：视频播放板块（上）+ 时间轴板块（下）
 *   右 4/12：字幕 / 人物 / 设置 / 日志 / 工作量 右边栏
 * 手机 / 折叠屏 sm、md：GridCol 全部 12/12，按
 *   视频 → 时间轴 → 右边栏 的顺序纵向堆叠，外层 Scroll。
 *
 * 这一页先用原生组件画出功能区，不接真实播放器/字幕引擎；
 * 布局只读 HomeDims.bp，断点来自 @ohos.mediaquery。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { Bp, HomeDims } from '../home/HomeBreakpoints';
import { HomeTokens } from '../home/HomeTokens';
import { ImmersiveBackground } from '../home/ImmersiveBackground';
import { AppStore, ProjectMeta, SpeakerRecord } from '../../store/AppStore';
import { Cue, WordTiming, writeJson } from 'common';
import { Logger, LogEntry } from '../../engine/Logger';
import { common } from '@kit.AbilityKit';
import { curves } from '@kit.ArkUI';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { media } from '@kit.MediaKit';
import { hdsMaterial, HdsTabs, HdsTabsController } from '@kit.UIDesignKit';
import { safeFileName, ensureDir, deleteFile, writeTextFile, writeTextFileAtomic, readTextFile, fileExists, importToSandbox } from '../../platform/FileUtil';
import { AudioSuiteDenoise } from '../../engine/AudioSuiteDenoise';
import { buildEditorAss, defaultEditorOptions, normalizeEditorOptions, effectApplies } from './EditorOptions';
import { EditorSettingsPane } from './EditorSettingsPane';
import { readSubtitleSource } from '../../platform/SubtitleImporter';
import { HarmonyAudioDecoder } from '../../platform/MediaDecoder';
import {
  cancelTranscode,
  FfmpegProbe,
  hasAv1Hardware,
  isAv1,
  probeMedia,
  proxyExists,
  transcodeToH264
} from '../../engine/FfmpegMedia';
import { isFfmpegForced } from '../../engine/MediaBackend';

const TAG = 'EditorPage';
interface CueEditorPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
/** 逐词边界的竖向虚线：用固定段数组代替不存在的虚线笔刷。 */
const TIMELINE_DASHES: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** 预览用的一行字幕：中文主行 + 英文副行 + 逐词时间。 */
class PreviewWord {
  text: string = '';
  start: number = 0;
  end: number = 0;
}

class PreviewLine {
  start: number = 0;
  end: number = 0;
  chinese: string = '';
  english: string = '';
  wordTimes: PreviewWord[] = [];
  words: PreviewWord[] = [];
}

function hasCjk(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4E00 && c <= 0x9FFF) {
      return true;
    }
  }
  return false;
}

function splitWords(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(' ');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.length > 0) {
      out.push(p);
    }
  }
  return out;
}

class CueDataSource implements IDataSource {
  private cues: Cue[] = [];
  private listeners: DataChangeListener[] = [];

  setCues(cues: Cue[]): void {
    this.cues = cues.slice();
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDataReloaded();
    }
  }

  notifyChange(index: number): void {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDataChange(index);
    }
  }

  totalCount(): number {
    return this.cues.length;
  }

  getData(index: number): Cue {
    return this.cues[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const at = this.listeners.indexOf(listener);
    if (at >= 0) {
      this.listeners.splice(at, 1);
    }
  }
}

class SpeakerStat {
  name: string = '';
  count: number = 0;
  color: string = '';

  constructor(name: string, count: number, color: string = '') {
    this.name = name;
    this.count = count;
    this.color = color;
  }
}

/** 编辑页统一玻璃壳：保证 GridItem / GridCol 里能撑满高度。 */
@Component
struct EditorPanel {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop pad: number = 0;

  @BuilderParam content: () => void = this.emptyContent;

  @Builder
  emptyContent() {
  }

  build() {
    Column() {
      this.content()
    }
    .width('100%')
    .height('100%')
    .padding(this.pad)
    .borderRadius(this.dims.radiusCard)
    .backgroundColor(HomeTokens.glassFill)
    .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: HomeTokens.glassEdge })
    .clip(true)
  }
}

/** 顶部/时间轴的小胶囊按钮。 */
@Component
struct EditorPill {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop primary: boolean = false;
  @Prop compact: boolean = false;
  onTap: () => void = (): void => {};

  build() {
    Row() {
      Text(this.label)
        .fontSize(this.dims.miniSize + 1)
        .fontColor(this.primary ? HomeTokens.onPrimary : HomeTokens.text)
        .maxLines(1)
    }
    .height(this.compact ? 30 : this.dims.buttonHeight - 6)
    .padding({ left: this.compact ? 10 : 14, right: this.compact ? 10 : 14 })
    .borderRadius(this.dims.radiusPill)
    .backgroundColor(this.primary ? HomeTokens.primary : HomeTokens.glassFill)
    .border({ width: 1, color: this.primary ? '#00000000' : HomeTokens.glassEdge })
    .onClick((): void => {
      this.onTap();
    })
  }
}

@Component
struct EditorSubtitleOverlay {
  @Prop options: Record<string, string> = defaultEditorOptions();
  @Prop videoHeight: number = 540;
  @Prop cueStart: number = 0;
  @Prop cueEnd: number = 0;
  @Prop clock: number = 0;
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop chinese: string = '';
  @Prop english: string = '';
  @Prop words: PreviewWord[] = [];
  @Prop active: number = -1;
  @Prop chineseOpacity: number = 1;
  @Prop bilingual: boolean = true;
  @Prop wordHighlight: boolean = true;
  @Prop speakerColor: string = '';
  @Prop speakerName: string = '';
  @Prop englishColor: string = '';
  @Prop wordColor: string = '';

  private trackColor(lang: string): string {
    if (lang === 'zh' && this.speakerColor.length > 0) {
      return this.speakerColor;
    }
    if (lang === 'en' && this.englishColor.length > 0) {
      return this.englishColor;
    }
    return this.options[`${lang}.PrimaryColour`];
  }

  private highlightColor(): string {
    return this.wordColor.length > 0 ? this.wordColor : this.options['wordColor'];
  }
  private chineseDisplayText(): string {
    const clean = this.chinese.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
    if (this.speakerName.length === 0 || clean.length === 0) {
      return clean;
    }
    return `[${this.speakerName}] ${clean}`;
  }
  private trackSize(lang: string): number {
    return Math.max(8, Number(this.options[`${lang}.Fontsize`]) * this.videoHeight / 1080 * Number(this.options['fontScale']));
  }
  private fadeOpacity(lang: string): number {
    if (!effectApplies(this.options, 'fadein', lang)) { return 1; }
    const duration = Math.max(1, Math.min(Number(this.options['fx.fadein.duration']),
      (this.cueEnd - this.cueStart) * 1000 * Number(this.options['fx.fadein.ratio']) / 100));
    const from = Number(this.options['fx.fadein.from']) / 100;
    return from + (1 - from) * Math.max(0, Math.min(1, (this.clock - this.cueStart) * 1000 / duration));
  }

  private wordCharacterColor(word: PreviewWord, index: number, charIndex: number): string {
    if (!this.wordHighlight) { return this.trackColor('en'); }
    const highlight = this.highlightColor();
    if (this.options['karaokeMode'] !== 'karaoke') {
      return index === this.active ? highlight : this.trackColor('en');
    }
    const base = this.trackColor('en');
    if (this.clock >= word.end) { return highlight; }
    if (this.clock < word.start) { return base; }
    if (this.options['kSweep'] !== '1') { return highlight; }
    const ratio = (this.clock - word.start) / Math.max(0.01, word.end - word.start);
    return charIndex / Math.max(1, word.text.length) < ratio ? highlight : base;
  }

  private subtitleShadows(lang: string, active: boolean = false): ShadowOptions[] {
    const glow = effectApplies(this.options, 'glow', lang, active) && this.options[`fx.glow.${lang}.enabled`] === '1';
    const edge = '#000000';
    const shadows: ShadowOptions[] = [
      { radius: 0, color: edge, offsetX: 2, offsetY: 0 },
      { radius: 0, color: edge, offsetX: -2, offsetY: 0 },
      { radius: 0, color: edge, offsetX: 0, offsetY: 2 },
      { radius: 0, color: edge, offsetX: 0, offsetY: -2 },
      { radius: 3, color: '#99000000', offsetX: 0, offsetY: 3 }
    ];
    if (glow) {
      const color = this.options['fx.glow.followRole'] === '1' && this.speakerColor ? this.speakerColor : this.options[`fx.glow.${lang}.color`];
      const alpha = Math.round(Number(this.options[`fx.glow.${lang}.intensity`]) * 2.55).toString(16).padStart(2, '0');
      shadows.push({ radius: Number(this.options[`fx.glow.${lang}.radius`]), color: `#${alpha}${color.substring(1)}`, offsetX: 0, offsetY: 0 });
    }
    return shadows;
  }

  build() {
    Column() {
      if (this.chinese.length > 0 || this.english.length > 0) {
        Flex({ direction: this.options['order'] === 'en-top' ? FlexDirection.ColumnReverse : FlexDirection.Column,
          justifyContent: this.options['order'] === 'en-top' ? FlexAlign.Start : FlexAlign.End }) {
          if (this.chinese.length > 0) {
            Text(this.chineseDisplayText())
              .fontSize(this.trackSize('zh'))
              .fontFamily(this.options['zh.Fontname'])
              .fontStyle(this.options['zh.Italic'] === '0' ? FontStyle.Normal : FontStyle.Italic)
              .fontWeight(this.options['zh.Bold'] === '0' ? FontWeight.Normal : FontWeight.Bold)
              .fontColor(this.trackColor('zh'))
              .textAlign(TextAlign.Center)
              .maxLines(2)
              .opacity(this.fadeOpacity('zh'))
              .width('100%')
              .textShadow(this.subtitleShadows('zh'))
          }
          if (this.english.length > 0 && (this.bilingual || this.chinese.length === 0)) {
            if (this.words.length > 0) {
              Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Center }) {
                ForEach(this.words, (word: PreviewWord, index: number) => {
                  Text() {
                    ForEach(word.text.split(''), (char: string, charIndex: number) => {
                      Span(char).fontColor(this.wordCharacterColor(word, index, charIndex))
                    }, (char: string, charIndex: number) => `${charIndex}-${char}`)
                    Span(' ')
                  }
                    .fontSize(this.trackSize('en'))
                    .fontFamily(this.options['en.Fontname'])
                    .fontStyle(this.options['en.Italic'] === '0' ? FontStyle.Normal : FontStyle.Italic)
                    .fontWeight(this.options['en.Bold'] === '0' ? FontWeight.Normal : FontWeight.Bold)
                    .fontColor(index === this.active && this.wordHighlight
                      ? this.highlightColor() : this.trackColor('en'))
                    .textShadow(this.subtitleShadows('en', index === this.active && this.wordHighlight))
                }, (word: PreviewWord, index: number) =>
                  `${index}-${word.text}-${index === this.active ? 'on' : 'off'}`)
              }
              .width('100%')
              .opacity(this.fadeOpacity('en'))
            } else {
              Text(this.english)
                .fontSize(this.trackSize('en'))
                .fontFamily(this.options['en.Fontname'])
                .fontStyle(this.options['en.Italic'] === '0' ? FontStyle.Normal : FontStyle.Italic)
                .fontWeight(this.options['en.Bold'] === '0' ? FontWeight.Normal : FontWeight.Bold)
                .fontColor(this.trackColor('en'))
                .textAlign(TextAlign.Center)
                .maxLines(2)
                .width('100%')
                .opacity(this.fadeOpacity('en'))
                .textShadow(this.subtitleShadows('en'))
            }
          }
        }
        .width('100%')
        .height(Math.min(this.videoHeight * 0.45, this.trackSize('zh') * 2.4 + this.trackSize('en') * 2.4))
      }
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.End)
    .padding({
      left: this.dims.cardPadding,
      right: this.dims.cardPadding,
      bottom: this.dims.bp === Bp.SM ? 18 : 28
    })
    .hitTestBehavior(HitTestMode.None)
  }
}

@Component
export struct EditorPage {
  @State private videoViewportHeight: number = 540;
  @State private subtitleClock: number = 0;
  @State private editorOptions: Record<string, string> = defaultEditorOptions();
  @State private auxiliaryAudioReady: boolean = false;
  private auxiliaryAudio: media.AVPlayer | null = null;
  private auxiliaryFile: fs.File | null = null;
  private auxiliaryGeneration: number = 0;
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  @StorageProp('navIndicatorHeight') navIndicatorHeight: number = 0;

  onClose: () => void = (): void => {};

  @State private playing: boolean = false;
  @State private progress: number = 0;
  @State private note: string = '';
  @State private sidebarTab: string = '字幕';
  @State private previewTime: number = 0;
  @State private videoDuration: number = 0;
  @State private cueChineseText: string = '';
  @State private cueEnglishText: string = '';
  @State private cueWords: PreviewWord[] = [];
  @State private activeWord: number = -1;
  @State private chineseOpacity: number = 1;
  @State private videoError: string = '';
  @State private videoSrc: string = '';
  @State private waveform: number[] = [];
  @State private waveformLoading: boolean = false;
  @State private timelineZoom: number = 1;
  @State private timelinePinching: boolean = false;
  private timelinePinchOffset: number = 0;
  private timelinePinchAnchor: number = 0;
  @State private expandedTimelineIndex: number = -1;
  /** 时间轴板块实际宽度（vp），用于限制放大块不超过 2/3。 */
  @State private timelineBoardWidth: number = 0;
  /** 旧版可见范围缓存，仅旧波形背景使用；固定刻度不再依赖。 */
  @State private timelineFirstVisible: number = 0;
  @State private timelineLastVisible: number = 6;
  @State private proxyState: string = 'idle';
  @State private proxyProgress: number = 0;
  @State private proxyError: string = '';
  @State private decodeLabel: string = '';
  @State private av1Source: boolean = false;
  @State private editingCueIndex: number = -1;
  @State private selectedCueIndex: number = -1;
  @State private editTarget: string = '';
  @State private editSource: string = '';
  @State private editingPreviewWords: WordTiming[] = [];
  private probeInfo: FfmpegProbe | null = null;
  private lastCueTapIndex: number = -1;
  private lastCueTapTime: number = 0;
  private cueTapTimer: number = -1;
  private suppressCueClickUntil: number = 0;
  private videoController: VideoController = new VideoController();
  private backController: HdsTabsController = new HdsTabsController();
  private cueSource: CueDataSource = new CueDataSource();
  private timelineScroller: Scroller = new Scroller();
  private cueScroller: Scroller = new Scroller();
  @State private speakers: SpeakerStat[] = [];
  @State private autoScroll: boolean = true;
  @State private showBilingual: boolean = true;
  @State private showWordHighlight: boolean = true;
  @State private splitRoles: boolean = false;
  @State private splitPanelVisible: boolean = false;
  @State private splitPanelExpanded: boolean = false;
  /** 人物登记与弹窗：颜色跟人物走，允许添加 0 条字幕的新人物。 */
  @State private speakerRegistry: SpeakerRecord[] = [];
  @State private speakerDialogOpen: boolean = false;
  @State private speakerDialogEditing: string = '';
  @State private speakerNameDraft: string = '';
  @State private speakerColorDraft: string = '';
  private speakerColors: Map<string, string> = new Map<string, string>();
  private suppressSpeakerTapUntil: number = 0;
  private sidebarController: HdsTabsController = new HdsTabsController();
  private splitController: HdsTabsController = new HdsTabsController();
  private splitNavStack: NavPathStack = new NavPathStack();
  private readonly speakerPalette: string[] = [
    '#8FBAFF', '#FF8FB1', '#7BD88F', '#FFC857',
    '#C9BDFF', '#5FD0D8', '#FF9F6E', '#B8E0C2'
  ];
  private lastUiTick: number = 0;
  private waveformTask: number = 0;
  private timelinePinchStart: number = 1;
  private lastTimelineTapIndex: number = -1;
  private lastTimelineTapTime: number = 0;
  private timelineTapTimer: number = -1;
  @State private timelineDragCueIndex: number = -1;
  @State private timelineDragLastDelta: number = 0;
  @State private selectedTimingWord: number = 0;
  @State private timingWords: WordTiming[] = [];
  @State private timingStart: number = 0;
  @State private timingEnd: number = 0;
  @State private timingDirty: boolean = false;
  /** 逐词拖拽条的实际宽度（vp），由 onAreaChange 更新。 */
  @State private timingStripWidth: number = 1;
  @State private timingStripHeight: number = 1;
  @State private timingEndDrag: boolean = false;
  private timingEndOrigin: number = 0;
  private timingDragWordIndex: number = -1;
  private timingDragOriginStart: number = 0;
  private timingDragOriginX: number = 0;
  private timelineDragOriginStart: number = 0;
  private timelineDragOriginEnd: number = 0;
  private timelineDragScale: number = 48;
  /** 时间轴波形可见区间的重采样条数。 */
  private readonly visibleWaveBars: number = 480;
  private waveRangeStart: number = 0;
  private waveRangeEnd: number = 1;
  private ticker: number = -1;
  private baseTime: number = 0;
  private baseClock: number = 0;
  private pendingSeekTarget: number = -1;
  private pendingSeekUntil: number = 0;

  aboutToDisappear(): void {
    this.stopTicker();
    if (this.cueTapTimer >= 0) {
      clearTimeout(this.cueTapTimer);
      this.cueTapTimer = -1;
    }
    cancelTranscode();
    this.waveformTask++;
    this.releaseAuxiliaryAudio();
  }

  /**
   * Video 的 onUpdate 间隔偏大，逐词高亮会明显慢半拍。
   * 播放期间用 80ms 定时器按播放时钟插值，onUpdate 到来时再校准基准。
   */
  private startTicker(): void {
    this.stopTicker();
    this.baseTime = this.previewTime;
    this.baseClock = Date.now();
    this.ticker = setInterval((): void => {
      if (this.ticker < 0) {
        return;
      }
      const time = this.baseTime + (Date.now() - this.baseClock) / 1000;
      this.refreshActiveCue(time);
    }, 80);
  }

  private stopTicker(): void {
    if (this.ticker >= 0) {
      clearInterval(this.ticker);
      this.ticker = -1;
    }
  }

  private seekTo(seconds: number): void {
    const target = Math.max(0, seconds);
    this.pendingSeekTarget = target;
    this.pendingSeekUntil = Date.now() + 650;
    this.videoController.setCurrentTime(target, SeekMode.Accurate);
    if (this.auxiliaryAudioReady && this.auxiliaryAudio) { this.auxiliaryAudio.seek(Math.round(target * 1000)); }
    this.previewTime = target;
    this.subtitleClock = target;
    this.baseTime = target;
    this.baseClock = Date.now();
    this.refreshActiveCue(target);
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 2200 });
    } catch (err) {
      Logger.info(TAG, msg);
    }
  }

  /**
   * 重新导入字幕：旧工程只存了整行/逐词事件，没有保留 ASS 高亮标签；
   * 重新选一次源字幕即可按文件里的真实高亮事件重建行 + 逐词时间。
   */
  private async reimportSubtitle(): Promise<void> {
    const ctx: common.UIAbilityContext | null = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters = ['字幕文件|.srt,.vtt,.ass,.json'];
      const uris: string[] = await new picker.DocumentViewPicker(ctx).select(options);
      if (uris.length === 0) {
        return;
      }
      const uri = uris[0];
      const rawName = uri.substring(uri.lastIndexOf('/') + 1);
      const label = safeFileName(rawName, 'subtitle');
      const info = readSubtitleSource(uri, label, this.editorOptions['removeLineBreaks'] === '1');
      if (info.cues.length === 0) {
        this.toast('没有解析出字幕行');
        return;
      }
      this.stopTicker();
      this.store.cues = info.cues;
      this.selectedCueIndex = -1;
      this.editingCueIndex = -1;
      const project = this.store.current;
      if (project !== null) {
        project.cueCount = info.cues.length;
      }
      await this.store.saveCurrent();
      this.store.projects = this.store.projects.slice();
      this.buildPreviewLines();
      this.cueSource.setCues(this.store.cues);
      this.buildSpeakers();
      this.activeLineIndex = -1;
      this.activeWord = -1;
      this.refreshActiveCue(this.previewTime);
      if (this.playing) {
        this.startTicker();
      }
      this.toast(`已重新导入 ${info.cues.length} 行字幕`);
    } catch (err) {
      const e = err as Error;
      Logger.warn(TAG, `重新导入字幕失败：${e.message}`);
      this.toast(`导入失败：${e.message}`);
    }
  }

  private async exportAss(kind: string = 'full', speaker: string = ''): Promise<void> {
    const ctx = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    if (kind !== 'video' && this.store.cues.length === 0) {
      this.toast('当前没有可导出的字幕');
      return;
    }
    try {
      if (this.editingCueIndex >= 0) {
        await this.saveCueEdit();
        if (this.editingCueIndex >= 0) { return; }
      }
      const cues = this.store.cues.filter((c: Cue): boolean => !speaker || this.cueSpeaker(c) === speaker)
        .map((c: Cue): Cue => {
          const clone = c.clone(); clone.speaker = this.cueSpeaker(c);
          clone.speakerColor = this.cueSpeakerColor(c); return clone;
        });
      if (kind !== 'video' && cues.length === 0) { this.toast('所选人物没有字幕'); return; }
      const project = this.project();
      const suffix = kind === 'json' ? 'json' : kind === 'video' ? (project?.mediaPath.split('.').pop() || 'mp4') : 'ass';
      if (kind === 'video' && (!project || !fileExists(project.mediaPath))) { this.toast('当前稿件没有视频文件'); return; }
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [`${safeFileName(this.projectName(), 'subtitle')}_${kind}.${suffix}`];
      const uris: string[] = await new picker.DocumentViewPicker(ctx).save(options);
      if (uris.length === 0) {
        return;
      }
      if (kind === 'video' && project !== null) {
        const src = await fs.open(project.mediaPath, fs.OpenMode.READ_ONLY);
        try {
          const dst = await fs.open(uris[0], fs.OpenMode.READ_WRITE);
          try { await fs.copyFile(src.fd, dst.fd); } finally { await fs.close(dst); }
        } finally { await fs.close(src); }
      } else {
        writeTextFile(uris[0], kind === 'json' ? writeJson(cues) : buildEditorAss(cues, this.editorOptions, kind));
      }
      this.toast('文件已导出');
    } catch (err) {
      const e = err as Error;
      Logger.warn(TAG, `ASS 导出失败：${e.message}`);
      this.toast(`ASS 导出失败：${e.message}`);
    }
  }

  private previewLines: PreviewLine[] = [];
  private activeLineIndex: number = -1;

  aboutToAppear(): void {
    this.selectedCueIndex = -1;
    this.editingCueIndex = -1;
    this.loadEditorOptions();
    this.buildPreviewLines();
    this.cueSource.setCues(this.store.cues);
    const p = this.store.current;
    this.speakerRegistry = p === null ? [] : this.store.loadSpeakers(p);
    this.buildSpeakers();
    this.prepareMedia();
    this.prepareWaveform();
  }

  private editorOptionsPath(): string {
    return `${this.store.projectsDir()}/${this.store.current?.id || 'draft'}/editor-options.json`;
  }
  private loadEditorOptions(): void {
    try {
      if (fileExists(this.editorOptionsPath())) {
        this.editorOptions = normalizeEditorOptions(JSON.parse(readTextFile(this.editorOptionsPath())) as Record<string, string>);
      }
      for (const lang of ['zh', 'en']) {
        const path = this.editorOptions[`${lang}.FontFile`];
        if (path && fileExists(path)) {
          this.getUIContext().getFont().registerFont({ familyName: this.editorOptions[`${lang}.Fontname`], familySrc: `file://${path}` });
        }
      }
    } catch (err) { Logger.warn(TAG, '读取稿件样式失败'); }
  }
  private saveEditorOptions(): void {
    try {
      ensureDir(`${this.store.projectsDir()}/${this.store.current?.id || 'draft'}`);
      writeTextFileAtomic(this.editorOptionsPath(), JSON.stringify(this.editorOptions));
    } catch (err) { this.toast('稿件设置保存失败'); }
  }
  private async loadEditorFont(lang: string): Promise<void> {
    const ctx = this.store.context;
    if (!ctx) { return; }
    try {
      const opts = new picker.DocumentSelectOptions(); opts.maxSelectNumber = 1;
      opts.fileSuffixFilters = ['字体|.ttf,.otf'];
      const uris = await new picker.DocumentViewPicker(ctx).select(opts);
      if (!uris.length) { return; }
      const name = safeFileName(decodeURIComponent(uris[0].split('/').pop() || 'font.ttf'));
      const path = await importToSandbox(ctx, uris[0], `${Date.now()}_${name}`);
      const family = `SF_${lang}_${Date.now()}`;
      this.getUIContext().getFont().registerFont({ familyName: family, familySrc: `file://${path}` });
      const next = normalizeEditorOptions(this.editorOptions);
      next[`${lang}.Fontname`] = family; next[`${lang}.FontFile`] = path;
      this.editorOptions = next; this.saveEditorOptions(); this.toast('字体已载入');
    } catch (err) { this.toast(`载入字体失败：${(err as Error).message}`); }
  }
  private async replaceEditorMedia(): Promise<void> {
    const ctx = this.store.context; const p = this.project();
    if (!ctx || !p) { return; }
    try {
      const opts = new picker.DocumentSelectOptions(); opts.maxSelectNumber = 1;
      opts.fileSuffixFilters = ['视频文件|.mp4,.mkv,.webm,.mov,.m4v'];
      const uris = await new picker.DocumentViewPicker(ctx).select(opts);
      if (!uris.length) { return; }
      const name = safeFileName(decodeURIComponent(uris[0].split('/').pop() || 'video.mp4'));
      const path = await importToSandbox(ctx, uris[0], `${Date.now()}_${name}`);
      this.videoController.pause(); this.stopTicker(); this.releaseAuxiliaryAudio();
      cancelTranscode(); deleteFile(this.proxyPath());
      deleteFile(`${this.store.projectsDir()}/${p.id}/editor-audio.wav`);
      p.mediaPath = path; p.mediaName = name;
      const info = probeMedia(path); p.durationSec = info.duration;
      this.videoDuration = 0; this.previewTime = 0; this.progress = 0; this.av1Source = false;
      this.prepareMedia(); await this.store.saveCurrent(); this.prepareWaveform();
    } catch (err) { this.toast(`打开视频失败：${(err as Error).message}`); }
  }
  private releaseAuxiliaryAudio(): void {
    this.auxiliaryGeneration++;
    this.auxiliaryAudioReady = false;
    const player = this.auxiliaryAudio; const file = this.auxiliaryFile;
    this.auxiliaryAudio = null; this.auxiliaryFile = null;
    if (player) {
      player.release().catch((): void => {}).finally((): void => { if (file) { fs.closeSync(file); } });
    } else if (file) { fs.closeSync(file); }
  }
  private async useAuxiliaryAudio(path: string): Promise<void> {
    this.releaseAuxiliaryAudio();
    const generation = this.auxiliaryGeneration;
    const player = await media.createAVPlayer();
    if (generation !== this.auxiliaryGeneration) { await player.release(); return; }
    this.auxiliaryAudio = player;
    this.auxiliaryFile = fs.openSync(path, fs.OpenMode.READ_ONLY);
    player.on('stateChange', (state: string): void => {
      if (player !== this.auxiliaryAudio) { return; }
      if (state === 'initialized') { player.prepare().catch((err: Error): void => { this.toast(err.message); }); }
      if (state === 'prepared') {
        player.seek(Math.round(this.previewTime * 1000));
        this.auxiliaryAudioReady = true;
        if (this.playing) { player.play().catch((err: Error): void => { this.toast(err.message); }); }
      }
    });
    player.on('error', (): void => {
      if (player === this.auxiliaryAudio) { this.toast('降噪音频播放失败，已恢复原声'); this.releaseAuxiliaryAudio(); }
    });
    player.fdSrc = { fd: this.auxiliaryFile.fd };
  }

  private async prepareWaveform(regenerate: boolean = false): Promise<void> {
    const p = this.project();
    const context = this.store.context;
    if (p === null || p.mediaPath.length === 0 || context === null) {
      this.waveform = [];
      return;
    }
    const task = ++this.waveformTask;
    this.waveformLoading = true;
    try {
      const decoder = new HarmonyAudioDecoder();
      const transcodeDir = `${context.cacheDir}/transcode`;
      ensureDir(transcodeDir);
      decoder.setWorkDir(transcodeDir);
      const audioPath = `${this.store.projectsDir()}/${p.id}/editor-audio.wav`;
      let pcm: Float64Array;
      if (!regenerate && fileExists(audioPath) && this.editorOptions['generatedAudioMode'] === this.editorOptions['audioMode']) {
        pcm = await decoder.decodeToPcm16k(audioPath);
      } else {
        pcm = await decoder.decodeToPcm16k(p.mediaPath);
        if (task !== this.waveformTask) { return; }
        const shorts = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) { shorts[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]))); }
        let samples: ArrayBuffer = shorts.buffer as ArrayBuffer;
        if (this.editorOptions['audioMode'] === 'denoise') {
          if (!AudioSuiteDenoise.supported()) { throw new Error('设备不支持系统人声降噪'); }
          samples = AudioSuiteDenoise.denoise(samples);
          const cleaned = new Int16Array(samples); pcm = new Float64Array(cleaned.length);
          for (let i = 0; i < cleaned.length; i++) { pcm[i] = cleaned[i]; }
        }
        const wav = new ArrayBuffer(44 + samples.byteLength); const bytes = new Uint8Array(wav); const view = new DataView(wav);
        const signature = (offset: number, text: string): void => {
          for (let i = 0; i < text.length; i++) { bytes[offset + i] = text.charCodeAt(i); }
        };
        signature(0, 'RIFF'); signature(8, 'WAVE'); signature(12, 'fmt '); signature(36, 'data');
        view.setUint32(4, wav.byteLength - 8, true); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
        view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        view.setUint32(40, samples.byteLength, true); bytes.set(new Uint8Array(samples), 44);
        ensureDir(`${this.store.projectsDir()}/${p.id}`);
        const file = fs.openSync(`${audioPath}.tmp`, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
        try { fs.writeSync(file.fd, wav); } finally { fs.closeSync(file); }
        fs.renameSync(`${audioPath}.tmp`, audioPath);
        const options = normalizeEditorOptions(this.editorOptions); options['generatedAudioMode'] = options['audioMode'];
        this.editorOptions = options; this.saveEditorOptions();
      }
      if (this.editorOptions['audioMode'] === 'denoise') { await this.useAuxiliaryAudio(audioPath); }
      else { this.releaseAuxiliaryAudio(); }
      if (task !== this.waveformTask) {
        return;
      }
      const bins = this.isWide() ? 1600 : 1000;
      const step = Math.max(1, Math.floor(pcm.length / bins));
      const peaks: number[] = [];
      let maxPeak = 0;
      for (let i = 0; i < bins; i++) {
        const start = i * step;
        const end = Math.min(pcm.length, start + step);
        let peak = 0;
        let mean = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
          const sample = Math.abs(pcm[j]);
          peak = Math.max(peak, sample);
          mean += sample;
          count++;
        }
        const level = count > 0 ? peak * 0.72 + (mean / count) * 0.28 : 0;
        peaks.push(level);
        maxPeak = Math.max(maxPeak, level);
      }
      const scale = maxPeak > 0 ? 1 / maxPeak : 1;
      this.waveform = peaks.map((value: number): number => Math.min(1, Math.max(0.06, value * scale)));
    } catch (err) {
      Logger.warn(TAG, `波形提取失败：${(err as Error).message}`);
      this.waveform = [];
      if (regenerate) { this.toast(`重新生成失败：${(err as Error).message}`); }
    } finally {
      if (task === this.waveformTask) {
        this.waveformLoading = false;
      }
    }
  }

  private speakerColorForName(name: string): string {
    for (let i = 0; i < this.speakerRegistry.length; i++) {
      const s = this.speakerRegistry[i];
      if (s.name === name && s.color.length > 0) {
        return s.color;
      }
    }
    const known = this.speakerColors.get(name);
    if (known !== undefined && known.length > 0) {
      return known;
    }
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) % 1000003;
    }
    return this.speakerPalette[Math.abs(hash) % this.speakerPalette.length];
  }

  private buildSpeakers(): void {
    const counts = new Map<string, number>();
    const cueColors = new Map<string, string>();
    const cues = this.store.cues;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const name = this.cueSpeaker(cue);
      if (name.length === 0 || name === '—' || name === '未标注') {
        continue;
      }
      const prev = counts.get(name);
      counts.set(name, prev === undefined ? 1 : prev + 1);
      const cueColor = cue.speakerColor.length > 0 ? cue.speakerColor : cue.targetColor;
      if (cueColor.length > 0) {
        cueColors.set(name, cueColor);
      }
    }
    for (let i = 0; i < this.speakerRegistry.length; i++) {
      const rec = this.speakerRegistry[i];
      if (!counts.has(rec.name)) {
        counts.set(rec.name, 0);
      }
    }
    this.speakerColors = new Map<string, string>();
    const out: SpeakerStat[] = [];
    counts.forEach((count: number, name: string): void => {
      const color = cueColors.get(name) ?? this.speakerColorForName(name);
      this.speakerColors.set(name, color);
      out.push(new SpeakerStat(name, count, color));
    });
    out.sort((a: SpeakerStat, b: SpeakerStat): number => {
      // 新添加、还没标注过的人物（0 行）置顶，避免添加后要滚到底才能看到。
      if (a.count === 0 && b.count !== 0) {
        return -1;
      }
      if (b.count === 0 && a.count !== 0) {
        return 1;
      }
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.name.localeCompare(b.name);
    });
    this.speakers = out;
  }

  private currentCueIndex(): number {
    const cues = this.store.cues;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (this.previewTime >= cue.start - 0.04 && this.previewTime <= cue.end + 0.04) {
        return i;
      }
      if (cue.start > this.previewTime + 0.04) {
        break;
      }
    }
    return -1;
  }

  private nextSpeakerColor(): string {
    const used = new Set<string>();
    for (let i = 0; i < this.speakers.length; i++) {
      used.add(this.speakers[i].color.toUpperCase());
    }
    for (let i = 0; i < this.speakerPalette.length; i++) {
      if (!used.has(this.speakerPalette[i].toUpperCase())) {
        return this.speakerPalette[i];
      }
    }
    return this.speakerPalette[this.speakers.length % this.speakerPalette.length];
  }

  private nextSpeakerName(): string {
    let n = this.speakers.length + 1;
    while (this.findSpeakerIndex(`人物 ${n}`) >= 0) {
      n++;
    }
    return `人物 ${n}`;
  }

  private findSpeakerIndex(name: string): number {
    for (let i = 0; i < this.speakers.length; i++) {
      if (this.speakers[i].name === name) {
        return i;
      }
    }
    return -1;
  }

  private openSpeakerCreator(): void {
    this.speakerDialogEditing = '';
    this.speakerNameDraft = this.nextSpeakerName();
    this.speakerColorDraft = this.nextSpeakerColor();
    this.speakerDialogOpen = true;
  }

  private openSpeakerEditor(speaker: SpeakerStat): void {
    this.suppressSpeakerTapUntil = Date.now() + 450;
    this.speakerDialogEditing = speaker.name;
    this.speakerNameDraft = speaker.name;
    this.speakerColorDraft = speaker.color;
    this.speakerDialogOpen = true;
  }

  private closeSpeakerDialog(): void {
    this.speakerDialogOpen = false;
    this.speakerDialogEditing = '';
  }

  private replaceSpeakerPrefix(text: string, name: string): string {
    const re = /^\[[^\]]+\]\s*/;
    if (re.test(text)) {
      return text.replace(re, `[${name}] `);
    }
    return text;
  }

  private applySpeakerToCue(cue: Cue, name: string, color: string): void {
    const hasPrefix = /^\[[^\]]+\]\s*/.test(cue.targetText)
      || /^\[[^\]]+\]\s*/.test(cue.sourceText);
    cue.speaker = name;
    cue.speakerColor = color;
    if (hasPrefix) {
      cue.targetText = this.replaceSpeakerPrefix(cue.targetText, name);
      cue.sourceText = this.replaceSpeakerPrefix(cue.sourceText, name);
    } else if (cue.targetText.trim().length > 0) {
      cue.targetText = `[${name}] ${cue.targetText.trim()}`;
    } else if (cue.sourceText.trim().length > 0) {
      cue.sourceText = `[${name}] ${cue.sourceText.trim()}`;
    }
    cue.edited = true;
  }

  private upsertSpeakerRecord(name: string, color: string, oldName: string): void {
    const list = this.speakerRegistry.slice();
    let updated = false;
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (rec.name === oldName || rec.name === name) {
        rec.name = name;
        rec.color = color;
        updated = true;
      }
    }
    if (!updated) {
      list.push(new SpeakerRecord(name, color));
    }
    this.speakerRegistry = list;
    const p = this.store.current;
    if (p !== null) {
      this.store.saveSpeakers(p, this.speakerRegistry);
    }
  }

  private assignSpeaker(speaker: SpeakerStat): void {
    if (Date.now() < this.suppressSpeakerTapUntil) {
      return;
    }
    const index = this.selectedCueIndex >= 0 ? this.selectedCueIndex : this.currentCueIndex();
    if (index < 0) {
      this.toast('请先定位到一句字幕，再点人物标注');
      return;
    }
    const cue = this.store.cues[index];
    this.applySpeakerToCue(cue, speaker.name, speaker.color);
    this.buildPreviewLines();
    this.cueSource.setCues(this.store.cues);
    this.buildSpeakers();
    this.refreshActiveCue(this.previewTime);
    this.store.saveCurrent().catch((err: Error): void => {
      this.toast(`保存人物标注失败：${err.message}`);
    });
    this.toast(`已将当前句标注为「${speaker.name}」`);
  }

  private requestDeleteSpeaker(): void {
    const name = this.speakerDialogEditing;
    if (name.length === 0) {
      return;
    }
    this.getUIContext().showAlertDialog({
      title: '删除人物',
      message: `确定删除「${name}」？它在当前项目字幕里的标注会被清除，字幕文本不会删除。`,
      autoCancel: true,
      primaryButton: {
        value: '取消',
        action: (): void => {
        }
      },
      secondaryButton: {
        value: '删除',
        fontColor: HomeTokens.danger,
        action: (): void => {
          this.deleteSpeaker(name);
        }
      }
    });
  }

  private deleteSpeaker(name: string): void {
    const cues = this.store.cues;
    let changed = false;
    const prefix = `[${name}]`;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (this.cueSpeaker(cue) !== name) {
        continue;
      }
      if (cue.targetText.startsWith(prefix)) {
        cue.targetText = cue.targetText.substring(prefix.length).trim();
      }
      if (cue.sourceText.startsWith(prefix)) {
        cue.sourceText = cue.sourceText.substring(prefix.length).trim();
      }
      cue.speaker = '';
      cue.speakerColor = '';
      changed = true;
    }
    const remain = this.speakerRegistry.filter((s: SpeakerRecord): boolean => s.name !== name);
    this.speakerRegistry = remain;
    const p = this.store.current;
    if (p !== null) {
      this.store.saveSpeakers(p, this.speakerRegistry);
    }
    if (changed) {
      this.buildPreviewLines();
      this.cueSource.setCues(cues);
      this.refreshActiveCue(this.previewTime);
      this.store.saveCurrent().catch((err: Error): void => {
        this.toast(`保存字幕失败：${err.message}`);
      });
    }
    this.buildSpeakers();
    this.closeSpeakerDialog();
    this.toast(`已删除人物「${name}」`);
  }

  private saveSpeakerDialog(): void {
    const name = this.speakerNameDraft.trim();
    if (name.length === 0) {
      this.toast('人物名称不能为空');
      return;
    }
    const color = this.speakerColorDraft;
    const oldName = this.speakerDialogEditing;
    if (oldName.length === 0) {
      if (this.findSpeakerIndex(name) >= 0) {
        this.toast(`人物「${name}」已存在`);
        return;
      }
      this.upsertSpeakerRecord(name, color, '');
      this.buildSpeakers();
      this.closeSpeakerDialog();
      this.toast(`已添加人物「${name}」`);
      return;
    }
    const existing = this.findSpeakerIndex(name);
    if (name !== oldName && existing >= 0) {
      this.toast(`人物「${name}」已存在`);
      return;
    }
    const cues = this.store.cues;
    let changed = false;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (this.cueSpeaker(cue) !== oldName) {
        continue;
      }
      const hadPrefix = /^\[[^\]]+\]\s*/.test(cue.targetText)
        || /^\[[^\]]+\]\s*/.test(cue.sourceText);
      cue.speaker = name;
      cue.speakerColor = color;
      if (hadPrefix) {
        cue.targetText = this.replaceSpeakerPrefix(cue.targetText, name);
        cue.sourceText = this.replaceSpeakerPrefix(cue.sourceText, name);
      }
      changed = true;
    }
    this.upsertSpeakerRecord(name, color, oldName);
    if (changed) {
      this.buildPreviewLines();
      this.cueSource.setCues(cues);
      this.refreshActiveCue(this.previewTime);
      this.store.saveCurrent().catch((err: Error): void => {
        this.toast(`保存人物失败：${err.message}`);
      });
    }
    this.buildSpeakers();
    this.closeSpeakerDialog();
    this.toast(name === oldName ? '人物颜色已更新' : `人物已改名为「${name}」`);
  }

  /**
   * 导入的 ASS 往往是「中文整行 + 英文逐词事件」：每个英文事件都带整行文本，
   * 只是起止时间落在某个词上。这里按时间重叠把事件合成一行，中文作为主行，
   * 英文按事件顺序回填到词上，预览时才能做逐词高亮。
   */
  private buildPreviewLines(): void {
    this.previewLines = [];
    const cues: Cue[] = this.store.cues;
    let line: PreviewLine | null = null;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      // 新导入的字幕已经是一行一条，逐词时间直接来自 ASS 文件，不需要再猜。
      if (cue.words.length > 0) {
        const clean = new PreviewLine();
        clean.start = cue.start;
        clean.end = cue.end;
        const src = cue.sourceText.trim();
        const tgt = cue.targetText.trim();
        if (src.length > 0) {
          if (hasCjk(src)) {
            clean.chinese = src;
          } else {
            clean.english = src;
          }
        }
        if (tgt.length > 0) {
          if (hasCjk(tgt)) {
            if (tgt.length > clean.chinese.length) {
              clean.chinese = tgt;
            }
          } else if (clean.english.length === 0) {
            clean.english = tgt;
          }
        }
        for (let k = 0; k < cue.words.length; k++) {
          const word = new PreviewWord();
          word.text = cue.words[k].text;
          word.start = cue.words[k].start;
          word.end = cue.words[k].end;
          clean.words.push(word);
        }
        clean.start = Math.min(clean.start, clean.words[0].start);
        clean.end = Math.max(clean.end, clean.words[clean.words.length - 1].end);
        this.previewLines.push(clean);
        continue;
      }
      const text = (cue.sourceText.length > 0 ? cue.sourceText : cue.targetText).trim();
      if (text.length === 0) {
        continue;
      }
      const cjk = hasCjk(text);
      if (line === null || cue.start > line.end + 0.08) {
        line = new PreviewLine();
        line.start = cue.start;
        line.end = cue.end;
        this.previewLines.push(line);
      } else {
        line.start = Math.min(line.start, cue.start);
        line.end = Math.max(line.end, cue.end);
      }
      if (cjk) {
        if (text.length > line.chinese.length) {
          line.chinese = text;
        }
      } else {
        if (text.length > line.english.length) {
          line.english = text;
        }
        // 整行英文事件通常跨整行；逐词事件带整行文本，只是时间落在某个词上。
        if (cue.end - cue.start < 1.6) {
          const word = new PreviewWord();
          word.text = text;
          word.start = cue.start;
          word.end = cue.end;
          line.wordTimes.push(word);
        }
      }
    }
    for (let i = 0; i < this.previewLines.length; i++) {
      this.finalizeLine(this.previewLines[i]);
    }
  }

  /** 只使用字幕文件里真实存在的逐词事件；映射不唯一时宁可不亮，也不均分造时间。 */
  private finalizeLine(line: PreviewLine): void {
    if (line.words.length > 0) {
      // 已经是新导入的干净行：逐词时间直接来自 ASS，不需要再推导。
      return;
    }
    if (line.english.length === 0) {
      return;
    }
    const parts = splitWords(line.english);
    if (parts.length === 0) {
      return;
    }
    const target = line.english.trim();
    const unique: PreviewWord[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < line.wordTimes.length; i++) {
      const w = line.wordTimes[i];
      // 同一行里可能混入下一句或另一种样式的英文事件；只认文本完全一致的事件。
      if (w.text.trim() !== target) {
        continue;
      }
      const key = `${w.start.toFixed(3)}|${w.end.toFixed(3)}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(w);
      }
    }
    if (unique.length !== parts.length) {
      // 文件没有给出可一一对应的逐词时间：保持整行显示，不伪造高亮。
      line.words = [];
      return;
    }
    const words: PreviewWord[] = [];
    for (let i = 0; i < parts.length; i++) {
      const w = new PreviewWord();
      w.text = parts[i];
      w.start = unique[i].start;
      w.end = unique[i].end;
      words.push(w);
    }
    line.words = words;
  }

  private readonly clipLabels: string[] = [
    '神秘小矮人对战', '1985 年 苏联拥有约', '49800 门火炮', '4100 架作战与',
    '然后我们', '当时 莫斯科是', '现在 Wenn', '苏联边境'
  ];
  private readonly clipSources: string[] = [
    '神秘小矮人对战乔叔?', '1985 年 苏联拥有约 52600 辆主战坦克',
    '49800 门火炮 迫击炮和火箭发射器', '4100 架作战与支援直升机',
    '然后我们', '当时 莫斯科是', '现在 Wenn', '苏联边境'
  ];
  private readonly clipTargets: string[] = [
    'The Purple Guy vs Uncle Joe', 'In 1985 the Soviet Union possessed around 52,600',
    '49,800 artillery pieces and rocket launchers', '4,100 combat and support helicopters',
    'Now before', 'The Soviet', 'Now', 'Border'
  ];
  private readonly cueTimes: string[] = [
    '00:00:00.600', '00:00:04.600', '00:00:09.480', '00:00:13.420', '00:00:16.880'
  ];
  private readonly cueDurations: string[] = ['4.000s', '4.880s', '3.940s', '3.460s', '2.660s'];
  private readonly cueSources: string[] = [
    '神秘小矮人对战乔叔? 和他那些怪人 谁会赢?',
    '1985 年 苏联拥有约 52600 辆主战坦克',
    '49800 门火炮 迫击炮和火箭发射器',
    '4100 架作战与支援直升机',
    '以及 1400 枚洲际弹道导弹'
  ];
  private readonly cueTargets: string[] = [
    'The Purple Guy vs Uncle Joe and his band of misfits — who would win',
    'In 1985 the Soviet Union possessed around 52,600 main battle tanks',
    '49,800 artillery pieces, mortars and rocket launchers',
    '4,100 combat and support helicopters',
    'and 1,400 intercontinental ballistic missiles'
  ];
  private readonly cueConfidence: number[] = [75, 84, 81, 81, 80];
  private readonly sidebarTabNames: string[] = ['字幕', '人物', '设置', '日志', '工作量'];
  private readonly rulerLabels: string[] = ['00:00', '00:05', '00:10', '00:15', '00:20', '00:25'];

  // ------------------------------------------------------------ 断点 / 尺寸

  private isWide(): boolean {
    return this.dims.bp === Bp.LG;
  }

  private gap(): number {
    return this.dims.bp === Bp.SM ? 8 : (this.isWide() ? 14 : 10);
  }

  private project(): ProjectMeta | null {
    return this.store.current;
  }

  private projectName(): string {
    const p = this.project();
    return p !== null && p.name.length > 0 ? p.name : '未命名稿件';
  }

  private mediaName(): string {
    const p = this.project();
    if (p === null || p.mediaName.length === 0) {
      return '未关联媒体';
    }
    return p.mediaName;
  }

  private cueCount(): number {
    return this.store.cues.length;
  }

  private wordCueCount(): number {
    let count = 0;
    for (let i = 0; i < this.store.cues.length; i++) {
      if (this.store.cues[i].words.length > 0) {
        count++;
      }
    }
    return count;
  }

  /** 编辑页真实媒体：沙箱路径转成 Video 组件认识的 file://bundle/sandboxPath。 */
  private mediaSrc(): string {
    const p = this.project();
    if (p === null || p.mediaPath.length === 0) {
      return '';
    }
    return `file://com.subfabric.harmony${p.mediaPath}`;
  }

  private sandboxSrc(path: string): string {
    return `file://com.subfabric.harmony${path}`;
  }

  private proxyPath(): string {
    const p = this.project();
    if (p === null) {
      return '';
    }
    return `${this.store.projectsDir()}/${p.id}/proxy_av1_h264.mp4`;
  }

  /** 播放源：默认原片；AV1 无系统硬解时切到 FFmpeg 生成的 H.264 代理。 */
  private prepareMedia(): void {
    const p = this.project();
    if (p === null || p.mediaPath.length === 0) {
      this.videoSrc = '';
      this.proxyState = 'idle';
      return;
    }
    const original = this.mediaSrc();
    this.videoSrc = original;
    this.proxyState = 'probing';
    this.proxyError = '';
    const probe = probeMedia(p.mediaPath);
    this.probeInfo = probe;
    Logger.info(TAG, `媒体探测：${probe.ok ? probe.videoCodec : probe.error} ` +
      `${probe.width}x${probe.height} ${probe.fps.toFixed(2)}fps`);
    if (!isAv1(probe)) {
      this.proxyState = 'idle';
      this.decodeLabel = probe.ok && probe.videoCodec.length > 0
        ? `${probe.videoCodec.toUpperCase()} · 系统解码` : '';
      return;
    }
    this.av1Source = true;
    // 设置页选择「全流程 FFmpeg」时，即使系统有 AV1 硬解也走 FFmpeg 代理，
    // 方便对比兼容性/画质与功耗；默认 AVCodec 模式优先系统硬解。
    if (!isFfmpegForced() && hasAv1Hardware()) {
      this.proxyState = 'idle';
      this.decodeLabel = 'AV1 · 硬件解码';
      return;
    }
    const backendNote = isFfmpegForced() ? 'AV1 · FFmpeg（按设置）' : 'AV1 · 软件代理';
    const proxy = this.proxyPath();
    if (proxy.length > 0 && proxyExists(proxy)) {
      const cached = probeMedia(proxy);
      if (cached.ok && cached.width > 0 && cached.height > 0) {
        this.videoSrc = this.sandboxSrc(proxy);
        this.proxyState = 'ready';
        this.decodeLabel = backendNote;
        return;
      }
      deleteFile(proxy);
    }
    this.startProxy(proxy);
  }

  private async startProxy(proxy: string): Promise<void> {
    const p = this.project();
    if (p === null || proxy.length === 0) {
      return;
    }
    if (this.proxyState === 'transcoding') {
      return;
    }
    this.proxyState = 'transcoding';
    this.proxyProgress = 0;
    this.proxyError = '';
    this.decodeLabel = isFfmpegForced() ? 'AV1 · FFmpeg（按设置）' : 'AV1 · 软件解码';
    try {
      ensureDir(`${this.store.projectsDir()}/${p.id}`);
      const output = await transcodeToH264(p.mediaPath, proxy, 720, 1800,
        (percent: number): void => {
          if (percent > this.proxyProgress) {
            this.proxyProgress = percent;
          }
        });
      const outProbe = probeMedia(output);
      if (!outProbe.ok || outProbe.width <= 0 || outProbe.height <= 0) {
        throw new Error('代理没有有效视频轨');
      }
      this.videoSrc = this.sandboxSrc(output);
      this.previewTime = 0;
      this.progress = 0;
      this.videoDuration = 0;
      this.activeLineIndex = -1;
      this.activeWord = -1;
      this.cueChineseText = '';
      this.cueEnglishText = '';
      this.cueWords = [];
      this.proxyState = 'ready';
      this.decodeLabel = isFfmpegForced() ? 'AV1 · FFmpeg 代理（按设置）' : 'AV1 · 软件代理';
      Logger.info(TAG, `AV1 代理已就绪：${output}`);
    } catch (err) {
      const e = err as Error;
      this.proxyState = 'failed';
      this.proxyError = `AV1 软件解码失败：${e.message}`;
      this.videoSrc = this.mediaSrc();
      this.decodeLabel = isFfmpegForced() ? 'AV1 · FFmpeg 失败' : 'AV1 · 软件解码失败';
      Logger.warn(TAG, this.proxyError);
    }
  }

  private playDuration(): number {
    if (this.videoDuration > 0) {
      return this.videoDuration;
    }
    const p = this.project();
    return p !== null ? p.durationSec : 0;
  }

  private clock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const pad = (v: number): string => v < 10 ? `0${v}` : `${v}`;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  private clockMillis(seconds: number): string {
    const safe = Math.max(0, seconds);
    const whole = Math.floor(safe);
    const millis = Math.min(999, Math.floor((safe - whole) * 1000 + 0.0001));
    const s = whole % 60;
    const m = Math.floor(whole / 60) % 60;
    const h = Math.floor(whole / 3600);
    const pad = (v: number, width: number): string => {
      const value = `${v}`;
      return value.length >= width ? value : `${'0'.repeat(width - value.length)}${value}`;
    };
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(millis, 3)}`;
  }

  /** 按播放时间在合并后的行里二分查找，并计算当前高亮词。 */
  private refreshActiveCue(time: number): void {
    this.subtitleClock = time;
    let index = -1;
    let lo = 0;
    let hi = this.previewLines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.previewLines[mid].start <= time) {
        index = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const line: PreviewLine | null = index >= 0 && time <= this.previewLines[index].end + 0.12
      ? this.previewLines[index] : null;
    if (index !== this.activeLineIndex) {
      this.activeLineIndex = index;
      if (line === null) {
        this.cueChineseText = '';
        this.cueEnglishText = '';
        this.cueWords = [];
        this.chineseOpacity = 1;
      } else {
        this.cueChineseText = line.chinese;
        this.cueEnglishText = line.english;
        this.cueWords = line.words;
        // 对应 ASS 中文字幕行的 \fade(...,300,300,300)。
        // 颜色和字幕内容在同一帧更新，避免淡入动画造成短暂的无色字幕帧。
        this.chineseOpacity = 1;
        if (this.autoScroll && this.timelineDragCueIndex < 0 && !this.timelinePinching &&
            this.expandedTimelineIndex < 0 && index < this.store.cues.length &&
            this.store.cues[index].words.length > 0) {
          try {
            this.cueScroller.scrollToIndex(index, true, ScrollAlign.CENTER);
          } catch (err) {
            // 字幕 Tab 未挂载时忽略
          }
          try {
            this.timelineScroller.scrollToIndex(index, true, ScrollAlign.CENTER);
          } catch (err) {
            // 时间轴尚未布局时忽略
          }
        }
      }
    }
    let active = -1;
    if (line !== null) {
      for (let i = 0; i < line.words.length; i++) {
        const word = line.words[i];
        if (time >= word.start - 0.05 && time <= word.end + 0.05) {
          active = i;
          break;
        }
      }
    }
    if (active !== this.activeWord) {
      this.activeWord = active;
    }
    const editingIndex = this.activeOverlayCueIndex();
    if (editingIndex === this.editingCueIndex) {
      this.cueChineseText = this.editTarget;
      this.cueEnglishText = this.editSource;
      this.cueWords = this.editingPreviewLineWords();
    }
  }

  private videoHeight(): number {
    const viewportWidth = Math.max(280, this.dims.widthVp - this.dims.pagePaddingH * 2);
    const viewportHeight = Math.round(viewportWidth * 9 / 16);
    const controlsHeight = this.dims.bp === Bp.SM ? 72 : 84;
    return viewportHeight + controlsHeight;
  }

  private timelineHeight(): number {
    return this.isWide() ? 220 : (this.dims.bp === Bp.SM ? 228 : 240);
  }

  private sidebarHeight(): number {
    return this.dims.bp === Bp.SM ? 540 : 580;
  }

  // ------------------------------------------------------------ 顶栏

  private backSize(): number {
    return this.isWide() ? 46 : 40;
  }

  @Builder
  backTab() {
    Column() {
      SymbolGlyph($r('sys.symbol.chevron_left'))
        .fontSize(this.backSize() * 0.5)
        .fontColor([HomeTokens.text])
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .accessibilityText('返回项目')
  }

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
      // 等本次点击的抬起事件完全消费后再关闭，避免同一击穿到项目页 ☰
      setTimeout((): void => {
        this.onClose();
      }, 60);
    })
    .width(this.backSize())
    .height(this.backSize())
    .borderRadius(this.backSize() / 2)
    .clip(true)
  }

  @Builder
  topBar() {
    Row({ space: this.gap() }) {
      this.backButton()

      Column({ space: 1 }) {
        Text('SubFabric')
          .fontSize(this.dims.miniSize)
          .letterSpacing(0.8)
          .fontColor(HomeTokens.primary)
        Text(this.projectName())
          .fontSize(this.isWide() ? this.dims.titleSize : this.dims.bodySize + 2)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (this.dims.bp !== Bp.SM) {
        Row({ space: 5 }) {
          Text('●')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.success)
          Text(`已保存 · ${this.cueCount()} 句`)
            .fontSize(this.dims.miniSize + 1)
            .fontColor(HomeTokens.textDim)
            .maxLines(1)
        }
      }

      if (this.isWide()) {
        EditorPill({
          dims: this.dims,
          label: '全局设置',
          onTap: (): void => {
            // 设置页入口预留
          }
        })
      }
      EditorPill({
        dims: this.dims,
        label: '导出',
        primary: true,
        onTap: (): void => {
          this.exportAss();
        }
      })
    }
    .width('100%')
    .height(this.isWide() ? 58 : 50)
    .alignItems(VerticalAlign.Center)
  }

  // ------------------------------------------------------------ 视频板块

  @Builder
  proxyProgressBoard() {
    Column({ space: 10 }) {
      LoadingProgress()
        .width(42)
        .height(42)
        .color(HomeTokens.primary)
      Text('AV1 软件解码中')
        .fontSize(this.dims.bodySize + 2)
        .fontWeight(FontWeight.Medium)
        .fontColor(HomeTokens.text)
      Text(`${this.proxyProgress}%`)
        .fontSize(this.dims.titleSize)
        .fontColor(HomeTokens.primary)
      Progress({ value: this.proxyProgress, total: 100, type: ProgressType.Linear })
        .width('62%')
        .height(4)
        .color(HomeTokens.primary)
        .backgroundColor(HomeTokens.glassFillStrong)
      Text('系统没有 AV1 硬件解码器，正在用随包 FFmpeg 生成 H.264 代理，完成后自动播放。')
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.textDim)
        .textAlign(TextAlign.Center)
        .maxLines(2)
        .padding({ left: 24, right: 24 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  videoBoard() {
    Column() {
      EditorPanel({ dims: this.dims, pad: 0 }) {
        Column() {
          Stack({ alignContent: Alignment.Center }) {
            if (this.proxyState === 'transcoding') {
              this.proxyProgressBoard()
            } else if (this.videoSrc.length > 0) {
              Video({ src: this.videoSrc, controller: this.videoController })
                .width('100%')
                .height('100%')
                .objectFit(ImageFit.Contain)
                .controls(false)
                .autoPlay(false)
                .muted(this.auxiliaryAudioReady)
                .onPrepared((event: PreparedInfo): void => {
                  this.videoDuration = event.duration;
                  this.videoError = '';
                })
                .onUpdate((event: PlaybackInfo): void => {
                  if (this.pendingSeekTarget >= 0) {
                    const seekDelta = Math.abs(event.time - this.pendingSeekTarget);
                    if (Date.now() < this.pendingSeekUntil &&
                        (event.time < this.pendingSeekTarget - 0.005 || seekDelta > 0.28)) {
                      return;
                    }
                    this.pendingSeekTarget = -1;
                    this.pendingSeekUntil = 0;
                  }
                  if (this.auxiliaryAudioReady && this.auxiliaryAudio &&
                      Math.abs(this.auxiliaryAudio.currentTime / 1000 - event.time) > 0.3) {
                    this.auxiliaryAudio.seek(Math.round(event.time * 1000));
                  }
                  // 字幕按词边界更新；时间码 / 进度条限制到 4Hz，避免每帧重建整页。
                  this.baseTime = event.time;
                  this.baseClock = Date.now();
                  this.refreshActiveCue(event.time);
                  const now = Date.now();
                  if (now - this.lastUiTick < 250) {
                    return;
                  }
                  this.lastUiTick = now;
                  this.previewTime = event.time;
                  const total = this.playDuration();
                  this.progress = total > 0 ? Math.min(100, event.time / total * 100) : 0;
                })
                .onStart((): void => {
                  this.playing = true;
                  if (this.auxiliaryAudioReady && this.auxiliaryAudio) { this.auxiliaryAudio.play(); }
                  this.startTicker();
                })
                .onPause((): void => {
                  this.playing = false;
                  if (this.auxiliaryAudioReady && this.auxiliaryAudio) { this.auxiliaryAudio.pause(); }
                  this.stopTicker();
                })
                .onFinish((): void => {
                  this.playing = false;
                  if (this.auxiliaryAudioReady && this.auxiliaryAudio) { this.auxiliaryAudio.pause(); }
                  this.stopTicker();
                })
                .onError((): void => {
                  this.stopTicker();
                  if (this.av1Source && this.proxyState !== 'transcoding' &&
                      this.proxyState !== 'ready') {
                    // 系统 AV1 硬解实际不可用：同一页内切到 FFmpeg 软件代理。
                    this.videoError = '系统无法解码 AV1，正在切换软件解码…';
                    this.startProxy(this.proxyPath());
                    return;
                  }
                  this.videoError = this.proxyState === 'failed'
                    ? this.proxyError : '视频无法解码，请检查编码格式';
                })

              // 实时字幕：拆成独立子组件，逐词高亮只刷新这一小块，不重建整页。
              EditorSubtitleOverlay({
                dims: this.dims,
                chinese: this.cueChineseText,
                english: this.cueEnglishText,
                words: this.cueWords,
                active: this.activeWord,
                chineseOpacity: this.chineseOpacity,
                bilingual: this.showBilingual,
                wordHighlight: this.showWordHighlight,
                speakerColor: this.activeCueSpeakerColor(),
                speakerName: this.activeCueSpeakerName(),
                englishColor: this.activeCueSourceColor(),
                wordColor: this.activeCueWordColor(),
                options: this.editorOptions, videoHeight: this.videoViewportHeight,
                clock: this.subtitleClock,
                cueStart: this.activeLineIndex >= 0 ? this.previewLines[this.activeLineIndex].start : 0,
                cueEnd: this.activeLineIndex >= 0 ? this.previewLines[this.activeLineIndex].end : 0
              })

              if (this.videoError.length > 0) {
                Text(this.videoError)
                  .fontSize(this.dims.miniSize + 1)
                  .fontColor(HomeTokens.danger)
                  .padding(8)
                  .borderRadius(this.dims.radiusInner)
                  .backgroundColor(HomeTokens.scrim)
              }
            } else {
              Column({ space: this.dims.gap / 2 }) {
                Text('▶')
                  .fontSize(this.isWide() ? 44 : 30)
                  .fontColor(HomeTokens.text)
                  .opacity(0.42)
                Text('视频播放区')
                  .fontSize(this.isWide() ? this.dims.titleSize : this.dims.bodySize + 2)
                  .fontColor(HomeTokens.text)
                Text(this.mediaName())
                  .fontSize(this.dims.miniSize + 1)
                  .fontColor(HomeTokens.textDim)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }
              .alignItems(HorizontalAlign.Center)
              .padding({ left: 16, right: 16 })
            }
          }
          .width('100%')
          .layoutWeight(1)
          .backgroundColor('#E6000000')
          .onAreaChange((_old: Area, area: Area): void => { this.videoViewportHeight = Number(area.height); })

          this.videoControls()
        }
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  videoControls() {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        Text(this.clock(this.previewTime))
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
        Slider({ value: this.progress, min: 0, max: 100, step: 1 })
          .layoutWeight(1)
          .selectedColor(HomeTokens.primary)
          .trackColor(HomeTokens.glassFillStrong)
          .blockColor(HomeTokens.primary)
          .onChange((value: number): void => {
            this.progress = value;
            if (this.videoSrc.length > 0 && this.playDuration() > 0) {
              this.seekTo(value / 100 * this.playDuration());
            }
          })
        Text(this.clock(this.playDuration()))
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
      }
      .width('100%')

      Row({ space: this.dims.bp === Bp.SM ? 8 : 12 }) {
        SymbolGlyph($r('sys.symbol.backward_end_fill'))
          .fontSize(this.isWide() ? 20 : 18)
          .fontColor([HomeTokens.textDim])
          .padding(5)
          .accessibilityText('上一帧')
          .onClick((): void => {
            if (this.videoSrc.length > 0) {
              this.seekTo(Math.max(0, this.previewTime - 1 / 30));
            }
          })
        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph(this.playing ? $r('sys.symbol.pause_fill') : $r('sys.symbol.play_fill'))
            .fontSize(this.isWide() ? 19 : 16)
            .fontColor([HomeTokens.onPrimary])
            .accessibilityText(this.playing ? '暂停' : '播放')
        }
        .width(this.isWide() ? 38 : 34)
        .height(this.isWide() ? 38 : 34)
        .borderRadius(this.isWide() ? 19 : 17)
        .backgroundColor(HomeTokens.primary)
        .onClick((): void => {
          if (this.videoSrc.length > 0) {
            if (this.playing) {
              this.videoController.pause();
              this.stopTicker();
            } else {
              this.videoController.start();
              this.startTicker();
            }
          } else {
            this.playing = !this.playing;
          }
        })
        SymbolGlyph($r('sys.symbol.forward_end_fill'))
          .fontSize(this.isWide() ? 20 : 18)
          .fontColor([HomeTokens.textDim])
          .padding(5)
          .accessibilityText('下一帧')
          .onClick((): void => {
            if (this.videoSrc.length > 0) {
              const limit = this.playDuration();
              const next = this.previewTime + 1 / 30;
              this.seekTo(limit > 0 ? Math.min(limit, next) : next);
            }
          })
        Text('1x')
          .fontSize(this.dims.miniSize + 1)
          .fontColor(HomeTokens.text)
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .borderRadius(this.dims.radiusPill)
          .backgroundColor(HomeTokens.glassFill)
          .hitTestBehavior(HitTestMode.Block)
        if (this.decodeLabel.length > 0) {
          Text(this.decodeLabel)
            .fontSize(this.dims.miniSize - 1)
            .fontColor(this.proxyState === 'ready' ? HomeTokens.success :
              (this.proxyState === 'failed' ? HomeTokens.danger : HomeTokens.tertiary))
            .maxLines(1)
            .padding({ left: 7, right: 7, top: 3, bottom: 3 })
            .borderRadius(this.dims.radiusPill)
            .backgroundColor(HomeTokens.tertiaryGlass)
        }
        Blank()
        SymbolGlyph($r('sys.symbol.speaker_wave_2_fill'))
          .fontSize(this.isWide() ? 18 : 16)
          .fontColor([HomeTokens.textDim])
          .accessibilityText('音量')
        Slider({ value: 70, min: 0, max: 100, step: 1 })
          .width(this.isWide() ? 90 : 56)
          .selectedColor(HomeTokens.primary)
          .trackColor(HomeTokens.glassFillStrong)
          .blockColor(HomeTokens.primary)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: this.dims.cardPadding, right: this.dims.cardPadding, top: 4, bottom: 8 })
  }

  // ------------------------------------------------------------ 时间轴板块

  @Builder
  timelineRuler() {
    Row() {
      ForEach(this.rulerLabels, (label: string, index: number) => {
        Column({ space: 2 }) {
          Column()
            .width(1)
            .height(5)
            .backgroundColor(HomeTokens.glassEdge)
          Text(label)
            .fontSize(this.dims.miniSize - 1)
            .fontColor(HomeTokens.textFaint)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }, (label: string, index: number) => `${index}-${label}`)
    }
    .width('100%')
    .padding({ left: 0, right: 8 })
  }

  /** 当前可见字幕块覆盖的时间范围 [start, end]。 */
  private timelineVisibleRange(): number[] {
    const cues = this.store.cues;
    if (cues.length === 0) {
      return [0, Math.max(0.01, this.playDuration())];
    }
    const first = Math.max(0, Math.min(cues.length - 1, this.timelineFirstVisible));
    const last = Math.max(first, Math.min(cues.length - 1, this.timelineLastVisible));
    let start = cues[first].start;
    let end = cues[last].end;
    for (let i = first; i <= last; i++) {
      start = Math.min(start, cues[i].start);
      end = Math.max(end, cues[i].end);
    }
    if (!(end > start)) {
      end = start + 0.01;
    }
    return [start, end];
  }

  private refreshWaveRange(): void {
    const range = this.timelineVisibleRange();
    this.waveRangeStart = range[0];
    this.waveRangeEnd = range[1];
  }

  /** 只取可见字幕块时间段内的波形，拉伸到整条时间轴宽度。 */
  private visibleWaveformLevels(): number[] {
    const out: number[] = [];
    const total = this.waveform.length;
    if (total === 0) {
      return out;
    }
    this.refreshWaveRange();
    const duration = Math.max(0.01, this.playDuration());
    const startIdx = Math.max(0, Math.floor(this.waveRangeStart / duration * total));
    const endIdx = Math.min(total - 1, Math.ceil(this.waveRangeEnd / duration * total));
    const span = Math.max(1, endIdx - startIdx);
    for (let i = 0; i < this.visibleWaveBars; i++) {
      const index = Math.min(total - 1, startIdx + Math.floor(i * span / this.visibleWaveBars));
      out.push(this.waveform[index]);
    }
    return out;
  }

  private visibleWaveColor(index: number): string {
    const time = this.waveRangeStart
      + (index + 0.5) / this.visibleWaveBars * (this.waveRangeEnd - this.waveRangeStart);
    return time <= this.previewTime ? HomeTokens.primary : '#5E6B82';
  }

  /**
   * 时间轴波形：铺满字幕块所在的整块区域，只显示当前可见字幕块的时间段。
   * 字幕块垂直居中盖在波形上，波形随时间轴滚动换段。
   */
  @Builder
  waveformBackdrop() {
    Stack({ alignContent: Alignment.Center }) {
      if (this.waveform.length > 0) {
        Row({ space: 1 }) {
          ForEach(this.visibleWaveformLevels(), (level: number, index: number) => {
            Column()
              .layoutWeight(1)
              .height(`${Math.max(3, Math.round(level * 92))}%`)
              .borderRadius(2)
              .backgroundColor(this.visibleWaveColor(index))
              .opacity(0.85)
          }, (level: number, index: number) => `wave-${index}-${level.toFixed(3)}`)
        }
        .width('100%')
        .height('100%')
        .alignItems(VerticalAlign.Center)
      } else {
        Text(this.waveformLoading ? '正在提取音频波形…' : '暂无可用音频波形')
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
      }
    }
    .width('100%')
    .height(this.timelineWaveHeight())
    .padding({ left: 8, right: 8 })
    .hitTestBehavior(HitTestMode.None)
  }

  private cuePrimary(cue: Cue): string {
    const target = this.stripSpeakerPrefix(cue.targetText);
    return target.length > 0 ? target : this.stripSpeakerPrefix(cue.sourceText);
  }

  private cueSecondary(cue: Cue): string {
    return this.stripSpeakerPrefix(cue.targetText).length > 0 ? this.stripSpeakerPrefix(cue.sourceText) : '';
  }

  private stripSpeakerPrefix(text: string): string {
    return text.replace(/^\[[^\]]+\]\s*/, '').trim();
  }

  private cueSpeaker(cue: Cue): string {
    const explicit = cue.speaker.trim();
    if (explicit.length > 0) {
      return explicit;
    }
    const raw = cue.targetText.trim().length > 0 ? cue.targetText.trim() : cue.sourceText.trim();
    const match = /^\[([^\]]+)\]/.exec(raw);
    return match !== null ? match[1] : '—';
  }

  private cueSpeakerColor(cue: Cue): string {
    if (cue.speakerColor.length > 0) {
      return cue.speakerColor;
    }
    const name = this.cueSpeaker(cue);
    const color = this.speakerColors.get(name);
    return color !== undefined ? color : HomeTokens.textFaint;
  }

  private activeCueSpeakerColor(): string {
    const index = this.activeOverlayCueIndex();
    if (index >= 0 && index < this.store.cues.length) {
      const cue = this.store.cues[index];
      return cue.speakerColor || cue.targetColor
        || this.speakerColors.get(this.cueSpeaker(cue)) || '';
    }
    return '';
  }

  private activeCueSpeakerName(): string {
    const index = this.activeOverlayCueIndex();
    if (index >= 0 && index < this.store.cues.length) {
      const name = this.cueSpeaker(this.store.cues[index]);
      return name === '—' || name === '未标注' ? '' : name;
    }
    return '';
  }

  private activeCueSourceColor(): string {
    const index = this.activeOverlayCueIndex();
    if (index >= 0 && index < this.store.cues.length) {
      return this.store.cues[index].sourceColor;
    }
    return '';
  }

  private activeCueWordColor(): string {
    const index = this.activeOverlayCueIndex();
    if (index >= 0 && index < this.store.cues.length) {
      return this.store.cues[index].wordColor;
    }
    return '';
  }

  private activeOverlayCueIndex(): number {
    const time = this.subtitleClock;
    const cues = this.store.cues;
    for (let i = 0; i < cues.length; i++) {
      if (time >= cues[i].start - 0.05 && time <= cues[i].end + 0.05) {
        return i;
      }
      if (cues[i].start > time + 0.05) {
        break;
      }
    }
    if (this.activeLineIndex >= 0 && this.activeLineIndex < this.previewLines.length) {
      const line = this.previewLines[this.activeLineIndex];
      for (let i = 0; i < cues.length; i++) {
        if (Math.abs(cues[i].start - line.start) < 0.08) {
          return i;
        }
      }
    }
    return -1;
  }

  private editingPreviewLineWords(): PreviewWord[] {
    return this.editingPreviewWords.map((word: WordTiming): PreviewWord => {
      const out = new PreviewWord();
      out.text = word.text;
      out.start = word.start;
      out.end = word.end;
      return out;
    });
  }

  private waveformColor(index: number): string {
    if (this.waveform.length === 0) {
      return HomeTokens.glassEdge;
    }
    const duration = this.playDuration();
    const progress = duration > 0 ? this.previewTime / duration : 0;
    return index / this.waveform.length <= progress ? HomeTokens.primary : HomeTokens.tertiaryGlass;
  }

  private cueDurationLabel(cue: Cue): string {
    return `${Math.max(0.1, cue.end - cue.start).toFixed(1)}s`;
  }

  private cueActive(cue: Cue): boolean {
    return this.previewTime >= cue.start && this.previewTime <= cue.end;
  }

  private timelinePixelsPerSecond(): number {
    return this.timelineDragScale;
  }

  private timelineClipWidth(cue: Cue, index: number): number {
    if (this.expandedTimelineIndex === index) {
      const panel = this.timelineBoardWidth > 0 ? this.timelineBoardWidth : this.dims.widthVp;
      // 手机窄屏基本占满时间轴；平板仍限制在 2/3，避免盖住其它块。
      const ratio = this.dims.bp === Bp.SM ? 0.94 : 2 / 3;
      const minWidth = this.dims.bp === Bp.SM ? 240 : 300;
      return Math.max(minWidth, Math.min(panel * ratio - 12, this.dims.widthVp - 24));
    }
    // 正常块宽直接按句长换算：同一时间尺度下，长句更长、短句更短，
    // 块内波形与块共用同一宽度，缩放/滑动时一起变化。
    const pps = (this.isWide() ? 64 : 52) * this.timelineZoom;
    return Math.max(72, Math.min(420, (cue.end - cue.start) * pps));
  }

  private timelineClipHeight(index: number): number {
    return this.expandedTimelineIndex === index ? Math.max(180, this.timelineHeight() - 12) : 120;
  }

  /** 波形带高度与正常字幕块一致，字幕块正好盖住波形的最高/最低点。 */
  private timelineWaveHeight(): number {
    return 120;
  }

  private adjustTimelineCue(cue: Cue, index: number, delta: number): void {
    if (this.timelineDragCueIndex !== index) {
      return;
    }
    const cues = this.store.cues;
    const lower = index > 0 ? Math.max(0, cues[index - 1].start) : 0;
    const total = this.playDuration();
    let upper = total > 0 ? Math.max(this.timelineDragOriginStart, total - (cue.end - cue.start)) : Infinity;
    if (index + 1 < cues.length) {
      upper = Math.min(upper, cues[index + 1].start);
    }
    this.timelineDragLastDelta = Math.round(Math.max(lower - this.timelineDragOriginStart,
      Math.min(upper - this.timelineDragOriginStart, delta)) * 1000) / 1000;
  }

  private finishTimelineDrag(index: number): void {
    if (this.timelineDragCueIndex !== index) {
      return;
    }
    const cue = this.store.cues[index];
    const delta = this.timelineDragLastDelta;
    cue.start = this.timelineDragOriginStart + delta;
    cue.end = this.timelineDragOriginEnd + delta;
    cue.words = cue.words.map((word: WordTiming): WordTiming =>
      new WordTiming(word.text, word.start + delta, word.end + delta, word.confidence));
    cue.edited = true;
    this.timelineDragLastDelta = 0;
    this.timelineDragCueIndex = -1;
    this.suppressCueClickUntil = Date.now() + 260;
    this.store.cues = this.store.cues.slice();
    this.buildPreviewLines();
    this.cueSource.setCues(this.store.cues);
    this.activeLineIndex = -1;
    this.refreshActiveCue(this.previewTime);
    this.store.saveCurrent().catch((err: Error): void => {
      Logger.warn(TAG, `时间轴调整保存失败：${err.message}`);
    });
  }

  /** 当前句时间范围内的波形切片（给逐词拖拽条用）。 */
  private timingWaveLevels(cue: Cue): number[] {
    const out: number[] = [];
    const total = this.waveform.length;
    if (total === 0) {
      return out;
    }
    const duration = Math.max(0.01, this.playDuration());
    const start = Math.max(0, Math.floor(cue.start / duration * total));
    const end = Math.min(total - 1, Math.ceil(cue.end / duration * total));
    const span = Math.max(1, end - start);
    const count = 72;
    for (let i = 0; i < count; i++) {
      const index = Math.min(total - 1, start + Math.floor(i * span / count));
      out.push(this.waveform[index]);
    }
    return out;
  }

  /** 词起点在拖拽条里的 x（vp）。 */
  private timingWordX(cue: Cue, word: WordTiming): number {
    const span = Math.max(0.01, cue.end - cue.start);
    const ratio = Math.max(0, Math.min(1, (word.start - cue.start) / span));
    return ratio * Math.max(1, this.timingStripWidth);
  }

  private timingWordBandX(cue: Cue, word: WordTiming): number {
    const span = Math.max(0.01, cue.end - cue.start);
    return Math.max(0, Math.min(1, (word.start - cue.start) / span)) * this.timingStripWidth;
  }

  private timingWordBandWidth(cue: Cue, word: WordTiming): number {
    const span = Math.max(0.01, cue.end - cue.start);
    return Math.max(2, (word.end - word.start) / span * this.timingStripWidth - 1);
  }

  private beginTimingWordDrag(index: number): void {
    this.timingDragWordIndex = index;
    this.timingDragOriginStart = this.timingWords[index].start;
    this.selectTimingWord(index);
  }

  /** 横向拖动词起点：前一个词的终点同步贴过来，保持逐词轴连续。 */
  private dragTimingWord(cue: Cue, wordIndex: number, offsetX: number): void {
    if (this.timingDragWordIndex !== wordIndex || this.timingStripWidth <= 0) {
      return;
    }
    const span = Math.max(0.01, cue.end - cue.start);
    const delta = offsetX / Math.max(1, this.timingStripWidth) * span;
    const words = this.timingWords.slice();
    const word = words[wordIndex].clone();
    const lower = wordIndex > 0 ? words[wordIndex - 1].start + 0.02 : cue.start;
    const upper = Math.max(lower, word.end - 0.02);
    const next = Math.max(lower, Math.min(upper, this.timingDragOriginStart + delta));
    word.start = next;
    words[wordIndex] = word;
    if (wordIndex > 0) {
      const prev = words[wordIndex - 1].clone();
      prev.end = Math.max(prev.start + 0.02, next);
      words[wordIndex - 1] = prev;
    }
    this.timingWords = words;
    this.timingStart = word.start;
    this.timingEnd = word.end;
    this.timingDirty = true;
  }

  private finishTimingWordDrag(cue: Cue, index: number): void {
    this.timingDragWordIndex = -1;
    this.suppressCueClickUntil = Date.now() + 300;
    if (!this.timingDirty) {
      return;
    }
    this.timingDirty = false;
    this.saveTimingWords(cue, index, false);
  }

  private beginTimingEndDrag(cue: Cue): void {
    if (this.timingWords.length === 0) {
      return;
    }
    this.timingEndDrag = true;
    this.timingEndOrigin = this.timingWords[this.timingWords.length - 1].end;
    this.selectTimingWord(this.timingWords.length - 1);
  }

  private dragTimingEnd(cue: Cue, offsetX: number): void {
    if (!this.timingEndDrag || this.timingStripWidth <= 0 || this.timingWords.length === 0) {
      return;
    }
    const span = Math.max(0.01, cue.end - cue.start);
    const delta = offsetX / Math.max(1, this.timingStripWidth) * span;
    const index = this.timingWords.length - 1;
    const words = this.timingWords.slice();
    const word = words[index].clone();
    word.end = Math.max(word.start + 0.02, Math.min(cue.end, this.timingEndOrigin + delta));
    words[index] = word;
    this.timingWords = words;
    this.timingStart = word.start;
    this.timingEnd = word.end;
    this.timingDirty = true;
  }

  private finishTimingEndDrag(cue: Cue, index: number): void {
    this.timingEndDrag = false;
    this.suppressCueClickUntil = Date.now() + 300;
    if (!this.timingDirty) {
      return;
    }
    this.timingDirty = false;
    this.saveTimingWords(cue, index, false);
  }

  /** 在波形条上按下时找最近的词边界，整个条带统一用 PanGesture 拖动。 */
  private beginTimingDragAt(cue: Cue, localX: number): void {
    this.timingDragWordIndex = -1;
    this.timingEndDrag = false;
    if (this.timingWords.length === 0 || this.timingStripWidth <= 0) {
      return;
    }
    let nearest = -1;
    let best = 30;
    for (let i = 1; i < this.timingWords.length; i++) {
      const distance = Math.abs(this.timingWordX(cue, this.timingWords[i]) - localX);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    }
    const endDistance = Math.abs(this.timingStripWidth - localX);
    if (endDistance < best) {
      nearest = this.timingWords.length;
    }
    this.suppressCueClickUntil = Date.now() + 900;
    if (nearest === this.timingWords.length) {
      this.beginTimingEndDrag(cue);
    } else if (nearest > 0) {
      this.beginTimingWordDrag(nearest);
    }
  }

  private updateTimingDrag(cue: Cue, offsetX: number): void {
    if (this.timingEndDrag) {
      this.dragTimingEnd(cue, offsetX);
      return;
    }
    if (this.timingDragWordIndex > 0) {
      this.dragTimingWord(cue, this.timingDragWordIndex, offsetX);
    }
  }

  private finishTimingDrag(cue: Cue, index: number): void {
    if (this.timingEndDrag) {
      this.finishTimingEndDrag(cue, index);
      return;
    }
    if (this.timingDragWordIndex > 0) {
      this.finishTimingWordDrag(cue, index);
    }
  }

  @Builder
  timingEditor(cue: Cue, index: number) {
    Column({ space: 5 }) {
      if (this.timingWords.length > 0) {
        Row({ space: 8 }) {
          Text('拖动白色方块调整逐词起点')
            .fontSize(this.dims.miniSize - 1)
            .fontColor(HomeTokens.textFaint)
            .layoutWeight(1)
          Text('完成')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.primary)
            .onClick((): void => { this.closeTimingEditor(); })
        }
        .width('100%')

        Stack({ alignContent: Alignment.TopStart }) {
          ForEach(this.timingWords, (word: WordTiming, wordIndex: number) => {
            Column() {
              Column()
                .width(9)
                .height(9)
                .borderRadius(2)
                .backgroundColor(this.selectedTimingWord === wordIndex
                  ? HomeTokens.primary : '#E8E8F0')
              Column()
                .width(1)
                .height(46)
                .backgroundColor(this.selectedTimingWord === wordIndex
                  ? HomeTokens.primary : '#66FFFFFF')
            }
            .width(22)
            .height(56)
            .alignItems(HorizontalAlign.Center)
            .position({ x: Math.max(0, this.timingWordX(cue, word) - 11), y: 0 })
            .onClick((): void => { this.selectTimingWord(wordIndex); })
            .onTouch((event: TouchEvent): void => {
              if (event.touches.length === 0) { return; }
              const x = event.touches[0].screenX;
              if (event.type === TouchType.Down) {
                this.beginTimingWordDrag(wordIndex);
                this.timingDragOriginX = x;
                this.suppressCueClickUntil = Date.now() + 900;
              } else if (event.type === TouchType.Move) {
                this.dragTimingWord(cue, wordIndex, x - this.timingDragOriginX);
              } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
                this.finishTimingWordDrag(cue, index);
              }
            })
          }, (word: WordTiming, wordIndex: number) => `th-${wordIndex}`)

          ForEach(this.timingWords, (word: WordTiming, wordIndex: number) => {
            Text(word.text)
              .fontSize(this.dims.miniSize - 2)
              .fontColor(this.selectedTimingWord === wordIndex
                ? HomeTokens.onPrimary : HomeTokens.text)
              .padding({ left: 4, right: 4, top: 1, bottom: 1 })
              .borderRadius(4)
              .maxLines(1)
              .backgroundColor(this.selectedTimingWord === wordIndex
                ? HomeTokens.primary : '#33000000')
              .position({
                x: Math.max(0, Math.min(this.timingStripWidth - 52,
                  this.timingWordX(cue, word) + 3)),
                y: 30
              })
              .onClick((): void => { this.selectTimingWord(wordIndex); })
          }, (word: WordTiming, wordIndex: number) => `tt-${wordIndex}`)
        }
        .width('100%')
        .height(58)
        .onAreaChange((oldArea: Area, newArea: Area): void => {
          const width = Number(newArea.width);
          if (!Number.isNaN(width) && width > 0) {
            this.timingStripWidth = width;
          }
        })
      } else {
        Text('此句没有逐词时间戳，请先识别或导入含逐词信息的字幕。')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
        Button('收起').onClick((): void => { this.closeTimingEditor(); })
      }
    }
    .width('100%')
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        // 逐词拖拽期间阻止父级字幕块的单击/双击逻辑。
        this.suppressCueClickUntil = Date.now() + 900;
      }
    })
  }

  private selectTimingWord(index: number): void {
    this.selectedTimingWord = index;
    const word = this.timingWords[index];
    this.timingStart = word.start;
    this.timingEnd = word.end;
  }

  private updateTimingWord(cue: Cue, start: boolean, value: number): void {
    const index = this.selectedTimingWord;
    if (index < 0 || index >= this.timingWords.length) { return; }
    const words = this.timingWords.slice();
    const word = words[index].clone();
    const lower = index > 0 ? Math.max(cue.start, words[index - 1].end) : cue.start;
    const upper = index + 1 < words.length ? Math.min(cue.end, words[index + 1].start) : cue.end;
    if (start) {
      word.start = Math.max(lower, Math.min(word.end - 0.01, value));
    } else {
      word.end = Math.min(upper, Math.max(word.start + 0.01, value));
    }
    words[index] = word;
    this.timingWords = words;
    this.timingStart = word.start;
    this.timingEnd = word.end;
    this.timingDirty = true;
  }

  private closeTimingEditor(suppressTap: boolean = true): void {
    const index = this.expandedTimelineIndex;
    if (this.timingDirty && index >= 0 && index < this.store.cues.length) {
      this.saveTimingWords(this.store.cues[index], index, false);
    }
    this.animateCueEditChange((): void => { this.expandedTimelineIndex = -1; });
    this.timingDirty = false;
    if (suppressTap) {
      this.suppressCueClickUntil = Date.now() + 250;
    }
  }

  private saveTimingWords(cue: Cue, index: number, showToast: boolean = true): void {
    if (this.timingWords.some((word: WordTiming): boolean =>
      word.start < cue.start || word.end > cue.end || word.start >= word.end)) {
      this.toast('请确保逐词时间在句内且起点早于终点');
      return;
    }
    cue.words = this.timingWords.map((word: WordTiming): WordTiming => word.clone());
    cue.edited = true;
    this.store.cues = this.store.cues.slice();
    this.cueSource.notifyChange(index);
    this.buildPreviewLines();
    this.activeLineIndex = -1;
    this.refreshActiveCue(this.previewTime);
    this.store.saveCurrent().then((): void => {
      if (showToast) {
        this.toast('逐词时间戳已保存');
        this.closeTimingEditor();
      }
    }).catch((err: Error): void => { this.toast(`保存失败：${err.message}`); });
  }

  /** 当前字幕块时间范围内的波形（块内背景，跟块一起横向滚动）。 */
  private clipWaveLevels(cue: Cue): number[] {
    const out: number[] = [];
    const total = this.waveform.length;
    if (total === 0) {
      return out;
    }
    const duration = Math.max(0.01, this.playDuration());
    const start = Math.max(0, Math.floor(cue.start / duration * total));
    const end = Math.min(total - 1, Math.ceil(cue.end / duration * total));
    const span = Math.max(1, end - start);
    const count = 96;
    for (let i = 0; i < count; i++) {
      const index = Math.min(total - 1, start + Math.floor(i * span / count));
      out.push(this.waveform[index]);
    }
    return out;
  }

  @Builder
  clipWaveform(cue: Cue) {
    Stack({ alignContent: Alignment.Center }) {
      if (this.waveform.length > 0) {
        Row({ space: 1 }) {
          ForEach(this.clipWaveLevels(cue), (level: number, index: number) => {
            Column()
              .layoutWeight(1)
              .height(`${Math.max(6, Math.round(level * 88))}%`)
              .borderRadius(1)
              .backgroundColor(this.cueActive(cue) || this.expandedTimelineIndex === cue.index
                ? HomeTokens.primary : '#5E6B82')
              .opacity(this.expandedTimelineIndex === cue.index ? 0.92 : 0.42)
          }, (level: number, index: number) => `cw-${cue.index}-${index}-${level.toFixed(3)}`)
        }
        .width('100%')
        .height('100%')
        .alignItems(VerticalAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(HitTestMode.None)
  }

  @Builder
  expandedClipEditor(cue: Cue, index: number) {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        Text(`${this.clock(cue.start)} · 逐词时间`)
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
        Blank()
        Text('完成')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.primary)
          .onClick((): void => { this.closeTimingEditor(); })
      }
      .width('100%')

      Text(this.cuePrimary(cue))
        .fontSize(this.dims.miniSize + 1)
        .fontColor(this.cueSpeakerColor(cue))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')

      Stack({ alignContent: Alignment.TopStart }) {
        ForEach(this.timingWords, (word: WordTiming, wordIndex: number) => {
          Row()
            .width(this.timingWordBandWidth(cue, word))
            .height('100%')
            .backgroundColor(this.selectedTimingWord === wordIndex
              ? '#338FBAFF' : '#00000000')
            .position({ x: this.timingWordBandX(cue, word), y: 0 })
        }, (word: WordTiming, wordIndex: number) => `eband-${wordIndex}`)

        ForEach(this.timingWords, (word: WordTiming, wordIndex: number) => {
          if (wordIndex > 0) {
            Column() {
              Stack({ alignContent: Alignment.Center }) {
                Column() {
                  ForEach(TIMELINE_DASHES, (dash: number) => {
                    Column()
                      .width(1)
                      .height(4)
                      .backgroundColor('#66C8C8D4')
                  }, (dash: number) => `dash-${dash}`)
                }
                .width(1)
                .height('100%')
                .justifyContent(FlexAlign.SpaceBetween)

                Column() {
                  Column()
                    .width(2)
                    .height(14)
                    .borderRadius(1)
                    .backgroundColor('#4A4A56')
                }
                .width(9)
                .height(26)
                .borderRadius(3)
                .backgroundColor('#A8A8B4')
                .alignItems(HorizontalAlign.Center)
                .justifyContent(FlexAlign.Center)
              }
              .width(20)
              .height('100%')
            }
            .width(20)
            .height('100%')
            .alignItems(HorizontalAlign.Center)
            .position({ x: Math.max(0, this.timingWordX(cue, word) - 10), y: 0 })
            .hitTestBehavior(HitTestMode.Block)
            .onTouch((event: TouchEvent): void => {
              if (event.touches.length === 0) { return; }
              const x = event.touches[0].screenX;
              if (event.type === TouchType.Down) {
                this.beginTimingWordDrag(wordIndex);
                this.timingDragOriginX = x;
                this.suppressCueClickUntil = Date.now() + 900;
              } else if (event.type === TouchType.Move) {
                this.dragTimingWord(cue, wordIndex, x - this.timingDragOriginX);
              } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
                this.finishTimingWordDrag(cue, index);
              }
            })
          }
        }, (word: WordTiming, wordIndex: number) => `eb-${wordIndex}`)

        Column() {
          Stack({ alignContent: Alignment.Center }) {
            Column() {
              ForEach(TIMELINE_DASHES, (dash: number) => {
                Column()
                  .width(1)
                  .height(4)
                  .backgroundColor('#66C8C8D4')
              }, (dash: number) => `end-dash-${dash}`)
            }
            .width(1)
            .height('100%')
            .justifyContent(FlexAlign.SpaceBetween)

            Column() {
              Column()
                .width(2)
                .height(14)
                .borderRadius(1)
                .backgroundColor('#4A4A56')
            }
            .width(9)
            .height(26)
            .borderRadius(3)
            .backgroundColor('#A8A8B4')
            .alignItems(HorizontalAlign.Center)
            .justifyContent(FlexAlign.Center)
          }
          .width(20)
          .height('100%')
        }
        .width(20)
        .height('100%')
        .alignItems(HorizontalAlign.Center)
        .position({ x: Math.max(0, this.timingStripWidth - 20), y: 0 })
        .hitTestBehavior(HitTestMode.Block)
        .onTouch((event: TouchEvent): void => {
          if (event.touches.length === 0) { return; }
          const x = event.touches[0].screenX;
          if (event.type === TouchType.Down) {
            this.beginTimingEndDrag(cue);
            this.timingDragOriginX = x;
            this.suppressCueClickUntil = Date.now() + 900;
          } else if (event.type === TouchType.Move) {
            this.dragTimingEnd(cue, x - this.timingDragOriginX);
          } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
            this.finishTimingEndDrag(cue, index);
          }
        })

        ForEach(this.timingWords, (word: WordTiming, wordIndex: number) => {
          Text(word.text)
            .fontSize(this.dims.miniSize)
            .fontColor(this.selectedTimingWord === wordIndex
              ? HomeTokens.primary : HomeTokens.text)
            .maxLines(1)
            .position({
              x: Math.max(0, Math.min(this.timingStripWidth - 64,
                this.timingWordBandX(cue, word) + 4)),
              y: Math.max(8, this.timingStripHeight - 24)
            })
            .onClick((): void => { this.selectTimingWord(wordIndex); })
        }, (word: WordTiming, wordIndex: number) => `et-${wordIndex}`)
      }
      .width('100%')
      .layoutWeight(1)
      .onAreaChange((oldArea: Area, newArea: Area): void => {
        const width = Number(newArea.width);
        const height = Number(newArea.height);
        if (!Number.isNaN(width) && width > 0) {
          this.timingStripWidth = width;
        }
        if (!Number.isNaN(height) && height > 0) {
          this.timingStripHeight = height;
        }
      })
      .gesture(
        PanGesture({ direction: PanDirection.Horizontal, distance: 1 })
          .onActionStart((event: GestureEvent): void => {
            if (event.fingerList.length > 0) {
              this.beginTimingDragAt(cue, event.fingerList[0].localX);
            }
          })
          .onActionUpdate((event: GestureEvent): void => {
            this.updateTimingDrag(cue, event.offsetX);
          })
          .onActionEnd((): void => { this.finishTimingDrag(cue, index); })
          .onActionCancel((): void => { this.finishTimingDrag(cue, index); })
      )

      Text('拖动方块调整词起点 / 终点')
        .fontSize(this.dims.miniSize - 1)
        .fontColor(HomeTokens.textFaint)
        .width('100%')
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  timelineClip(cue: Cue, index: number) {
    Stack({ alignContent: Alignment.TopStart }) {
      this.clipWaveform(cue)

      Column() {
        if (this.expandedTimelineIndex === index) {
          this.expandedClipEditor(cue, index)
        } else {
        Row() {
          Text(this.cuePrimary(cue))
            .fontSize(this.expandedTimelineIndex === index
              ? this.dims.miniSize + 1 : this.dims.miniSize + 5)
            .fontColor(this.cueSpeakerColor(cue))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .translate({ y: this.expandedTimelineIndex === index ? -6 : 0 })
            .animation({ duration: 180, curve: Curve.EaseOut })
        }
        .width('100%')
        .layoutWeight(1)
        .alignItems(VerticalAlign.Center)

        if (cue.words.length > 0) {
          Row({ space: 1 }) {
            ForEach(cue.words, (word: WordTiming) => {
              Row()
                .layoutWeight(Math.max(0.05, word.end - word.start))
                .height(3)
                .borderRadius(1)
                .backgroundColor(HomeTokens.primary)
            }, (word: WordTiming, i: number) => `${cue.index}-${i}-${word.start}`)
          }
          .width('100%')
          .height(3)
          .margin({ top: 3, bottom: 3 })
          .opacity(this.expandedTimelineIndex === index ? 0 : 1)
          .animation({ duration: 180, curve: Curve.EaseOut })
        } else {
          Row()
            .width('100%')
            .height(1)
            .borderRadius(1)
            .backgroundColor(HomeTokens.glassEdge)
            .margin({ top: 3, bottom: 3 })
            .opacity(this.expandedTimelineIndex === index ? 0 : 1)
            .animation({ duration: 180, curve: Curve.EaseOut })
        }

        Row() {
          Text(this.cueSecondary(cue))
            .fontSize(this.dims.miniSize + 4)
            .fontColor(HomeTokens.textDim)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        .width('100%')
        .layoutWeight(1)
        .alignItems(VerticalAlign.Center)
        .opacity(this.expandedTimelineIndex === index ? 0 : 1)
        .animation({ duration: 180, curve: Curve.EaseOut })
        }
      }
    .width('100%')
    .height('100%')
    .padding(7)
    }
    .width(this.timelineClipWidth(cue, index))
    .height(this.timelineClipHeight(index))
    .translate({
      x: this.timelineDragCueIndex === index ? this.timelineDragLastDelta * this.timelinePixelsPerSecond() : 0,
      y: this.expandedTimelineIndex === index ? -82 : 0
    })
    .borderRadius(this.dims.radiusInner)
    .clip(true)
    // 低模糊玻璃：让背后的时间轴波形透出来，字幕块像盖在波形上。
    .backgroundEffect({
      // 放大块背后的备注/刻度/其它块强压暗+模糊；浅色模式改成浅色玻璃，避免整块发黑。
      radius: this.expandedTimelineIndex === index ? 18 : 3,
      saturation: 1.02,
      brightness: 1.0,
      color: this.expandedTimelineIndex === index
        ? (this.themeLight ? '#D9F7FAFF' : '#B80A0E15')
        : (this.themeLight ? '#0DF2F5FA' : '#140A0E15')
    })
    .border({
      width: 1,
      color: this.cueActive(cue) ? HomeTokens.primary : HomeTokens.glassEdge
    })
    .onClick((event: ClickEvent): void => {
      if (Date.now() < this.suppressCueClickUntil) {
        return;
      }
      this.selectedCueIndex = index;
      const now = Date.now();
      const doubleTap = this.lastTimelineTapIndex === index
        && now - this.lastTimelineTapTime < 400;

      if (this.expandedTimelineIndex === index) {
        // 波形区域内的点击/滑动交给逐词拖拽；只有顶部信息区双击才收起。
        if (event.y > 48) {
          return;
        }
        if (doubleTap) {
          this.lastTimelineTapIndex = -1;
          this.lastTimelineTapTime = 0;
          this.closeTimingEditor(true);
        } else {
          this.lastTimelineTapIndex = index;
          this.lastTimelineTapTime = now;
        }
        return;
      }

      if (this.expandedTimelineIndex >= 0) {
        // 点其它字幕块：先保存并收起当前块，再按普通点击处理。
        this.closeTimingEditor(false);
      }

      if (doubleTap) {
        if (this.timelineTapTimer >= 0) {
          clearTimeout(this.timelineTapTimer);
          this.timelineTapTimer = -1;
        }
        if (this.timingDirty) {
          this.toast('请先保存或取消逐词调整');
          return;
        }
        this.timingWords = cue.words.map((word: WordTiming): WordTiming => word.clone());
        if (this.timingWords.length > 0) { this.selectTimingWord(0); }
        this.lastTimelineTapIndex = -1;
        this.lastTimelineTapTime = 0;
        this.seekTo(this.cueJumpTime(cue));
        this.getUIContext().animateTo({
          duration: 180,
          curve: curves.springMotion(0.28, 0.72)
        }, (): void => {
          this.expandedTimelineIndex = index;
        });
        // 展开后把块滚到视野中央，右边界不会超出时间轴区域。
        setTimeout((): void => {
          try {
            this.timelineScroller.scrollToIndex(index, true, ScrollAlign.AUTO);
          } catch (err) {
            // 时间轴尚未布局时忽略
          }
        }, 220);
        return;
      }
      this.lastTimelineTapIndex = index;
      this.lastTimelineTapTime = now;
      if (this.timelineTapTimer >= 0) {
        clearTimeout(this.timelineTapTimer);
      }
      // 单击延迟 seek：给双击留出时间，避免双击未居中的块时先跳过去。
      this.timelineTapTimer = setTimeout((): void => {
        this.timelineTapTimer = -1;
        if (this.lastTimelineTapIndex === index) {
          this.seekTo(this.cueJumpTime(cue));
        }
      }, 440);
    })
    .gesture(
      GestureGroup(GestureMode.Sequence,
        LongPressGesture({ repeat: false, duration: 400 })
        .onAction((): void => {
          if (this.expandedTimelineIndex >= 0) { return; }
          this.timelineDragCueIndex = index;
          this.timelineDragLastDelta = 0;
          this.timelineDragOriginStart = cue.start;
          this.timelineDragOriginEnd = cue.end;
          this.timelineDragScale = this.timelineClipWidth(cue, index) / Math.max(0.01, cue.end - cue.start);
        }),
        PanGesture({ direction: PanDirection.Horizontal, distance: 2 })
        .onActionUpdate((event: GestureEvent): void => {
          if (this.timelineDragCueIndex === index) {
            this.adjustTimelineCue(cue, index, event.offsetX / this.timelinePixelsPerSecond());
          }
        })
        .onActionEnd((): void => {
          this.finishTimelineDrag(index);
        })
      ).onCancel((): void => {
        this.timelineDragCueIndex = -1;
        this.timelineDragLastDelta = 0;
      })
    )
  }

  @Builder
  wordTimingOverlay(cue: Cue, index: number) {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Text(`${this.clock(cue.start)} · 逐词时间`)
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
        Blank()
        Text('完成')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.primary)
          .onClick((): void => { this.closeTimingEditor(); })
      }
      .width('100%')

      Text(this.cuePrimary(cue))
        .fontSize(this.dims.miniSize + 2)
        .fontColor(this.cueSpeakerColor(cue))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')

      Stack({ alignContent: Alignment.TopStart }) {
        Row({ space: 1 }) {
          ForEach(this.clipWaveLevels(cue), (level: number, waveIndex: number) => {
            Column()
              .layoutWeight(1)
              .height(`${Math.max(8, Math.round(level * 96))}%`)
              .borderRadius(1)
              .backgroundColor(HomeTokens.primary)
              .opacity(0.45)
          }, (level: number, waveIndex: number) => `ow-${cue.index}-${waveIndex}-${level.toFixed(3)}`)
        }
        .width('100%')
        .height(80)
        .alignItems(VerticalAlign.Center)

        ForEach(this.timingWords, (word: WordTiming, wordIndex: number) => {
          if (wordIndex > 0) {
            Column() {
              Column()
                .width(9)
                .height(9)
                .borderRadius(2)
                .backgroundColor(this.selectedTimingWord === wordIndex
                  ? HomeTokens.primary : '#D8D8E4')
              Column()
                .width(1)
                .height(71)
                .backgroundColor('#66FFFFFF')
            }
            .width(20)
            .height(80)
            .alignItems(HorizontalAlign.Center)
            .position({ x: Math.max(0, this.timingWordX(cue, word) - 10), y: 0 })
            .onTouch((event: TouchEvent): void => {
              if (event.touches.length === 0) { return; }
              const x = event.touches[0].screenX;
              if (event.type === TouchType.Down) {
                this.beginTimingWordDrag(wordIndex);
                this.timingDragOriginX = x;
                this.suppressCueClickUntil = Date.now() + 900;
              } else if (event.type === TouchType.Move) {
                this.dragTimingWord(cue, wordIndex, x - this.timingDragOriginX);
              } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
                this.finishTimingWordDrag(cue, index);
              }
            })
          }
        }, (word: WordTiming, wordIndex: number) => `ob-${wordIndex}`)

        Column() {
          Column()
            .width(9)
            .height(9)
            .borderRadius(2)
            .backgroundColor('#D8D8E4')
          Column()
            .width(1)
            .height(71)
            .backgroundColor('#66FFFFFF')
        }
        .width(20)
        .height(80)
        .alignItems(HorizontalAlign.Center)
        .position({ x: Math.max(0, this.timingStripWidth - 20), y: 0 })
        .onTouch((event: TouchEvent): void => {
          if (event.touches.length === 0) { return; }
          const x = event.touches[0].screenX;
          if (event.type === TouchType.Down) {
            this.beginTimingEndDrag(cue);
            this.timingDragOriginX = x;
            this.suppressCueClickUntil = Date.now() + 900;
          } else if (event.type === TouchType.Move) {
            this.dragTimingEnd(cue, x - this.timingDragOriginX);
          } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
            this.finishTimingEndDrag(cue, index);
          }
        })

        ForEach(this.timingWords, (word: WordTiming, wordIndex: number) => {
          Text(word.text)
            .fontSize(this.dims.miniSize)
            .fontColor(this.selectedTimingWord === wordIndex
              ? HomeTokens.onPrimary : HomeTokens.text)
            .padding({ left: 4, right: 4, top: 1, bottom: 1 })
            .borderRadius(4)
            .maxLines(1)
            .backgroundColor(this.selectedTimingWord === wordIndex
              ? HomeTokens.primary : '#33000000')
            .position({
              x: Math.max(0, Math.min(this.timingStripWidth - 60,
                this.timingWordX(cue, word) + 4)),
              y: 58
            })
            .onClick((): void => { this.selectTimingWord(wordIndex); })
        }, (word: WordTiming, wordIndex: number) => `ot-${wordIndex}`)
      }
      .width('100%')
      .layoutWeight(1)
      .onAreaChange((oldArea: Area, newArea: Area): void => {
        const width = Number(newArea.width);
        if (!Number.isNaN(width) && width > 0) {
          this.timingStripWidth = width;
        }
      })

      Text('拖动方块调整词起点 / 终点')
        .fontSize(this.dims.miniSize - 1)
        .fontColor(HomeTokens.textFaint)
        .width('100%')
    }
    .width('94%')
    .height('92%')
    .padding(12)
    .borderRadius(this.dims.radiusCard)
    .backgroundEffect({
      radius: 4,
      saturation: 1.04,
      brightness: 1.0,
      color: '#440A0E15'
    })
    .border({ width: 1, color: HomeTokens.glassEdge })
    .shadow({ radius: 24, color: HomeTokens.shadow, offsetX: 0, offsetY: 10 })
    .backgroundColor('#440A0E15')
    .hitTestBehavior(HitTestMode.Block)
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        this.suppressCueClickUntil = Date.now() + 900;
      }
    })
  }

  @Builder
  timelineBoard() {
    EditorPanel({ dims: this.dims, pad: 0 }) {
      Stack({ alignContent: Alignment.Center }) {
        Column({ space: 5 }) {
        Row({ space: 6 }) {
          TextInput({ placeholder: '输入备注 / 弹幕', text: this.note })
            .fontSize(this.dims.miniSize + 1)
            .fontColor(HomeTokens.text)
            .placeholderColor(HomeTokens.textFaint)
            .height(30)
            .layoutWeight(1)
            .padding({ left: 10, right: 10 })
            .backgroundColor(HomeTokens.glassFill)
            .borderRadius(this.dims.radiusPill)
            .onChange((value: string): void => {
              this.note = value;
            })
          EditorPill({
            dims: this.dims,
            label: '停留 2.5 秒',
            compact: true,
            onTap: (): void => {
            }
          })
          if (this.dims.bp !== Bp.SM) {
            Toggle({ type: ToggleType.Switch, isOn: true })
              .width(34)
              .height(20)
              .selectedColor(HomeTokens.primary)
          }
          EditorPill({
            dims: this.dims,
            label: '发送',
            primary: true,
            compact: true,
            onTap: (): void => {
            }
          })
        }
        .width('100%')

        Row() {
          Text(`${this.clock(this.previewTime)} / ${this.clock(this.playDuration())}`)
            .fontSize(this.dims.miniSize - 1)
            .fontColor(HomeTokens.textDim)
          Blank()
          if (this.isWide()) {
            Text('双指缩放 · 双击逐词调整 · 长按拖动起点')
              .fontSize(this.dims.miniSize - 2)
              .fontColor(HomeTokens.textFaint)
              .maxLines(1)
          }
        }
        .width('100%')

        // 顶部刻度跟随当前可见字幕范围；横向滚动/缩放时整排时间随之更新。
        this.timelineRuler()

        List({ space: 6, scroller: this.timelineScroller }) {
          LazyForEach(this.cueSource, (cue: Cue, index: number) => {
            ListItem() {
              this.timelineClip(cue, index)
            }
          }, (cue: Cue) => `timeline-${cue.index}-${Math.round(this.timelineZoom * 20)}`)
        }
        .width('100%')
        .layoutWeight(1)
        .listDirection(Axis.Horizontal)
        // 字幕块置于时间轴板块顶部；放大块允许向上越出列表，盖住刻度区。
        .alignListItem(ListItemAlign.Start)
        .clip(false)
        // 放大块要盖住上方的备注/刻度行，而不是被它们挡住。
        .zIndex(10)
        .enableScrollInteraction(this.timelineDragCueIndex < 0 && !this.timelinePinching
          && this.expandedTimelineIndex < 0)
        .parallelGesture(
          PinchGesture({ fingers: 2 })
            .onActionStart((): void => {
              if (this.expandedTimelineIndex >= 0) { return; }
              this.timelinePinchStart = this.timelineZoom;
              this.timelinePinching = true;
              this.timelinePinchOffset = this.timelineScroller.currentOffset().xOffset;
            })
            .onActionUpdate((event: GestureEvent): void => {
              if (this.expandedTimelineIndex >= 0) { return; }
              this.timelinePinchAnchor = event.pinchCenterX;
              this.timelineZoom = Math.max(0.65, Math.min(2.4,
                this.timelinePinchStart * event.scale));
            })
            .onActionEnd((): void => {
              this.timelinePinching = false;
              const offset = Math.max(0, (this.timelinePinchOffset + this.timelinePinchAnchor)
                * this.timelineZoom / this.timelinePinchStart - this.timelinePinchAnchor);
              this.timelineScroller.scrollTo({ xOffset: offset, yOffset: 0 });
            })
            .onActionCancel((): void => { this.timelinePinching = false; })
        )
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
        .padding({ left: 0, right: 8, top: 0, bottom: 0 })
      }
      .width('100%')
      .height('100%')
      .padding({
        left: this.dims.cardPadding,
        right: this.dims.cardPadding,
        // 手机布局再下移一档（上边距 12→16）；下边距收小，避免玻璃遮罩底部留白过大。
        top: this.dims.bp === Bp.SM ? 16 : 6,
        bottom: this.dims.bp === Bp.SM ? 6 : 0
      })
      }
      .width('100%')
      .height('100%')
      .onAreaChange((oldArea: Area, newArea: Area): void => {
        const width = Number(newArea.width);
        if (!Number.isNaN(width) && width > 0) {
          this.timelineBoardWidth = width;
        }
      })
    }
  }

  // ------------------------------------------------------------ 右边栏板块

  @Builder
  splitTab() {
    Column() {
      SymbolGlyph($r('sys.symbol.rectangle_split_2x1'))
        .fontSize(15)
        .fontColor([this.splitRoles ? HomeTokens.primary : HomeTokens.textDim])
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .accessibilityText(this.splitRoles ? '关闭字幕与人物双栏' : '字幕与人物双栏显示')
  }

  @Builder
  splitDestination(name: string, param: Object) {
    if (name === 'speaker-split') {
      NavDestination() {
        this.speakerTab(true)
      }
      .hideTitleBar(true)
      .backgroundColor('#00000000')
      .transition(TransitionEffect.translate({ x: 18 }).animation({
        duration: 220,
        curve: curves.springMotion(0.3, 0.78)
      }))
    }
  }

  @Builder
  splitToggle() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph($r('sys.symbol.rectangle_split_2x1'))
        .fontSize(15)
        .fontColor([this.splitRoles ? HomeTokens.primary : HomeTokens.textDim])
    }
    .width(32)
    .height(30)
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(this.splitRoles ? HomeTokens.accentGlass : HomeTokens.glassFill)
    .border({ width: 1, color: this.splitRoles ? HomeTokens.primary : HomeTokens.glassEdge })
    .onClick((): void => {
      if (this.splitPanelVisible) {
        this.splitPanelExpanded = false;
        this.splitNavStack.pop();
        setTimeout((): void => {
          this.splitPanelVisible = false;
          this.splitRoles = false;
        }, 220);
        return;
      }
      // 双栏 = 字幕列表 + 人物列表，和桌面版一样只在字幕页出现。
      this.sidebarTab = '字幕';
      this.sidebarController.changeIndex(0);
      this.splitRoles = true;
      this.splitPanelVisible = true;
      this.splitPanelExpanded = true;
      this.splitNavStack.pushPath({ name: 'speaker-split' });
    })
  }

  @Builder
  sidebarTabItem(label: string) {
    Column() {
      Text(label)
        .fontSize(this.dims.miniSize)
        .fontColor(this.sidebarTab === label ? HomeTokens.primary : HomeTokens.textDim)
        .maxLines(1)
    }
    .height(34)
    .justifyContent(FlexAlign.Center)
    .padding({ left: 3, right: 3 })
    .borderRadius(this.dims.radiusInner)
  }

  private startCueEdit(cue: Cue, index: number): void {
    if (this.editingCueIndex === index) {
      return;
    }
    this.editingCueIndex = index;
    const speaker = this.cueSpeaker(cue);
    if (cue.speaker.length === 0 && speaker.length > 0 && speaker !== '—' && speaker !== '未标注') {
      cue.speaker = speaker;
    }
    this.editTarget = this.stripSpeakerPrefix(cue.targetText);
    this.editSource = this.stripSpeakerPrefix(cue.sourceText);
    this.editingPreviewWords = cue.words.map((word: WordTiming): WordTiming => word.clone());
    this.refreshActiveCue(this.previewTime);
  }

  private splitEditableWords(text: string): string[] {
    const normalized = text.replace(/\r?\n/g, ' ').trim();
    if (normalized.length === 0) {
      return [];
    }
    return normalized.split(/\s+/).filter((word: string): boolean => word.length > 0);
  }

  private allocateEditableWordTimes(words: string[], start: number, end: number): WordTiming[] {
    if (words.length === 0) {
      return [];
    }
    const span = Math.max(0.05, end - start);
    let weight = 0;
    for (let i = 0; i < words.length; i++) {
      weight += Math.max(1, words[i].length);
    }
    const out: WordTiming[] = [];
    let cursor = start;
    for (let i = 0; i < words.length; i++) {
      const portion = Math.max(0.01, span * Math.max(1, words[i].length) / weight);
      const wordEnd = i === words.length - 1 ? end : Math.min(end, cursor + portion);
      out.push(new WordTiming(words[i], cursor, Math.max(cursor + 0.01, wordEnd), 0));
      cursor = wordEnd;
    }
    return out;
  }

  private rebuildEditableWordTimes(cue: Cue, text: string): WordTiming[] {
    const words = this.splitEditableWords(text);
    if (words.length === 0) {
      return [];
    }
    if (cue.words.length === words.length) {
      let sameText = true;
      for (let i = 0; i < words.length; i++) {
        if (cue.words[i].text !== words[i]) {
          sameText = false;
          break;
        }
      }
      if (sameText) {
        return cue.words.map((old: WordTiming, i: number): WordTiming =>
          new WordTiming(words[i], old.start, old.end, old.confidence));
      }
    }
    return this.allocateEditableWordTimes(words, cue.start, cue.end);
  }

  private handleCueCardTap(cue: Cue, index: number): void {
    if (Date.now() < this.suppressCueClickUntil) {
      return;
    }
    this.selectedCueIndex = index;
    const now: number = Date.now();
    const doubleTap = this.lastCueTapIndex === index && now - this.lastCueTapTime < 380;
    if (this.cueTapTimer >= 0) {
      clearTimeout(this.cueTapTimer);
      this.cueTapTimer = -1;
    }
    this.lastCueTapIndex = doubleTap ? -1 : index;
    this.lastCueTapTime = doubleTap ? 0 : now;
    if (!doubleTap) {
      // 延迟单击跳转，给第二次点击留出识别双击的时间，避免自动滚动改变第二下的落点。
      this.cueTapTimer = setTimeout((): void => {
        this.cueTapTimer = -1;
        if (this.lastCueTapIndex === index) {
          this.seekTo(this.cueJumpTime(cue));
        }
      }, 420);
      return;
    }
    // 双击也要把播放头立即落到被点击的句子，避免仍按上一句的播放时间高亮。
    this.seekTo(this.cueJumpTime(cue));
    if (this.editingCueIndex === index) {
      // 同一块再次双击：先保存当前文本，再收起卡片。
      this.suppressCueClickUntil = Date.now() + 220;
      this.animateCueEditChange((): void => {
        this.saveCueEdit();
      });
      return;
    }
    if (this.editingCueIndex >= 0) {
      // 切换到另一块时，先完成当前保存，再展开目标卡片。
      this.saveCueEdit().then((): void => {
        if (this.editingCueIndex >= 0) {
          return;
        }
        this.suppressCueClickUntil = Date.now() + 220;
        this.animateCueEditChange((): void => {
          this.startCueEdit(cue, index);
        });
        this.seekTo(this.cueJumpTime(cue));
      }).catch((err: Error): void => {
        Logger.warn(TAG, `切换字幕块保存失败：${err.message}`);
      });
      return;
    }
    this.animateCueEditChange((): void => {
      this.startCueEdit(cue, index);
    });
  }

  private cueJumpTime(cue: Cue): number {
    // 点击定位必须落在本句内部；首词时间偶尔会早于 cue.start（或正好压在上一条的
    // 结束边界上），直接 seek 会让播放头和“当前句”判定落回上一条。留一点内缩。
    const span = Math.max(0.001, cue.end - cue.start);
    const margin = Math.min(0.03, Math.max(0.001, span * 0.05));
    const lower = cue.start + margin;
    const upper = Math.max(lower, cue.end - margin);
    const raw = cue.words.length > 0 ? cue.words[0].start : cue.start;
    return Math.max(lower, Math.min(upper, raw));
  }

  private animateCueEditChange(change: () => void): void {
    this.getUIContext().animateTo({
      duration: 180,
      curve: curves.springMotion(0.28, 0.72)
    }, change);
  }

  private cueEditorHeight(text: string, compact: boolean): number {
    const lineCount = this.cueEditorLineCount(text);
    const lineHeight = compact ? Math.max(20, this.dims.miniSize + 8) : Math.max(22, this.dims.miniSize + 10);
    return lineCount === 1 ? lineHeight + 16 : lineHeight * 2 + 16;
  }

  private cueEditorLineCount(text: string): number {
    const lines = text.split(/\r?\n/);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      count += Math.max(1, Math.ceil(lines[i].length / 24));
    }
    return Math.min(2, Math.max(1, count));
  }

  private cueEditorPadding(text: string): CueEditorPadding {
    return { left: 8, right: 8, top: 8, bottom: 8 };
  }

  private restoreSpeakerPrefix(text: string, original: string, speaker: string): string {
    const value = this.stripSpeakerPrefix(text);
    const hadPrefix = /^\[[^\]]+\]\s*/.test(original);
    if (hadPrefix && value.length > 0 && speaker.length > 0 && speaker !== '—' && speaker !== '未标注') {
      return `[${speaker}] ${value}`;
    }
    return value;
  }

  private toggleWordChecked(cue: Cue, index: number): void {
    if (cue.words.length === 0) {
      this.toast('当前字幕没有逐词时间戳');
      return;
    }
    cue.wordChecked = !cue.wordChecked;
    this.store.cues = this.store.cues.slice();
    this.cueSource.notifyChange(index);
    this.store.saveCurrent().catch((err: Error): void => {
      Logger.warn(TAG, `保存逐词校对状态失败：${err.message}`);
    });
  }

  private cancelCueEdit(): void {
    this.editingCueIndex = -1;
    this.lastCueTapIndex = -1;
    this.lastCueTapTime = 0;
    this.editTarget = '';
    this.editSource = '';
    this.editingPreviewWords = [];
    this.refreshActiveCue(this.previewTime);
  }

  private async saveCueEdit(): Promise<void> {
    const index = this.editingCueIndex;
    if (index < 0 || index >= this.store.cues.length) {
      this.cancelCueEdit();
      return;
    }
    const cue = this.store.cues[index];
    const target = this.editTarget.trim();
    const source = this.editSource.trim();
    if (target.length === 0 && source.length === 0) {
      this.toast('字幕内容不能为空');
      return;
    }
    const speaker = this.cueSpeaker(cue);
    const targetText = this.restoreSpeakerPrefix(target, cue.targetText, speaker);
    const sourceText = this.restoreSpeakerPrefix(source, cue.sourceText, speaker);
    if (sourceText !== cue.sourceText) {
      // 参考 Windows 版：词面不变保留原时间，词面或词数变化时按文本长度重建。
      cue.words = this.rebuildEditableWordTimes(cue, this.stripSpeakerPrefix(sourceText));
    }
    cue.targetText = targetText;
    cue.sourceText = sourceText;
    cue.edited = true;
    this.editingCueIndex = -1;
    this.lastCueTapIndex = -1;
    this.lastCueTapTime = 0;
    this.editingPreviewWords = [];
    this.store.cues = this.store.cues.slice();
    this.cueSource.setCues(this.store.cues);
    this.cueSource.notifyChange(index);
    this.buildPreviewLines();
    this.refreshActiveCue(this.previewTime);
    try {
      await this.store.saveCurrent();
      this.toast('字幕已保存');
    } catch (err) {
      Logger.warn(TAG, '保存字幕失败');
      this.toast('字幕已更新，但写入文件失败');
    }
  }

  @Builder
  cueEditor(cue: Cue) {
    Column({ space: 6 }) {
      Text('中文 / 译文')
        .fontSize(this.dims.miniSize - 1)
        .fontColor(HomeTokens.textFaint)
        .width('100%')
      TextArea({ text: $$this.editTarget, placeholder: '输入中文字幕' })
        .fontSize(this.dims.miniSize + 1)
        .fontColor(HomeTokens.text)
        .placeholderColor(HomeTokens.textFaint)
        .height(this.cueEditorHeight(this.editTarget, false))
        .maxLines(2)
        .lineHeight(Math.max(22, this.dims.miniSize + 10))
        .textOverflow(TextOverflow.Clip)
        .padding(this.cueEditorPadding(this.editTarget))
        .backgroundColor(HomeTokens.glassFill)
        .borderRadius(this.dims.radiusInner)
        .onChange((value: string): void => {
          this.editTarget = value;
          this.refreshActiveCue(this.previewTime);
        })
      Text('English / 原文')
        .fontSize(this.dims.miniSize - 1)
        .fontColor(HomeTokens.textFaint)
        .width('100%')
      TextArea({ text: $$this.editSource, placeholder: '输入英文原文' })
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.textDim)
        .placeholderColor(HomeTokens.textFaint)
        .height(this.cueEditorHeight(this.editSource, true))
        .maxLines(2)
        .lineHeight(Math.max(20, this.dims.miniSize + 8))
        .textOverflow(TextOverflow.Clip)
        .padding(this.cueEditorPadding(this.editSource))
        .backgroundColor(HomeTokens.glassFill)
        .borderRadius(this.dims.radiusInner)
        .onChange((value: string): void => {
          this.editSource = value;
          this.editingPreviewWords = this.rebuildEditableWordTimes(cue, this.stripSpeakerPrefix(value));
          this.refreshActiveCue(this.previewTime);
        })
      Row({ space: 8 }) {
        Blank()
        Text('取消')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .padding({ left: 12, right: 12, top: 5, bottom: 5 })
          .borderRadius(this.dims.radiusPill)
          .backgroundColor(HomeTokens.glassFill)
          .onClick((): void => {
            this.suppressCueClickUntil = Date.now() + 220;
            this.animateCueEditChange((): void => {
              this.cancelCueEdit();
            });
          })
        Text('保存')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.onPrimary)
          .padding({ left: 12, right: 12, top: 5, bottom: 5 })
          .borderRadius(this.dims.radiusPill)
          .backgroundColor(HomeTokens.primary)
          .onClick((): void => {
            this.suppressCueClickUntil = Date.now() + 220;
            this.animateCueEditChange((): void => {
              this.saveCueEdit();
            });
          })
      }
      .width('100%')
    }
    .width('100%')
    .padding({ top: 2 })
  }

  @Builder
  cueCard(cue: Cue, index: number) {
    Column({ space: 3 }) {
      Row({ space: 6 }) {
        Text(this.clock(cue.start))
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
        Text(this.cueSpeaker(cue))
          .fontSize(this.dims.miniSize - 2)
          .fontColor(this.cueSpeakerColor(cue))
          .padding({ left: 4, right: 4, top: 1, bottom: 1 })
          .borderRadius(4)
          .backgroundColor(HomeTokens.tertiaryGlass)
        Blank()
        Text(this.cueDurationLabel(cue))
          .fontSize(this.dims.miniSize - 2)
          .fontColor(HomeTokens.textFaint)
      }
      .width('100%')

      if (this.editingCueIndex === index) {
        this.cueEditor(cue)
      } else {
        Text(this.cuePrimary(cue))
          .fontSize(this.dims.miniSize + 2)
          .fontColor(this.cueSpeakerColor(cue))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Text(this.cueSecondary(cue))
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }

      Row({ space: 6 }) {
        Text(cue.words.length > 0 ? `${cue.words.length} 词` : '整行')
          .fontSize(this.dims.miniSize - 1)
          .fontColor(cue.words.length > 0 ? HomeTokens.primary : HomeTokens.textFaint)
        if (cue.edited) {
          Text('✓ 已校对')
            .fontSize(this.dims.miniSize - 1)
            .fontColor(HomeTokens.success)
            .padding({ left: 5, right: 5, top: 1, bottom: 1 })
            .borderRadius(4)
            .backgroundColor(HomeTokens.successGlass)
        }
        Blank()
      }
      .width('100%')
    }
    .width('100%')
    .padding(8)
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(this.editingCueIndex === index || this.selectedCueIndex === index
      ? HomeTokens.accentGlass
      : (this.editingCueIndex < 0 && this.selectedCueIndex < 0 && this.cueActive(cue)
        ? HomeTokens.tertiaryGlass : HomeTokens.cueCardFill))
    .border({
      width: 1,
      color: this.editingCueIndex === index || this.selectedCueIndex === index
        ? HomeTokens.primary
        : (this.editingCueIndex < 0 && this.selectedCueIndex < 0 && this.cueActive(cue)
          ? HomeTokens.tertiary : HomeTokens.glassEdge)
    })
    .onClick((): void => {
      this.handleCueCardTap(cue, index);
    })
  }

  @Builder
  cueCardRedesigned(cue: Cue, index: number) {
    Row({ space: 10 }) {
      Column({ space: 3 }) {
        Text(this.clockMillis(cue.start))
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
        Text(this.clockMillis(cue.end))
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
        Text(this.cueDurationLabel(cue))
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textDim)
        Divider()
          .strokeWidth(1)
          .color(HomeTokens.glassEdge)
          .width('78%')
        Row({ space: 5 }) {
          Stack() {
            Text('↻')
              .fontSize(this.dims.miniSize + 1)
              .fontColor(HomeTokens.textDim)
          }
          .width(28)
          .height(28)
          .alignContent(Alignment.Center)
          .borderRadius(this.dims.radiusPill)
          .backgroundColor(HomeTokens.glassFill)
          .onClick((): void => {
            this.toast('重新识别将在识别后端接入后执行');
          })
          Row() {
            Text(cue.wordChecked ? '✓ 已校对' : '逐词校对')
              .fontSize(this.dims.miniSize - 2)
              .fontColor(cue.wordChecked ? HomeTokens.primary : HomeTokens.textDim)
              .maxLines(1)
          }
            .padding({ left: 7, right: 7, top: 4, bottom: 4 })
            .borderRadius(this.dims.radiusPill)
            .backgroundColor(cue.wordChecked ? HomeTokens.accentGlass : HomeTokens.glassFill)
            .border({ width: 1, color: cue.wordChecked ? HomeTokens.primary : HomeTokens.glassEdge })
            .onClick((): void => {
              this.toggleWordChecked(cue, index);
            })
        }
        .width('100%')
      }
      .width(this.splitPanelExpanded ? 0 : 106)
      .alignItems(HorizontalAlign.Start)
      .opacity(this.splitPanelExpanded ? 0 : 1)
      .clip(true)
      .animation({ duration: 180, curve: curves.springMotion(0.28, 0.72) })

      Column({ space: 4 }) {
        Row({ space: 5 }) {
          Circle()
            .width(7)
            .height(7)
            .fill(this.cueSpeakerColor(cue))
          Text(this.cueSpeaker(cue))
            .fontSize(this.dims.miniSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.cueSpeakerColor(cue))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text('中文 / 字幕 · Default')
            .fontSize(this.dims.miniSize - 2)
            .fontColor(HomeTokens.textDim)
            .maxLines(1)
        }
        if (this.editingCueIndex === index) {
          this.cueEditor(cue)
        } else {
          Text(this.cuePrimary(cue))
            .fontSize(this.dims.miniSize + 2)
            .fontColor(this.cueSpeakerColor(cue))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          Text(this.cueSecondary(cue))
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textDim)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .translate({ x: 0, y: 0 })
    }
    .alignItems(VerticalAlign.Top)
    .width('100%')
    .padding({
      left: this.splitPanelExpanded ? 6 : 10,
      right: this.splitPanelExpanded ? 6 : 10,
      top: 9,
      bottom: 9
    })
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(this.editingCueIndex === index || this.selectedCueIndex === index
      ? HomeTokens.accentGlass
      : (this.editingCueIndex < 0 && this.selectedCueIndex < 0 && this.cueActive(cue)
        ? HomeTokens.tertiaryGlass : HomeTokens.cueCardFill))
    .border({
      width: 1,
      color: this.editingCueIndex === index || this.selectedCueIndex === index
        ? HomeTokens.primary
        : (this.editingCueIndex < 0 && this.selectedCueIndex < 0 && this.cueActive(cue)
          ? HomeTokens.tertiary : HomeTokens.glassEdge)
    })
    .onClick((): void => {
      this.handleCueCardTap(cue, index);
    })
  }

  @Builder
  subtitleSidebar() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        Text(this.projectName())
          .fontSize(this.dims.bodySize + 1)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text('ASS 特效')
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.tertiary)
          .padding({ left: 5, right: 5, top: 2, bottom: 2 })
          .borderRadius(5)
          .backgroundColor(HomeTokens.tertiaryGlass)
        this.splitToggle()
      }
      .width('100%')

      Row({ space: 5 }) {
        EditorPill({
          dims: this.dims,
          label: '全部角色',
          compact: true,
          onTap: (): void => {
          }
        })
        TextInput({ placeholder: '输入内容过滤' })
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.text)
          .placeholderColor(HomeTokens.textFaint)
          .height(28)
          .layoutWeight(1)
          .padding({ left: 9, right: 9 })
          .backgroundColor(HomeTokens.glassFill)
          .borderRadius(this.dims.radiusPill)
        Text('⌕')
          .fontSize(this.dims.bodySize)
          .fontColor(HomeTokens.textDim)
          .padding(5)
      }
      .width('100%')

      Row({ space: 6 }) {
        Text('显示模式')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
        Text('中英双行')
          .fontSize(this.dims.miniSize + 1)
          .fontColor(HomeTokens.text)
        Toggle({ type: ToggleType.Switch, isOn: this.showBilingual })
          .width(32)
          .height(19)
          .selectedColor(HomeTokens.primary)
          .onChange((on: boolean): void => {
            this.showBilingual = on;
          })
        Text(`△ ${this.cueCount()}`)
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
        Blank()
        Text('◉')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
      }
      .width('100%')

      Row() {
        Text('逐词高亮按 ASS 标签')
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
        Blank()
        Text('重新导入字幕')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.primary)
          .padding({ left: 9, right: 9, top: 4, bottom: 4 })
          .borderRadius(this.dims.radiusPill)
          .backgroundColor(HomeTokens.accentGlass)
          .onClick((): void => {
            this.reimportSubtitle();
          })
      }
      .width('100%')

      List({ space: 6, scroller: this.cueScroller }) {
        LazyForEach(this.cueSource, (cue: Cue, index: number) => {
          ListItem() {
            this.cueCardRedesigned(cue, index)
          }
        }, (cue: Cue) => `${cue.index}-${cue.start}`)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)

      Text('单击跳转播放 · 双击字幕编辑 · 点其他位置自动保存')
        .fontSize(this.dims.miniSize - 2)
        .fontColor(HomeTokens.textFaint)
        .maxLines(1)
        .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding({ left: 8, right: 8, bottom: 8 })
  }

  @Builder
  settingToggleRow(label: string, kind: string) {
    Row() {
      Text(label)
        .fontSize(this.dims.miniSize + 1)
        .fontColor(HomeTokens.text)
      Blank()
      Toggle({ type: ToggleType.Switch, isOn: this.settingValue(kind) })
        .width(32)
        .height(19)
        .selectedColor(HomeTokens.primary)
        .onChange((on: boolean): void => {
          this.setSetting(kind, on);
        })
    }
    .width('100%')
  }

  private settingValue(kind: string): boolean {
    if (kind === 'bilingual') {
      return this.showBilingual;
    }
    if (kind === 'word') {
      return this.showWordHighlight;
    }
    if (kind === 'scroll') {
      return this.autoScroll;
    }
    if (kind === 'translate') {
      return this.store.autoTranslate;
    }
    return this.store.useVad;
  }

  private setSetting(kind: string, on: boolean): void {
    if (kind === 'bilingual') {
      this.showBilingual = on;
      return;
    }
    if (kind === 'word') {
      this.showWordHighlight = on;
      return;
    }
    if (kind === 'scroll') {
      this.autoScroll = on;
      return;
    }
    if (kind === 'translate') {
      this.store.autoTranslate = on;
    } else {
      this.store.useVad = on;
    }
    this.store.saveSettings();
  }

  @Builder
  speakerCard(speaker: SpeakerStat) {
    Row({ space: 7 }) {
      Column()
        .width(11)
        .height(11)
        .borderRadius(6)
        .backgroundColor(speaker.color)
        .border({ width: 1, color: HomeTokens.glassEdge })
      Column({ space: 1 }) {
        Text(speaker.name)
          .fontSize(this.dims.miniSize + 1)
          .fontColor(HomeTokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${speaker.count} 行`)
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
          .maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .height(54)
    .padding({ left: 9, right: 9 })
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(HomeTokens.innerFill)
    .border({ width: 1, color: HomeTokens.glassEdge })
    .onClick((): void => {
      this.assignSpeaker(speaker);
    })
    .gesture(
      LongPressGesture({ repeat: false, duration: 500 })
        .onAction((): void => {
          this.openSpeakerEditor(speaker);
        })
    )
  }

  @Builder
  speakerAddCard() {
    Row({ space: 6 }) {
      SymbolGlyph($r('sys.symbol.plus'))
        .fontSize(15)
        .fontColor([HomeTokens.primary])
      Text('添加人物')
        .fontSize(this.dims.miniSize + 1)
        .fontColor(HomeTokens.primary)
    }
    .width('100%')
    .height(54)
    .justifyContent(FlexAlign.Center)
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(HomeTokens.accentGlass)
    .border({ width: 1, color: HomeTokens.primary, style: BorderStyle.Dashed })
    .onClick((): void => {
      this.openSpeakerCreator();
    })
  }

  @Builder
  speakerTab(singleColumn: boolean) {
    Column({ space: 8 }) {
      Row() {
        Text('人物列表')
          .fontSize(this.dims.bodySize + 1)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
        Blank()
        Text(`${this.speakers.length} 人`)
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
      }
      .width('100%')

      Text('点击标注当前句 · 长按编辑名字/颜色')
        .fontSize(this.dims.miniSize - 1)
        .fontColor(HomeTokens.textFaint)
        .width('100%')

      if (this.speakers.length === 0) {
        Text('还没有人物。先添加一个，再播放到要标注的字幕上点它。')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .width('100%')
          .padding({ top: 2, bottom: 2 })
      }

      Grid() {
        GridItem() {
          this.speakerAddCard()
        }
        .width('100%')

        ForEach(this.speakers, (speaker: SpeakerStat) => {
          GridItem() {
            this.speakerCard(speaker)
          }
          .width('100%')
        }, (speaker: SpeakerStat) => `${speaker.name}-${speaker.count}-${speaker.color}`)
      }
      .columnsTemplate(singleColumn ? '1fr' : '1fr 1fr')
      .columnsGap(6)
      .rowsGap(6)
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .padding(8)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  speakerDialogOverlay() {
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#77000000')
        .onClick((): void => {
          this.closeSpeakerDialog();
        })

      Column({ space: 12 }) {
        Text(this.speakerDialogEditing.length > 0 ? '编辑人物' : '添加人物')
          .fontSize(this.dims.bodySize + 2)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
          .width('100%')

        TextInput({ text: this.speakerNameDraft, placeholder: '人物名称' })
          .fontSize(this.dims.bodySize)
          .fontColor(HomeTokens.text)
          .placeholderColor(HomeTokens.textFaint)
          .height(40)
          .padding({ left: 10, right: 10 })
          .backgroundColor(HomeTokens.glassFill)
          .borderRadius(this.dims.radiusInner)
          .onChange((value: string): void => {
            this.speakerNameDraft = value;
          })

        Text('颜色')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .width('100%')

        Row({ space: 9 }) {
          ForEach(this.speakerPalette, (color: string) => {
            Column()
              .width(28)
              .height(28)
              .borderRadius(14)
              .backgroundColor(color)
              .border({
                width: this.speakerColorDraft.toUpperCase() === color.toUpperCase() ? 3 : 1,
                color: this.speakerColorDraft.toUpperCase() === color.toUpperCase()
                  ? HomeTokens.text : HomeTokens.glassEdge
              })
              .onClick((): void => {
                this.speakerColorDraft = color;
              })
          }, (color: string) => color)
        }
        .width('100%')

        if (this.speakerDialogEditing.length > 0) {
          Row() {
            Blank()
            Text('删除人物')
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.danger)
              .padding({ left: 8, right: 8, top: 4, bottom: 4 })
              .onClick((): void => {
                this.requestDeleteSpeaker();
              })
          }
          .width('100%')
        }

        Text('点击人物卡片会标注当前句；长按卡片可改名字和颜色。')
          .fontSize(this.dims.miniSize - 1)
          .fontColor(HomeTokens.textFaint)
          .width('100%')

        Row({ space: 10 }) {
          Button('取消', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(38)
            .fontSize(this.dims.miniSize + 1)
            .fontColor(HomeTokens.textDim)
            .backgroundColor(HomeTokens.glassFill)
            .borderRadius(this.dims.radiusPill)
            .onClick((): void => {
              this.closeSpeakerDialog();
            })
          Button('保存', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(38)
            .fontSize(this.dims.miniSize + 1)
            .fontColor(HomeTokens.onPrimary)
            .backgroundColor(HomeTokens.primary)
            .borderRadius(this.dims.radiusPill)
            .onClick((): void => {
              this.saveSpeakerDialog();
            })
        }
        .width('100%')
      }
      .width(this.dims.bp === Bp.SM ? '86%' : 400)
      .padding(20)
      .borderRadius(this.dims.radiusCard)
      .backgroundColor(HomeTokens.panelFill)
      .backgroundBlurStyle(this.dims.glassBlur, { colorMode: HomeTokens.blurMode() })
      .border({ width: 1, color: HomeTokens.glassEdge })
    }
    .width('100%')
    .height('100%')
    .zIndex(60)
  }

  @Builder
  settingsTab() {
    EditorSettingsPane({
      dims: this.dims, options: $editorOptions, context: this.store.context,
      libraryPath: `${this.store.rootDir()}/editor-style-presets.json`,
      speakers: this.speakers.map((s: SpeakerStat): string => s.name),
      onChanged: (): void => {
        this.saveEditorOptions();
        if (this.editorOptions['audioMode'] !== this.editorOptions['generatedAudioMode']) { this.releaseAuxiliaryAudio(); }
        else if (this.editorOptions['audioMode'] === 'denoise' && this.auxiliaryAudio === null) {
          const path = `${this.store.projectsDir()}/${this.store.current?.id || 'draft'}/editor-audio.wav`;
          if (fileExists(path)) { this.useAuxiliaryAudio(path).catch((err: Error): void => { this.toast(err.message); }); }
        }
      },
      onMedia: (): void => { this.replaceEditorMedia(); },
      onSubtitle: (): void => { this.reimportSubtitle(); },
      onAudio: (): void => { this.prepareWaveform(true); },
      onFont: (lang: string): void => { this.loadEditorFont(lang); },
      onExport: (kind: string, speaker: string): void => { this.exportAss(kind, speaker); }
    }) {
      Column() { this.legacySettingsTab() }.height(440).width('100%')
    }
  }

  @Builder
  legacySettingsTab() {
    Scroll() {
      Column({ space: 10 }) {
        Text('字幕显示')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .width('100%')
        this.settingToggleRow('中英双行', 'bilingual')
        this.settingToggleRow('逐词高亮', 'word')
        this.settingToggleRow('自动滚动', 'scroll')

        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)

        Text('识别与翻译')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .width('100%')
        this.settingToggleRow('识别后自动翻译', 'translate')
        this.settingToggleRow('VAD 静音裁剪', 'vad')

        Text('目标语言')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .width('100%')
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(['zh', 'en', 'ja', 'ko'], (code: string) => {
            Text(this.langLabel(code))
              .fontSize(this.dims.miniSize)
              .fontColor(this.store.targetLang === code ? HomeTokens.onPrimary : HomeTokens.textDim)
              .padding({ left: 10, right: 10, top: 5, bottom: 5 })
              .margin({ right: 6, bottom: 6 })
              .borderRadius(this.dims.radiusPill)
              .backgroundColor(this.store.targetLang === code ? HomeTokens.primary : HomeTokens.glassFill)
              .onClick((): void => {
                this.store.targetLang = code;
                this.store.saveSettings();
              })
          }, (code: string) => code)
        }
        .width('100%')

        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)

        Text('翻译接口')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textDim)
          .width('100%')
        Text(this.store.translateEndpoint.length > 0
          ? this.store.translateEndpoint
          : '未配置（到「设置 → 翻译与术语」填写）')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(`模型：${this.store.translateModel.length > 0 ? this.store.translateModel : '跟随接口默认'}`)
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(10)
      .borderRadius(this.dims.radiusInner)
      .backgroundColor(HomeTokens.innerFill)
      .border({ width: 1, color: HomeTokens.glassEdge })
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
    .padding(8)
    .align(Alignment.TopStart)
  }

  private langLabel(code: string): string {
    if (code === 'zh') {
      return '简中';
    }
    if (code === 'en') {
      return 'English';
    }
    if (code === 'ja') {
      return '日本語';
    }
    return '한국어';
  }

  @Builder
  logTab() {
    Column({ space: 6 }) {
      Row() {
        Text('运行日志')
          .fontSize(this.dims.bodySize + 1)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
        Blank()
        Text(`${Logger.history().length} 条`)
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
      }
      .width('100%')

      Scroll() {
        Column({ space: 4 }) {
          ForEach(Logger.history().slice(-80).reverse(), (entry: LogEntry, index: number) => {
            Text(entry.format())
              .fontSize(this.dims.miniSize - 1)
              .fontColor(entry.level >= 3 ? HomeTokens.danger
                : (entry.level === 2 ? '#FFD166' : HomeTokens.textDim))
              .maxLines(3)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }, (entry: LogEntry, index: number) => `${entry.time}-${index}`)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .padding(8)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  workloadTab() {
    Column({ space: 7 }) {
      Text('工作量')
        .fontSize(this.dims.bodySize + 1)
        .fontWeight(FontWeight.Medium)
        .fontColor(HomeTokens.text)
        .width('100%')
      Row() {
        Text('字幕行数').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(`${this.store.cues.length}`).fontSize(this.dims.miniSize).fontColor(HomeTokens.text)
      }.width('100%')
      Row() {
        Text('逐词行数').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(`${this.wordCueCount()}`).fontSize(this.dims.miniSize).fontColor(HomeTokens.text)
      }.width('100%')
      Row() {
        Text('人物').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(`${this.speakers.length}`).fontSize(this.dims.miniSize).fontColor(HomeTokens.text)
      }.width('100%')
      Row() {
        Text('媒体时长').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(this.clock(this.playDuration())).fontSize(this.dims.miniSize).fontColor(HomeTokens.text)
      }.width('100%')
      Row() {
        Text('编码').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(this.probeInfo !== null && this.probeInfo.ok
          ? `${this.probeInfo.videoCodec.toUpperCase()} ${this.probeInfo.width}x${this.probeInfo.height}`
          : '—')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.text)
      }.width('100%')
      Row() {
        Text('解码').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(this.decodeLabel.length > 0 ? this.decodeLabel : '—')
          .fontSize(this.dims.miniSize)
          .fontColor(this.proxyState === 'failed' ? HomeTokens.danger : HomeTokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }.width('100%')
      Row() {
        Text('媒体文件').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(this.mediaName()).fontSize(this.dims.miniSize).fontColor(HomeTokens.text)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.width('100%')
      Row() {
        Text('项目').fontSize(this.dims.miniSize).fontColor(HomeTokens.textDim)
        Blank()
        Text(this.projectName()).fontSize(this.dims.miniSize).fontColor(HomeTokens.text)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.width('100%')
    }
    .width('100%')
    .padding(10)
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(HomeTokens.innerFill)
    .border({ width: 1, color: HomeTokens.glassEdge })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  sidebarSubtitleWithSplit() {
    Row() {
      Column() {
        this.subtitleSidebar()
      }
      .width(this.splitPanelExpanded
        ? (this.dims.bp === Bp.MD ? '66%' : '70%')
        : '100%')
      .height('100%')
      .animation({ duration: 220, curve: curves.springMotion(0.3, 0.78) })

      if (this.splitPanelVisible) {
        Divider()
          .vertical(true)
          .height('100%')
          .color(HomeTokens.glassEdge)
          .strokeWidth(0.5)
          .transition(TransitionEffect.OPACITY.animation({ duration: 220, curve: Curve.EaseOut }))

        Column() {
          this.speakerTab(true)
        }
        .layoutWeight(1)
        .height('100%')
        .backgroundColor(Color.Transparent)
        .transition(
          TransitionEffect.OPACITY.animation({ duration: 220, curve: Curve.EaseOut })
            .combine(TransitionEffect.translate({ x: 16 }).animation({
              duration: 240,
              curve: curves.springMotion(0.3, 0.78)
            }))
            .combine(TransitionEffect.scale({ x: 0.94, y: 0.96 }).animation({
              duration: 240,
              curve: curves.springMotion(0.3, 0.78)
            }))
        )
      }
    }
    .width('100%')
    .height('100%')
    .animation({ duration: 220, curve: curves.springMotion(0.3, 0.78) })
  }

  @Builder
  sidebarBoard() {
    EditorPanel({ dims: this.dims, pad: 0 }) {
      Column() {
        HdsTabs({ controller: this.sidebarController }) {
          TabContent() {
            this.sidebarSubtitleWithSplit()
          }
          .tabBar(this.sidebarTabItem('字幕'))

          TabContent() {
            this.speakerTab(false)
          }
          .tabBar(this.sidebarTabItem('人物'))

          TabContent() {
            this.settingsTab()
          }
          .tabBar(this.sidebarTabItem('设置'))

          TabContent() {
            this.logTab()
          }
          .tabBar(this.sidebarTabItem('日志'))

          TabContent() {
            this.workloadTab()
          }
          .tabBar(this.sidebarTabItem('工作量'))
        }
        .vertical(false)
        .barPosition(BarPosition.Start)
        .barHeight(38)
        .barMode(BarMode.Fixed)
        .barBackgroundColor(Color.Transparent)
        // 侧栏切换栏也用 HdsTabs 的沉浸材质；不再给单个 tab 铺蓝底。
        .barFloatingStyle({
          barWidth: {
            smallWidth: 280,
            mediumWidth: 280,
            largeWidth: 280
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
        .scrollable(false)
        .onChange((index: number): void => {
          if (index >= 0 && index < this.sidebarTabNames.length) {
            this.sidebarTab = this.sidebarTabNames[index];
          }
          if (index !== 0) {
            if (this.splitPanelVisible) {
              this.splitPanelExpanded = false;
              this.splitNavStack.pop();
              setTimeout((): void => {
                this.splitPanelVisible = false;
                this.splitRoles = false;
              }, 220);
            } else {
              this.splitRoles = false;
            }
          }
        })
        .layoutWeight(1)
        .width('100%')
      }
      .width('100%')
      .height('100%')
    }
  }

  // ------------------------------------------------------------ 布局

  @Builder
  wideLayout() {
    GridRow({ columns: 12, gutter: { x: this.gap(), y: this.gap() } }) {
      GridCol({ span: 8 }) {
        Column({ space: this.gap() }) {
          Column() {
            this.videoBoard()
          }
          .width('100%')
          .layoutWeight(1)

          Column() {
            this.timelineBoard()
          }
          .width('100%')
          .height(this.timelineHeight())
        }
        .width('100%')
        .height('100%')
      }
      .height('100%')

      GridCol({ span: 4 }) {
        this.sidebarBoard()
      }
      .height('100%')
    }
    .width('100%')
    .height('100%')
    .layoutWeight(1)
  }

  @Builder
  stackedLayout() {
    GridRow({ columns: 12, gutter: { x: this.gap(), y: this.gap() } }) {
      GridCol({ span: 12 }) {
        Column({ space: this.gap() }) {
          Column() {
            this.videoBoard()
          }
          .width('100%')
          .height(this.videoHeight())

          Column() {
            this.timelineBoard()
          }
          .width('100%')
          .height(this.timelineHeight())
        }
        .width('100%')
      }

      GridCol({ span: 12 }) {
        Column() {
          this.sidebarBoard()
        }
        .width('100%')
        .height(this.sidebarHeight())
      }
    }
    .width('100%')
  }

  build() {
    Stack() {
      ImmersiveBackground()

      Column() {
        this.topBar()

        if (this.isWide()) {
          this.wideLayout()
        } else {
          Scroll() {
            this.stackedLayout()
          }
          .width('100%')
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
          .align(Alignment.TopStart)
        }
      }
      .width('100%')
      .height('100%')
      .padding({
        left: this.dims.pagePaddingH,
        right: this.dims.pagePaddingH,
        top: this.statusBarHeight + 6,
        bottom: this.navIndicatorHeight + 8
      })

      if (this.speakerDialogOpen) {
        this.speakerDialogOverlay()
      }
    }
    .width('100%')
    .height('100%')
    .id('editor_root')
    .backgroundColor(HomeTokens.base)
  }
}
