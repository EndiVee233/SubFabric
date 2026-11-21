import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { curves } from '@kit.ArkUI';
import { HomeDims } from '../home/HomeBreakpoints';
import { HomeTokens } from '../home/HomeTokens';
import { fileExists, readTextFile, writeTextFile, writeTextFileAtomic, safeFileName } from '../../platform/FileUtil';
import { EditorField, EditorPreset, applyEditorPreset, makeEditorPreset, normalizeEditorOptions,
  bilingualFields, effectFields, glowFields, trackFields } from './EditorOptions';

const GROUPS: string[] = ['ASS 双语样式', '字幕后处理特效', '字幕样式预设', '导入与音频', '导出', '字幕显示与识别'];

@Component
export struct EditorSettingsPane {
  @Prop dims: HomeDims;
  @Link options: Record<string, string>;
  context: common.UIAbilityContext | null = null;
  libraryPath: string = '';
  @Prop speakers: string[] = [];
  onChanged: () => void = (): void => {};
  onMedia: () => void = (): void => {};
  onSubtitle: () => void = (): void => {};
  onAudio: () => void = (): void => {};
  onFont: (lang: string) => void = (lang: string): void => {};
  onExport: (kind: string, speaker: string) => void = (kind: string, speaker: string): void => {};
  @State private expandedGroups: number[] = [];
  @State private presets: EditorPreset[] = [];
  @State private presetIndex: number = -1;
  @State private presetName: string = '';
  @State private exportSpeaker: string = '全部人物';
  @BuilderParam moreSettings: () => void = this.emptySettings;
  @Builder
  emptySettings() {}

