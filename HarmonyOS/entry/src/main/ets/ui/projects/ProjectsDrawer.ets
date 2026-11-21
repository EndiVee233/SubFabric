/*
 * 项目页抽屉。
 *
 * 放在入口页的根 Stack 里（不是 TabContent 内部），原因是：
 *   · 抽屉要盖住底部标签栏和状态栏，真正铺满全屏；
 *   · HdsTabs 的内容区一改 barHeight 就会整体缩放，抽屉在里面会被一起缩掉。
 * 所以它只是一个「全屏遮罩 + 侧边面板」，开关完全由父级 `open` 控制。
 *
 * 面板方向由父级传入：抽屉默认左侧；右边缘临时拉出时父级传 right，
 * 只影响本次打开，不改写 GripAwareness 的默认握姿侧。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { curves, display } from '@kit.ArkUI';
import { hdsMaterial, HdsTabs, HdsTabsController } from '@kit.UIDesignKit';

import { AppStore, ProjectMeta } from '../../store/AppStore';
import { Bp, HomeDims } from '../home/HomeBreakpoints';
import { HomeTokens, relativeLabel } from '../home/HomeTokens';

/** 文件夹列表的 AppStorage 键（本机内存态，后续接真实目录）。 */
const FOLDERS_KEY: string = 'projectFolders';

/** 当前所在文件夹层级（空串 = 全部文件夹）。 */
const ACTIVE_FOLDER_KEY: string = 'projectActiveFolder';

/** 读文件夹列表。 */
export function folderNames(): string[] {
  const v: string[] | undefined = AppStorage.get<string[]>(FOLDERS_KEY);
  return v === undefined ? ['默认文件夹'] : v;
}

/** 当前文件夹层级。 */
export function activeFolderName(): string {
  const v: string | undefined = AppStorage.get<string>(ACTIVE_FOLDER_KEY);
  return v === undefined ? '' : v;
}

/** 进入 / 退出文件夹层级；传空串表示回到全部。 */
export function setActiveFolder(name: string): void {
  AppStorage.setOrCreate<string>(ACTIVE_FOLDER_KEY, name);
}

/** 新建一个文件夹；空名字使用“新建文件夹”，重名时追加序号。 */
export function addFolder(name: string = '新建文件夹'): void {
  const base: string = name.trim().length > 0 ? name.trim() : '新建文件夹';
  const list: string[] = folderNames().slice();
  let next: string = base;
  let index: number = 2;
  while (list.includes(next)) {
    next = `${base} ${index}`;
    index++;
  }
  list.push(next);
  AppStorage.setOrCreate<string[]>(FOLDERS_KEY, list);
}

/** 重命名文件夹；空名字保持原名，重名时追加序号。 */
export function renameFolder(oldName: string, rawName: string): void {
  const list: string[] = folderNames().slice();
  const index: number = list.indexOf(oldName);
  if (index < 0) {
    return;
  }
  const base: string = rawName.trim().length > 0 ? rawName.trim() : oldName;
  let next: string = base;
  let suffix: number = 2;
  while (list.some((value: string, i: number): boolean => i !== index && value === next)) {
    next = `${base} ${suffix}`;
    suffix++;
  }
  if (next === oldName) {
    return;
  }
  list[index] = next;
  AppStorage.setOrCreate<string[]>(FOLDERS_KEY, list);
  if (activeFolderName() === oldName) {
    setActiveFolder(next);
  }
}

/** 删除文件夹；如果删的是当前层级则退回全部。 */
export function deleteFolder(name: string): void {
  const list: string[] = folderNames().filter((value: string): boolean => value !== name);
  AppStorage.setOrCreate<string[]>(FOLDERS_KEY, list);
  if (activeFolderName() === name) {
    setActiveFolder('');
  }
}

/** 拖拽排序：把 from 位置的文件夹移到 to 位置。 */
export function moveFolder(from: number, to: number): void {
  const list: string[] = folderNames().slice();
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
    return;
  }
  const item: string = list.splice(from, 1)[0];
  list.splice(to, 0, item);
  AppStorage.setOrCreate<string[]>(FOLDERS_KEY, list);
}

const SIDE_LEFT: string = 'left';

/** lg 宽屏侧栏外留白：让侧栏像一张浮起的玻璃卡，和项目页处在同一层级。 */
export const WIDE_DRAWER_MARGIN: number = 10;
/** lg 宽屏侧栏与右移后的项目页之间的间距。 */
export const WIDE_DRAWER_GAP: number = 14;

/**
 * 侧栏宽度。
 * lg 固定约为屏宽的 21%，夹在 280–330vp；sm/md 覆盖式抽屉缩到原来的 2/3。
 */
