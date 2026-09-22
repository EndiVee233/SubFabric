/** 主逻辑: 状态管理 + 视频/字幕加载 + 各模块联动 */
import { fmtTime, parseTime } from './util.js';
import { parseSRT, serializeSRT, splitBilingual, srtPlainText } from './srt.js';
import { AssDoc, assPlainText } from './ass.js';
import { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs, buildCleanAss } from './karaoke.js';
import { SrtOverlay } from './overlay.js';
import { AssPlayer } from './assplayer.js';
import { Timeline } from './timeline.js';
import { EditorPanel } from './editor.js';
import { shortcuts, comboFromEvent } from './shortcuts.js';
import { openShortcutDialog, closeShortcutDialog, handleCaptureKey } from './shortcutui.js';

/* ─────────── DOM ─────────── */
const video = document.getElementById('video');
const stage = document.getElementById('video-stage');
const stageHint = document.getElementById('stage-hint');
const statusFile = document.getElementById('status-file');
const btnExport = document.getElementById('btn-export');
const tlCursor = document.getElementById('tl-cursor-time');
const tlDuration = document.getElementById('tl-duration');
const selBiOrder = document.getElementById('sel-bi-order');
const rngFont = document.getElementById('rng-font');
const srtOptions = document.getElementById('srt-options');
const btnExportClean = document.getElementById('btn-export-clean');
const btnExportJson = document.getElementById('btn-export-json');

/* ─────────── 模块实例 ─────────── */
const overlay = new SrtOverlay(document.getElementById('srt-overlay'), video);
const assPlayer = new AssPlayer(video, (msg) => toast(msg));
const timeline = new Timeline(document.getElementById('timeline'), video);
const panel = new EditorPanel();

/* ─────────── 状态 ─────────── */
const state = {
  format: null,          // 'srt' | 'ass'
  fileName: '',
  srtCues: [],
  assDoc: null,
  items: [],             // 编辑面板视图模型
  itemByRef: new Map(),  // ref(cue|event) → item
  selected: null,
  videoLoaded: false
};

/* ─────────── Toast ─────────── */
let toastTimer = null;
function toast(msg, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;top:60px;transform:translateX(-50%);background:rgba(28,36,49,.95);border:1px solid var(--border);color:var(--text-0);padding:8px 18px;border-radius:10px;z-index:99;font-size:13px;pointer-events:none;transition:opacity .3s;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.style.opacity = '0', ms);
}

/* ═══════════ 视频加载 ═══════════ */
function loadVideoUrl(url, name) {
  video.src = url;
  state.videoLoaded = true;
  timeline.setVideo(video);
  stageHint.classList.add('hidden');
  toast('视频加载中: ' + name);
}

function loadVideoFile(file) {
  loadVideoUrl(URL.createObjectURL(file), file.name);
}

video.addEventListener('loadedmetadata', () => {
  timeline.setDuration(video.duration);
  timeline.setVideo(video);          // 确保胶片缩略图取到新的 currentSrc
  timeline.fit();
  overlay.fitToVideo();
  tlDuration.textContent = fmtTime(video.duration);
});
window.addEventListener('resize', () => overlay.fitToVideo());

/* ═══════════ 字幕加载 ═══════════ */
async function loadSubUrl(url, name) {
  const resp = await fetch(url);
  if (!resp.ok) { toast('字幕加载失败: ' + resp.status); return; }
  const text = await resp.text();
  routeSub(text, name);
}

function routeSub(text, name) {
  const isAss = /\.(ass|ssa)$/i.test(name) || /\[V4\+? Styles\]/i.test(text.slice(0, 2000));
  if (isAss) setAss(text, name);
  else setSrt(text, name);
}

/* ─────────── SRT ─────────── */
function setSrt(text, name) {
  assPlayer.dispose();
  state.format = 'srt';
  state.fileName = name;
  state.assDoc = null;
  state.kar = null;
  state.srtCues = parseSRT(text);

  overlay.setCues(state.srtCues);
  overlay.show();

  panel.setBadge('SRT 双语', 'srt');
  panel.setModeOptions([
    { v: 'bi', t: '双语双行' },
    { v: 'first', t: '仅主语言' },
    { v: 'second', t: '仅副语言' }
  ], 'bi');
  srtOptions.style.opacity = '1';
  rebuildItemsAndLanes(true);
  btnExport.disabled = false;
  btnExportClean.disabled = true;
  btnExportJson.disabled = true;
  statusFile.textContent = `${name} · ${state.srtCues.length} 条`;
  toast(`SRT 已加载: ${state.srtCues.length} 条(双语)`);
}

