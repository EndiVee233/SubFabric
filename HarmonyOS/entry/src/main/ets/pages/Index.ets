/*
 * 应用入口：沉浸光感背景 + HdsTabs（UIDesignKit 官方 Tabs）。
 *
 * 四个分区固定为 主页 / 项目 / 模型 / 设置，样式走官方 `barFloatingStyle` 的
 * IMMERSIVE 材质，底部栏自带渐变遮罩与沉浸模糊，不再是自绘玻璃条。
 *
 * 手势策略：**手机不可左右滑动**（避免和内容横向手势打架），
 * 折叠屏 / 平板及更宽的设备才允许滑动切换 —— 由 `dims.twoPane` 决定。
 *
 * 旧的「老主页 / 编辑器 / 听写 / 模型 / 设置」五页已按要求删除
 * （StudioPage.ets，备份在 docs/archive/）；项目页、模型页和设置页均已重建。
 */

import { common } from '@kit.AbilityKit';
import { curves, SymbolGlyphModifier } from '@kit.ArkUI';
import { hdsMaterial, HdsTabs, HdsTabsController } from '@kit.UIDesignKit';

import { AppStore, ProjectMeta, RunState } from '../store/AppStore';
import { STORE_KEY } from '../entryability/EntryAbility';
import { Logger } from '../engine/Logger';
import { Bp, BreakpointObserver, breakpointOfWidth, HomeDims } from '../ui/home/HomeBreakpoints';
import { HomePrefs } from '../ui/home/HomePreferences';
import { AppearancePrefs, ensureAppearanceDefaults } from '../ui/settings/AppearancePrefs';
import { ensureMediaCodecDefaults } from '../engine/MediaBackend';
import { applyColorMode, applySystemBars } from '../platform/ThemeManager';
import { HomeSummary } from '../ui/home/HomeData';
import { HomeTokens } from '../ui/home/HomeTokens';
import { ImmersiveBackground } from '../ui/home/ImmersiveBackground';
import { HomePane } from '../ui/home/HomePane';
import { ProjectsPane, NewProjectGate } from '../ui/projects/ProjectsPane';
import { ProjectsDrawer, wideDrawerInset } from '../ui/projects/ProjectsDrawer';
import { ModelsPane } from '../ui/models/ModelsPane';
import { SettingsPane } from '../ui/settings/SettingsPane';
import { EditorPage } from '../ui/editor/EditorPage';
import { GripAwareness } from '../ui/nav/GripAwareness';

const TAG = 'Index';

@Entry
@Component
struct Index {
  @StorageLink(STORE_KEY) store: AppStore = new AppStore();
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  /** 底部导航条（小白条）高度：浮动 TabBar 的下边距要把它让出来。 */
  @StorageProp('navIndicatorHeight') navIndicatorHeight: number = 0;

  @State private bp: string = Bp.SM;
  @State private dims: HomeDims = HomeDims.of(Bp.SM);
  /** 根容器实际宽度（vp），由 onAreaChange 维护，用来算点击落点比例。 */
  @State private rootWidth: number = 360;
  @State private rootHeight: number = 780;
  /** 本次抽屉打开的方向：默认左侧；右边缘滑出只覆盖本次，不写回握姿。 */
  @State private drawerSide: string = 'left';
  /** 项目页抽屉是否展开：展开时把底部标签栏收掉，让面板真正铺满。 */
  @State private drawerOpen: boolean = false;
  /** 打开新建页前侧栏是否展开；取消新建时恢复。 */
  private drawerBeforeCreate: boolean = false;
  private createRestoreTimer: number = -1;
  /** 首页滚动时自动收起底部 HdsTabs；只影响首页。 */
  @State private barHidden: boolean = false;
  @State private activeTab: number = 0;
  @StorageProp(AppearancePrefs.EFFECTIVE_LIGHT) private effectiveLight: boolean = false;
  @State private ready: boolean = false;