export function projectsPanelWidth(dims: HomeDims): number {
  if (dims.bp === Bp.LG) {
    const byRatio: number = dims.widthVp * 0.21;
    if (byRatio < 280) {
      return 280;
    }
    return byRatio > 330 ? 330 : byRatio;
  }
  const byRatio: number = dims.widthVp * 0.78;
  const maxWidth: number = 460;
  let panel: number = byRatio;
  if (panel < 264) {
    panel = 264;
  } else if (panel > maxWidth) {
    panel = maxWidth;
  }
  return Math.round(panel * 2 / 3);
}

/** lg 打开侧栏时，项目页需要让出的左侧总宽度。 */
export function wideDrawerInset(dims: HomeDims): number {
  if (dims.bp !== Bp.LG) {
    return 0;
  }
  return projectsPanelWidth(dims) + WIDE_DRAWER_MARGIN * 2 + WIDE_DRAWER_GAP;
}

/**
 * 文件夹命名对话框：对齐系统弹窗设计语言。
 * 居中标题 + 单横线输入框（不再是整块圆角矩形）+ 底部两枚纯文字按钮：
 * 取消红色、确定主题色；去掉按钮底色和描边，按压时文字轻微缩小并浮出一层浅色底。
 * 新建与重命名共用，标题和初始文本由调用方给。
 */
@CustomDialog
struct FolderNameDialog {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  controller?: CustomDialogController;
  @Prop dims: HomeDims;
  @Prop title: string = '新建文件夹';
  @Prop initialName: string = '';
  onConfirm: (name: string) => void = (): void => {};

  @State private name: string = '';
  @State private focused: boolean = false;
  @State private cancelPressed: boolean = false;
  @State private confirmPressed: boolean = false;
  @State private submitted: boolean = false;

  aboutToAppear(): void {
    this.name = this.initialName;
  }

  private dialogWidth(): number {
    return this.dims.twoPane ? 420 : 320;
  }

  private dialogRadius(): number {
    return this.dims.twoPane ? 32 : 28;
  }

  private titleFont(): number {
    return this.dims.twoPane ? 24 : 20;
  }

  private fieldFont(): number {
    return this.dims.twoPane ? 18 : 16;
  }

  private sidePadding(): number {
    return this.dims.twoPane ? 28 : 24;
  }

  private buttonHeight(): number {
    return this.dims.twoPane ? 56 : 52;
  }

  private confirm(): void {
    if (this.submitted) {
      return;
    }
    this.submitted = true;
    this.onConfirm(this.name);
    this.controller?.close();
  }

  private setPressed(primary: boolean, down: boolean): void {
    if (primary) {
      this.confirmPressed = down;
    } else {
      this.cancelPressed = down;
    }
  }

  @Builder
  textButton(label: string, color: string, primary: boolean, onTap: () => void) {
    Row() {
      Text(label)
        .fontSize(this.fieldFont())
        .fontWeight(FontWeight.Medium)
        .fontColor(color)
    }
    .layoutWeight(1)
    .height(this.buttonHeight())
    .justifyContent(FlexAlign.Center)
    .margin({ left: 4, right: 4 })
    .borderRadius(this.buttonHeight() / 2)
    .backgroundColor((primary ? this.confirmPressed : this.cancelPressed)
      ? HomeTokens.pressFill : Color.Transparent)
    .animation({ duration: 110, curve: Curve.EaseOut })
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        this.setPressed(primary, true);
      } else if (event.type === TouchType.Up) {
        // 保持按压态一小段时间再执行，快速点击也能看到反馈
        setTimeout((): void => {
          this.setPressed(primary, false);
          onTap();
        }, 120);
      } else if (event.type === TouchType.Cancel) {
        this.setPressed(primary, false);
      }
    })
  }

  build() {
    Column() {
      Text(this.title)
        .fontSize(this.titleFont())
        .fontWeight(FontWeight.Medium)
        .fontColor(HomeTokens.text)
        .textAlign(TextAlign.Center)
        .width('100%')
        .padding({ left: this.sidePadding(), right: this.sidePadding() })
        .margin({ top: this.sidePadding() })

      // 单横线输入框：透明底 + 一条细线，聚焦时线变主题色
      Column() {
        TextInput({ placeholder: '新建文件夹', text: this.name })
          .placeholderColor(HomeTokens.textFaint)
          .fontColor(HomeTokens.text)
          .fontSize(this.fieldFont())
          .caretColor(HomeTokens.primary)
          .height(44)
          .padding({ left: 0, right: 0 })
          .backgroundColor(Color.Transparent)
          .onChange((value: string): void => {
            this.name = value;
          })
          .onFocus((): void => {
            this.focused = true;
          })
          .onBlur((): void => {
            this.focused = false;
          })
        Divider()
          .strokeWidth(1)
          .color(this.focused ? HomeTokens.primary : HomeTokens.glassEdge)
          .animation({ duration: 150, curve: Curve.EaseOut })
      }
      .width('100%')
      .padding({ left: this.sidePadding(), right: this.sidePadding() })
      .margin({ top: 18 })

      Row() {
        this.textButton('取消', HomeTokens.danger, false, (): void => {
          this.controller?.close();
        })
        Divider()
          .vertical(true)
          .height(20)
          .strokeWidth(1)
          .color(HomeTokens.glassEdge)
        this.textButton('确定', HomeTokens.primary, true, (): void => {
          this.confirm();
        })
      }
      .width('100%')
      .padding({ left: 8, right: 8 })
      .margin({ top: 14 })
    }
    .width(this.dialogWidth())
    .padding({ bottom: 6 })
    .borderRadius(this.dialogRadius())
    .backgroundColor(HomeTokens.panelFill)
    .shadow({ radius: 36, color: HomeTokens.shadow, offsetX: 0, offsetY: 14 })
  }
}