/* ─────────── ASS ─────────── */
function setAss(text, name) {
  overlay.hide();
  overlay.setCues([]);
  state.format = 'ass';
  state.fileName = name;
  state.srtCues = [];
  state.assDoc = new AssDoc(text);
  // 双轨分析: 干净整句(编辑/列表/时间轴) + 词级映射; 原始逐词文档保留给视频渲染
  state.kar = analyzeKaraoke(state.assDoc);
  // 跨语言配对: 中文整句 + 英文逐词句 → 一行(中英双行)
  state.kar.rows = pairRows(state.kar.sentences, state.kar.wordStyle);

  panel.setBadge('ASS 特效', 'ass');
  panel.setModeOptions([
    { v: 'bi', t: '中英双行' },
    { v: 'first', t: '仅中文' },
    { v: 'second', t: '仅英文' }
  ], 'bi');
  srtOptions.style.opacity = '.45';
  rebuildItemsAndLanes(true);
  assPlayer.load(state.assDoc.serialize());
  btnExport.disabled = false;
  const hasKar = !!state.kar.wordStyle;
  btnExportClean.disabled = !hasKar;
  btnExportJson.disabled = !hasKar;
  statusFile.textContent = `${name} · ${state.kar.rows.length} 行 / ${state.kar.sentences.length} 句` + (hasKar ? '（逐词特效）' : '');
}

/* ═══════════ 视图模型重建 ═══════════ */
function rebuildItemsAndLanes(rebuildItems) {
  const keepRef = state.selected ? state.selected.ref : null;

  if (rebuildItems) {
    state.itemByRef = new Map();
    if (state.format === 'srt') {
      state.items = state.srtCues.map((c, i) => {
        const { main, subs } = splitBilingual(c.lines);
        const it = {
          kind: 'srt', ref: c, no: i + 1,
          start: c.start, end: c.end,
          l1: main ? main.replace(/<[^>]+>/g, '') : '',
          l2: subs.map(l => l.replace(/<[^>]+>/g, '')).join(' / '),
          badge1: '主语言', badge2: subs.length ? '副语言' : '',
          textRaw: c.lines.join('\n')
        };
        state.itemByRef.set(c, it);
        return it;
      });
    } else if (state.format === 'ass' && state.kar) {
      // 双轨: 列表显示"中英双行"干净整句块, 视频区保持逐词特效
      state.kar.rows.sort((a, b) => a.start - b.start || a.end - b.end);
      state.kar.rows.forEach((r, i) => r.no = i + 1);
      state.items = state.kar.rows.map((row) => {
        const zhS = row.zh, enS = row.en;
        const zhText = zhS ? (zhS.words.length ? zhS.text : assPlainText(zhS.events[0].text)) : '';
        const enText = enS ? (enS.words.length ? enS.text : assPlainText(enS.events[0].text)) : '';
        const it = {
          kind: 'ass-row', ref: row, no: row.no,
          start: row.start, end: row.end,
          l1: zhText, l2: enText,
          badge1: zhS ? zhS.style : '', badge2: enS ? enS.style : '',
          textRaw: zhText + '\n' + enText
        };
        state.itemByRef.set(row, it);
        return it;
      });
    } else {
      state.items = [];
    }
    panel.setItems(state.items);
  }

  // 时间轴车道: 每个样式一条轨道(中文 / 英文各归其位); 块内带文本
  if (state.format === 'srt') {
    timeline.setLanes([{
      label: '双语字幕', bilingual: true,
      cues: state.srtCues.map(c => ({ start: c.start, end: c.end, ref: c, row: c, text: (c.lines[0] || '').replace(/<[^>]+>/g, '').slice(0, 40) }))
    }]);
  } else if (state.format === 'ass' && state.kar) {
    const rowOf = new Map();
    for (const row of state.kar.rows) {
      if (row.zh) rowOf.set(row.zh, row);
      if (row.en) rowOf.set(row.en, row);
    }
    const byStyle = new Map();
    for (const sent of state.kar.sentences) {
      if (!byStyle.has(sent.style)) byStyle.set(sent.style, []);
      byStyle.get(sent.style).push({
        start: sent.start, end: sent.end,
        ref: rowOf.get(sent) || null, row: rowOf.get(sent) || null,
        text: (sent.text || '').slice(0, 40)
      });
    }
    const lanes = [];
    for (const [style, cues] of byStyle) {
      cues.sort((a, b) => a.start - b.start);
      // 逐词样式(英文) → 紫; 整句样式(中文) → 橙, 与列表配色呼应
      lanes.push({ label: style, cues, color: style === state.kar.wordStyle ? '#8b7cf6' : '#ff7a45' });
    }
    timeline.setLanes(lanes);
  } else {
    timeline.setLanes([]);
  }

  // 恢复选中
  if (keepRef && state.itemByRef.has(keepRef)) {
    state.selected = state.itemByRef.get(keepRef);
    panel.select(state.selected, false);
    timeline.setSelected(keepRef);
  } else {
    state.selected = null;
  }
}

