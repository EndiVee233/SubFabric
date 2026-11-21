/*
 * 项目页：仿系统日历的主体 + 可展开边栏。
 *
 * 主体：
 *   顶栏  [☰] 项目                                    N 个稿件
 *   瀑布流  稿件卡片（点击打开），列数按窗口宽度自适应：
 *           手机 1–2 列、折叠屏 3 列、平板 4 列
 *
 * 边栏（抽屉）不在这里渲染 —— 它要盖住底部标签栏和状态栏，所以放在入口页的根 Stack
 * （见 `ProjectsDrawer`）。本组件只负责一件事：把「用户想从哪边拉开」告诉父级。
 *
 * 两种呼出方式：
 *   · 点左上角 ☰：用当前握姿那侧；
 *   · 从屏幕左 / 右边缘横滑：从哪边拉就在哪边开，并把这一侧写回握姿。
 * 系统把最边缘约 16vp 留给返回手势，所以热区做成 28vp，实测从 22vp 起手就能稳定命中。
 */

import { AppearancePrefs } from '../settings/AppearancePrefs';
import { hdsMaterial, HdsTabs, HdsTabsController } from '@kit.UIDesignKit';
import { curves } from '@kit.ArkUI';

import { AppStore, ProjectMeta } from '../../store/AppStore';
import { Bp, HomeDims } from '../home/HomeBreakpoints';
import { HomeTokens, relativeLabel } from '../home/HomeTokens';
import { GlassCard } from '../home/GlassCard';
import { GripAwareness } from '../nav/GripAwareness';
import { BarAutoHide } from '../nav/BarAutoHide';
import { NewProjectPane } from './NewProjectPane';

const SIDE_LEFT: string = 'left';

/** 工程重命名对话框：单行输入 + 取消/确定，和项目页的玻璃风格保持一致。 */
@CustomDialog
struct ProjectRenameDialog {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  controller?: CustomDialogController;
  @Prop dims: HomeDims;
  @Prop initialName: string = '';
  onConfirm: (name: string) => void = (): void => {};

  @State private name: string = '';

  aboutToAppear(): void {
    this.name = this.initialName;
  }

  private submit(): void {
    const next: string = this.name.trim();
    if (next.length === 0) {
      return;
    }
    this.onConfirm(next);
    this.controller?.close();
  }

  build() {
    Column({ space: 14 }) {
      Text('重命名稿件')
        .fontSize(this.dims.titleSize)
        .fontWeight(FontWeight.Medium)
        .fontColor(HomeTokens.text)
        .width('100%')
      TextInput({ text: this.name, placeholder: '输入稿件名称' })
        .fontSize(this.dims.bodySize)
        .fontColor(HomeTokens.text)
        .placeholderColor(HomeTokens.textFaint)
        .height(44)
        .padding({ left: 12, right: 12 })
        .backgroundColor(HomeTokens.glassFill)
        .borderRadius(this.dims.radiusInner)
        .onChange((value: string): void => {
          this.name = value;
        })
        .onSubmit((): void => {
          this.submit();
        })
      Row({ space: 10 }) {
        Button('取消', { type: ButtonType.Normal })
          .layoutWeight(1)
          .height(42)
          .fontSize(this.dims.bodySize)
          .fontColor(HomeTokens.textDim)
          .backgroundColor(HomeTokens.glassFill)
          .borderRadius(this.dims.radiusPill)
          .onClick((): void => {
            this.controller?.close();
          })
        Button('确定', { type: ButtonType.Normal })
          .layoutWeight(1)
          .height(42)
          .fontSize(this.dims.bodySize)
          .fontColor(HomeTokens.onPrimary)
          .backgroundColor(HomeTokens.primary)
          .borderRadius(this.dims.radiusPill)
          .onClick((): void => {
            this.submit();
          })
      }
      .width('100%')
    }
    .width(this.dims.twoPane ? 420 : 320)
    .padding(22)
    .borderRadius(this.dims.radiusCard)
    .backgroundColor(HomeTokens.panelFill)
    .backgroundBlurStyle(BlurStyle.COMPONENT_ULTRA_THICK, { colorMode: HomeTokens.blurMode() })
    .border({ width: 1, color: HomeTokens.glassEdge })
  }
}