@Component
export struct ProjectsDrawer {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;
  /** 本次打开方向：默认左侧；右边缘临时拉出时由父级传 right。 */
  @Prop side: string = SIDE_LEFT;
  /** 宽屏常驻展开：隐藏关闭键并禁用横滑收起。 */
  @Prop pinned: boolean = false;
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  @StorageProp(FOLDERS_KEY) folders: string[] = ['默认文件夹'];
  @StorageProp(ACTIVE_FOLDER_KEY) activeFolder: string = '';

  onClose: () => void = (): void => {};
  onOpenProject: (project: ProjectMeta) => void = (): void => {};

  @State private addPressed: boolean = false;
  @State private pressedFolder: string = '';
  @State private dragFolder: string = '';
  @State private dragStart: number = -1;
  @State private dragTarget: number = -1;
  @State private dragOffset: number = 0;
  @State private dragMoved: boolean = false;
  @State private menuFolder: string = '';
  @State private menuTop: number = 0;
  @State private menuPressed: string = '';
  @State private rootHeight: number = 800;
  @State private cornerRadius: number = 24;

  private touchStartY: number = 0;
  private folderDialog: CustomDialogController | null = null;
  private renameDialog: CustomDialogController | null = null;
  private renameTarget: string = '';
  private longPressGuard: boolean = false;
  private closeController: HdsTabsController = new HdsTabsController();

  aboutToAppear(): void {
    this.cornerRadius = this.deviceCornerRadius();
  }

  /** 设备屏幕圆角（px → vp）；拿不到时退回卡片圆角。 */
  private deviceCornerRadius(): number {
    try {
      const d = display.getDefaultDisplaySync();
      const corners = d.getRoundedCorner();
      let maxPx: number = 0;
      for (let i = 0; i < corners.length; i++) {
        if (corners[i].radius > maxPx) {
          maxPx = corners[i].radius;
        }
      }
      const density: number = d.densityPixels > 0 ? d.densityPixels : 1;
      const vp: number = Math.round(maxPx / density);
      return vp >= 12 ? vp : this.dims.radiusCard;
    } catch (err) {
      return this.dims.radiusCard;
    }
  }

  aboutToDisappear(): void {
    this.folderDialog?.close();
    this.folderDialog = null;
    this.renameDialog?.close();
    this.renameDialog = null;
  }

  private openFolderDialog(): void {
    this.closeMenu();
    this.clearDrag();
    this.folderDialog = new CustomDialogController({
      builder: FolderNameDialog({
        dims: this.dims,
        title: '新建文件夹',
        initialName: '',
        onConfirm: (name: string): void => {
          addFolder(name);
        }
      }),
      autoCancel: true,
      alignment: DialogAlignment.Center,
      customStyle: true
    });
    this.folderDialog.open();
  }

  private openRenameDialog(name: string): void {
    this.renameTarget = name;
    this.renameDialog = new CustomDialogController({
      builder: FolderNameDialog({
        dims: this.dims,
        title: '重命名文件夹',
        initialName: name,
        onConfirm: (next: string): void => {
          if (next.trim().length > 0 && next.trim() !== this.renameTarget) {
            this.toast('文件夹已重命名');
          }
          renameFolder(this.renameTarget, next);
        }
      }),
      autoCancel: true,
      alignment: DialogAlignment.Center,
      customStyle: true
    });
    this.renameDialog.open();
  }

  // ------------------------------------------------------------ 文件夹层级 / 拖拽

  private toggleFolder(name: string): void {
    this.closeMenu();
    this.clearDrag();
    if (this.activeFolder === name) {
      setActiveFolder('');
      this.toast('已退出文件夹');
    } else {
      setActiveFolder(name);
      this.toast(`已进入「${name}」`);
    }
  }

  /** 无动画地清掉拖拽/抬起态，避免手势中断后行卡在偏移位置。 */
  private clearDrag(): void {
    this.dragFolder = '';
    this.dragStart = -1;
    this.dragTarget = -1;
    this.dragOffset = 0;
    this.dragMoved = false;
    this.pressedFolder = '';
  }