  // ------------------------------------------------------------ 编辑页全屏模态
  private navStack: NavPathStack = new NavPathStack();
  /** 新建页系统返回：入口页负责拦截，项目页负责关闭。 */
  private newProjectGate: NewProjectGate = new NewProjectGate();
  /** 编辑页是否由 bindContentCover 全屏覆盖。 */
  @State private editorOpen: boolean = false;
  /** 当前共享元素的项目 id；空串表示从首页/抽屉进入，不做一镜到底。 */
  @State private editorProjectId: string = '';
  private navAnimating: boolean = false;

  private tabsController: HdsTabsController = new HdsTabsController();
  private watcher: BreakpointObserver | null = null;
  private inited: boolean = false;

  // ------------------------------------------------------------ 生命周期

  async aboutToAppear(): Promise<void> {
    if (AppStorage.get<number>(HomePrefs.LIGHT) === undefined) {
      AppStorage.setOrCreate<number>(HomePrefs.LIGHT, 1);
    }
    ensureAppearanceDefaults();
    ensureMediaCodecDefaults();
    // PersistentStorage 的恢复发生在 Ability 生命周期之后：页面出现时再应用一次，
    // 保证重启后仍保持上次选择的浅色/深色。
    try {
      const themeCtx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const themeMode = AppStorage.get<string>(AppearancePrefs.MODE) ?? 'dark';
      const light = applyColorMode(themeCtx, themeMode);
      applySystemBars(themeCtx, light);
    } catch (err) {
      Logger.warn(TAG, '恢复外观失败（忽略）');
    }

    GripAwareness.ensure();
    GripAwareness.startSensor();

    this.watcher = new BreakpointObserver(this.getUIContext(), (bp: string): void => {
      this.bp = bp;
      this.dims = HomeDims.of(bp, this.rootWidth);
      // 常驻展开只属于宽屏：转回 lg 且停在项目页时补开；离开 lg 时收起覆盖式抽屉。
      if (this.activeTab === 1 && this.drawerPinned()) {
        if (!this.drawerOpen) {
          this.openDrawer('left');
        }
      } else if (this.dims.bp !== Bp.LG && this.drawerOpen) {
        this.closeDrawer();
      }
    });
    this.watcher.start();

    if (!this.inited) {
      this.inited = true;
      const abilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
      try {
        await this.store.init(abilityContext);
        this.ready = true;
      } catch (err) {
        const e = err as Error;
        Logger.error(TAG, `初始化失败：${e.message}`);
      }
    }
  }