export class NewProjectGate {
  open: boolean = false;
  busy: boolean = false;
  requestClose: () => void = (): void => {};
}

@Component
export struct ProjectsPane {
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private themeLight: boolean = false;
  @ObjectLink store: AppStore;
  @Prop dims: HomeDims;
  /** 底部给 HdsTabs 浮动标签栏让出的高度。 */
  @Prop bottomInset: number = 0;
  /** lg 侧栏展开时内容右移的宽度；只用于把页头左侧组反向拉回原位，让侧栏盖住它。 */
  @Prop leftInset: number = 0;

  /** 请求父级打开抽屉：left / right。 */
  onRequestDrawer: (side: string) => void = (): void => {};
  /** 点击稿件卡打开编辑页。 */
  onOpenProject: (project: ProjectMeta) => void = (): void => {};
  /** 新建页置顶前收起项目页侧栏，避免侧栏盖在新页面左侧。 */
  onCreateOpen: () => void = (): void => {};
  /** 取消新建时恢复打开前的侧栏状态。 */
  onCreateCancel: () => void = (): void => {};
  /** 稿件瀑布流滚动时通知入口页收起 / 展开底部 HdsTabs。 */
  onBarCollapse: (hidden: boolean) => void = (): void => {};

  /** 入口页通过它感知新建页是否打开，并在系统返回时请求关闭。 */
  newProjectGate: NewProjectGate = new NewProjectGate();
  /** 当前打开编辑页的项目 id；只有卡片进入时绑定共享元素。 */
  @Prop editorProjectId: string = '';

  /** 新建稿件页是否盖在项目页上。 */
  @State private creating: boolean = false;
  /** 新建页内部是否正在复制/识别；忙碌时系统返回不关闭页面。 */
  @State private createBusy: boolean = false;
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  @State private menuProject: ProjectMeta | null = null;
  @State private menuX: number = 0;
  @State private menuY: number = 0;
  @State private menuPressed: string = '';
  @State private rootHeight: number = 800;
  private menuGuard: boolean = false;
  private renameDialog: CustomDialogController | null = null;
  private autoHide: BarAutoHide = new BarAutoHide();

  aboutToAppear(): void {
    this.newProjectGate.requestClose = (): void => {
      if (!this.createBusy) {
        this.closeCreate();
      }
    };
  }

  aboutToDisappear(): void {
    this.newProjectGate.open = false;
    this.newProjectGate.busy = false;
    this.newProjectGate.requestClose = (): void => {};
    this.renameDialog?.close();
    this.renameDialog = null;
  }

  private handleScroll(offset: number, state: ScrollState): void {
    this.autoHide.handle(offset, state, (hidden: boolean): void => {
      this.onBarCollapse(hidden);
    });
  }

  private openDrawer(side: string): void {
    this.onRequestDrawer(side);
  }

  private openCreate(): void {
    this.onCreateOpen();
    this.createBusy = false;
    this.newProjectGate.open = true;
    this.creating = true;
  }

  private closeCreate(): void {
    this.creating = false;
    this.createBusy = false;
    this.newProjectGate.open = false;
    this.newProjectGate.busy = false;
    this.onCreateCancel();
  }