  private folderScale(name: string): number {
    if (this.dragFolder === name) {
      return 1.02;
    }
    return this.pressedFolder === name ? 0.97 : 1;
  }

  private folderBackground(name: string): string {
    if (this.dragFolder === name || this.activeFolder === name) {
      return HomeTokens.glassFillStrong;
    }
    return this.pressedFolder === name ? HomeTokens.glassFill : '#00000000';
  }

  /** 拖拽时让目标位置之前的行让出空位。 */
  private folderShift(index: number): number {
    if (this.dragFolder.length === 0 || this.dragStart < 0 || this.dragTarget < 0) {
      return 0;
    }
    const step: number = this.rowHeight();
    if (this.dragTarget > this.dragStart && index > this.dragStart && index <= this.dragTarget) {
      return -step;
    }
    if (this.dragTarget < this.dragStart && index >= this.dragTarget && index < this.dragStart) {
      return step;
    }
    return 0;
  }

  private folderOffset(name: string, index: number): number {
    return this.dragFolder === name ? this.dragOffset : this.folderShift(index);
  }

  private liftFolder(name: string, index: number, event: GestureEvent): void {
    this.longPressGuard = true;
    this.pressedFolder = '';
    this.dragStart = index;
    this.dragTarget = index;
    this.dragOffset = 0;
    this.dragMoved = false;
    this.getUIContext().animateTo({
      duration: 140,
      curve: curves.springMotion(0.32, 0.8)
    }, (): void => {
      this.dragFolder = name;
    });
    let anchorY: number = this.rootHeight / 2;
    if (event.fingerList.length > 0) {
      anchorY = Number(event.fingerList[0].globalY);
    }
    this.openFolderMenu(name, anchorY);
  }

  private resetLift(): void {    this.getUIContext().animateTo({
      duration: 180,
      curve: curves.springMotion(0.36, 0.9)
    }, (): void => {
      this.dragFolder = '';
      this.dragStart = -1;
      this.dragTarget = -1;
      this.dragOffset = 0;
    });
  }

  private beginDrag(): void {
    if (this.dragFolder.length === 0) {
      return;
    }
    this.menuFolder = '';
    this.dragMoved = true;
  }

  /** 长按手势结束时的兜底：保证抬起后不会留下位移中的行。 */
  private finishFolderGesture(name: string): void {
    if (this.dragFolder === name) {
      if (this.dragMoved) {
        this.dropFolder();
      } else {
        this.resetLift();
      }
    }
    setTimeout((): void => {
      this.longPressGuard = false;
    }, 240);
  }

  private updateDrag(dy: number): void {
    if (this.dragFolder.length === 0) {
      return;
    }
    this.dragOffset = dy;
    const shift: number = Math.round(dy / this.rowHeight());
    let target: number = this.dragStart + shift;
    if (target < 0) {
      target = 0;
    }
    if (target > this.folders.length - 1) {
      target = this.folders.length - 1;
    }
    if (target !== this.dragTarget) {
      this.getUIContext().animateTo({
        duration: 150,
        curve: Curve.EaseOut
      }, (): void => {
        this.dragTarget = target;
      });
    }
  }

  private dropFolder(): void {
    const from: number = this.dragStart;
    const to: number = this.dragTarget;
    this.getUIContext().animateTo({
      duration: 200,
      curve: curves.springMotion(0.36, 0.9)
    }, (): void => {
      if (from >= 0 && to >= 0 && from !== to) {
        moveFolder(from, to);
      }
      this.dragFolder = '';
      this.dragStart = -1;
      this.dragTarget = -1;
      this.dragOffset = 0;
      this.dragMoved = false;
    });
    setTimeout((): void => {
      this.longPressGuard = false;
    }, 240);
  }

  private cancelDrag(): void {
    this.resetLift();
    this.dragMoved = false;
    setTimeout((): void => {
      this.longPressGuard = false;
    }, 220);
  }

  // ------------------------------------------------------------ 文件夹菜单

  private menuWidth(): number {
    // sm/md 侧栏缩到 2/3 后，菜单也要跟着收，避免超出面板右缘
    const base: number = this.dims.twoPane ? 210 : 182;
    const maxWidth: number = this.panelWidth() - 16;
    return Math.max(150, Math.min(base, maxWidth));
  }

  private menuItemHeight(): number {
    return this.dims.twoPane ? 54 : 48;
  }

  private menuHeight(): number {
    return this.menuItemHeight() * 2 + 10;
  }

  private menuX(): number {
    const originX: number = this.dims.bp === Bp.LG ? WIDE_DRAWER_MARGIN : 0;
    const rightEdge: number = this.side === SIDE_LEFT
      ? originX + this.panelWidth() : this.dims.widthVp;
    const x: number = rightEdge - this.menuWidth() - this.dims.cardPadding;
    return x < 8 ? 8 : x;
  }

