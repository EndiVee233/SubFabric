/*
 * 模型页。
 *
 * 只保留两类识别模型卡片：
 *   · Parakeet 0.6B · NPU（MindSpore Lite，当前可下载/可推理）
 *   · Parakeet 0.6B · Vulkan（模型文件与 NPU 共用；Vulkan 推理接口已预留）
 * 另加一张「手动导入模型」卡：本地多选 .ms/.txt/manifest 或导入 zip。
 *
 * CPU 不再作为模型/硬件选项出现。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';

import { AppStore } from '../../store/AppStore';
import { Bp, HomeDims } from '../home/HomeBreakpoints';
import { HomeTokens } from '../home/HomeTokens';
import { GlassCard } from '../home/GlassCard';
import { NpuHardware, VulkanHardware, VulkanModelInterface } from '../../engine/RecognitionHardware';
import { BarAutoHide } from '../nav/BarAutoHide';
import { deleteFile, importToSandbox, safeFileName } from '../../platform/FileUtil';

@Component
struct ModelButton {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @Prop dims: HomeDims;
  @Prop label: string = '';
  @Prop primary: boolean = false;
  @Prop isEnabled: boolean = true;
  onTap: () => void = (): void => {};

  build() {
    Button(this.label, { type: ButtonType.Normal })
      .fontSize(this.dims.bodySize + 1)
      .fontColor(this.primary ? HomeTokens.onPrimary : HomeTokens.primary)
      .backgroundColor(this.primary ? HomeTokens.primary : HomeTokens.accentGlass)
      .border({ width: this.primary ? 0 : 1, color: HomeTokens.glassEdge })
      .borderRadius(this.dims.radiusPill)
      .height(42)
      .padding({ left: 18, right: 18 })
      .opacity(this.isEnabled ? 1 : 0.5)
      .enabled(this.isEnabled)
      .onClick((): void => {
        this.onTap();
      })
  }
}

@Component
export struct ModelsPane {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;
  @Prop bottomInset: number = 0;
  /** 模型卡片滚动时通知入口页收起 / 展开底部 HdsTabs。 */
  onBarCollapse: (hidden: boolean) => void = (): void => {};

  private autoHide: BarAutoHide = new BarAutoHide();
  @State private asrState: string = 'idle';
  @State private asrProgress: number = 0;
  @State private asrText: string = '';
  @State private asrError: string = '';
  @State private downloadUrlDraft: string = '';

  aboutToAppear(): void {
    this.downloadUrlDraft = this.store.modelDownloadUrl;
  }

  private handleScroll(offset: number, state: ScrollState): void {
    this.autoHide.handle(offset, state, (hidden: boolean): void => {
      this.onBarCollapse(hidden);
    });
  }

  private npuHardware: NpuHardware = new NpuHardware();
  private vulkanHardware: VulkanHardware = new VulkanHardware();
  private qwenVulkan: VulkanModelInterface = new VulkanModelInterface(
    'qwen-asr-vulkan',
    'Qwen ASR · Vulkan',
    'Qwen ASR Vulkan 接口已预留 · 权重与推理待接入'
  );
  private alignerVulkan: VulkanModelInterface = new VulkanModelInterface(
    'aligner-vulkan',
    '对齐模型 · Vulkan',
    '对齐模型 Vulkan 接口已预留 · 权重与推理待接入'
  );

  private modelReady(): boolean {
    return this.store.hasModels();
  }

  private busyDownload(): boolean {
    return this.store.isDownloading();
  }

  private busyImport(): boolean {
    return this.store.isImporting();
  }

  private async pickImportFiles(): Promise<void> {
    const ctx: common.UIAbilityContext | null = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    try {
      await this.store.importModelFromFiles(ctx);
    } catch (err) {
      this.toast('导入模型文件失败');
    }
  }

  private async pickImportZip(): Promise<void> {
    const ctx: common.UIAbilityContext | null = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    try {
      await this.store.importModelFromZip(ctx);
    } catch (err) {
      this.toast('导入模型压缩包失败');
    }
  }

  private saveDownloadUrl(notify: boolean): boolean {
    const url: string = this.downloadUrlDraft.trim();
    this.store.modelDownloadUrl = url;
    this.store.saveSettings();
    if (notify) {
      this.toast(url.length > 0 ? '下载地址已保存' : '已清空下载地址');
    }
    return url.length > 0;
  }

  private async startDownload(): Promise<void> {
    if (!this.saveDownloadUrl(false)) {
      this.toast('请先填写 manifest.json 下载地址');
      return;
    }
    await this.store.downloadModel();
    if (this.store.isDownloading()) {
      return;
    }
    this.toast(this.store.downloadText);
  }

  private confirmClearModels(): void {
    this.getUIContext().showAlertDialog({
      title: '清理模型',
      message: '将删除模型目录中的全部文件（含未完成的 .part）。'
        + '稿件与项目数据不受影响，但下次识别前需要重新下载模型。',
      autoCancel: true,
      primaryButton: {
        value: '取消',
        action: (): void => {
        }
      },
      secondaryButton: {
        value: '清理',
        fontColor: HomeTokens.danger,
        action: (): void => {
          this.store.clearModelFiles().then((): void => {
            this.toast('模型文件已清理');
          }).catch((err: Error): void => {
            this.toast(`清理失败：${err.message}`);
          });
        }
      }
    });
  }

  private async runNpuCheck(): Promise<void> {
    await this.store.runNpuSelfTest();
    this.toast(this.store.statusText);
  }

  private async pickAsrSample(): Promise<void> {
    const ctx: common.UIAbilityContext | null = this.store.context;
    if (ctx === null) {
      this.toast('应用尚未初始化');
      return;
    }
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters =
        ['音频或视频|.wav,.mp3,.m4a,.aac,.flac,.ogg,.mp4,.mkv,.mov'];
      const uris: string[] = await new picker.DocumentViewPicker(ctx).select(options);
      if (uris.length === 0) {
        return;
      }
      const uri: string = uris[0];
      const rawName: string = uri.substring(uri.lastIndexOf('/') + 1);
      const unique: string =
        `asr_test_${Date.now()}_${safeFileName(rawName, 'audio')}`;
      const local: string = await importToSandbox(ctx, uri, unique);
      this.asrState = 'decoding';
      this.asrProgress = 0;
      this.asrText = '';
      this.asrError = '';
      try {
        const samples: Float64Array =
          await this.store.decoderForProbe().decodeToPcm16k(local,
            (ratio: number): void => {
              this.asrProgress = Math.round(ratio * 45);
            });
        this.asrState = 'recognizing';
        this.asrProgress = 50;
        const text: string = await this.store.transcribeSamples(samples);
        this.asrText = text.length > 0 ? text : '（识别结果为空）';
        this.asrProgress = 100;
        this.asrState = 'done';
        this.toast('语音识别测试完成');
      } finally {
        deleteFile(local);
      }
    } catch (err) {
      const e = err as Error;
      this.asrState = 'failed';
      this.asrError = e.message;
      this.toast(`识别测试失败：${e.message}`);
    }
  }

  private async runModelLoadTest(): Promise<void> {
    this.asrState = 'recognizing';
    this.asrProgress = 50;
    this.asrText = '';
    this.asrError = '';
    try {
      const samples = new Float64Array(16000);
      const text: string = await this.store.transcribeSamples(samples);
      this.asrText = text.length > 0 ? text : '（空载测试完成，识别结果为空）';
      this.asrProgress = 100;
      this.asrState = 'done';
      this.toast('模型加载与推理链路正常');
    } catch (err) {
      const e = err as Error;
      this.asrState = 'failed';
      this.asrError = e.message;
      this.toast(`模型加载测试失败：${e.message}`);
    }
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 1800 });
    } catch (err) {
      // 提示失败不影响主流程
    }
  }

  @Builder
  badge(text: string, accent: boolean) {
    Text(text)
      .fontSize(this.dims.miniSize)
      .fontColor(accent ? HomeTokens.primary : HomeTokens.textDim)
      .padding({ left: 9, right: 9, top: 3, bottom: 3 })
      .borderRadius(this.dims.radiusPill)
      .backgroundColor(accent ? HomeTokens.accentGlass : HomeTokens.glassFill)
      .border({ width: 1, color: accent ? HomeTokens.accentEdge : HomeTokens.glassEdge })
  }

  @Builder
  infoRow(label: string, value: string) {
    Row({ space: 12 }) {
      Text(label)
        .fontSize(this.dims.bodySize + 1)
        .fontColor(HomeTokens.textDim)
        .maxLines(1)
      Text(value)
        .fontSize(this.dims.bodySize + 1)
        .fontColor(HomeTokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.End)
        .layoutWeight(1)
    }
    .width('100%')
    .height(38)
  }

  @Builder
  header() {
    Row({ space: 12 }) {
      Column({ space: 3 }) {
        Text('模型')
          .fontSize(this.dims.titleSize + 6)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
        Text('识别模型与硬件后端 · 瀑布流按 sm/md/lg 自适应')
          .fontSize(this.dims.labelSize + 1)
          .fontColor(HomeTokens.textFaint)
          .maxLines(2)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Row({ space: 6 }) {
        this.badge(this.store.npuAvailable ? 'NPU 可用' : 'NPU 不可用', this.store.npuAvailable)
        this.badge(this.vulkanHardware.isAvailable() ? 'Vulkan 可用' : 'Vulkan 未接入', false)
      }
    }
    .width('100%')
  }

  private modelColumns(): number {
    if (this.dims.bp === Bp.LG) {
      return 3;
    }
    if (this.dims.bp === Bp.MD) {
      return 2;
    }
    return 1;
  }

  private columnsTemplate(): string {
    const n: number = this.modelColumns();
    if (n >= 3) {
      return '1fr 1fr 1fr';
    }
    if (n === 2) {
      return '1fr 1fr';
    }
    return '1fr';
  }

  @Builder
  downloadProgress() {
    if (this.store.downloadStage.length > 0) {
      Column({ space: 5 }) {
        Progress({
          value: this.store.downloadRatio * 100,
          total: 100,
          type: ProgressType.Linear
        })
          .width('100%')
          .color(this.store.downloadStage === 'failed' ? HomeTokens.danger : HomeTokens.primary)
          .backgroundColor(HomeTokens.glassFill)
        Row({ space: 8 }) {
          Text(this.store.downloadText)
            .fontSize(this.dims.miniSize)
            .fontColor(this.store.downloadStage === 'failed'
              ? HomeTokens.danger : HomeTokens.textDim)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          if (this.store.isDownloading()) {
            Text('取消')
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.danger)
              .padding({ left: 8, right: 8, top: 3, bottom: 3 })
              .borderRadius(this.dims.radiusPill)
              .backgroundColor(HomeTokens.dangerGlass)
              .onClick((): void => {
                this.store.cancelModelDownload();
              })
          }
        }
        .width('100%')
      }
      .width('100%')
    }
  }

  @Builder
  parakeetNpuCard() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Text('Parakeet 0.6B')
            .fontSize(this.dims.titleSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          this.badge('NPU', true)
          Blank()
          this.badge('MindSpore Lite', false)
        }
        .width('100%')

        Text('端侧离线识别模型，支持 VAD 静音裁剪与逐句时间戳。')
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .lineHeight(this.dims.labelSize + 5)

        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        this.infoRow('模型状态', this.modelReady() ? '已就绪' : '未安装')
        this.infoRow('推理后端', this.npuHardware.interfaceNote())
        this.infoRow('模型大小', '约 622 MB')

        Row({ space: 10 }) {
          ModelButton({
            dims: this.dims,
            label: this.busyDownload() ? '正在下载…' : (this.modelReady() ? '重新下载' : '下载模型'),
            primary: true,
            isEnabled: !this.busyDownload(),
            onTap: (): void => {
              this.startDownload();
            }
          })
          ModelButton({
            dims: this.dims,
            label: 'NPU 自检',
            isEnabled: this.store.npuAvailable,
            onTap: (): void => {
              this.runNpuCheck();
            }
          })
        }
        .width('100%')

        this.downloadProgress()
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  parakeetVulkanCard() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Text('Parakeet 0.6B')
            .fontSize(this.dims.titleSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          this.badge('Vulkan', true)
          Blank()
          this.badge('GPU', false)
        }
        .width('100%')

        Text('与 NPU 共用同一套 Parakeet 模型文件；GPU（Vulkan）推理接口已预留，'
          + '当前先提供模型文件下载。')
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .lineHeight(this.dims.labelSize + 5)

        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        this.infoRow('模型文件', this.modelReady() ? '已就绪（与 NPU 共用）' : '未安装')
        this.infoRow('推理接口', this.vulkanHardware.interfaceNote())
        this.infoRow('模型大小', '约 622 MB')

        Row({ space: 10 }) {
          ModelButton({
            dims: this.dims,
            label: this.busyDownload() ? '正在下载…' : '下载模型文件',
            primary: true,
            isEnabled: !this.busyDownload(),
            onTap: (): void => {
              this.startDownload();
            }
          })
          ModelButton({
            dims: this.dims,
            label: '接口说明',
            onTap: (): void => {
              this.toast(this.vulkanHardware.interfaceNote());
            }
          })
        }
        .width('100%')

        this.downloadProgress()
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  vulkanModelCard(title: string, description: string, extraLabel: string,
                  extraValue: string, note: string) {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Text(title)
            .fontSize(this.dims.titleSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          this.badge('Vulkan', true)
          Blank()
          this.badge('接口预留', false)
        }
        .width('100%')

        Text(description)
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .lineHeight(this.dims.labelSize + 5)

        Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
        this.infoRow('模型状态', '接口预留 · 未安装')
        this.infoRow('推理接口', note)
        this.infoRow(extraLabel, extraValue)

        Row({ space: 10 }) {
          ModelButton({
            dims: this.dims,
            label: '接口说明',
            onTap: (): void => {
              this.toast(note);
            }
          })
        }
        .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  qwenAsrVulkanCard() {
    this.vulkanModelCard(
      'Qwen ASR',
      '通义千问端侧语音识别模型；Vulkan 推理接口已预留，模型权重与原生推理待接入。',
      '适用场景',
      '多语种 / 长音频',
      this.qwenVulkan.interfaceNote()
    )
  }

  @Builder
  alignerVulkanCard() {
    this.vulkanModelCard(
      '对齐模型',
      '为识别结果生成词级时间戳；Vulkan 接口已预留，对齐权重与推理待接入。',
      '输出',
      '词级时间戳',
      this.alignerVulkan.interfaceNote()
    )
  }

  @Builder
  downloadSetupCard() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Text('下载与部署')
            .fontSize(this.dims.titleSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          this.badge('后端清单', true)
          Blank()
          this.badge(this.modelReady() ? '模型就绪' : '未安装', this.modelReady())
        }
        .width('100%')

        Text('地址指向后端 manifest.json；文件按清单逐个下载，支持断点续传与 SHA-256 校验。')
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .lineHeight(this.dims.labelSize + 5)

        TextInput({ text: this.downloadUrlDraft, placeholder: 'https://…/manifest.json' })
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.text)
          .placeholderColor(HomeTokens.textFaint)
          .height(38)
          .padding({ left: 9, right: 9 })
          .backgroundColor(HomeTokens.glassFill)
          .borderRadius(this.dims.radiusInner)
          .onChange((value: string): void => {
            this.downloadUrlDraft = value;
          })

        Row({ space: 10 }) {
          ModelButton({
            dims: this.dims,
            label: this.busyDownload() ? '正在下载…' : '保存并下载',
            primary: true,
            isEnabled: !this.busyDownload(),
            onTap: (): void => {
              this.startDownload();
            }
          })
          ModelButton({
            dims: this.dims,
            label: this.busyDownload() ? '取消下载' : '仅保存地址',
            isEnabled: true,
            onTap: (): void => {
              if (this.busyDownload()) {
                this.store.cancelModelDownload();
              } else {
                this.saveDownloadUrl(true);
              }
            }
          })
        }
        .width('100%')

        this.downloadProgress()
        Text(this.store.modelStatus())
          .fontSize(this.dims.miniSize)
          .fontColor(HomeTokens.textFaint)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Row() {
          Blank()
          Text('清理模型文件')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.danger)
            .padding({ left: 8, right: 8, top: 4, bottom: 4 })
            .onClick((): void => {
              this.confirmClearModels();
            })
        }
        .width('100%')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  recognitionTestCard() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Text('语音识别测试')
            .fontSize(this.dims.titleSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          this.badge('端侧', true)
          Blank()
          this.badge(this.modelReady() ? '模型就绪' : '模型未就绪', this.modelReady())
        }
        .width('100%')

        Text('选择一段音频/视频，解码为 16 kHz PCM 后直接验证当前识别后端；'
          + '结果只用于测试，不会写入稿件。')
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .lineHeight(this.dims.labelSize + 5)

        Row({ space: 10 }) {
          ModelButton({
            dims: this.dims,
            label: this.asrState === 'decoding' ? '解码中…'
              : (this.asrState === 'recognizing' ? '识别中…' : '选择音频测试'),
            primary: true,
            isEnabled: this.asrState !== 'decoding' && this.asrState !== 'recognizing',
            onTap: (): void => {
              this.pickAsrSample();
            }
          })
          ModelButton({
            dims: this.dims,
            label: '模型加载测试',
            isEnabled: this.asrState !== 'decoding' && this.asrState !== 'recognizing',
            onTap: (): void => {
              this.runModelLoadTest();
            }
          })
        }
        .width('100%')

        if (this.asrState !== 'idle') {
          Column({ space: 5 }) {
            Progress({ value: this.asrProgress, total: 100, type: ProgressType.Linear })
              .width('100%')
              .color(this.asrState === 'failed' ? HomeTokens.danger : HomeTokens.primary)
              .backgroundColor(HomeTokens.glassFill)
            Text(this.asrError.length > 0 ? this.asrError :
              (this.asrText.length > 0 ? this.asrText :
                (this.asrState === 'decoding' ? '正在解码音频…' : '正在识别…')))
              .fontSize(this.dims.miniSize)
              .fontColor(this.asrState === 'failed' ? HomeTokens.danger : HomeTokens.textDim)
              .maxLines(4)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
          .width('100%')
        } else {
          Text('提示：模型未就绪或设备没有 NPU 时，识别会直接返回具体错误。')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textFaint)
            .width('100%')
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  manualImportCard() {
    GlassCard({ dims: this.dims, interactive: false }) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Text('手动导入模型')
            .fontSize(this.dims.titleSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          Blank()
          this.badge('本地', false)
        }
        .width('100%')

        Text('选择 encoder.ms / decoder_joint.ms / vocab.txt / encoder.msw（可多选），'
          + '或导入包含这些文件的 zip 压缩包。文件会复制到应用沙箱。')
          .fontSize(this.dims.labelSize)
          .fontColor(HomeTokens.textDim)
          .lineHeight(this.dims.labelSize + 5)

        Row({ space: 10 }) {
          ModelButton({
            dims: this.dims,
            label: this.busyImport() ? '正在导入…' : '导入模型文件',
            isEnabled: !this.busyImport(),
            onTap: (): void => {
              this.pickImportFiles();
            }
          })
          ModelButton({
            dims: this.dims,
            label: '导入压缩包',
            isEnabled: !this.busyImport(),
            onTap: (): void => {
              this.pickImportZip();
            }
          })
        }
        .width('100%')

        if (this.store.importStage.length > 0) {
          Column({ space: 5 }) {
            if (this.store.importRatio >= 0) {
              Progress({
                value: this.store.importRatio * 100,
                total: 100,
                type: ProgressType.Linear
              })
                .width('100%')
                .color(HomeTokens.primary)
                .backgroundColor(HomeTokens.glassFill)
            }
            Text(this.store.importText)
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.textDim)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
        } else {
          Text(this.modelReady() ? `当前模型：${this.store.modelStatus()}` : '导入后会自动核对文件名和大小。')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textFaint)
            .width('100%')
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  build() {
    Column({ space: this.dims.gap }) {
      this.header()

      WaterFlow() {
        FlowItem() {
          this.parakeetNpuCard()
        }
        .width('100%')

        FlowItem() {
          this.parakeetVulkanCard()
        }
        .width('100%')

        FlowItem() {
          this.qwenAsrVulkanCard()
        }
        .width('100%')

        FlowItem() {
          this.alignerVulkanCard()
        }
        .width('100%')

        FlowItem() {
          this.manualImportCard()
        }
        .width('100%')

        FlowItem() {
          this.downloadSetupCard()
        }
        .width('100%')

        FlowItem() {
          this.recognitionTestCard()
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
    .alignItems(HorizontalAlign.Start)
    .padding({
      left: this.dims.pagePaddingH,
      right: this.dims.pagePaddingH,
      top: this.dims.pagePaddingTop
    })
  }
}
