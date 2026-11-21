/*
 * 智感握姿。
 *
 * 先说明边界：API 26 的 SDK 提供了动作感知 `@ohos.multimodalAwareness.motion`
 * 的 `holdingHandChanged`（API 20+，需要 DETECT_GESTURE），但系统不保证每台设备
 * 都有对应硬件。这里优先订阅系统握姿；订阅失败（801/201）时退回触摸落点推断。
 *
 * 触摸推断规则固定两条：
 *   1. 触摸落点落在左 1/3 → 判左手，右 1/3 → 判右手，中间三分之一不动（那多半是双手）；
 *   2. 连续 2 次同向才切换，避免横滑一下就把整条栏翻到另一边。
 *
 * 系统握姿是**权威来源**：只要订阅成功，触摸推断就不再覆盖它；默认仍为左侧。
 * 结果只写 AppStorage 一个键，项目页边栏订阅它，决定从哪一侧打开；
 * 底部 HdsTabs 的左右跟手由 barFloatingStyle.adaptToHandedness 自己处理，
 * 不再读这个键，避免两套位置逻辑互相打架。
 *
 * 点左上角菜单、右边缘临时拉出边栏都不会改写这个默认侧。
 */

import { motion } from '@kit.MultimodalAwarenessKit';

export class GripAwareness {
  /** AppStorage 键：'left' / 'right'。 */
  static readonly SIDE: string = 'gripSide';

  private static candidate: string = '';
  private static streak: number = 1;
  private static sensorStarted: boolean = false;
  private static sensorActive: boolean = false;
  private static sensorCallback: ((status: motion.HoldingHandStatus) => void) | null = null;

  /** 首帧兜底：没值就写默认左侧。 */
  static ensure(): void {
    if (AppStorage.get<string>(GripAwareness.SIDE) === undefined) {
      AppStorage.setOrCreate<string>(GripAwareness.SIDE, 'left');
    }
  }

  /** 订阅系统握姿；不支持或权限被拒时安静退回触摸推断。 */
  static startSensor(): void {
    if (GripAwareness.sensorStarted) {
      return;
    }
    GripAwareness.sensorStarted = true;
    const cb = (status: motion.HoldingHandStatus): void => {
      if (status === motion.HoldingHandStatus.LEFT_HAND_HELD) {
        GripAwareness.applySide('left');
      } else if (status === motion.HoldingHandStatus.RIGHT_HAND_HELD) {
        GripAwareness.applySide('right');
      }
      // NOT_HELD / BOTH_HANDS_HELD / UNKNOWN_STATUS 不表态，保留当前默认侧。
    };
    try {
      motion.on('holdingHandChanged', cb);
      GripAwareness.sensorCallback = cb;
      GripAwareness.sensorActive = true;
    } catch (err) {
      // 801 能力不支持 / 201 权限被拒：保持 sensorActive=false，走触摸兜底。
      GripAwareness.sensorCallback = null;
      GripAwareness.sensorActive = false;
      GripAwareness.sensorStarted = false;
    }
  }

  /** 取消订阅，避免页面离场后仍持有回调。 */
  static stopSensor(): void {
    if (!GripAwareness.sensorStarted) {
      return;
    }
    try {
      if (GripAwareness.sensorCallback !== null) {
        motion.off('holdingHandChanged', GripAwareness.sensorCallback);
      }
    } catch (err) {
      // 退订失败不影响页面退出；下次启动会重新订阅。
    }
    GripAwareness.sensorCallback = null;
    GripAwareness.sensorActive = false;
    GripAwareness.sensorStarted = false;
  }

  /** 当前边；**默认左侧**，只有明确判到右手才返回 right。 */
  static side(): string {
    const v: string | undefined = AppStorage.get<string>(GripAwareness.SIDE);
    return v === 'right' ? 'right' : 'left';
  }

  private static applySide(side: string): void {
    if (GripAwareness.side() !== side) {
      AppStorage.setOrCreate<string>(GripAwareness.SIDE, side);
    }
    GripAwareness.candidate = side;
    GripAwareness.streak = 2;
  }

  /**
   * 喂一个触摸落点的横向比例（0..1）。
   *
   * 只在 **抬起（TouchType.Up）** 时调用：在 Down 里改 AppStorage 会触发一次重建，
   * 把这次 onClick 一起吞掉（这个坑真机踩过）。
   * 系统握姿订阅成功时直接忽略，避免触摸兜底覆盖真实手性。
   *
   * @param ratio 触摸点 x / 容器宽度
   */
  static noteRatio(ratio: number): void {
    if (GripAwareness.sensorActive) {
      return;
    }
    let want: string = '';
    if (ratio < 0.34) {
      want = 'left';
    } else if (ratio > 0.66) {
      want = 'right';
    } else {
      // 中间区域不表态，也不清空候选：单手拇指划到中间再回来不该重置
      return;
    }

    if (want === GripAwareness.candidate) {
      GripAwareness.streak++;
    } else {
      GripAwareness.candidate = want;
      GripAwareness.streak = 1;
    }

    if (GripAwareness.streak >= 2 && GripAwareness.side() !== want) {
      AppStorage.setOrCreate<string>(GripAwareness.SIDE, want);
    }
  }
}