  private openFolderMenu(name: string, anchorY: number): void {
    // 菜单落在文件夹下方，避免手指抬起时正好点到第一项
    let top: number = anchorY + this.rowHeight() / 2 + 6;
    if (top + this.menuHeight() > this.rootHeight - 16) {
      top = anchorY - this.rowHeight() / 2 - this.menuHeight() - 6;
    }
    const minTop: number = this.statusBarHeight + 12;
    this.menuTop = top < minTop ? minTop : top;
    this.menuPressed = '';
    this.menuFolder = name;
  }

  private closeMenu(): void {
    this.menuFolder = '';
    this.menuPressed = '';
  }

  private startRename(name: string): void {
    this.closeMenu();
    this.openRenameDialog(name);
  }

  private removeFolder(name: string): void {
    this.closeMenu();
    deleteFolder(name);
    this.toast(`已删除「${name}」`);
  }

  // 抽屉字号比主页再大一档；平板侧栏常驻，再收一档避免显得笨重。
  private fsTitle(): number {
    return this.dims.bp === Bp.LG ? this.dims.titleSize + 3 : this.dims.titleSize + 6;
  }

  private fsBody(): number {
    return this.dims.bp === Bp.LG ? this.dims.bodySize + 2 : this.dims.bodySize + 4;
  }

  private fsLabel(): number {
    return this.dims.bp === Bp.LG ? this.dims.labelSize + 1 : this.dims.labelSize + 2;
  }

  private rowHeight(): number {
    return this.dims.bp === Bp.LG ? 72 : (this.dims.twoPane ? 66 : 62);
  }

  /** 面板宽度：sm/md 为原 78% 的 2/3；lg 固定约屏宽 21%（280–330vp），见 projectsPanelWidth。 */
  private panelWidth(): number {
    return projectsPanelWidth(this.dims);
  }

  // ------------------------------------------------------------ 面板内容

  /** sm 侧栏缩窄后，行内图标/间距/字号一起收一档，避免「默认文件夹」被截成三个字。 */
  private rowGap(): number {
    return this.dims.bp === Bp.SM ? 8 : 14;
  }

  private rowIconSize(): number {
    return this.dims.bp === Bp.LG ? 30 : (this.dims.bp === Bp.SM ? 22 : 26);
  }

  private rowChevronSize(): number {
    return this.dims.bp === Bp.LG ? 21 : (this.dims.bp === Bp.SM ? 17 : 19);
  }

  private rowPadH(): number {
    return this.dims.bp === Bp.SM ? 8 : (this.dims.bp === Bp.LG ? 14 : 12);
  }

  private rowFont(): number {
    return this.dims.bp === Bp.SM ? this.dims.bodySize + 2 : this.fsBody();
  }

  @Builder
  sectionTitle(title: string, showCount: boolean) {
    Row() {
      Text(title)
        .fontSize(this.fsLabel())
        .letterSpacing(1.2)
        .fontColor(HomeTokens.textFaint)
      Blank()
      if (showCount) {
        // 数量在 Builder 内部现算：@Builder 的参数是值传递，传进来不会随状态刷新
        Text(`${this.folders.length}`)
          .fontSize(this.fsLabel())
          .fontColor(HomeTokens.textFaint)
      }
    }
    .width('100%')
    .margin({ top: this.dims.rowGap, bottom: 4 })
  }