/* ═══════════ 选中 / 编辑 ═══════════ */
function selectItem(item, seek = true) {
  state.selected = item;
  panel.select(item);
  timeline.setSelected(item.ref);
  if (seek && item) {
    video.currentTime = item.start + 0.001;
  }
}

panel.onSelect = (item) => selectItem(item, true);
timeline.onSelect = (ref, opts) => {
  const item = state.itemByRef.get(ref);
  if (item) selectItem(item, opts && opts.seek);
};
timeline.onSeek = (t) => { video.currentTime = t; };

timeline.isEditable = () => true;
timeline.onRetime = (row, s, e, done) => {
  const item = state.itemByRef.get(row);
  if (!item) return;
  item.start = s; item.end = e;
  if (state.format === 'srt') {
    row.start = s; row.end = e;
  } else {
    if (row.zh) { row.zh.start = s; row.zh.end = e; state.assDoc.setEventTime(row.zh.events[0], s, e); }
    if (row.en) {
      row.en.words = recalcWords(row.en, row.en.text, s, e);
      row.en.start = s; row.en.end = e;
      row.en.events = state.assDoc.replaceEvents(row.en.events, buildWordSpecs(row.en));
    }
    row.start = s; row.end = e;
    if (row.zh || row.en) assPlayer.update(state.assDoc.serialize());
  }
  if (state.selected === item) panel.select(item, false);
  if (done) rebuildItemsAndLanes(true);
};

/** 整句样式(如中文字幕): 保留原颜色标签, 更新时间与文本 */
function applyAnchorSentence(sent, s, e, text) {
  const ev = sent.events[0];
  let newText = text;
  if (!/^\s*\{/.test(newText)) {
    const m = /^\s*(\{\\[^}]*\})/.exec(ev.text);   // 继承 {\c&H....&} 之类的前置标签
    if (m) newText = m[1] + newText;
  }
  newText = newText.replace(/\r\n?|\n/g, '\\N');
  state.assDoc.setEventTime(ev, s, e);
  state.assDoc.setEventText(ev, newText);
  sent.start = s; sent.end = e; sent.text = assPlainText(newText);
}

/** 逐词样式(如英文): 重算词级时间并重建切片 */
function applyWordSentence(sent, s, e, text) {
  sent.words = recalcWords(sent, text, s, e);   // 词数不变→保留原时间; 变化→加权重算
  sent.text = text;
  sent.start = s; sent.end = e;
  sent.events = state.assDoc.replaceEvents(sent.events, buildWordSpecs(sent));
}

/** 应用一行(中英双行)编辑: 中文整句 + 英文逐词句同步更新, 视频区立即重渲染 */
function applyAssRow(item, s, e, text) {
  const row = item.ref;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const zhText = (lines[0] || '').trim();
  const enText = lines.length > 1 ? lines.slice(1).join(' ').trim() : '';
  if (row.zh) applyAnchorSentence(row.zh, s, e, zhText || row.zh.text);
  if (row.en) applyWordSentence(row.en, s, e, enText || row.en.text);
  row.start = s; row.end = e;
  assPlayer.updateNow(state.assDoc.serialize()); // 视频区立即生效
}