  aboutToAppear(): void {
    try {
      if (fileExists(this.libraryPath)) {
        const list = JSON.parse(readTextFile(this.libraryPath)) as EditorPreset[];
        for (const p of list) { applyEditorPreset(this.options, p); }
        this.presets = list;
      }
    } catch (err) { this.message('预设库读取失败，原文件保留'); }
  }
  private message(text: string): void { this.getUIContext().getPromptAction().showToast({ message: text }); }
  private toggleGroup(index: number): void {
    this.getUIContext().animateTo({ curve: curves.springMotion(0.28, 0.9) }, (): void => {
      this.expandedGroups = this.expandedGroups.includes(index)
        ? this.expandedGroups.filter((i: number): boolean => i !== index)
        : this.expandedGroups.concat([index]);
    });
  }
  private update(key: string, value: string): void {
    const next = JSON.parse(JSON.stringify(this.options)) as Record<string, string>;
    next[key] = value;
    if (key.endsWith('.Fontname')) { next[key.replace('.Fontname', '.FontFile')] = ''; }
    if (key === 'order') {
      next['zh.MarginV'] = value === 'zh-top' ? '80' : '16';
      next['en.MarginV'] = value === 'en-top' ? '90' : '16';
    }
    this.options = normalizeEditorOptions(next);
    this.onChanged();
  }
  private label(value: string): string {
    const keys: string[] = ['zh-top', 'en-top', 'active_word', 'zh', 'en', 'all', 'shadow', 'outline', 'both', 'slice', 'karaoke', 'raw', 'denoise'];
    const labels: string[] = ['中文在上', '英文在上', '仅逐词高亮词', '中文字幕', '英文字幕', '中英文全部',
      '阴影（保留描边）', '描边', '双通道', '颜色切片', '卡拉OK（\\k / \\kf）', '原视频音频', '系统降噪音频'];
    const i = keys.indexOf(value);
    return i >= 0 ? labels[i] : value;
  }
  private saveLibrary(next: EditorPreset[]): void {
    try { writeTextFileAtomic(this.libraryPath, JSON.stringify(next)); this.presets = next; }
    catch (err) { this.message('预设库保存失败'); }
  }
  private savePreset(): void {
    if (this.presets.length >= 60) { this.message('预设库已满（60条）'); return; }
    const name = this.presetName.trim().slice(0, 60) || `预设 ${this.presets.length + 1}`;
    this.saveLibrary(this.presets.concat([makeEditorPreset(this.options, name)]));
    this.presetIndex = this.presets.length - 1;
  }
  private applyPreset(): void {
    if (this.presetIndex < 0 || this.presetIndex >= this.presets.length) { return; }
    try {
      this.options = applyEditorPreset(this.options, this.presets[this.presetIndex]);
      this.onChanged(); this.message('预设已应用到当前稿件');
    } catch (err) { this.message((err as Error).message); }
  }
  private renamePreset(): void {
    if (this.presetIndex < 0 || !this.presetName.trim()) { return; }
    const next = JSON.parse(JSON.stringify(this.presets)) as EditorPreset[];
    next[this.presetIndex].name = this.presetName.trim().slice(0, 60);
    this.saveLibrary(next);
  }
  private deletePreset(): void {
    if (this.presetIndex < 0) { return; }
    const next = this.presets.filter((p: EditorPreset, i: number): boolean => i !== this.presetIndex);
    this.saveLibrary(next); this.presetIndex = -1;
  }
  private async exportPreset(onlyStyle: boolean): Promise<void> {
    if (this.context === null) { return; }
    try {
      let data: EditorPreset = makeEditorPreset(this.options, this.presetName || '当前样式', onlyStyle);
      if (!onlyStyle && this.presetIndex >= 0) { data = this.presets[this.presetIndex]; }
      else if (!onlyStyle && this.presets.length > 0) {
        data = { kind: 'subfabric.subtitle-style-presets', version: 1, presets: this.presets };
      }
      const opts = new picker.DocumentSaveOptions();
      opts.newFileNames = [`${safeFileName(data.name || 'SubFabric样式预设')}.json`];
      const uris = await new picker.DocumentViewPicker(this.context).save(opts);
      if (uris.length > 0) { writeTextFile(uris[0], JSON.stringify(data, null, 2)); this.message('预设已导出'); }
    } catch (err) { this.message(`预设导出失败：${(err as Error).message}`); }
  }
  private async importPreset(onlyStyle: boolean): Promise<void> {
    if (this.context === null) { return; }
    try {
      const opts = new picker.DocumentSelectOptions(); opts.maxSelectNumber = 1;
      opts.fileSuffixFilters = ['样式预设|.json'];
      const uris = await new picker.DocumentViewPicker(this.context).select(opts);
      if (uris.length === 0) { return; }
      const raw = JSON.parse(readTextFile(uris[0])) as EditorPreset;
      const list = raw.kind === 'subfabric.subtitle-style-presets' ? raw.presets ?? [] : [raw];
      if (list.length === 0 || list.length > 60) { throw new Error('预设数量无效'); }
      for (const p of list) { applyEditorPreset(this.options, p); }
      if (onlyStyle) {
        const p = list[0];
        const style = p.kind === 'subfabric.ass-style-preset' ? p : p.style;
        if (style === undefined) { throw new Error('文件不含双语样式'); }
        this.options = applyEditorPreset(this.options, JSON.parse(JSON.stringify(style)) as EditorPreset);
        this.onChanged(); this.message('双语样式已应用');
      } else {
        if (this.presets.length + list.length > 60) { throw new Error('最多保存60条预设'); }
        this.saveLibrary(this.presets.concat(list)); this.message(`已导入 ${list.length} 条预设`);
      }
    } catch (err) { this.message(`预设导入失败：${(err as Error).message}`); }
  }