  @Builder
  sideRow(icon: Resource, label: string, accent: boolean, onTap: () => void) {
    Row({ space: this.rowGap() }) {
      SymbolGlyph(icon)
        .fontSize(this.rowIconSize())
        .fontColor([accent ? HomeTokens.primary : HomeTokens.textDim])
      Text(label)
        .fontSize(this.rowFont())
        .fontColor(accent ? HomeTokens.primary : HomeTokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(this.rowChevronSize())
        .fontColor([HomeTokens.textFaint])
    }
    .width('100%')
    .height(this.rowHeight())
    .padding({ left: this.rowPadH(), right: this.rowPadH() })
    .borderRadius(this.dims.radiusInner)
    .onClick((): void => {
      onTap();
    })
  }

  @Builder
  addFolderRow() {
    Row({ space: this.rowGap() }) {
      SymbolGlyph($r('sys.symbol.plus'))
        .fontSize(this.rowIconSize())
        .fontColor([HomeTokens.primary])
      Text('新建文件夹')
        .fontSize(this.rowFont())
        .fontColor(HomeTokens.primary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(this.rowChevronSize())
        .fontColor([HomeTokens.textFaint])
    }
    .width('100%')
    .height(this.rowHeight())
    .padding({ left: this.rowPadH(), right: this.rowPadH() })
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(this.addPressed ? HomeTokens.glassFill : '#00000000')
    .scale({ x: this.addPressed ? 0.97 : 1, y: this.addPressed ? 0.97 : 1 })
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        this.getUIContext().animateTo({
          duration: 100,
          curve: curves.springMotion(0.3, 0.72)
        }, (): void => {
          this.addPressed = true;
        });
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.getUIContext().animateTo({
          duration: 220,
          curve: curves.springMotion(0.38, 0.86)
        }, (): void => {
          this.addPressed = false;
        });
      }
    })
    .onClick((): void => {
      this.openFolderDialog();
    })
  }

  @Builder
  folderRowSlot(name: string, index: number) {
    Row() {
      this.folderRow(name, index)
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  folderRow(name: string, index: number) {
    Row({ space: this.rowGap() }) {
      SymbolGlyph(this.activeFolder === name
        ? $r('sys.symbol.folder_fill')
        : $r('sys.symbol.folder'))
        .fontSize(this.rowIconSize())
        .fontColor([this.activeFolder === name ? HomeTokens.primary : HomeTokens.textDim])
      Text(name)
        .fontSize(this.rowFont())
        .fontColor(this.activeFolder === name ? HomeTokens.primary : HomeTokens.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(this.rowChevronSize())
        .fontColor([HomeTokens.textFaint])
    }
    .width('98%')
    .height(this.rowHeight())
    .padding({ left: this.rowPadH(), right: this.rowPadH() })
    .borderRadius(this.dims.radiusInner)
    .backgroundColor(this.folderBackground(name))
    .scale({ x: this.folderScale(name), y: this.folderScale(name) })
    .offset({ y: this.folderOffset(name, index) })
    .zIndex(this.dragFolder === name ? 20 : 0)
    .shadow(this.dragFolder === name
      ? { radius: 22, color: HomeTokens.shadow, offsetX: 0, offsetY: 10 }
      : { radius: 0, color: '#00000000', offsetX: 0, offsetY: 0 })
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        if (event.touches.length > 0) {
          this.touchStartY = event.touches[0].screenY;
        }
        this.getUIContext().animateTo({
          duration: 100,
          curve: curves.springMotion(0.3, 0.72)
        }, (): void => {
          this.pressedFolder = name;
        });
      } else if (event.type === TouchType.Move) {
        if (this.dragFolder === name && event.touches.length > 0) {
          const dy: number = event.touches[0].screenY - this.touchStartY;
          if (!this.dragMoved && Math.abs(dy) > 4) {
            this.beginDrag();
          }
          if (this.dragMoved) {
            this.updateDrag(dy);
          }
        }
      } else if (event.type === TouchType.Up) {
        if (this.dragFolder === name) {
          if (this.dragMoved) {
            this.dropFolder();
          } else {
            this.resetLift();
          }
        }
        this.getUIContext().animateTo({
          duration: 220,
          curve: curves.springMotion(0.38, 0.86)
        }, (): void => {
          if (this.pressedFolder === name) {
            this.pressedFolder = '';
          }
        });
        setTimeout((): void => {
          this.longPressGuard = false;
        }, 240);
      } else if (event.type === TouchType.Cancel) {
        this.cancelDrag();
        this.getUIContext().animateTo({
          duration: 220,
          curve: curves.springMotion(0.38, 0.86)
        }, (): void => {
          if (this.pressedFolder === name) {
            this.pressedFolder = '';
          }
        });
      }
    })
    .onClick((): void => {
      if (this.longPressGuard || this.dragFolder.length > 0) {
        return;
      }
      this.toggleFolder(name);
    })
    .onMouse((event: MouseEvent): void => {
      // 鼠标右键等同长按：在文件夹位置弹出同一套菜单
      if (event.button === MouseButton.Right && event.action === MouseAction.Press) {
        this.longPressGuard = true;
        this.resetLift();
        this.openFolderMenu(name, event.displayY);
        setTimeout((): void => {
          this.longPressGuard = false;
        }, 240);
      }
    })
    .gesture(
      LongPressGesture({ repeat: false, duration: 360 })
        .onAction((event: GestureEvent): void => {
          this.liftFolder(name, index, event);
        })
        .onActionEnd((): void => {
          this.finishFolderGesture(name);
        })
    )
  }

  @Builder
  menuItem(label: string, danger: boolean, onTap: () => void) {
    Row() {
      Text(label)
        .fontSize(this.fsBody())
        .fontColor(danger ? HomeTokens.danger : HomeTokens.text)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(this.menuItemHeight())
    .padding({ left: 14, right: 14 })
    .borderRadius(14)
    .backgroundColor(this.menuPressed === label ? HomeTokens.glassFillStrong : '#00000000')
    .scale({ x: this.menuPressed === label ? 0.98 : 1, y: this.menuPressed === label ? 0.98 : 1 })
    .onTouch((event: TouchEvent): void => {
      if (event.type === TouchType.Down) {
        this.menuPressed = label;
      } else if (event.type === TouchType.Up) {
        setTimeout((): void => {
          this.menuPressed = '';
          onTap();
        }, 100);
      } else if (event.type === TouchType.Cancel) {
        this.menuPressed = '';
      }
    })
  }

  @Builder
  folderMenu() {
    Column({ space: 2 }) {
      this.menuItem('重命名', false, (): void => {
        this.startRename(this.menuFolder);
      })
      this.menuItem('删除文件夹', true, (): void => {
        this.removeFolder(this.menuFolder);
      })
    }
    .width(this.menuWidth())
    .padding({ left: 4, right: 4, top: 4, bottom: 4 })
    .borderRadius(18)
    // 实时背景模糊 + 很薄的深色染色；菜单后面的侧栏/项目页会透出来
    .backgroundEffect({ radius: 28, saturation: 1.15, brightness: 1.0, color: HomeTokens.panelTint })
    .linearGradient({
      angle: 165,
      colors: HomeTokens.isLightMode()
        ? [['#E6FFFFFF', 0.0], ['#B3FFFFFF', 0.5], ['#33FFFFFF', 1.0]]
        : [['#1AFFFFFF', 0.0], ['#00FFFFFF', 0.5], ['#10000000', 1.0]]
    })
    .border({ width: 1, color: HomeTokens.glassEdge })
    .shadow({ radius: 24, color: HomeTokens.shadow, offsetX: 0, offsetY: 10 })
    .clip(true)
    .position({ x: this.menuX(), y: this.menuTop })
    .zIndex(30)
  }

  private closeSize(): number {
    return this.dims.bp === Bp.LG ? 48 : 44;
  }

  @Builder
  closeTab() {
    Column() {
      SymbolGlyph($r('sys.symbol.xmark'))
        .fontSize(this.closeSize() * 0.4)
        .fontColor([HomeTokens.textDim])
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .accessibilityText('收起侧边栏')
  }

  /** 抽屉关闭键：和项目页左上角一样用 HdsTabs 单 Tab 的沉浸光感材质。 */
  @Builder
  closeButton() {
    HdsTabs({ controller: this.closeController }) {
      TabContent() {
        // 空内容：只借用 HdsTabs 底栏的沉浸材质。
      }
      .tabBar(this.closeTab())
    }
    .vertical(false)
    .scrollable(false)
    .barHeight(this.closeSize())
    .barOverlap(true)
    .barPosition(BarPosition.End)
    .barFloatingStyle({
      barWidth: {
        smallWidth: this.closeSize(),
        mediumWidth: this.closeSize(),
        largeWidth: this.closeSize()
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
      this.closeMenu();
      this.onClose();
    })
    .width(this.closeSize())
    .height(this.closeSize())
    .borderRadius(this.closeSize() / 2)
    .clip(true)
  }

  @Builder
  panel() {
    Column() {
      // 头：标题 + 副标题 + 关闭；顶部要多让出状态栏，否则标题会被时间压住
      Row() {
        Column({ space: 2 }) {
          Text('项目')
            .fontSize(this.fsTitle())
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
          Text(this.activeFolder.length > 0
            ? `${this.store.projects.length} 个稿件 · 当前：${this.activeFolder}`
            : `${this.store.projects.length} 个稿件 · ${this.folders.length} 个文件夹`)
            .fontSize(this.fsLabel())
            .fontColor(HomeTokens.textFaint)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        // 常驻展开时保留占位但隐藏，避免状态切换时按钮闪一下。
        Column() {
          this.closeButton()
        }
        .width(this.closeSize())
        .height(this.closeSize())
        .visibility(this.pinned ? Visibility.Hidden : Visibility.Visible)
      }
      .width('100%')
      .margin({ bottom: this.dims.gap })

      Scroll() {
        Column() {
          this.sectionTitle('稿件库', false)
          if (this.store.projects.length === 0) {
            Text('还没有稿件')
              .fontSize(this.fsLabel())
              .fontColor(HomeTokens.textFaint)
              .width('100%')
              .padding({ top: 8, bottom: 8 })
          } else {
            ForEach(this.store.projects, (p: ProjectMeta) => {
              this.sideRow($r('sys.symbol.doc_text'),
                p.name.length > 0 ? p.name : '未命名稿件', false, (): void => {
                  // 打开稿件不收起侧栏；编辑页是全屏覆盖层，关闭后恢复原状态。
                  this.onOpenProject(p);
                })
            }, (p: ProjectMeta) => p.id)
          }

          this.sectionTitle('文件夹', true)
          ForEach(this.folders, (name: string, index: number) => {
            this.folderRowSlot(name, index)
          }, (name: string) => name)

          // 新建文件夹：固定在文件夹段末尾
          this.addFolderRow()
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width(this.panelWidth())
    .height('100%')
    .padding({
      left: this.dims.cardPadding,
      right: this.dims.cardPadding,
      top: this.statusBarHeight + this.dims.cardPadding,
      bottom: this.dims.cardPadding
    })
    .alignItems(HorizontalAlign.Start)
    // 实时背景模糊：radius 直接作用在抽屉背后的页面上，再叠一层很薄的深色染色
    .backgroundEffect({ radius: 36, saturation: 1.15, brightness: 1.0, color: HomeTokens.panelTint })
    // 与底栏胶囊同款高光：顶亮底暗，才有「玻璃片」的厚度
    .linearGradient({
      angle: 165,
      colors: HomeTokens.isLightMode()
        ? [['#E6FFFFFF', 0.0], ['#B3FFFFFF', 0.42], ['#33FFFFFF', 1.0]]
        : [['#14FFFFFF', 0.0], ['#00FFFFFF', 0.42], ['#0A000000', 1.0]]
    })
    .border({ width: 1, color: HomeTokens.glassEdge })
    // 平板是浮起的同级侧栏：四角都圆；手机抽屉贴边，只圆朝内的两角
    .borderRadius(this.dims.bp === Bp.LG ? this.cornerRadius : {
      topLeft: this.side === SIDE_LEFT ? 0 : this.cornerRadius,
      topRight: this.side === SIDE_LEFT ? this.cornerRadius : 0,
      bottomLeft: this.side === SIDE_LEFT ? 0 : this.cornerRadius,
      bottomRight: this.side === SIDE_LEFT ? this.cornerRadius : 0
    })
    .shadow({
      radius: 34,
      color: HomeTokens.shadow,
      offsetX: this.dims.bp === Bp.LG ? 0 : (this.side === SIDE_LEFT ? 14 : -14),
      offsetY: this.dims.bp === Bp.LG ? 8 : 0
    })
    .gesture(
      // 朝屏幕外横滑 = 收起；常驻展开时禁用。
      PanGesture({ direction: PanDirection.Horizontal, distance: 12 })
        .onActionEnd((event: GestureEvent): void => {
          if (this.pinned) {
            return;
          }
          const dx: number = event.offsetX;
          const out: boolean = this.side === SIDE_LEFT ? dx < -48 : dx > 48;
          if (out) {
            this.onClose();
          }
        })
    )
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 1600 });
    } catch (err) {
      // 提示失败不影响主流程
    }
  }

  build() {
    if (this.dims.bp === Bp.LG) {
      // 平板：侧栏固定左侧、与项目页同一层级。不铺遮罩，也不占满全屏，
      // 只占左侧「侧栏 + 留白 + 间距」这一条，右侧内容由入口页右移缩窄。
      Stack({ alignContent: Alignment.TopStart }) {
        Column() {
          this.panel()
        }
        .width(this.panelWidth() + WIDE_DRAWER_MARGIN * 2)
        .height('100%')
        .padding(WIDE_DRAWER_MARGIN)
        .transition(TransitionEffect.translate({
          x: -(this.panelWidth() + WIDE_DRAWER_MARGIN * 2)
        }).animation({ duration: 280, curve: curves.springMotion(0.34, 0.92) })
          .combine(TransitionEffect.OPACITY.animation({ duration: 160 })))

        if (this.menuFolder.length > 0) {
          this.folderMenu()
        }
      }
      .width(this.panelWidth() + WIDE_DRAWER_MARGIN * 2)
      .height('100%')
      .onAreaChange((oldArea: Area, newArea: Area): void => {
        const h: number = Number(newArea.height);
        if (!Number.isNaN(h) && h > 0) {
          this.rootHeight = h;
        }
      })
    } else {
      Stack({
        alignContent: this.side === SIDE_LEFT ? Alignment.TopStart : Alignment.TopEnd
      }) {
        // 遮罩：点一下收起；自身带动画，和面板一起淡入
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(HomeTokens.scrim)
          .onClick((): void => {
            this.onClose();
          })
          .transition(TransitionEffect.OPACITY.animation({ duration: 200, curve: Curve.EaseOut }))

        // @Builder 返回 void，不能在上面挂 transition，包一层容器
        Column() {
          this.panel()
        }
        .height('100%')
        .transition(TransitionEffect.translate({
          x: this.side === SIDE_LEFT ? -this.panelWidth() : this.panelWidth()
        }).animation({ duration: 280, curve: curves.springMotion(0.34, 0.92) })
          .combine(TransitionEffect.OPACITY.animation({ duration: 160 })))

        // 长按文件夹后的选项框：跟随手指位置锚定，点面板空白或选择其他操作即收起
        if (this.menuFolder.length > 0) {
          this.folderMenu()
        }
      }
      .width('100%')
      .height('100%')
      .onAreaChange((oldArea: Area, newArea: Area): void => {
        const h: number = Number(newArea.height);
        if (!Number.isNaN(h) && h > 0) {
          this.rootHeight = h;
        }
      })
    }
  }
}