panel.onApply = ({ start, end, dur, text }) => {
  const item = state.selected;
  if (!item) return;
  let s = parseTime(start);
  let e = parseTime(end);
  const d = parseFloat(dur);
  if (isNaN(s)) { toast('开始时间格式无效'); return; }
  if (isNaN(e) && !isNaN(d)) e = s + d;
  if (isNaN(e)) { toast('结束时间格式无效'); return; }
  if (e <= s) { toast('结束时间必须大于开始时间'); e = s + 0.05; }

  if (item.kind === 'srt') {
    const cue = item.ref;
    cue.start = s; cue.end = e;
    cue.lines = text.replace(/\r\n?/g, '\n').split('\n');
    state.srtCues.sort((a, b) => a.start - b.start || a.end - b.end);
    state.srtCues.forEach((c, i) => c.id = i + 1);
    overlay.setCues(state.srtCues);
  } else {
    applyAssRow(item, s, e, text);
  }
  rebuildItemsAndLanes(true);
  toast('已应用 #' + item.no);
};

panel.onDelete = () => {
  const item = state.selected;
  if (!item) return;
  if (item.kind === 'srt') {
    const i = state.srtCues.indexOf(item.ref);
    if (i !== -1) state.srtCues.splice(i, 1);
    state.srtCues.forEach((c, idx) => c.id = idx + 1);
    overlay.setCues(state.srtCues);
  } else {
    const row = item.ref;
    for (const sent of [row.zh, row.en]) {
      if (!sent) continue;
      state.assDoc.deleteEvents(sent.events);
      const i = state.kar.sentences.indexOf(sent);
      if (i !== -1) state.kar.sentences.splice(i, 1);
    }
    const ri = state.kar.rows.indexOf(row);
    if (ri !== -1) state.kar.rows.splice(ri, 1);
    assPlayer.updateNow(state.assDoc.serialize());
  }
  state.selected = null;
  rebuildItemsAndLanes(true);
  toast('已删除 #' + item.no);
};

panel.onInsert = () => {
  const item = state.selected;
  if (!item) { toast('请先选择一条字幕'); return; }
  if (item.kind === 'srt') {
    const cue = { id: 0, start: item.ref.end + 0.05, end: item.ref.end + 2.05, lines: ['新字幕'] };
    state.srtCues.push(cue);
    state.srtCues.sort((a, b) => a.start - b.start || a.end - b.end);
    state.srtCues.forEach((c, i) => c.id = i + 1);
    overlay.setCues(state.srtCues);
    rebuildItemsAndLanes(true);
    const ni = state.itemByRef.get(cue);
    if (ni) selectItem(ni, true);
    return;
  }
  // ASS: 为每个样式各插入一句(形成新的"中英双行")
  const row = item.ref;
  const start = Math.min(item.ref.end + 0.05, Math.max(0, (video.duration || 1e9) - 2.1));
  const end = start + 2;
  const styles = [];
  if (row.zh) styles.push({ style: row.zh.style, proto: row.zh.proto });
  if (row.en) styles.push({ style: row.en.style, proto: row.en.proto });
  if (!styles.length) { toast('插入失败'); return; }
  const newSents = [];
  for (const st of styles) {
    const evsOfStyle = state.assDoc.sorted.filter(e => e.style === st.style);
    const anchorEv = evsOfStyle.length ? evsOfStyle[evsOfStyle.length - 1] : null;
    if (!anchorEv) continue;
    const ev = state.assDoc.insertAfterEvent(anchorEv);
    if (!ev) continue;
    state.assDoc.setEventTime(ev, start, end);
    state.assDoc.setEventText(ev, '新字幕');
    newSents.push({
      style: st.style, start, end, text: '新字幕', events: [ev], words: [],
      proto: JSON.parse(JSON.stringify(st.proto)), highlightTag: '{\\c&H00FF00&}'
    });
  }
  if (!newSents.length) { toast('插入失败'); return; }
  newSents.forEach(s => state.kar.sentences.push(s));
  const zh = newSents.find(s => s.style !== state.kar.wordStyle) || null;
  const en = newSents.find(s => s.style === state.kar.wordStyle) || null;
  const newRow = { zh, en, start, end, no: 0 };
  state.kar.rows.push(newRow);
  state.kar.sentences.sort((a, b) => a.start - b.start || a.end - b.end);
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true);
  const ni = state.itemByRef.get(newRow);
  if (ni) selectItem(ni, true);
};