  @Builder
  heading(text: string) {
    Text(text).fontSize(this.dims.bodySize).fontWeight(FontWeight.Medium).fontColor(HomeTokens.text)
      .width('100%').margin({ top: 8 })
  }
  @Builder
  action(text: string, tap: () => void) {
    Button(text).fontSize(this.dims.miniSize + 1).height(34)
      .backgroundColor(HomeTokens.accentGlass).fontColor(HomeTokens.primary)
      .margin({ right: 5, bottom: 5 }).onClick(tap)
  }
  @Builder
  field(f: EditorField) {
    Column({ space: 5 }) {
      Row({ space: 8 }) {
        Text(f.label).fontSize(this.dims.miniSize + 1).fontColor(HomeTokens.textDim).layoutWeight(1)
        if (f.type === 'toggle') {
          Toggle({ type: ToggleType.Switch, isOn: this.options[f.key] !== '0' })
            .selectedColor(HomeTokens.primary)
            .onChange((on: boolean): void => { this.update(f.key, on ? '1' : '0'); })
        } else if (f.type === 'select') {
          Select(f.choices.map((c: string): SelectOption => ({ value: this.label(c) })))
            .selected(Math.max(0, f.choices.indexOf(this.options[f.key])))
            .value(this.label(this.options[f.key])).font({ size: this.dims.miniSize })
            .onSelect((i: number): void => { this.update(f.key, f.choices[i]); })
        } else if (f.type === 'range') {
          Text(this.options[f.key]).fontSize(this.dims.miniSize).fontColor(HomeTokens.primary)
        }
      }.width('100%')
      if (f.type === 'text' || f.type === 'color') {
        TextInput({ text: this.options[f.key] }).fontSize(this.dims.miniSize + 1).height(34)
          .fontColor(f.type === 'color' ? this.options[f.key] : HomeTokens.text)
          .backgroundColor(HomeTokens.glassFill)
          .onChange((value: string): void => {
            if (f.type !== 'color' || /^#[0-9a-f]{6}$/i.test(value)) { this.update(f.key, value); }
          })
        if (f.type === 'color') {
          Row({ space: 8 }) {
            ForEach(['#FFFFFF', '#00FF00', '#FF00FF', '#8FBAFF', '#FF8FB1', '#FFC857'], (c: string) => {
              Circle().width(20).height(20).fill(c).onClick((): void => { this.update(f.key, c); })
            })
          }.width('100%')
        }
      } else if (f.type === 'range') {
        Slider({ value: Number(this.options[f.key]), min: f.min, max: f.max, step: f.step })
          .selectedColor(HomeTokens.primary).height(26)
          .onChange((value: number): void => { this.update(f.key, String(value)); })
      }
    }.width('100%').padding({ bottom: 7 })
  }
  @Builder
  fields(list: EditorField[]) {
    ForEach(list, (f: EditorField) => { this.field(f) }, (f: EditorField) => f.key)
  }
  @Builder
  stylePage() {
    this.heading('中文字幕')
    this.fields(trackFields('zh'))
    this.action('载入中文字体', (): void => { this.onFont('zh'); })
    this.heading('英文字幕')
    this.fields(trackFields('en'))
    this.action('载入英文字体', (): void => { this.onFont('en'); })
    this.fields(bilingualFields())
    Flex({ wrap: FlexWrap.Wrap }) {
      this.action('导出样式预设', (): void => { this.exportPreset(true); })
      this.action('导入样式预设', (): void => { this.importPreset(true); })
    }
    Text('纯样式预设不含后处理特效。字体名需在设备可用，或载入字体文件。')
      .fontSize(this.dims.miniSize).fontColor(HomeTokens.textFaint)
  }
  @Builder
  fxPage() {
    this.fields(effectFields())
    this.heading('中文字幕微光')
    this.fields(glowFields('zh'))
    this.heading('英文字幕微光')
    this.fields(glowFields('en'))
    Text('不改变文本或时间轴。原版已隐藏的词生长保持关闭。')
      .fontSize(this.dims.miniSize).fontColor(HomeTokens.textFaint)
  }
  @Builder
  presetPage() {
    this.heading('本机预设库')
    if (this.presets.length > 0) {
      Select(this.presets.map((p: EditorPreset): SelectOption => ({ value: p.name || '未命名预设' })))
        .selected(this.presetIndex).value(this.presetIndex >= 0 ? this.presets[this.presetIndex].name || '未命名预设' : '选择预设')
        .onSelect((i: number): void => { this.presetIndex = i; this.presetName = this.presets[i].name || ''; })
      this.action('应用选中预设', (): void => { this.applyPreset(); })
    }
    TextInput({ text: this.presetName, placeholder: '例如：双语对话·暖光' })
      .fontColor(HomeTokens.text).fontSize(this.dims.miniSize + 1).height(36)
      .onChange((value: string): void => { this.presetName = value; })
    Flex({ wrap: FlexWrap.Wrap }) {
      this.action('保存当前样式', (): void => { this.savePreset(); })
      this.action('重命名', (): void => { this.renamePreset(); })
      this.action('删除选中预设', (): void => { this.deletePreset(); })
      this.action('导出预设', (): void => { this.exportPreset(false); })
      this.action('导入预设', (): void => { this.importPreset(false); })
    }
    Text('保存双语样式、上下顺序和特效；支持桌面版新旧 JSON 预设。应用后自动保存到当前稿件。')
      .fontSize(this.dims.miniSize).fontColor(HomeTokens.textFaint)
  }
  @Builder
  mediaPage() {
    this.action('打开视频', (): void => { this.onMedia(); })
    this.action('打开字幕', (): void => { this.onSubtitle(); })
    this.field(new EditorField('removeLineBreaks', '导入时合并字幕换行', 'toggle', '1'))
    this.field(new EditorField('audioMode', '音频源', 'select', 'raw', ['raw', 'denoise']))
    this.action('重新生成音频与波形', (): void => { this.onAudio(); })
    Text('切换音频源后重新生成；字幕内容与逐词时间保持不变。系统降噪不可用时会明确报错。')
      .fontSize(this.dims.miniSize).fontColor(HomeTokens.textFaint)
  }
  @Builder
  exportPage() {
    Flex({ wrap: FlexWrap.Wrap }) {
      this.action('导出仅中文 ASS', (): void => { this.onExport('zh', ''); })
      this.action('导出仅英文 ASS', (): void => { this.onExport('en', ''); })
      this.action('导出无逐词 ASS', (): void => { this.onExport('clean', ''); })
      this.action('导出逐词字幕 ASS', (): void => { this.onExport('full', ''); })
      this.action('导出逐词 JSON', (): void => { this.onExport('json', ''); })
    }
    this.heading('高级导出')
    Select(['全部人物'].concat(this.speakers).map((name: string): SelectOption => ({ value: name })))
      .value(this.exportSpeaker)
      .onSelect((i: number): void => { this.exportSpeaker = i === 0 ? '全部人物' : this.speakers[i - 1]; })
    this.action('导出所选人物 ASS', (): void => { this.onExport('full', this.exportSpeaker === '全部人物' ? '' : this.exportSpeaker); })
    this.heading('导出视频')
    this.action('保存生肉原片', (): void => { this.onExport('video', ''); })
    Text('可导出原片与 ASS 字幕文件；当前视频导出链路尚未接入双语硬字幕压制。')
      .fontSize(this.dims.miniSize).fontColor(HomeTokens.textFaint)
  }
  build() {
    Scroll() {
      Column({ space: 10 }) {
        ForEach(GROUPS, (title: string, i: number) => {
          Column() {
            Row({ space: 8 }) {
              Text(title).fontSize(this.dims.bodySize).fontWeight(FontWeight.Medium)
                .fontColor(HomeTokens.text).layoutWeight(1)
              SymbolGlyph($r('sys.symbol.chevron_down'))
                .fontSize(13).fontColor([HomeTokens.textDim])
                .rotate({ angle: this.expandedGroups.includes(i) ? 180 : 0 })
            }
            .width('100%').padding(12)
            .accessibilityText(`${title}，${this.expandedGroups.includes(i) ? '已展开' : '已收起'}`)
            .onClick((): void => { this.toggleGroup(i); })
            if (this.expandedGroups.includes(i)) {
              Column({ space: 10 }) {
                Divider().color(HomeTokens.glassEdge).strokeWidth(0.5)
                if (i === 0) { this.stylePage() }
                else if (i === 1) { this.fxPage() }
                else if (i === 2) { this.presetPage() }
                else if (i === 3) { this.mediaPage() }
                else if (i === 4) { this.exportPage() }
                else { this.moreSettings() }
              }
              .width('100%').padding({ left: 12, right: 12, bottom: 12 })
              .alignItems(HorizontalAlign.Start)
              .transition(TransitionEffect.OPACITY.combine(TransitionEffect.translate({ y: -6 })))
            }
          }
          .width('100%').alignItems(HorizontalAlign.Start)
          .borderRadius(this.dims.radiusInner).backgroundColor(HomeTokens.glassFill)
          .border({ width: 0.5, color: HomeTokens.glassEdge }).clip(true)
        }, (title: string) => title)
        Text('样式与特效随稿件保存；预设库保存在本机。')
          .fontSize(this.dims.miniSize).fontColor(HomeTokens.textFaint)
      }.width('100%').alignItems(HorizontalAlign.Start).padding(8)
    }.width('100%').height('100%').scrollBar(BarState.Auto).align(Alignment.TopStart)
  }
}