  aboutToDisappear(): void {
    GripAwareness.stopSensor();
    if (this.watcher !== null) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /** 系统返回：新建页盖住项目页时，先关闭新建页而不是退出应用。 */
  onBackPress(): boolean {
    if (this.activeTab === 1 && this.newProjectGate.open) {
      this.newProjectGate.requestClose();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ 数据

  private summary(): HomeSummary {
    const s = new HomeSummary();
    s.projectCount = this.store.projects.length;
    let editable: number = 0;
    let attention: number = 0;
    for (const p of this.store.projects) {
      if (p.cueCount > 0) {
        editable++;
      } else {
        attention++;
      }
    }
    s.editable = editable;
    s.attention = attention;
    s.busy = this.store.runState === RunState.BUSY;
    s.processingPct = Math.round(this.store.progress.ratio * 100);
    const cur = this.store.current;
    if (s.busy) {
      s.processingName = cur !== null && cur.name.length > 0 ? cur.name : '正在处理稿件';
    }
    s.processingHint = this.store.statusText.length > 0 ? this.store.statusText : '本机工作空间待命';
    s.deviceLabel = this.store.npuAvailable ? 'NPU' : '未加载';
    return s;
  }

  // ------------------------------------------------------------ TabBar 样式

  private tabBarStyle(title: ResourceStr, normal: Resource, selected: Resource): BottomTabBarStyle {
    // 单一图层渲染：深色底上多透明度分层会糊成一团
    const normalGlyph = new SymbolGlyphModifier(normal)
      .renderingStrategy(SymbolRenderingStrategy.SINGLE);
    normalGlyph.fontColor([HomeTokens.textDim]);

    const selectedGlyph = new SymbolGlyphModifier(selected)
      .renderingStrategy(SymbolRenderingStrategy.SINGLE);
    selectedGlyph.fontColor([HomeTokens.primary]);

    // TabBarSymbol 是纯类型声明（没有运行时构造器），只能传对象字面量：
    // `new TabBarSymbol()` 编译能过，但真机会报 ReferenceError: TabBarSymbol is not defined。
    return BottomTabBarStyle.of({ normal: normalGlyph, selected: selectedGlyph }, title)
      .labelStyle({ unselectedColor: HomeTokens.textDim, selectedColor: HomeTokens.primary })
      .padding({ bottom: 0 });
  }

  // ------------------------------------------------------------ 分区内容

  @Builder
  HomeTab() {
    Column() {
      HomePane({
        store: this.store,
        dims: this.contentDims(),
        summary: this.summary(),
        bottomInset: this.barHidden ? 0 : this.bottomInset(),
        onAction: (key: string): void => {
          this.handleAction(key);
        },
        onOpenProject: (p: ProjectMeta): void => {
          this.openProject(p, false);
        },
        onBarCollapse: (hidden: boolean): void => {
          this.setBarHidden(hidden);
        }
      })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  SettingsTab() {
    SettingsPane({
      store: this.store,
      dims: this.contentDims(),
      bottomInset: this.bottomInset(),
      onBarCollapse: (hidden: boolean): void => {
        this.setBarHidden(hidden);
      }
    })
  }

  @Builder
  editorCover() {
    Column() {
      EditorPage({
        store: this.store,
        dims: this.dims,
        onClose: (): void => {
          this.closeEditor();
        }
      })
    }
    .width('100%')
    .height('100%')
    .borderRadius(0)
    .clip(true)
    .backgroundColor(HomeTokens.base)
    // 与项目卡片共享同一个 geometryTransition id；只在卡片进入时设置。
    .geometryTransition(this.editorProjectId.length > 0
      ? `project_cover_${this.editorProjectId}` : '', { follow: true })
    .transition(TransitionEffect.OPACITY)
  }

  // ------------------------------------------------------------ 交互

  private handleAction(key: string): void {
    if (key === 'settings') {
      this.barHidden = false;
      this.tabsController.changeIndex(3);
      return;
    }
    if (key === 'new' || key === 'import' || key === 'all' || key === 'ready' || key === 'attention') {
      this.barHidden = false;
      this.tabsController.changeIndex(1); // 项目分区（待重建）
      return;
    }
    if (key === 'batch') {
      this.toast('批量初稿：端上尚未接入');
    }
  }

  private openProject(p: ProjectMeta, withGeometry: boolean = true): void {
    if (this.navAnimating || this.editorOpen) {
      return;
    }
    this.navAnimating = true;
    this.store.openProject(p).catch((err: Error): void => {
      Logger.warn(TAG, `打开稿件失败：${err.message}`);
    });
    this.barHidden = false;
    this.tabsController.changeIndex(1);
    // 打开稿件不再收起项目页侧栏：编辑页是全屏覆盖层，
    // 关掉稿件后应回到原来的侧栏展开状态。
    // 先把卡片共享 id 绑上，再在 animateTo 里打开全屏模态。
    this.editorProjectId = withGeometry ? p.id : '';
    this.getUIContext().animateTo({
      duration: 360,
      curve: curves.springMotion(0.34, 0.92),
      onFinish: (): void => {
        this.navAnimating = false;
      }
    }, (): void => {
      this.editorOpen = true;
    });
  }

  private closeEditor(): void {
    if (!this.editorOpen || this.navAnimating) {
      return;
    }
    this.navAnimating = true;
    this.getUIContext().animateTo({
      duration: 350,
      curve: curves.springMotion(0.34, 0.92),
      onFinish: (): void => {
        // 官方建议：动效结束后清空共享 id，避免下一次状态变化误触发。
        this.editorProjectId = '';
        this.navAnimating = false;
        // 常驻展开时，新建稿件页曾临时收起侧栏；关闭编辑页后补回来。
        if (this.activeTab === 1 && this.drawerPinned() && !this.drawerOpen) {
          this.openDrawer('left');
        }
      }
    }, (): void => {
      this.editorOpen = false;
    });
  }

  /** 底部占位：HdsTabs 的浮动栏在竖屏和横屏都保留，统一按断点给高度。 */
  private bottomInset(): number {
    return this.dims.navBarHeight;
  }

  /** lg 宽屏侧栏展开时，项目页整体让出的左侧宽度。 */
  private contentInset(): number {
    return this.dims.bp === Bp.LG && this.drawerOpen ? wideDrawerInset(this.dims) : 0;
  }

  /** 设置里的「项目页侧栏常驻展开」只在宽屏双栏布局生效。 */
  private drawerPinned(): boolean {
    return this.store.projectsDrawerPinned && this.dims.bp === Bp.LG;
  }

  /**
   * 内容区断点变量：lg 侧栏展开时按「右移后剩下的宽度」重新算一套，
   * 让项目卡和间距跟着变窄，而不是保持全屏尺寸被裁切。
   */
  private contentDims(): HomeDims {
    const inset: number = this.contentInset();
    if (inset <= 0) {
      return this.dims;
    }
    const width: number = Math.max(320, this.dims.widthVp - inset);
    return HomeDims.of(breakpointOfWidth(width), width, 0.9);
  }

  /** 打开项目页抽屉：本次从 side 展开，但不改写默认握姿侧。 */
  private openDrawer(side: string): void {
    // lg 宽屏固定左侧；sm/md 保留左/右握姿
    this.drawerSide = this.dims.bp === Bp.LG || side !== 'right' ? 'left' : 'right';
    this.getUIContext().animateTo({
      duration: 280,
      curve: curves.springMotion(0.34, 0.92)
    }, (): void => {
      this.drawerOpen = true;
    });
  }

  private closeDrawer(): void {
    this.getUIContext().animateTo({
      duration: 220,
      curve: curves.springMotion(0.4, 0.95)
    }, (): void => {
      this.drawerOpen = false;
    });
  }

  /** 底部浮动栏的收起 / 展开：与项目页侧栏同一组弹簧参数。 */
  private setBarHidden(hidden: boolean): void {
    if (this.barHidden === hidden) {
      return;
    }
    this.getUIContext().animateTo({
      duration: 280,
      curve: curves.springMotion(0.34, 0.92)
    }, (): void => {
      this.barHidden = hidden;
    });
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 2200 });
    } catch (err) {
      Logger.info(TAG, msg);
    }
  }

  // ------------------------------------------------------------ 视图

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      ImmersiveBackground()

      Navigation(this.navStack) {
        Column() {
          HdsTabs({ controller: this.tabsController }) {
            TabContent() {
              this.HomeTab()
            }.tabBar(this.tabBarStyle('主页', $r('sys.symbol.house'), $r('sys.symbol.house_fill')))

            TabContent() {
              ProjectsPane({
                store: this.store,
                dims: this.contentDims(),
                bottomInset: this.bottomInset(),
                newProjectGate: this.newProjectGate,
                editorProjectId: this.editorProjectId,
                leftInset: this.contentInset(),
                onOpenProject: (project: ProjectMeta): void => {
                  this.openProject(project);
                },
                onRequestDrawer: (side: string): void => {
                  // 常驻展开时 ☰ 不再收起侧栏；若因开始新稿临时收起过，则重新展开。
                  if (this.drawerPinned()) {
                    if (!this.drawerOpen) {
                      this.openDrawer('left');
                    }
                    return;
                  }
                  // 侧栏已展开时，项目页左上角 ☰ 再次点击 = 收起侧栏
                  if (this.drawerOpen) {
                    this.closeDrawer();
                  } else {
                    this.openDrawer(side);
                  }
                },
                onCreateOpen: (): void => {
                  // 宽屏创建页只占右侧内容区，侧栏展开时不需要收起；
                  // 窄屏抽屉是覆盖式的，仍先收起，取消新建后恢复。
                  if (this.createRestoreTimer >= 0) {
                    clearTimeout(this.createRestoreTimer);
                    this.createRestoreTimer = -1;
                  }
                  const keepDrawer: boolean = this.dims.bp === Bp.LG && this.drawerOpen;
                  this.drawerBeforeCreate = this.drawerOpen && !keepDrawer;
                  if (this.drawerOpen && !keepDrawer) {
                    this.drawerOpen = false;
                  }
                  this.barHidden = false;
                },
                onCreateCancel: (): void => {
                  const restore: boolean = this.drawerBeforeCreate;
                  this.drawerBeforeCreate = false;
                  if (restore) {
                    // 等新建页滑出后再恢复侧栏，避免两段位移叠加。
                    this.createRestoreTimer = setTimeout((): void => {
                      this.createRestoreTimer = -1;
                      this.openDrawer('left');
                    }, 320);
                  }
                },
                onBarCollapse: (hidden: boolean): void => {
                  this.setBarHidden(hidden);
                }
              })
            }.tabBar(this.tabBarStyle('项目', $r('sys.symbol.folder'), $r('sys.symbol.folder_fill')))

            TabContent() {
              ModelsPane({
                store: this.store,
                dims: this.contentDims(),
                bottomInset: this.bottomInset(),
                onBarCollapse: (hidden: boolean): void => {
                  this.setBarHidden(hidden);
                }
              })
            }.tabBar(this.tabBarStyle('模型', $r('sys.symbol.memory_module'), $r('sys.symbol.memory_module')))

            TabContent() {
              this.SettingsTab()
            }.tabBar(this.tabBarStyle('设置', $r('sys.symbol.gearshape'), $r('sys.symbol.gearshape_fill')))
          }
          // 横竖屏都用同一个 HdsTabs 浮动栏；横屏不再自绘胶囊，
          // 左右跟随由 barFloatingStyle.adaptToHandedness 自动完成。
          .vertical(false)
          .onChange((index: number): void => {
            this.activeTab = index;
            if (index === 1 && this.drawerPinned()) {
              // 常驻展开：进入项目页自动展开；离开项目页仍按原逻辑收起。
              if (!this.drawerOpen) {
                this.openDrawer('left');
              }
            } else if (this.drawerOpen) {
              this.closeDrawer();
            }
            if (this.barHidden) {
              this.setBarHidden(false);
            }
          })
          // lg 宽屏侧栏与项目页同级：侧栏展开时底栏仍保留，跟着内容一起右移；
          // sm/md 抽屉是覆盖式的，仍收起底栏。
          .barHeight((this.drawerOpen && this.dims.bp !== Bp.LG) || this.barHidden ? 0 : 56)
          // 鼠标滚轮 / 触控板纵向滚动不得切页：HdsTabs 只保留点按页签切换。
          // 需要左右滑动时，由页面内容自己的横向手势处理，不能被整页切换吃掉。
          // 常驻四个页签：切走再回来时保留二级页、滚动位置和未保存草稿。
          .cachedMaxCount(3, TabsCacheMode.CACHE_BOTH_SIDE)
          .scrollable(false)
          .barOverlap(true)
          .barPosition(BarPosition.End)
          .barFloatingStyle({
            // 不再用系统渐变遮罩：浅色模式下它会在底栏高度拉出一条横跨全屏的深色带。
            // 其余页面统一用透明 mask，只保留浮动胶囊自身的材质。
            gradientMask: { maskColor: Color.Transparent },
            // 参照图库：胶囊贴着底部安全区，且不像通栏那样铺满。尺寸按 Tabs 宽度分档，
            // 手机(<440vp)走 smallWidth —— 这是 HdsBarWidthRangeOptions 的定义，不是拍脑袋。
            barWidth: { smallWidth: 296, mediumWidth: 360, largeWidth: 420 },
            // 回滚到上一版的安全区（12 + 导航条），再按 20% 收紧
            barBottomMargin: (12 + this.navIndicatorHeight) * 0.8,
            barSideMargin: this.dims.twoPane ? 8 : undefined,
            adaptToHandedness: true,
            systemMaterialEffect: {
              materialType: hdsMaterial.MaterialType.IMMERSIVE,
              materialLevel: hdsMaterial.MaterialLevel.EXQUISITE
            }
          })
          .width('100%')
          .height('100%')
        }
        .width('100%')
        .height('100%')
        // 光感背景铺满，内容从状态栏下面开始；平板侧栏展开时左侧让出侧栏宽度
        .padding({ top: this.statusBarHeight, left: this.contentInset() })

        .onAreaChange((oldArea: Area, newArea: Area): void => {
          const w: number = Number(newArea.width);
          const h: number = Number(newArea.height);
          if (!Number.isNaN(h) && h > 0) {
            this.rootHeight = h;
          }
          if (!Number.isNaN(w) && w > 0) {
            this.rootWidth = w;
            // onAreaChange 只做即时校准；真正的断点监听在 BreakpointObserver 的
            // @ohos.mediaquery sm/md/lg 回调里，两者都走 breakpointOfWidth。
            const nextBp: string = breakpointOfWidth(w);
            if (nextBp !== this.bp) {
              this.bp = nextBp;
            }
            this.dims = HomeDims.of(nextBp, w);
          }
        })
        .onTouch((event: TouchEvent): void => {
          // 只在抬起时采样：按下时改 AppStorage 会触发重建，把本次 onClick 吞掉。
          if (event.type !== TouchType.Up || event.touches.length === 0) {
            return;
          }
          const width: number = this.rootWidth;
          if (width <= 0) {
            return;
          }
          // 只根据下半屏内容区的落点推断握姿：避开底部 HdsTabs 栏，
          // 否则连点右侧「设置」页签也会被误判成右手；顶上这颗 ☰ 也不参与。
          const yRatio: number = this.rootHeight > 0 ? event.touches[0].y / this.rootHeight : 1;
          if (yRatio > 0.55 && yRatio < 0.86) {
            GripAwareness.noteRatio(event.touches[0].x / width);
          }
        })
      }
      .hideTitleBar(true)
      .mode(NavigationMode.Stack)
      .backgroundColor(Color.Transparent)
      .width('100%')
      .height('100%')

      // 横屏也使用 HdsTabs 自带的浮动栏；barFloatingStyle.adaptToHandedness
      // 会按触控焦点自动把整条栏移到左侧或右侧，不再需要自绘胶囊。

      // lg 宽屏项目页：左边缘热区必须放在 HdsTabs 之上，否则会被宽屏的
      // 横向切页手势吃掉。只在项目分区、侧栏未展开、编辑页未打开时挂载。
      if (this.dims.bp === Bp.LG && this.activeTab === 1 && !this.drawerOpen
        && !this.editorOpen) {
        Column()
          .width(28)
          .height('100%')
          .backgroundColor('#00000000')
          .gesture(
            PanGesture({ direction: PanDirection.Horizontal, distance: 8 })
              .onActionEnd((event: GestureEvent): void => {
                if (event.offsetX > 28) {
                  this.openDrawer('left');
                }
              })
          )
      }

      // 项目页抽屉放在最上层：要盖住标签栏、也盖住状态栏
      if (this.drawerOpen) {
        ProjectsDrawer({
          store: this.store,
          dims: this.dims,
          side: this.drawerSide,
          pinned: this.drawerPinned(),
          onOpenProject: (project: ProjectMeta): void => {
            this.openProject(project, false);
          },
          onClose: (): void => {
            if (this.drawerPinned()) {
              return;
            }
            this.closeDrawer();
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(HomeTokens.base)
    .bindContentCover(this.editorOpen, this.editorCover(), {
      modalTransition: ModalTransition.NONE,
      onWillDismiss: (): void => {
        // 侧滑/系统返回关闭时，在 animateTo 里翻转状态，共享元素才会缩回卡片。
        this.closeEditor();
      }
    })
  }
}