panel.onPlayCue = () => {
  const item = state.selected;
  if (!item) return;
  video.currentTime = item.start + 0.01;
  video.play();
};

/* ═══════════ 导出 ═══════════ */
function download(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

btnExport.addEventListener('click', () => {
  if (state.format === 'srt') {
    download(state.fileName.replace(/\.srt$/i, '') + '_edited.srt', serializeSRT(state.srtCues));
  } else if (state.format === 'ass' && state.assDoc) {
    download(state.fileName.replace(/\.(ass|ssa)$/i, '') + '_edited.ass', state.assDoc.serialize());
  }
});

/* 导出无逐词效果的干净 ASS */
btnExportClean.addEventListener('click', () => {
  if (state.format !== 'ass' || !state.kar) return;
  const clean = buildCleanAss(state.assDoc, state.kar.sentences);
  download(state.fileName.replace(/\.(ass|ssa)$/i, '') + '_clean.ass', clean);
  toast('已导出干净 ASS(无逐词特效)');
});

/* 导出词级时间轴 JSON 映射 */
btnExportJson.addEventListener('click', () => {
  if (state.format !== 'ass' || !state.kar) return;
  const r3 = v => Math.round(v * 1000) / 1000;
  const data = {
    generator: 'subtitle-editor',
    wordStyle: state.kar.wordStyle,
    sentences: state.kar.sentences
      .filter(sn => sn.words.length)
      .map(sn => ({
        style: sn.style,
        start: r3(sn.start), end: r3(sn.end),
        text: sn.text,
        words: sn.words.map(w => ({ w: w.w, s: r3(w.s), e: r3(w.e) }))
      }))
  };
  download(state.fileName.replace(/\.(ass|ssa)$/i, '') + '_words.json', JSON.stringify(data, null, 2));
  toast('已导出词级时间轴 JSON');
});

/* ═══════════ 工具栏 / 文件 / 拖放 ═══════════ */
document.getElementById('btn-open-video').addEventListener('click', () => document.getElementById('file-video').click());
document.getElementById('btn-open-sub').addEventListener('click', () => document.getElementById('file-sub').click());
document.getElementById('file-video').addEventListener('change', (e) => {
  if (e.target.files[0]) loadVideoFile(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('file-sub').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) routeSub(await f.text(), f.name);
  e.target.value = '';
});

stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  for (const f of e.dataTransfer.files) {
    if (/\.(srt|ass|ssa)$/i.test(f.name)) routeSub(await f.text(), f.name);
    else if (/\.(mp4|m4v|webm|mkv|avi|mov)$/i.test(f.name) || f.type.startsWith('video/')) loadVideoFile(f);
  }
});

selBiOrder.addEventListener('change', () => overlay.setOrder(selBiOrder.value));
rngFont.addEventListener('input', () => overlay.setFontScale(parseFloat(rngFont.value)));

/* 时间轴头部按钮 */
document.getElementById('btn-tl-zoom-in').addEventListener('click', () => timeline.zoomIn());
document.getElementById('btn-tl-zoom-out').addEventListener('click', () => timeline.zoomOut());
document.getElementById('btn-tl-fit').addEventListener('click', () => timeline.fit());
const btnFollow = document.getElementById('btn-tl-follow');
btnFollow.addEventListener('click', () => {
  timeline.follow = !timeline.follow;
  btnFollow.classList.toggle('active', timeline.follow);
});

/* ═══════════ 快捷键与鼠标操作 ═══════════ */
function seekBy(dt) {
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + dt));
}
function jumpCue(dir) {
  const arr = (panel.filtered && panel.filtered.length) ? panel.filtered : state.items;
  if (!arr.length) return;
  let idx = state.selected ? arr.indexOf(state.selected) : -1;
  if (idx === -1 && panel.playingItem) idx = arr.indexOf(panel.playingItem);
  const ni = idx + dir;
  if (ni < 0 || ni >= arr.length) return;
  selectItem(arr[ni], true);
}