  private finishCreate(project: ProjectMeta): void {
    // @Observed 只可靠地感知属性赋值，不感知数组 push；这里赋一次新数组，
    // 保证瀑布流立刻出现刚建的稿件。
    this.store.projects = this.store.projects.slice();
    this.creating = false;
    this.createBusy = false;
    this.newProjectGate.open = false;
    this.newProjectGate.busy = false;
    this.toast(`已创建「${project.name}」`);
    // 创建完成后直接进入编辑页：导入模式可继续校对，初稿模式立即可见识别结果。
    setTimeout((): void => {
      this.onOpenProject(project);
    }, 320);
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 1800 });
    } catch (err) {
      // 提示失败不影响建稿
    }
  }

  // ------------------------------------------------------------ 顶栏 / 主体

  /** 按钮直径：sm/md 44vp、lg 48vp；由 HdsTabs 单 Tab 底栏承载沉浸材质。 */
  private menuSize(): number {
    return this.dims.bp === Bp.LG ? 48 : 44;
  }

  private menuController: HdsTabsController = new HdsTabsController();

  @Builder
  menuGlyph() {
    SymbolGlyph($r('sys.symbol.line_3_horizontal'))
      .fontSize(this.menuSize() * 0.43)
      .fontColor([HomeTokens.text])
  }

  /** 单个 Tab 的自定义内容：只有图标，没有文字。 */
  @Builder
  menuTab() {
    Column() {
      this.menuGlyph()
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .accessibilityText('打开稿件库')
  }

  /**
   * 项目页左上角 ☰：用 HdsTabs 单 Tab 悬浮底栏承载 IMMERSIVE 沉浸材质。
   * 不再叠自绘玻璃底；gradientMask 设为透明，尽量只留下材质本身的光感。
   */
  @Builder
  menuButton() {
    HdsTabs({ controller: this.menuController }) {
      TabContent() {
        // 空内容：只借用 HdsTabs 底栏的沉浸材质。
      }
      .tabBar(this.menuTab())
    }
    .vertical(false)
    .scrollable(false)
    .barHeight(this.menuSize())
    .barOverlap(true)
    .barPosition(BarPosition.End)
    .barFloatingStyle({
      barWidth: {
        smallWidth: this.menuSize(),
        mediumWidth: this.menuSize(),
        largeWidth: this.menuSize()
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
      // lg 宽屏固定左侧；sm/md 仍按握姿/触摸落点决定
      this.openDrawer(this.dims.bp === Bp.LG ? SIDE_LEFT : GripAwareness.side());
    })
    .width(this.menuSize())
    .height(this.menuSize())
    .borderRadius(this.menuSize() / 2)
    .clip(true)
  }

  private addController: HdsTabsController = new HdsTabsController();

  @Builder
  addGlyph() {
    SymbolGlyph($r('sys.symbol.plus'))
      .fontSize(this.menuSize() * 0.45)
      .fontColor([HomeTokens.primary])
  }

  @Builder
  addTab() {
    Column() {
      this.addGlyph()
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .accessibilityText('新建稿件')
  }

  /**
   * 项目页右上角 ＋：和左上角 ☰ 同一套 HdsTabs 单 Tab 沉浸材质，
   * 点击滑入新建稿件页，不再额外画圆形玻璃底。
   */
  @Builder
  addButton() {
    HdsTabs({ controller: this.addController }) {
      TabContent() {
        // 空内容：只借用 HdsTabs 底栏的沉浸材质。
      }
      .tabBar(this.addTab())
    }
    .vertical(false)
    .scrollable(false)
    .barHeight(this.menuSize())
    .barOverlap(true)
    .barPosition(BarPosition.End)
    .barFloatingStyle({
      barWidth: {
        smallWidth: this.menuSize(),
        mediumWidth: this.menuSize(),
        largeWidth: this.menuSize()
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
      this.openCreate();
    })
    .width(this.menuSize())
    .height(this.menuSize())
    .borderRadius(this.menuSize() / 2)
    .clip(true)
  }

  @Builder
  header() {
    Row({ space: this.dims.gap }) {
      // 侧栏展开时内容整体右移；左侧「☰ + 项目」反向拉回屏幕原位，
      // 由侧栏直接盖住；右侧计数 / ＋ 仍留在右移后的内容区。
      Row({ space: this.dims.gap }) {
        this.menuButton()

        Text('项目')
          .fontSize(this.dims.titleSize + 4)
          .fontWeight(FontWeight.Medium)
          .fontColor(HomeTokens.text)
      }
      .translate({ x: -this.leftInset })

      Blank()
      Text(`${this.store.projects.length} 个稿件`)
        .fontSize(this.dims.miniSize)
        .fontColor(HomeTokens.textFaint)
      this.addButton()
    }
    .width('100%')
  }

  /**
   * 瀑布流列数：只按 sm / md / lg 断点。
   *   sm 手机 2 列；md 折叠屏 3 列；lg 平板/宽窗口 4 列。
   * 不再在 sm 内部再切 1/2 列的宽度阈值，和主页瀑布流保持同一套断点。
   */
  private projectColumns(): number {
    if (this.dims.bp === Bp.LG) {
      return 4;
    }
    if (this.dims.bp === Bp.MD) {
      return 3;
    }
    return 2;
  }

  private columnsTemplate(): string {
    const n: number = this.projectColumns();
    if (n >= 4) {
      return '1fr 1fr 1fr 1fr';
    }
    if (n === 3) {
      return '1fr 1fr 1fr';
    }
    if (n === 2) {
      return '1fr 1fr';
    }
    return '1fr';
  }

  private openProject(p: ProjectMeta): void {
    if (this.menuGuard) {
      return;
    }
    this.onOpenProject(p);
  }

  private menuWidth(): number {
    return 172;
  }

  private menuHeight(): number {
    return 140;
  }

  private openProjectMenu(p: ProjectMeta, screenX: number, screenY: number): void {
    this.menuGuard = true;
    let x: number = screenX - this.leftInset;
    let y: number = screenY - this.statusBarHeight;
    if (x < 8) {
      x = 8;
    }
    if (x + this.menuWidth() > this.dims.widthVp - 8) {
      x = this.dims.widthVp - this.menuWidth() - 8;
    }
    if (y < 8) {
      y = 8;
    }
    if (y + this.menuHeight() > this.rootHeight - 8) {
      y = this.rootHeight - this.menuHeight() - 8;
    }
    this.menuX = x;
    this.menuY = y;
    this.menuPressed = '';
    this.menuProject = p;
    setTimeout((): void => {
      this.menuGuard = false;
    }, 320);
  }

  private closeProjectMenu(): void {
    this.menuProject = null;
    this.menuPressed = '';
  }

  private openRename(p: ProjectMeta): void {
    this.closeProjectMenu();
    this.renameDialog = new CustomDialogController({
      builder: ProjectRenameDialog({
        dims: this.dims,
        initialName: p.name,
        onConfirm: (name: string): void => {
          this.store.renameProject(p, name);
          this.toast('稿件已重命名');
        }
      }),
      autoCancel: true,
      alignment: DialogAlignment.Center,
      customStyle: true
    });
    this.renameDialog.open();
  }

  private showDetails(p: ProjectMeta): void {
    this.closeProjectMenu();
    const duration: string = p.durationSec > 0 ? `${p.durationSec.toFixed(1)} 秒` : '未知';
    const media: string = p.mediaPath.length > 0 ? p.mediaPath : '未关联媒体文件';
    const message: string = [
      `名称：${p.name}`,
      `ID：${p.id}`,
      `字幕：${p.cueCount} 条`,
      `语言：${p.sourceLang.toUpperCase()} → ${p.targetLang.toUpperCase()}`,
      `时长：${duration}`,
      `媒体：${media}`,
      `最近更新：${new Date(p.updatedAt).toLocaleString()}`
    ].join('\n');
    this.getUIContext().showAlertDialog({
      title: '稿件详细信息',
      message: message,
      autoCancel: true,
      confirm: {
        value: '关闭',
        action: (): void => {
        }
      }
    });
  }

  private confirmDelete(p: ProjectMeta): void {
    this.closeProjectMenu();
    this.getUIContext().showAlertDialog({
      title: '删除稿件',
      message: `确定删除「${p.name}」吗？\n工程目录和字幕缓存会被移除，已导入的媒体文件不会被删除。`,
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
          this.store.deleteProject(p);
          this.toast(`已删除「${p.name}」`);
        }
      }
    });
  }

  @Builder
  menuItem(label: string, danger: boolean, onTap: () => void) {
    Row() {
      Text(label)
        .fontSize(this.dims.bodySize)
        .fontColor(danger ? HomeTokens.danger : HomeTokens.text)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(42)
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
        }, 90);
      } else if (event.type === TouchType.Cancel) {
        this.menuPressed = '';
      }
    })
  }

  @Builder
  projectMenu() {
    if (this.menuProject !== null) {
      Column({ space: 2 }) {
        this.menuItem('重命名', false, (): void => {
          const p = this.menuProject;
          if (p !== null) {
            this.openRename(p);
          }
        })
        this.menuItem('详细信息', false, (): void => {
          const p = this.menuProject;
          if (p !== null) {
            this.showDetails(p);
          }
        })
        this.menuItem('删除稿件', true, (): void => {
          const p = this.menuProject;
          if (p !== null) {
            this.confirmDelete(p);
          }
        })
      }
      .width(this.menuWidth())
      .padding(4)
      .borderRadius(18)
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
      .position({ x: this.menuX, y: this.menuY })
      .zIndex(30)
    }
  }

  @Builder
  projectCard(p: ProjectMeta) {
    Column() {
      GlassCard({
        dims: this.dims,
        interactive: true,
        onTap: (): void => {
          this.openProject(p);
        }
      }) {
        Column({ space: 8 }) {
          Row({ space: 8 }) {
            Text('♪')
              .fontSize(this.dims.bp === Bp.LG ? 18 : 16)
              .fontColor(HomeTokens.primary)
              .width(this.dims.bp === Bp.LG ? 40 : 34)
              .height(this.dims.bp === Bp.LG ? 40 : 34)
              .textAlign(TextAlign.Center)
              .borderRadius(this.dims.radiusInner)
              .backgroundColor(HomeTokens.accentGlass)
            Blank()
            Text(`${p.cueCount} 条`)
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.primary)
              .padding({ left: 7, right: 7, top: 2, bottom: 2 })
              .borderRadius(this.dims.radiusPill)
              .backgroundColor(HomeTokens.accentGlass)
          }
          .width('100%')

          Text(p.name.length > 0 ? p.name : '未命名稿件')
            .fontSize(this.dims.bodySize + 1)
            .fontWeight(FontWeight.Medium)
            .fontColor(HomeTokens.text)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          Text(p.mediaName.length > 0 ? p.mediaName : '未关联媒体文件')
            .fontSize(this.dims.miniSize)
            .fontColor(HomeTokens.textFaint)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          Divider()
            .color(HomeTokens.glassEdge)
            .strokeWidth(0.5)
            .margin({ top: 2, bottom: 2 })

          Row() {
            Text(`${relativeLabel(p.updatedAt, Date.now())}更新`)
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.textDim)
            Blank()
            Text(`${p.sourceLang.toUpperCase()} → ${p.targetLang.toUpperCase()}`)
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.textFaint)
          }
          .width('100%')
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .id(`project_card_${p.id}`)
    .borderRadius(this.dims.radiusCard)
    .clip(true)
    .geometryTransition(this.editorProjectId === p.id
      ? `project_cover_${p.id}` : '', { follow: true })
    .transition(TransitionEffect.OPACITY)
    .onMouse((event: MouseEvent): void => {
      // 鼠标右键等同长按：在指针位置弹出稿件菜单。
      if (event.button === MouseButton.Right && event.action === MouseAction.Press) {
        this.openProjectMenu(p, event.displayX, event.displayY);
      }
    })
    .gesture(
      LongPressGesture({ repeat: false, duration: 420 })
        .onAction((event: GestureEvent): void => {
          if (event.fingerList.length > 0) {
            const finger: FingerInfo = event.fingerList[0];
            this.openProjectMenu(p, finger.displayX, finger.displayY);
          }
        })
    )
  }

  build() {
    Stack() {
      // 主体
      Column({ space: this.dims.gap }) {
        this.header()

        if (this.store.projects.length === 0) {          Column() {
            Text('还没有稿件')
              .fontSize(this.dims.bodySize)
              .fontColor(HomeTokens.textDim)
            Text('新建或导入之后，这里按最近修改排列。')
              .fontSize(this.dims.miniSize)
              .fontColor(HomeTokens.textFaint)
              .margin({ top: 6 })
          }
          .width('100%')
          .padding(this.dims.cardPadding * 2)
          .borderRadius(this.dims.radiusCard)
          .backgroundColor(HomeTokens.glassFill)
          .border({ width: 1, color: HomeTokens.glassEdge, style: BorderStyle.Dashed })
        } else {
          WaterFlow() {
            ForEach(this.store.projects, (p: ProjectMeta) => {
              FlowItem() {
                this.projectCard(p)
              }
              .width('100%')
            }, (p: ProjectMeta) => p.id)
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
      }
      .width('100%')
      .height('100%')
      .padding({
        left: this.dims.pagePaddingH,
        right: this.dims.pagePaddingH,
        top: this.dims.pagePaddingTop
      })
      // 新建页盖上来时把项目列表淡出，让背景统一用全局沉浸光感，避免再叠一层底色。
      .opacity(this.creating ? 0 : 1)
      .animation({ duration: 160, curve: Curve.EaseOut })
      // 页面内容上直接支持左右横滑：不依赖系统占用的最边缘，平板也能双向呼出侧栏。
      .gesture(
        PanGesture({ direction: PanDirection.Horizontal, distance: 24 })
          .onActionEnd((event: GestureEvent): void => {
            if (event.offsetX > 64) {
              this.openDrawer(SIDE_LEFT);
            } else if (event.offsetX < -64) {
              this.openDrawer('right');
            }
          })
      )

      // 边缘热区：sm/md 左右都可；lg 固定左侧，右侧由内容横滑兜底
      Row() {
        Column()
          .width(28)
          .height('100%')
          .backgroundColor('#00000000')
          .gesture(
            PanGesture({ direction: PanDirection.Horizontal, distance: 8 })
              .onActionEnd((event: GestureEvent): void => {
                if (event.offsetX > 28) {
                  this.openDrawer(SIDE_LEFT);
                }
              })
          )
        Blank()
        if (this.dims.bp !== Bp.LG) {
          Column()
            .width(28)
            .height('100%')
            .backgroundColor('#00000000')
            .gesture(
              PanGesture({ direction: PanDirection.Horizontal, distance: 8 })
                .onActionEnd((event: GestureEvent): void => {
                  if (event.offsetX < -28) {
                    this.openDrawer('right');
                  }
                })
            )
        }
      }
      .width('100%')
      .height('100%')
      // 自身不拦中间的触摸，只有两侧 28vp 的条接手势
      .hitTestBehavior(HitTestMode.Transparent)

      // 新建稿件页：盖住项目页内容和两侧热区，底部 HdsTabs 仍由入口页提供。
      // 不铺第二张背景，背景直接用全局沉浸光感；项目列表在转场中淡出。
      if (this.creating) {
        Stack() {
          NewProjectPane({
            store: this.store,
            dims: this.dims,
            bottomInset: this.bottomInset,
            onBack: (): void => {
              this.closeCreate();
            },
            onCreated: (project: ProjectMeta): void => {
              this.finishCreate(project);
            },
            onBusyChange: (busy: boolean): void => {
              this.createBusy = busy;
              this.newProjectGate.busy = busy;
            }
          })
        }
        .width('100%')
        .height('100%')
        .clip(true)
        .transition(TransitionEffect.translate({ x: this.dims.widthVp })
          .animation({ duration: 300, curve: curves.springMotion(0.34, 0.92) }))
      }

      // 稿件右键 / 长按菜单：透明遮罩负责点空白关闭，菜单浮在最上层。
      if (!this.creating && this.menuProject !== null) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor('#00000000')
          .zIndex(29)
          .onClick((): void => {
            this.closeProjectMenu();
          })
        this.projectMenu()
      }
    }
    .width('100%')
    .height('100%')
    .onAreaChange((oldArea: Area, newArea: Area): void => {
      const h: number = Number(newArea.height);
      if (!Number.isNaN(h) && h > 0 && Math.abs(h - this.rootHeight) > 1) {
        this.rootHeight = h;
      }
    })
  }
}
