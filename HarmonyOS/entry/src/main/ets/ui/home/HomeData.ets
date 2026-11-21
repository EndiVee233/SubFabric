/*
 * 主页的数据形状。
 *
 * 组件只接收这两个类：HomeSummary 是「聚合数字」，QuickAction 是「一张快捷卡」。
 * 这样 QuickGrid 不需要认识 AppStore，页面把 store 拍平成 summary 就行。
 */

/** 一张快捷卡。 */
export class QuickAction {
  readonly key: string;
  readonly kicker: string;
  readonly title: string;
  readonly hint: string;
  readonly tone: string;

  constructor(key: string, kicker: string, title: string, hint: string, tone: string) {
    this.key = key;
    this.kicker = kicker;
    this.title = title;
    this.hint = hint;
    this.tone = tone;
  }
}

/** 主页顶部的聚合数字。 */
export class HomeSummary {
  projectCount: number = 0;
  editable: number = 0;
  attention: number = 0;
  busy: boolean = false;
  processingPct: number = 0;
  processingName: string = '还没有处理中的稿件';
  processingHint: string = '本机工作空间待命';
  deviceLabel: string = '端侧';

  /** 快捷卡列表：顺序即栅格顺序。 */
  actions(): QuickAction[] {
    return [
      new QuickAction('all', 'LIBRARY', `${this.projectCount}`, '全部稿件', 'plain'),
      new QuickAction('ready', 'READY', `${this.editable}`, '可编辑', 'plain'),
      new QuickAction('attention', 'TODO', `${this.attention}`, '需处理', this.attention > 0 ? 'danger' : 'plain'),
      new QuickAction('new', 'NEW', '新建稿件', '视频、链接或字幕', 'accent'),
      new QuickAction('batch', 'BATCH', '批量初稿', '多项目依次识别', 'accent'),
      new QuickAction('settings', 'SETTINGS', '全局设置', '模型、翻译与外观', 'plain'),
    ];
  }
}