const actions = {
  playPause: () => { video.paused ? video.play() : video.pause(); },
  seekBack2: () => seekBy(-2),
  seekFwd2: () => seekBy(2),
  seekBack5: () => seekBy(-5),
  seekFwd5: () => seekBy(5),
  stepBack: () => seekBy(-0.04),
  stepFwd: () => seekBy(0.04),
  gotoStart: () => { video.currentTime = 0; },
  gotoEnd: () => { video.currentTime = Math.max(0, (video.duration || 0) - 0.05); },
  zoomIn: () => timeline.zoomIn(),
  zoomOut: () => timeline.zoomOut(),
  fitAll: () => timeline.fit(),
  toggleFollow: () => {
    timeline.follow = !timeline.follow;
    btnFollow.classList.toggle('active', timeline.follow);
    toast('跟随播放: ' + (timeline.follow ? '开' : '关'));
  },
  prevCue: () => jumpCue(-1),
  nextCue: () => jumpCue(1),
  selectPlayCue: () => { if (panel.playingItem) selectItem(panel.playingItem, false); },
  applyEdit: () => panel.applyEdit(),
  insertCue: () => panel.onInsert && panel.onInsert(),
  deleteCue: () => panel.onDelete && panel.onDelete(),
  focusSearch: () => document.getElementById('search-box').focus(),
  exportSub: () => btnExport.click(),
  openShortcuts: () => openShortcutDialog()
};

// 录入模式优先(捕获阶段), 避免触发其它动作
document.addEventListener('keydown', (e) => {
  if (handleCaptureKey(e)) { e.preventDefault(); e.stopPropagation(); }
}, true);

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  const combo = comboFromEvent(e);
  if (!combo) return;
  const id = shortcuts.actionForCombo(combo);
  if (!id) return;
  if (typing && id !== 'openShortcuts') return;   // 输入框内不抢键(Ctrl+Enter 由 textarea 自行处理)
  e.preventDefault();
  const fn = actions[id];
  if (fn) fn();
});

document.getElementById('btn-shortcuts').addEventListener('click', openShortcutDialog);

/* 调试钩子(测试用) */
window.__dbg = { state, assPlayer, overlay, timeline, panel, video, selectItem, buildCleanAss, shortcuts };

/* ═══════════ 主循环 ═══════════ */
function tick() {
  const t = video.currentTime;
  overlay.update(t);
  timeline.draw(t);
  panel.setPlayingByTime(t);
  tlCursor.textContent = fmtTime(t);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ═══════════ 示例自动加载 ═══════════ */
(async function boot() {
  panel.setBadge('未加载');
  timeline.setDuration(0);
  let samples = null;
  try {
    const resp = await fetch('/api/samples');
    samples = await resp.json();
  } catch { return; }
  if (!samples) return;

  const firstVideo = samples.videos[0];
  const firstSrt = samples.subs.find(s => s.kind === 'srt');
  const firstAss = samples.subs.find(s => s.kind === 'ass' || s.kind === 'ssa');

  const btnV = document.getElementById('btn-sample-video');
  const btnS = document.getElementById('btn-sample-srt');
  const btnA = document.getElementById('btn-sample-ass');
  if (!firstVideo) btnV.disabled = true;
  if (!firstSrt) btnS.disabled = true;
  if (!firstAss) btnA.disabled = true;
  if (firstVideo) btnV.addEventListener('click', () => loadVideoUrl(firstVideo.url, firstVideo.name));
  if (firstSrt) btnS.addEventListener('click', () => loadSubUrl(firstSrt.url, firstSrt.name));
  if (firstAss) btnA.addEventListener('click', () => loadSubUrl(firstAss.url, firstAss.name));

  // 自动加载示例视频 + 示例 SRT, 开箱即用
  // 延迟到 window load 之后: 避免大视频流阻塞页面 load 事件
  const autoLoad = async () => {
    if (firstVideo) loadVideoUrl(firstVideo.url, firstVideo.name);
    if (firstSrt) await loadSubUrl(firstSrt.url, firstSrt.name);
  };
  if (document.readyState === 'complete') setTimeout(autoLoad, 100);
  else window.addEventListener('load', () => setTimeout(autoLoad, 100));
})();
