/*
 * 新建稿件页（PROJECT WORKSPACE 四板块）。
 *
 * 布局：
 *   · WaterFlow 由 @ohos.mediaquery 的 sm / md / lg 断点驱动：
 *       sm 1 列 / md 2 列 / lg 3 列；
 *   · 四个板块依次是 预览 / 输入与配置 / 处理进度 / 生成设置。
 *
 * 当前可用链路：
 *   · 生成方式「导入已有字幕」：选视频（可选）+ 字幕文件或 SubFabric 项目包，
 *     创建时把字幕写进项目；项目包里的 translation.json 会一并写入译文；
 *   · 「创建初稿」：选视频/音频 → 建项目 → 端侧语音识别 → 写入字幕。
 *
 * 建稿规则：
 *   · 名称留空时依次使用 项目包 project.json 的 name / 视频文件名 / 字幕文件名；
 *   · 视频在点「创建项目」时才复制进沙箱；
 *   · 必须选到能解析出字幕的来源，避免建出空项目（空稿件入口后续由初稿模式承担）。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { hdsMaterial, HdsTabs, HdsTabsController } from '@kit.UIDesignKit';
import { Cue } from 'common';

import { AppStore, ProjectMeta, RunState } from '../../store/AppStore';
import { Bp, HomeDims } from '../home/HomeBreakpoints';
import { HomeTokens } from '../home/HomeTokens';
import { GlassCard } from '../home/GlassCard';
import { importToSandbox, safeFileName, deleteFile } from '../../platform/FileUtil';
import {
  ImportedSubtitle, readSubtitleSource, readProjectPackage, rebuildCues
} from '../../platform/SubtitleImporter';
import { Logger } from '../../engine/Logger';

const TAG = 'NewProject';
const MODE_IMPORT: string = 'import';
const MODE_DRAFT: string = 'draft';

@Extend(Text)
function workspaceKicker() {
  .fontSize(9)
  .fontColor(HomeTokens.primary)
  .letterSpacing(1.1)
  .fontWeight(FontWeight.Medium)
}

@Extend(Text)
function workspaceSub() {
  .fontSize(11)
  .fontColor(HomeTokens.textFaint)
  .lineHeight(16)
}

@Component
export struct NewProjectPane {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;
  @Prop bottomInset: number = 0;

  onBack: () => void = (): void => {};
  onCreated: (project: ProjectMeta) => void = (): void => {};
  /** 通知外层：当前是否正在复制/识别，系统返回时据此避免中断。 */
  onBusyChange: (busy: boolean) => void = (): void => {};

  @State private name: string = '';
  @State private mode: string = MODE_IMPORT;

  @State private mediaUri: string = '';
  @State private mediaName: string = '';
  @State private mediaDuration: number = 0;
  @State private mediaHasVideo: boolean = false;
  @State private mediaProbing: boolean = false;

  @State private subtitleUri: string = '';
  @State private subtitleName: string = '';
  @State private packUri: string = '';
  @State private packName: string = '';

  @State private pendingCount: number = 0;
  @State private pendingLabel: string = '';
  @State private pendingWarning: string = '';
  @State private pendingKind: string = '';
  @State private removeLineBreaks: boolean = true;

  @State @Watch('notifyBusy') private busy: boolean = false;
  @State private progressPct: number = 0;
  @State private progressStage: number = -1;
  @State private progressMsg: string = '尚未开始';
  @State private progressLog: string = '';

  @State private nameFocused: boolean = false;

  private pending: ImportedSubtitle | null = null;
  private pendingCues: Cue[] = [];

  private backController: HdsTabsController = new HdsTabsController();

  // ------------------------------------------------------------ 尺寸 / 文案

  private backSize(): number {
    return this.dims.bp === Bp.LG ? 48 : 44;
  }

  private titleFont(): number {
    return this.dims.titleSize + 4;
  }

  private bodyFont(): number {
    return this.dims.bodySize + 1;
  }

  private hintFont(): number {
    return this.dims.miniSize + 1;
  }

  private columnsTemplate(): string {
    if (this.dims.bp === Bp.LG) {
      return '1fr 1fr 1fr';
    }
    if (this.dims.bp === Bp.MD) {
      return '1fr 1fr';
    }
    return '1fr';
  }

  private previewHeight(): number {
    if (this.dims.bp === Bp.LG) {
      return 224;
    }
    return this.dims.bp === Bp.MD ? 200 : 176;
  }

  private canCreate(): boolean {
    if (this.busy) {
      return false;
    }
    if (this.mode === MODE_DRAFT) {
      return this.mediaUri.length > 0;
    }
    return this.pendingCount > 0 && this.pendingCues.length > 0;
  }

  private importHint(): string {
    if (this.busy) {
      return this.mode === MODE_DRAFT ? '正在端侧识别，请保持应用在前台…' : '正在处理，请稍候…';
    }
    if (this.mode === MODE_DRAFT) {
      if (this.mediaUri.length === 0) {
        return '还不能开始：先选择要识别的视频或音频';
      }
      return `已选择 ${this.mediaName}，创建后将运行端侧语音识别`;
    }
    if (this.pendingCount > 0) {
      return `已读取 ${this.pendingCount} 条字幕，创建后可继续校对`;
    }
    return '还不能开始：先选择要导入的字幕文件或项目包';
  }

  private hintPositive(): boolean {
    if (this.mode === MODE_DRAFT) {
      return this.mediaUri.length > 0;
    }
    return this.pendingCount > 0;
  }

  private displayTitle(): string {
    const typed = this.name.trim();
    if (typed.length > 0) {
      return typed;
    }
    if (this.pending !== null && this.pending.projectName.length > 0) {
      return this.pending.projectName;
    }
    const mediaBase = stripExtension(this.mediaName);
    if (mediaBase.length > 0) {
      return mediaBase;
    }
    if (this.pending !== null && this.pending.fileBase.length > 0) {
      return this.pending.fileBase;
    }
    return '未命名稿件';
  }

  private durationLabel(): string {
    if (this.mediaProbing) {
      return '读取中…';
    }
    if (this.mediaDuration <= 0) {
      return '—';
    }
    return clockLabel(this.mediaDuration);
  }

  private summaryLabel(): string {
    const parts: string[] = [];
    if (this.mode === MODE_DRAFT) {
      if (this.mediaName.length > 0) {
        parts.push(this.mediaHasVideo ? '视频识别初稿' : '音频识别初稿');
      }
      return parts.length > 0 ? parts.join(' · ') : '—';
    }
    if (this.pendingCount > 0) {
      parts.push(`${this.pendingCount} 条字幕`);
    }
    if (this.pendingKind === 'pack') {
      parts.push('项目包');
    } else if (this.pendingKind === 'file') {
      parts.push('字幕文件');
    }
    if (this.mediaName.length > 0) {
      parts.push(this.mediaHasVideo ? '视频' : '音频');
    }
    if (this.pendingWarning.length > 0) {
      parts.push(this.pendingWarning);
    }
    return parts.length > 0 ? parts.join(' · ') : '—';
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 2200 });
    } catch (err) {
      Logger.info(TAG, msg);
    }
  }

  private setProgress(pct: number, msg: string, stage: number): void {
    this.progressPct = Math.max(0, Math.min(100, Math.round(pct)));
    this.progressMsg = msg;
    if (stage >= 0) {
      this.progressStage = stage;
    }
    const line = `[${clockStamp()}] ${msg}`;
    const all = (this.progressLog.length > 0 ? `${this.progressLog}\n` : '') + line;
    const parts = all.split('\n');
    if (parts.length > 6) {
      parts.splice(0, parts.length - 6);
    }
    this.progressLog = parts.join('\n');
  }

  private resetProgress(): void {
    this.progressPct = 0;
    this.progressStage = -1;
    this.progressMsg = '尚未开始';
    this.progressLog = '';
  }

  private clearPending(): void {
    this.pending = null;
    this.pendingCues = [];
    this.pendingCount = 0;
    this.pendingLabel = '';
    this.pendingWarning = '';
    this.pendingKind = '';
  }

  private applyPending(info: ImportedSubtitle, kind: string): void {
    this.pending = info;
    this.pendingKind = kind;
    this.pendingCues = info.cues;
    this.pendingCount = info.cues.length;
    this.pendingLabel = info.label;
    this.pendingWarning = info.warning;
    if (this.name.trim().length === 0 && info.projectName.length > 0) {
      this.name = info.projectName;
    }
  }

  // ------------------------------------------------------------ 选择素材

  private async pickMedia(): Promise<void> {
    if (this.busy) {
      return;
    }
    const ctx: common.UIAbilityContext | null = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters =
        ['视频或音频|.mp4,.mkv,.mov,.m4a,.mp3,.wav,.flac,.aac,.ogg'];
      const uris: string[] = await new picker.DocumentViewPicker(ctx).select(options);
      if (uris.length === 0) {
        return;
      }
      const uri: string = uris[0];
      const rawName: string = decodeName(uri.substring(uri.lastIndexOf('/') + 1));
      this.mediaUri = uri;
      this.mediaName = safeFileName(rawName, 'media');
      this.mediaDuration = 0;
      this.mediaHasVideo = false;
      this.probeMedia(uri);
      this.toast(`已选择 ${this.mediaName}`);
    } catch (err) {
      const e = err as Error;
      Logger.warn(TAG, `选择媒体失败：${e.message}`);
      this.toast('没有选择媒体');
    }
  }

  private async probeMedia(uri: string): Promise<void> {
    this.mediaProbing = true;
    try {
      const info = await this.store.decoderForProbe().probe(uri);
      this.mediaDuration = info.durationSec;
      this.mediaHasVideo = info.hasVideo;
    } catch (err) {
      Logger.warn(TAG, '读取媒体信息失败（忽略）');
    } finally {
      this.mediaProbing = false;
    }
  }

  private async pickSubtitle(): Promise<void> {
    if (this.busy) {
      return;
    }
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
      const uri: string = uris[0];
      const rawName: string = decodeName(uri.substring(uri.lastIndexOf('/') + 1));
      const label: string = safeFileName(rawName, 'subtitle');
      this.busy = true;
      this.setProgress(12, '读取字幕文件…', 0);
      try {
        const info = readSubtitleSource(uri, label, this.removeLineBreaks);
        this.subtitleUri = uri;
        this.subtitleName = label;
        this.packUri = '';
        this.packName = '';
        this.applyPending(info, 'file');
        this.setProgress(info.cues.length > 0 ? 40 : 16,
          info.cues.length > 0 ? `已读取 ${info.cues.length} 条字幕` : '没有解析出字幕行', 0);
        this.toast(info.cues.length > 0 ? `已读取 ${info.cues.length} 条字幕` : '没有解析出字幕行');
      } finally {
        this.busy = false;
      }
    } catch (err) {
      const e = err as Error;
      this.busy = false;
      Logger.warn(TAG, `读取字幕失败：${e.message}`);
      this.setProgress(0, `读取字幕失败：${e.message}`, -1);
      this.toast(`读取字幕失败：${e.message}`);
    }
  }

  private async pickPackage(): Promise<void> {
    if (this.busy) {
      return;
    }
    const ctx: common.UIAbilityContext | null = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters = ['SubFabric 项目包|.zip'];
      const uris: string[] = await new picker.DocumentViewPicker(ctx).select(options);
      if (uris.length === 0) {
        return;
      }
      const uri: string = uris[0];
      const rawName: string = decodeName(uri.substring(uri.lastIndexOf('/') + 1));
      const label: string = safeFileName(rawName, 'project.zip');
      this.busy = true;
      this.setProgress(10, '正在读取项目包…', 0);
      try {
        const info = await readProjectPackage(ctx, uri, label, this.removeLineBreaks);
        this.packUri = uri;
        this.packName = label;
        this.subtitleUri = '';
        this.subtitleName = '';
        this.applyPending(info, 'pack');
        this.setProgress(info.cues.length > 0 ? 42 : 16,
          info.cues.length > 0 ? `项目包：${info.cues.length} 条字幕` : '项目包里没有可用字幕', 0);
        this.toast(info.cues.length > 0 ? `已读取 ${info.cues.length} 条字幕` : '项目包里没有可用字幕');
      } finally {
        this.busy = false;
      }
    } catch (err) {
      const e = err as Error;
      this.busy = false;
      Logger.warn(TAG, `读取项目包失败：${e.message}`);
      this.setProgress(0, `读取项目包失败：${e.message}`, -1);
      this.toast(`读取项目包失败：${e.message}`);
    }
  }

  private pickSource(kind: string): void {
    if (kind === 'media') {
      this.pickMedia();
    } else if (kind === 'subtitle') {
      this.pickSubtitle();
    } else {
      this.pickPackage();
    }
  }

  private clearSource(kind: string): void {
    if (this.busy) {
      return;
    }
    if (kind === 'media') {
      this.mediaUri = '';
      this.mediaName = '';
      this.mediaDuration = 0;
      this.mediaHasVideo = false;
      this.mediaProbing = false;
      return;
    }
    if (kind === 'subtitle') {
      this.subtitleUri = '';
      this.subtitleName = '';
      if (this.pendingKind === 'file') {
        this.clearPending();
        this.resetProgress();
      }
      return;
    }
    this.packUri = '';
    this.packName = '';
    if (this.pendingKind === 'pack') {
      this.clearPending();
      this.resetProgress();
    }
  }

  private toggleLineBreaks(on: boolean): void {
    this.removeLineBreaks = on;
    if (this.pending === null) {
      return;
    }
    const cues = rebuildCues(this.pending, on);
    this.pendingCues = cues;
    this.pendingCount = cues.length;
    this.pendingWarning = this.pending.warning;
  }

  // ------------------------------------------------------------ 创建

  private async submit(): Promise<void> {
    if (!this.canCreate()) {
      return;
    }
    const ctx: common.UIAbilityContext | null = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    if (this.mode === MODE_DRAFT) {
      await this.submitDraft(ctx);
      return;
    }
    if (this.pending === null) {
      return;
    }
    const source: ImportedSubtitle = this.pending as ImportedSubtitle;
    this.busy = true;
    this.setProgress(12, '准备素材…', 0);
    try {
      let localPath: string = '';
      let storedName: string = '';
      if (this.mediaUri.length > 0) {
        this.setProgress(20, '复制视频到应用沙箱…', 0);
        const unique: string = `${Date.now()}_${safeFileName(this.mediaName, 'media')}`;
        localPath = await importToSandbox(ctx, this.mediaUri, unique);
        storedName = safeFileName(this.mediaName, 'media');
      }

      this.setProgress(35, '创建项目…', 1);
      const mediaBase = stripExtension(this.mediaName);
      const fallbackName = source.projectName.length > 0 ? source.projectName
        : (mediaBase.length > 0 ? mediaBase : source.fileBase);
      const displayName = this.name.trim().length > 0 ? this.name.trim()
        : (fallbackName.length > 0 ? fallbackName : '未命名稿件');
      const project: ProjectMeta =
        await this.store.createProject(displayName, localPath, storedName);

      this.setProgress(60, '解析并写入字幕…', 2);
      const cues: Cue[] = rebuildCues(source, this.removeLineBreaks);
      if (cues.length === 0) {
        throw new Error('没有解析出字幕行');
      }
      this.store.cues = cues;
      project.cueCount = cues.length;
      project.updatedAt = Date.now();
      if (this.mediaDuration > 0) {
        project.durationSec = this.mediaDuration;
      } else if (localPath.length > 0) {
        try {
          const info = await this.store.decoderForProbe().probe(localPath);
          project.durationSec = info.durationSec;
        } catch (err) {
          Logger.warn(TAG, '读取媒体时长失败（忽略）');
        }
      }
      await this.store.saveCurrent();
      this.store.projects = this.store.projects.slice();

      this.setProgress(100, `完成：${project.name}（${cues.length} 条字幕）`, 3);
      this.busy = false;
      this.onCreated(project);
    } catch (err) {
      const e = err as Error;
      this.busy = false;
      Logger.error(TAG, `新建稿件失败：${e.message}`);
      this.setProgress(this.progressPct, `失败：${e.message}`, this.progressStage);
      this.toast(`新建失败：${e.message}`);
    }
  }

  /**
   * 「创建初稿」：复制媒体 → 建项目 → 调用 AppStore.runRecognition() → 保存 cues。
   * 识别失败时删掉刚建的空项目和本次复制的媒体，避免留下半成品或孤儿大文件。
   */
  private async submitDraft(ctx: common.UIAbilityContext): Promise<void> {
    if (this.mediaUri.length === 0) {
      this.toast('请先选择要识别的视频或音频');
      return;
    }
    this.busy = true;
    this.setProgress(8, '复制媒体到应用沙箱…', 0);
    let project: ProjectMeta | null = null;
    let copiedMedia: string = '';
    try {
      const unique: string = `${Date.now()}_${safeFileName(this.mediaName, 'media')}`;
      const localPath: string = await importToSandbox(ctx, this.mediaUri, unique);
      copiedMedia = localPath;
      const storedName: string = safeFileName(this.mediaName, 'media');

      this.setProgress(24, '创建项目…', 1);
      const mediaBase: string = stripExtension(this.mediaName);
      const displayName: string = this.name.trim().length > 0 ? this.name.trim()
        : (mediaBase.length > 0 ? mediaBase : '未命名稿件');
      project = await this.store.createProject(displayName, localPath, storedName);
      project.mediaName = storedName;
      if (this.mediaDuration > 0) {
        project.durationSec = this.mediaDuration;
      }
      await this.store.saveCurrent();
      this.store.projects = this.store.projects.slice();

      this.setProgress(34, '加载识别模型…', 2);
      let lastPct: number = -1;
      let lastMsg: string = '';
      const timer: number = setInterval((): void => {
        const pr = this.store.progress;
        const pct: number = 34 + Math.round(Math.max(0, Math.min(1, pr.ratio)) * 56);
        if (pct !== lastPct || pr.message !== lastMsg) {
          lastPct = pct;
          lastMsg = pr.message;
          this.setProgress(pct, pr.message.length > 0 ? pr.message : '正在识别…', 2);
        }
      }, 350);
      try {
        await this.store.runRecognition();
      } finally {
        clearInterval(timer);
      }

      if (this.store.runState !== RunState.DONE) {
        throw new Error(this.store.statusText.length > 0 ? this.store.statusText : '语音识别失败');
      }
      const count: number = this.store.cues.length;
      if (count === 0) {
        throw new Error('没有识别出字幕，请检查音频是否包含人声');
      }
      project.cueCount = count;
      project.updatedAt = Date.now();
      await this.store.saveCurrent();
      this.store.projects = this.store.projects.slice();

      this.setProgress(100, `完成：${project.name}（${count} 条字幕）`, 3);
      this.busy = false;
      this.onCreated(project);
    } catch (err) {
      const e = err as Error;
      this.busy = false;
      if (project !== null) {
        await this.store.deleteProject(project);
      }
      // 本次刚复制进来的媒体没有任何项目引用，失败时一并清掉，避免 100 MB+ 孤儿文件。
      if (copiedMedia.length > 0 && deleteFile(copiedMedia)) {
        Logger.info(TAG, `已清理未使用的媒体：${copiedMedia}`);
      }
      Logger.error(TAG, `创建初稿失败：${e.message}`);
      this.setProgress(this.progressPct, `失败：${e.message}`, 2);
      this.toast(`创建初稿失败：${e.message}`);
    }
  }

  private goBack(): void {
    if (this.busy) {
      return;
    }
    this.onBack();
  }

  private notifyBusy(): void {
    this.onBusyChange(this.busy);
  }

  // ------------------------------------------------------------ 顶部返回

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
      this.goBack();
    })
    .width(this.backSize())
    .height(this.backSize())
    .borderRadius(this.backSize() / 2)
    .clip(true)
  }

  @Builder
  header() {
    Row({ space: 12 }) {
      this.backButton()
      Column({ space: 3 }) {
        Text('SubFabric / 新建稿件')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.primary)
          .letterSpacing(0.7)
        Text('新建稿件')
          .fontSize(this.titleFont())
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
        Text(this.mode === MODE_DRAFT
          ? '选择视频或音频，创建后运行端侧语音识别'
          : '选择视频与字幕，确认后创建稿件')
          .fontSize(this.hintFont())
          .fontColor(HomeTokens.textFaint)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
  }

  // ------------------------------------------------------------ 板块公共件

  private toneColor(tone: string): string {
    if (tone === 'live') {
      return HomeTokens.primary;
    }
    if (tone === 'ok') {
      return HomeTokens.success;
    }
    if (tone === 'warn') {
      return HomeTokens.danger;
    }
    return HomeTokens.textDim;
  }

  private toneFill(tone: string): string {
    if (tone === 'live') {
      return HomeTokens.accentGlass;
    }
    if (tone === 'ok') {
      return HomeTokens.successGlass;
    }
    if (tone === 'warn') {
      return HomeTokens.dangerGlass;
    }
    return HomeTokens.glassFillStrong;
  }

  @Builder
  panelHead(section: string) {
    Row() {
      Column({ space: 2 }) {
        Text(this.sectionKicker(section)).workspaceKicker()
        Text(this.sectionTitle(section))
          .fontSize(this.bodyFont() + 2)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
      }
      .alignItems(HorizontalAlign.Start)

      Blank()

      Text(this.sectionBadge(section))
        .fontSize(this.dims.miniSize)
        .fontColor(this.toneColor(this.sectionTone(section)))
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .borderRadius(this.dims.radiusPill)
        .backgroundColor(this.toneFill(this.sectionTone(section)))
    }
    .width('100%')
  }

  private sectionKicker(section: string): string {
    if (section === 'preview') {
      return 'PREVIEW';
    }
    if (section === 'input') {
      return 'INPUT';
    }
    if (section === 'progress') {
      return 'PROCESS';
    }
    return 'GENERATE';
  }

  private sectionTitle(section: string): string {
    if (section === 'preview') {
      return '稿件预览';
    }
    if (section === 'input') {
      return '输入与配置';
    }
    if (section === 'progress') {
      return '处理进度';
    }
    return '生成设置';
  }

  private sectionBadge(section: string): string {
    if (section === 'preview') {
      return this.pendingCount > 0 ? '已就绪' : '等待确认';
    }
    if (section === 'input') {
      return this.pendingCount > 0 ? '可创建' : '待配置';
    }
    if (section === 'progress') {
      return this.busy ? '处理中' : (this.progressPct >= 100 ? '完成' : '待开始');
    }
    return this.store.translateEndpoint.length > 0 ? '已配置' : '跟随全局';
  }

  private sectionTone(section: string): string {
    if (section === 'preview' || section === 'input') {
      return this.pendingCount > 0 ? 'ok' : 'muted';
    }
    if (section === 'progress') {
      return this.busy ? 'live' : (this.progressPct >= 100 ? 'ok' : 'muted');
    }
    return this.store.translateEndpoint.length > 0 ? 'ok' : 'muted';
  }

  @Builder
  metaRow(kind: string) {
    Row({ space: 8 }) {
      Text(this.metaLabel(kind))
        .fontSize(this.hintFont())
        .fontColor(HomeTokens.textDim)
        .width(40)
      Text(this.metaValue(kind))
        .fontSize(this.hintFont())
        .fontColor(HomeTokens.text)
        .layoutWeight(1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
  }

  private metaLabel(kind: string): string {
    if (kind === 'title') {
      return '标题';
    }
    if (kind === 'author') {
      return '作者';
    }
    if (kind === 'duration') {
      return '时长';
    }
    return '简介';
  }

  private metaValue(kind: string): string {
    if (kind === 'title') {
      return this.displayTitle();
    }
    if (kind === 'author') {
      return '—';
    }
    if (kind === 'duration') {
      return this.durationLabel();
    }
    return this.summaryLabel();
  }

  // ------------------------------------------------------------ ① 预览

  @Builder
  previewPanel() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        this.panelHead('preview')
        Text('视频和字幕就绪后，这里显示标题、作者、时长和简介。').workspaceSub()

        Stack({ alignContent: Alignment.Center }) {
          if (this.mediaName.length > 0) {
            Column({ space: 6 }) {
              SymbolGlyph($r('sys.symbol.play_circle_fill'))
                .fontSize(this.dims.bp === Bp.SM ? 34 : 42)
                .fontColor([HomeTokens.primary])
              Text(this.mediaName)
                .fontSize(this.bodyFont())
                .fontColor(HomeTokens.text)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('90%')
                .textAlign(TextAlign.Center)
              Text(this.durationLabel())
                .fontSize(this.dims.miniSize)
                .fontColor(HomeTokens.textFaint)
            }
            .alignItems(HorizontalAlign.Center)
          } else if (this.pendingCount > 0) {
            Column({ space: 6 }) {
              SymbolGlyph($r('sys.symbol.doc_text'))
                .fontSize(this.dims.bp === Bp.SM ? 32 : 40)
                .fontColor([HomeTokens.primary])
              Text(this.pendingLabel)
                .fontSize(this.bodyFont())
                .fontColor(HomeTokens.text)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('90%')
                .textAlign(TextAlign.Center)
              Text(`${this.pendingCount} 条字幕已读取`)
                .fontSize(this.dims.miniSize)
                .fontColor(HomeTokens.success)
            }
            .alignItems(HorizontalAlign.Center)
          } else {
            Column({ space: 6 }) {
              SymbolGlyph($r('sys.symbol.play_circle'))
                .fontSize(this.dims.bp === Bp.SM ? 32 : 40)
                .fontColor([HomeTokens.textFaint])
              Text('还没有素材')
                .fontSize(this.bodyFont())
                .fontColor(HomeTokens.textDim)
              Text('先在「输入与配置」里选择视频和字幕 / 项目包。')
                .fontSize(this.dims.miniSize)
                .fontColor(HomeTokens.textFaint)
                .maxLines(2)
                .textAlign(TextAlign.Center)
                .width('86%')
            }
            .alignItems(HorizontalAlign.Center)
          }
        }
        .width('100%')
        .height(this.previewHeight())
        .borderRadius(this.dims.radiusInner)
        .backgroundColor(HomeTokens.mediaPlaceholder)
        .border({ width: 1, color: HomeTokens.glassEdge })
        .clip(true)

        this.metaRow('title')
        this.metaRow('author')
        this.metaRow('duration')
        this.metaRow('summary')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  // ------------------------------------------------------------ ② 输入与配置

  @Builder
  modeCard(kind: string, icon: Resource, title: string, desc: string) {
    Row({ space: 10 }) {
      SymbolGlyph(icon)
        .fontSize(this.dims.bp === Bp.SM ? 20 : 22)
        .fontColor([this.mode === kind ? HomeTokens.primary : HomeTokens.textFaint])
      Column({ space: 2 }) {
        Text(title)
          .fontSize(this.bodyFont())
          .fontColor(this.mode === kind ? HomeTokens.text : HomeTokens.textDim)
        Text(desc)
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .maxLines(2)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Text(this.mode === kind ? '当前' : '可选')
        .fontSize(this.dims.miniSize)
        .fontColor(this.mode === kind ? HomeTokens.primary : HomeTokens.textFaint)
    }
    .width('100%')
    .padding(10)
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(this.mode === kind ? HomeTokens.accentGlass : HomeTokens.glassFill)
    .border({
      width: 1,
      color: this.mode === kind ? HomeTokens.primary : HomeTokens.glassEdge
    })
    .onClick((): void => {
      if (this.busy) {
        return;
      }
      this.mode = kind;
      this.resetProgress();
      if (kind === MODE_DRAFT && this.mediaUri.length === 0) {
        this.toast('创建初稿：先选择要识别的视频或音频');
      }
    })
  }

  @Builder
  fileRow(label: string, kind: string) {
    Row({ space: 6 }) {
      Text(label)
        .fontSize(this.hintFont())
        .fontColor(HomeTokens.textDim)
        .width(46)
      Text(this.sourceValue(kind))
        .fontSize(this.hintFont())
        .fontColor(this.sourceChosen(kind) ? HomeTokens.text : HomeTokens.textFaint)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.sourceChosen(kind)) {
        SymbolGlyph($r('sys.symbol.xmark'))
          .fontSize(13)
          .fontColor([HomeTokens.textFaint])
          .padding(4)
          .onClick((): void => {
            this.clearSource(kind);
          })
      }
      Button(this.sourceChosen(kind) ? '更换' : '浏览…', { type: ButtonType.Normal })
        .height(28)
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.primary)
        .backgroundColor(HomeTokens.accentGlass)
        .borderRadius(this.dims.radiusPill)
        .padding({ left: 10, right: 10 })
        .onClick((): void => {
          this.pickSource(kind);
        })
    }
    .width('100%')
  }

  private sourceValue(kind: string): string {
    if (kind === 'media') {
      return this.mediaName.length > 0 ? this.mediaName : '还没选';
    }
    if (kind === 'subtitle') {
      return this.subtitleName.length > 0 ? this.subtitleName : '还没选';
    }
    return this.packName.length > 0 ? this.packName : '还没选';
  }

  private sourceChosen(kind: string): boolean {
    if (kind === 'media') {
      return this.mediaUri.length > 0;
    }
    if (kind === 'subtitle') {
      return this.subtitleUri.length > 0;
    }
    return this.packUri.length > 0;
  }

  @Builder
  inputPanel() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        this.panelHead('input')
        Text('各环节参数都在这里，确认没问题再开始生成。').workspaceSub()

        Text('项目名称')
          .fontSize(this.hintFont())
          .fontColor(HomeTokens.textDim)
        Column({ space: 4 }) {
          TextInput({ placeholder: '不填则使用视频 / 字幕文件名', text: this.name })
            .fontSize(this.bodyFont())
            .fontColor(HomeTokens.text)
            .placeholderColor(HomeTokens.textFaint)
            .caretColor(HomeTokens.primary)
            .height(42)
            .padding({ left: 0, right: 0 })
            .backgroundColor(Color.Transparent)
            .borderRadius(0)
            .onChange((value: string): void => {
              this.name = value;
            })
            .onFocus((): void => {
              this.nameFocused = true;
            })
            .onBlur((): void => {
              this.nameFocused = false;
            })
          Divider()
            .strokeWidth(1)
            .color(this.nameFocused ? HomeTokens.primary : HomeTokens.glassEdge)
        }
        .width('100%')

        Text('生成方式')
          .fontSize(this.hintFont())
          .fontColor(HomeTokens.textDim)
        this.modeCard(MODE_IMPORT, $r('sys.symbol.doc_text'),
          '导入已有字幕', '选好视频和字幕，创建后直接进入校对')
        this.modeCard(MODE_DRAFT, $r('sys.symbol.mic_circle_fill'),
          '创建初稿', '端侧语音识别，创建后直接进入校对')

        Text('素材来源')
          .fontSize(this.hintFont())
          .fontColor(HomeTokens.textDim)
        this.fileRow('视频', 'media')
        if (this.mode === MODE_IMPORT) {
          this.fileRow('字幕', 'subtitle')
          this.fileRow('项目包', 'pack')
        }

        if (this.mode === MODE_IMPORT) {
          Row() {
            Text('删除换行符')
              .fontSize(this.hintFont())
              .fontColor(HomeTokens.textDim)
            Blank()
            Toggle({ type: ToggleType.Switch, isOn: this.removeLineBreaks })
              .selectedColor(HomeTokens.primary)
              .switchPointColor(HomeTokens.onPrimary)
              .onChange((on: boolean): void => {
                this.toggleLineBreaks(on);
              })
          }
          .width('100%')
        }

        Text(this.importHint())
          .fontSize(this.hintFont())
          .fontColor(this.hintPositive() ? HomeTokens.success : HomeTokens.danger)
          .lineHeight(this.hintFont() + 5)
          .width('100%')
          .padding({ left: 10, right: 10, top: 8, bottom: 8 })
          .borderRadius(this.dims.radiusInner)
          .backgroundColor(this.hintPositive() ? HomeTokens.successGlass : HomeTokens.dangerGlass)

        if (this.pendingWarning.length > 0) {
          Text(this.pendingWarning)
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.danger)
            .width('100%')
        }

        Row({ space: 8 }) {
          Button('返回项目', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(this.dims.bp === Bp.SM ? 44 : 46)
            .fontSize(this.hintFont())
            .fontColor(HomeTokens.textDim)
            .backgroundColor(HomeTokens.glassFillStrong)
            .borderRadius(this.dims.radiusPill)
            .onClick((): void => {
              this.goBack();
            })
          Button({ type: ButtonType.Normal }) {
            Row({ space: 7 }) {
              if (this.busy) {
                LoadingProgress()
                  .width(this.dims.bp === Bp.SM ? 16 : 18)
                  .height(this.dims.bp === Bp.SM ? 16 : 18)
                  .color(this.canCreate() ? HomeTokens.onPrimary : HomeTokens.textFaint)
              }
              Text(this.busy ? '处理中…' :
                (this.mode === MODE_DRAFT ? '创建并识别' : '创建项目'))
                .fontSize(this.hintFont())
                .fontColor(this.canCreate() ? HomeTokens.onPrimary : HomeTokens.textDim)
                .maxLines(1)
            }
            .width('100%')
            .justifyContent(FlexAlign.Center)
          }
            .layoutWeight(1)
            .height(this.dims.bp === Bp.SM ? 44 : 46)
            .backgroundColor(this.canCreate() ? HomeTokens.primary : HomeTokens.disabledFill)
            .borderRadius(this.dims.radiusPill)
            .enabled(this.canCreate())
            .shadow({
              radius: this.canCreate() ? 16 : 0,
              color: this.canCreate() ? HomeTokens.primaryGlow : '#00000000',
              offsetX: 0,
              offsetY: 8
            })
            .onClick((): void => {
              this.submit();
            })
        }
        .width('100%')
        .margin({ top: 2 })

        Text(this.mode === MODE_DRAFT
          ? '端侧识别需要模型就绪并可用 NPU；识别过程会显示在上方进度面板。'
          : '项目包只带字幕与译文；视频需要在这里另外选择。')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  // ------------------------------------------------------------ ③ 处理进度

  private stageLabel(index: number): string {
    if (index === 0) {
      return '读取素材';
    }
    if (index === 1) {
      return '创建项目';
    }
    if (index === 2) {
      return this.mode === MODE_DRAFT ? '语音识别' : '写入字幕';
    }
    return '完成';
  }

  @Builder
  stageStep(index: number) {
    Column({ space: 5 }) {
      Stack({ alignContent: Alignment.Center }) {
        Text(`${index + 1}`)
          .fontSize(this.dims.miniSize)
          .fontColor(this.progressStage >= index ? HomeTokens.onPrimary : HomeTokens.textFaint)
      }
      .width(22)
      .height(22)
      .borderRadius(11)
      .backgroundColor(this.progressStage >= index ? HomeTokens.primary : HomeTokens.glassFillStrong)

      Text(this.stageLabel(index))
        .fontSize(this.dims.miniSize)
        .fontColor(this.progressStage >= index ? HomeTokens.text : HomeTokens.textFaint)
        .maxLines(1)
    }
    .layoutWeight(1)
  }

  @Builder
  progressPanel() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 12 }) {
        this.panelHead('progress')
        Text('各环节状态依次点亮，处理记录会保留在下方。').workspaceSub()

        Row({ space: 4 }) {
          this.stageStep(0)
          this.stageStep(1)
          this.stageStep(2)
          this.stageStep(3)
        }
        .width('100%')

        Stack({ alignContent: Alignment.Start }) {
          Row()
            .width('100%')
            .height(6)
            .borderRadius(3)
            .backgroundColor(HomeTokens.glassFillStrong)
          Row()
            .width(`${this.progressPct}%`)
            .height(6)
            .borderRadius(3)
            .backgroundColor(HomeTokens.primary)
        }
        .width('100%')
        .height(6)

        Row({ space: 8 }) {
          Text(`${this.progressPct}%`)
            .fontSize(this.bodyFont())
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.primary)
          Text(this.progressMsg)
            .fontSize(this.hintFont())
            .fontColor(HomeTokens.textDim)
            .layoutWeight(1)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)

        Column({ space: 4 }) {
          Text('进度内容')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textFaint)
          Text(this.progressLog.length > 0 ? this.progressLog
            : '创建项目后，这里会记录每一步的状态和结果。')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textDim)
            .lineHeight(this.dims.miniSize + 6)
            .width('100%')
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(10)
        .borderRadius(this.dims.radiusInner)
        .backgroundColor(HomeTokens.glassFill)

        Text('开始创建后，项目会先出现在「项目」瀑布流的最前面。')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  // ------------------------------------------------------------ ④ 生成设置

  @Builder
  settingsPanel() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        this.panelHead('settings')
        Text('翻译方案在全局设置里管理；导入已有字幕不会自动翻译。').workspaceSub()

        Text('当前翻译方案')
          .fontSize(this.hintFont())
          .fontColor(HomeTokens.textDim)
        Column({ space: 6 }) {
          Row({ space: 8 }) {
            SymbolGlyph($r('sys.symbol.translate'))
              .fontSize(18)
              .fontColor([HomeTokens.primary])
            Text(this.store.translateEndpoint.length > 0
              ? this.store.translateEndpoint : '未配置翻译接口')
              .fontSize(this.hintFont())
              .fontColor(HomeTokens.text)
              .layoutWeight(1)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
          .alignItems(VerticalAlign.Top)

          Text(this.store.translateEndpoint.length > 0
            ? (this.store.translateModel.length > 0 ? this.store.translateModel : '模型跟随接口默认')
            : '到「设置 → 翻译与术语」填写接口与模型')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textFaint)
            .width('100%')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .padding(10)
        .borderRadius(this.dims.radiusInner)
        .backgroundColor(HomeTokens.accentGlass)
        .alignItems(HorizontalAlign.Start)

        Row({ space: 8 }) {
          Button('刷新', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(32)
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textDim)
            .backgroundColor(HomeTokens.glassFillStrong)
            .borderRadius(this.dims.radiusPill)
            .onClick((): void => {
              this.toast('已刷新：方案来自全局设置');
            })
          Button('管理方案', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(32)
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.primary)
            .backgroundColor(HomeTokens.accentGlass)
            .borderRadius(this.dims.radiusPill)
            .onClick((): void => {
              this.toast('请在「设置 → 翻译与术语」中管理');
            })
        }
        .width('100%')

        Divider()
          .strokeWidth(0.5)
          .color(HomeTokens.glassEdge)

        Text('语音识别在端侧运行：模型就绪且设备有 NPU 时可直接创建初稿，否则请先到「模型」页面准备。')
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .lineHeight(this.dims.miniSize + 5)
          .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  // ------------------------------------------------------------ 页面

  build() {
    Column({ space: this.dims.gap }) {
      this.header()

      WaterFlow() {
        FlowItem() {
          this.previewPanel()
        }
        .width('100%')

        FlowItem() {
          this.inputPanel()
        }
        .width('100%')

        FlowItem() {
          this.progressPanel()
        }
        .width('100%')

        FlowItem() {
          this.settingsPanel()
        }
        .width('100%')
      }
      .columnsTemplate(this.columnsTemplate())
      .columnsGap(this.dims.gap)
      .rowsGap(this.dims.gap)
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
      .padding({ bottom: this.dims.pagePaddingBottom })
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

// ------------------------------------------------------------ 工具

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function clockStamp(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function stripExtension(name: string): string {
  const slash = name.lastIndexOf('/');
  const file = slash >= 0 ? name.substring(slash + 1) : name;
  const dot = file.lastIndexOf('.');
  return (dot > 0 ? file.substring(0, dot) : file).trim();
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return raw;
  }
}
