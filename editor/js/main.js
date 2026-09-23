/** 主逻辑: 状态管理 + 视频/字幕加载 + 各模块联动 */
import { fmtTime, parseTime } from './util.js';
import { parseSRT, serializeSRT, splitBilingual, srtPlainText } from './srt.js';
import { AssDoc, assPlainText } from './ass.js';
import { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs, buildCleanAss, sameTime, sentenceFromEvent } from './karaoke.js';
import { SrtOverlay } from './overlay.js';
import { AssPlayer } from './assplayer.js';
import { Timeline } from './timeline.js';
import { EditorPanel } from './editor.js';
import { shortcuts, comboFromEvent } from './shortcuts.js';

/* ─────────── DOM ─────────── */
const video = document.getElementById('video');
const stage = document.getElementById('video-stage');
const stageHint = document.getElementById('stage-hint');
const statusFile = document.getElementById('status-file');
const btnExport = document.getElementById('btn-export');
const tlCursor = document.getElementById('tl-cursor-time');
const tlDuration = document.getElementById('tl-duration');
const rngFont = document.getElementById('rng-font');
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
  newRows: new Set(),    // 新建但还没输入内容的行(用户不输入就离开 → 撤销)
  extraRoles: [],        // 用户手动添加、还没用到任何字幕上的角色 [{name, color}]
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

/* ─────────── 可拖动分割线: 视频/时间轴(横) 与 左区/字幕列表(竖) ─────────── */
function bindSplit(el, onMove) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const app = document.getElementById('app');
    const cs = getComputedStyle(app);
    const startTl = parseFloat(cs.getPropertyValue('--tl-h')) || 232;
    const startPw = parseFloat(cs.getPropertyValue('--panel-w')) || 400;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev) => onMove(app, ev.clientY - y0, ev.clientX - x0, startTl, startPw);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      overlay.fitToVideo();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
bindSplit(document.getElementById('hsplit'), (app, dy, dx, startTl) => {
  setTlHeight(startTl - dy, true);    // 拖动即记住, 下次打开保持这个比例
});
bindSplit(document.getElementById('vsplit'), (app, dy, dx, startTl, startPw) => {
  const w = Math.round(Math.max(280, Math.min(720, startPw - dx)));
  app.style.setProperty('--panel-w', w + 'px');
  overlay.fitToVideo();
});

/* ─────────── 波形图(ffmpeg 服务端提取; 视频不在服务端保存) ───────────
 * 本机 ffmpeg 对管道不流式输出进度, 进度提示用客户端计时: "波形生成中… 已用 Ns" */
let waveToastTimer = null;
function startWaveToast() {
  const t0 = performance.now();
  clearInterval(waveToastTimer);
  waveToastTimer = setInterval(() => {
    toast('波形生成中… 已用 ' + Math.round((performance.now() - t0) / 1000) + 's（视频越长耗时越久）', 120000);
  }, 500);
  toast('波形生成中… 已用 0s', 120000);
  return () => clearInterval(waveToastTimer);
}
/** 等视频元数据就绪拿到时长(波形分辨率按时长自适应, 必须在拿到 duration 后请求) */
function waitDuration(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (isFinite(video.duration) && video.duration > 0) return resolve(video.duration);
      if (performance.now() - t0 > timeoutMs) return resolve(0);
      setTimeout(tick, 120);
    };
    tick();
  });
}

async function loadWaveformFromServer() {
  timeline.setPeaks(null);
  timeline.setWaveform(null);
  const stop = startWaveToast();
  const dur = await waitDuration();
  try {
    const name = decodeURIComponent(state.videoUrl.split('/').pop() || '');
    // 首选峰值数据(矢量绘制, 任意缩放都锐利)
    const rp = await fetch('/api/peaks?name=' + encodeURIComponent(name) + '&dur=' + dur + '&rate=100');
    if (rp.ok) {
      const data = new Uint8Array(await rp.arrayBuffer());
      timeline.setPeaks({ data, rate: parseFloat(rp.headers.get('X-Peak-Rate') || '100') });
      toast('波形已就绪', 2000);
      clearInterval(waveToastTimer); stop();
      return;
    }
    throw new Error('peaks HTTP ' + rp.status);
  } catch {
    // 兜底: 整段波形 PNG
    try {
      const name = decodeURIComponent(state.videoUrl.split('/').pop() || '');
      const resp = await fetch('/api/waveform?name=' + encodeURIComponent(name) + '&dur=' + dur);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      timeline.setWaveform(URL.createObjectURL(await resp.blob()));
      toast('波形图已生成', 2000);
    } catch { toast('波形生成失败'); }
  }
  clearInterval(waveToastTimer);
  stop();
}
async function uploadWaveform(file) {
  timeline.setPeaks(null);
  timeline.setWaveform(null);
  const stop = startWaveToast();
  const dur = await waitDuration();
  try {
    // 首选峰值数据: 视频流式上传到服务端临时文件, 生成后立即删除(不保存)
    const rp = await fetch('/api/peaks-upload?dur=' + dur + '&rate=100', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    });
    if (!rp.ok) throw new Error('peaks HTTP ' + rp.status);
    const data = new Uint8Array(await rp.arrayBuffer());
    timeline.setPeaks({ data, rate: parseFloat(rp.headers.get('X-Peak-Rate') || '100') });
    toast('波形已就绪', 2000);
    clearInterval(waveToastTimer); stop();
    return;
  } catch {
    try {
      const resp = await fetch('/api/waveform-upload?dur=' + dur, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      timeline.setWaveform(URL.createObjectURL(await resp.blob()));
      toast('波形图已生成', 2000);
    } catch { toast('波形生成失败'); }
  }
  clearInterval(waveToastTimer);
  stop();
}

/* ═══════════ 视频加载 ═══════════ */
function loadVideoUrl(url, name) {
  video.src = url;
  state.videoUrl = url;
  state.videoLoaded = true;
  timeline.setVideo(video);
  stageHint.classList.add('hidden');
  toast('视频加载中: ' + name);
  // 服务端直读磁盘原文件提取波形(示例视频是站内相对路径), 不产生任何视频副本
  if (url && !/^blob:/i.test(url)) loadWaveformFromServer();
}

function loadVideoFile(file) {
  loadVideoUrl(URL.createObjectURL(file), file.name);
  // 本地文件: 流式上传到服务端临时文件提取波形, 用完立即删除(服务端不保存视频)
  uploadWaveform(file);
}

video.addEventListener('loadedmetadata', () => {
  timeline.setDuration(video.duration);   // 内部会按"默认 30s 跨度"摆好视图
  timeline.setVideo(video);               // 确保胶片缩略图取到新的 currentSrc
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
  panel.setFileName(name);
  panel.setRolesEnabled(false);   // SRT 没有角色(说话人)概念 → 禁用角色 Tab 与角色筛选
  panel.setModeOptions([
    { v: 'bi', t: '双语双行' },
    { v: 'first', t: '仅主语言' },
    { v: 'second', t: '仅副语言' }
  ], 'bi');
  timeline.resetView();          // 新文件 → 时间轴回到"默认 30s 跨度"
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
  panel.setFileName(name);
  panel.setRolesEnabled(true);    // ASS 有角色(说话人) → 恢复角色 Tab 与角色筛选
  panel.setModeOptions([
    { v: 'bi', t: '中英双行' },
    { v: 'first', t: '仅中文' },
    { v: 'second', t: '仅英文' }
  ], 'bi');
  timeline.resetView();          // 新文件 → 时间轴回到"默认 30s 跨度"
  rebuildItemsAndLanes(true);
  assPlayer.load(state.assDoc.serialize());
  btnExport.disabled = false;
  const hasKar = !!state.kar.wordStyle;
  btnExportClean.disabled = !hasKar;
  btnExportJson.disabled = !hasKar;
  statusFile.textContent = `${name} · ${state.kar.rows.length} 行 / ${state.kar.sentences.length} 句` + (hasKar ? '（逐词特效）' : '');
}

/* ─────────── 异常行 ─────────── */
/** 汇总一句的异常原因(供列表 ⚠ 标记的 tooltip) */
function badReasonOf(sent) {
  if (!sent) return '';
  const parts = [];
  if (sent.end <= sent.start) parts.push('句时长≤0');
  for (const ev of (sent.events || [])) {
    if (!ev.bad) continue;
    if (ev.bad.start) parts.push(`开始时间 "${ev.bad.start}" 无法解析`);
    if (ev.bad.end) parts.push(`结束时间 "${ev.bad.end}" 无法解析`);
    if (ev.bad.order) parts.push(`结束早于开始(${ev.bad.order})`);
  }
  return parts.slice(0, 3).join('; ');
}

/* ─────────── 坏行判定 ─────────── */
/**
 * 汇总坏行原因(供列表 ⚠ 筛选与 tooltip):
 *   · 字幕重叠 —— 与其它条目时间相交(两种格式都检测)
 *   · 仅 ASS: 时间异常(解析失败 / 结束早于开始) / 英文行含方括号 / 单中文行 / 单英文行
 *   · SRT 只检测重叠(用户要求: SRT 的坏行检测重叠就好)
 */
function markBadRows(items) {
  // 重叠: 按开始时间扫描, 用"当前最大结束时间"一次扫出所有相交对
  const overlap = new Set();
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || items[a].end - items[b].end);
  let curI = -1, curEnd = -Infinity;
  for (const i of order) {
    const it = items[i];
    if (curI !== -1 && it.start < curEnd - 1e-3) { overlap.add(i); overlap.add(curI); }
    if (curI === -1 || it.end > curEnd) { curI = i; curEnd = it.end; }
  }

  const isAss = state.format === 'ass';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const reasons = [];
    if (isAss) {
      if (it.badReason) reasons.push(it.badReason);
      if (/[[\]]/.test(it.l2 || '')) reasons.push('英文行含方括号');
      const hasL1 = !!it.l1, hasL2 = !!it.l2;
      if (hasL1 && !hasL2) reasons.push('单中文行(缺英文)');
      if (!hasL1 && hasL2) reasons.push('单英文行(缺中文)');
    }
    if (overlap.has(i)) reasons.push('字幕重叠');
    it.bad = reasons.length > 0;
    it.badReason = reasons.join('; ');
  }
}

/* ═══════════ 视图模型重建 ═══════════ */
/**
 * 重建视图模型.
 * rebuildItems=true 时重建条目对象(改时间/改文本/增删后调用);
 * keepView=true 时列表保持当前滚动位置, 否则回到顶部(载入新文件时用)。
 */
function rebuildItemsAndLanes(rebuildItems, keepView = false) {
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
          textRaw: c.lines.join('\n'),
          speaker: '',
          isNew: state.newRows.has(c),
          bad: !!c.bad,
          badReason: c.bad ? ('结束早于开始(' + c.bad.order + ')') : ''
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
          color: row.color || null,                 // 角色(说话人)色: 卡片文字/徽标/时间值都跟着它走
          speaker: row.speaker || '',               // 角色筛选用: 字幕 Name 栏的 [人物]
          isNew: state.newRows.has(row),            // 新建未输入 → 卡片显示占位, 空着离开则撤销
          textRaw: zhText + '\n' + enText,
          bad: !!((zhS && zhS.bad) || (enS && enS.bad)),
          badReason: [badReasonOf(zhS), badReasonOf(enS)].filter(Boolean).join(' / ')
        };
        state.itemByRef.set(row, it);
        return it;
      });
    } else {
      state.items = [];
    }
    markBadRows(state.items);      // 时间异常 + 重叠 + 英文含方括号 + 单语行
    panel.setItems(state.items, keepView);
    panel.setRoles(computeRoles()); // 角色 Tab: 解析所有说话人(字幕 Name 栏的 [人物]); computeRoles 见模块级定义
  }

  // 坏行计数 → 搜索框旁的 ⚠ 按钮
  panel.setBadCount(state.items.filter(i => i.bad).length);

  // 时间轴车道: 每个样式一条轨道(中文 / 英文各归其位); 块内带文本
  if (state.format === 'srt') {
    // SRT 与 ASS 同款块样式: 一条合并轨(高度撑满), 块内中间灰色分隔线切两半
    //   · 上半区 = 主语言(lines[0])
    //   · 下半区 = 副语言(其余行)
    // SRT 不做逐词(无 words → 块内只画"主语言 / 分隔线 / 副语言")
    const cues = state.srtCues.map(c => {
      const { main, subs } = splitBilingual(c.lines);
      return {
        start: c.start, end: c.end, ref: c, row: c,
        text2: (main || '').replace(/<[^>]+>/g, '').slice(0, 60),                 // 上半: 主语言
        text: subs.map(l => l.replace(/<[^>]+>/g, '')).join(' / ').slice(0, 60)   // 下半: 副语言
      };
    });
    // 兜底色用与 ASS 相同的中性石板灰(SRT 没有说话人颜色)
    timeline.setLanes([{ label: '双语字幕', merged: true, cues, color: '#5b6472' }]);
  } else if (state.format === 'ass' && state.kar) {
    // 所有 ASS 字幕都画在**同一条轨**上(不再为中/英单行另开轨道):
    //   · 中英「同开始同结束」→ 整轨一个块(块内英文在上、中文在下, 中间无空隙)
    //   · 只有中文的孤行     → 画在该轨的**上半区**
    //   · 只有英文的孤行     → 画在该轨的**下半区**
    // 这样沿用「中文在上、英文在下」的位置感, 又不会多出一条空荡荡的轨道。
    // 块的背景用说话人颜色(半透明), 颜色取自 ASS 里该行 {\c&H......&} 的覆盖色。
    const cues = [];
    let zhStyle = '', enStyle = state.kar.wordStyle || '';
    let hasFull = false, hasTop = false;
    for (const row of state.kar.rows) {
      const zh = row.zh, en = row.en;
      if (zh) zhStyle = zh.style;
      const zhText = zh ? (zh.words.length ? zh.text : assPlainText(zh.events[0].text)) : '';
      const enText = en ? (en.words.length ? en.text : assPlainText(en.events[0].text)) : '';
      const color = row.color || null;
      if (zh && en && sameTime(zh, en)) {
        hasFull = true;
        cues.push({
          start: row.start, end: row.end, ref: row, row,
          text: (enText || '').slice(0, 60), text2: (zhText || '').slice(0, 60),
          words: (en && en.words && en.words.length) ? en.words : null,   // 词级时间: 时间轴块内逐词平铺
          color, speaker: row.speaker || ''
        });
      } else {
        if (zh) { hasTop = true; cues.push({ start: zh.start, end: zh.end, ref: row, row, text: zhText.slice(0, 60), color, half: 'top' }); }
        if (en) cues.push({
          start: en.start, end: en.end, ref: row, row,
          text: enText.slice(0, 60), color: en.color || color, half: 'bottom',
          words: (en.words && en.words.length) ? en.words : null
        });
      }
    }
    // 命中测试/绘制都依赖按开始时间有序
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    if (cues.length) {
      // 纯单行文件里"中英双语"这个名字会不对, 按实际内容取标签
      const label = hasFull ? '中英双语' : (hasTop ? (zhStyle || '中文字幕') : (enStyle || 'Default'));
      // 兜底色用中性石板灰: 有说话人内联色时逐块覆盖, 没有时不至于被误读为某个说话人的颜色
      timeline.setLanes([{ label, merged: true, cues, color: '#5b6472' }]);
    } else {
      timeline.setLanes([]);
    }
  } else {
    timeline.setLanes([]);
  }

  // 恢复选中(重建后行序号可能变化); 'keep' = 仅在完全不可见时才滚, 保持阅读位置稳定
  if (keepRef && state.itemByRef.has(keepRef)) {
    state.selected = state.itemByRef.get(keepRef);
    panel.select(state.selected, 'keep');
    timeline.setSelected(keepRef);
  } else {
    state.selected = null;
  }
}

/* ═══════════ 角色(说话人) ═══════════ */
/** 取 Name 栏原始串里的人物名列表: '[Spoke]' → ['Spoke'], '[A][B]' → ['A','B'] */
function speakerNames(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const segs = s.match(/\[[^\]]+\]/g);
  return segs && segs.length ? segs.map(x => x.slice(1, -1).trim()).filter(Boolean) : [s];
}

function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** '#rrggbb' → ASS 的 'BBGGRR' */
function hexToAss(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const h = m[1].toUpperCase();
  return h[4] + h[5] + h[2] + h[3] + h[0] + h[1];
}

/**
 * 解析所有角色(说话人): 取每行字幕 Name 栏里的 [人物] 标记(如 [Spoke])。
 * 注意: 只解析 Name 栏, 不碰字幕文本 —— 英文行文本里若出现 [xxx] 会被 markBadRows 判为坏行。
 * 返回 [{name, raw, color, count}] 按出现次数降序。
 */
function computeRoles() {
  if (state.format !== 'ass' || !state.kar) return [];
  const map = new Map();
  for (const row of state.kar.rows) {
    const raw = (row.speaker || '').trim();
    if (!raw) continue;
    for (const name of speakerNames(raw)) {
      const key = name.toLowerCase();
      if (!map.has(key)) map.set(key, { name, raw, color: row.color || null, count: 0 });
      const e = map.get(key);
      e.count++;
      if (row.color && !e.color) e.color = row.color;
    }
  }
  // 合并用户手动添加的角色(还没用上时 count = 0, 也会出现在角色栏/筛选里)
  for (const ex of state.extraRoles) {
    const key = ex.name.toLowerCase();
    if (!map.has(key)) map.set(key, { name: ex.name, raw: '[' + ex.name + ']', color: ex.color || null, count: 0, custom: true });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 角色栏“＋ 添加角色”: 登记一个新角色, 之后单击它即可应用到播放头所在字幕 */
panel.onAddRole = () => {
  if (state.format !== 'ass' || !state.kar) { toast('角色仅支持 ASS 字幕'); return; }
  panel.showAddRoleDialog(({ name, color }) => {
    const exists = computeRoles().some(r => r.name.toLowerCase() === name.toLowerCase());
    if (exists) { toast(`角色「${name}」已存在，请换个名字`); return false; }   // false → 弹窗不关闭
    state.extraRoles.push({ name, color });
    panel.showTab('roles');
    rebuildItemsAndLanes(true, true);
    toast(`已添加角色「${name}」——单击它即可应用到播放头所在字幕`);
  });
};

/** 把事件文本行首可见的 [旧tag] 换成 tag(没有则补上); 不动 {\...} 覆盖标签 */
function setEventSpeakerTag(ev, tag) {
  const t = String(ev.text || '');
  const head = /^(?:\s*\{[^}]*\})*/.exec(t)[0];
  let rest = t.slice(head.length);
  const m = /^\s*\[[^\]]*\]/.exec(rest);
  rest = m ? tag + rest.slice(m[0].length) : tag + rest;
  state.assDoc.setEventText(ev, head + rest);
  return true;
}

/** 把某一行字幕的说话人改成 name(含标签/Name 栏/颜色), 不含重建与提示 —— 供单行与"角色合并"复用 */
function applyRoleToRow(hit, name) {
  const tag = '[' + name + ']';
  // 颜色即身份: 目标角色已有颜色时, 连该块行首色标一起换成目标角色的颜色
  const role = computeRoles().find(r => r.name.toLowerCase() === String(name).toLowerCase());
  const newAss = role && role.color ? hexToAss(role.color) : null;
  const hexNorm = role && role.color ? ('#' + String(role.color).replace(/^#/, '').toLowerCase()) : null;
  const leadRe = /^(\s*\{[^}]*?\\c&H)([0-9A-Fa-f]{6})(&)/;
  for (const s of [hit.zh, hit.en]) {
    if (!s) continue;
    if (s.proto) s.proto.name = name;     // 重建逐词切片时沿用新 Name
    s.speaker = tag;
    for (const ev of s.events) state.assDoc.setEventName(ev, name);
  }
  // 中文行文本行首的可见 [Spoke] 才是用户看到/导出的说话人标记, 必须一起换;
  // 颜色即身份: 行首没有内联色标时(会渲染成样式默认色)要**补上**目标角色的颜色
  if (hit.zh) {
    for (const ev of hit.zh.events) {
      setEventSpeakerTag(ev, tag);
      if (!newAss) continue;
      const t = ev.text || '';
      if (leadRe.test(t)) {
        state.assDoc.setEventText(ev, t.replace(leadRe, (all, a, b, c) => a + newAss + c));
      } else {
        // 行首没有 \c 色标 → 插到行首标签块之后(或最前面)
        const head = /^(?:\s*\{[^}]*\})*/.exec(t)[0];
        state.assDoc.setEventText(ev, head + '{\\c&H' + newAss + '&}' + t.slice(head.length));
      }
    }
    hit.zh.text = assPlainText(hit.zh.events[0].text);
    if (hexNorm) hit.zh.color = hexNorm;
  }
  if (hexNorm) hit.color = hexNorm;
  hit.speaker = tag;
}

/** 角色栏单击(单行): 改完重建 + 提示 */
function doAssignSpeaker(hit, name) {
  applyRoleToRow(hit, name);
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  toast(`已将 #${hit.no} 说话人改为 [${name}]`);
}

/** 角色合并: 把 fromName 名下所有台词(含颜色)改成 toName, 并删除原角色 */
function mergeRoleInto(fromName, toName) {
  const key = String(fromName).toLowerCase();
  let n = 0;
  for (const row of state.kar.rows) {
    const names = speakerNames(row.speaker).map(x => x.toLowerCase());
    if (!names.includes(key)) continue;
    applyRoleToRow(row, toName);
    n++;
  }
  state.extraRoles = state.extraRoles.filter(e => e.name.toLowerCase() !== key);
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  toast(`已将「${fromName}」的 ${n} 条台词继承到「${toName}」`);
}

/** 离开角色栏时: 用户添加但**从未分配过任何台词**的新角色判定作废并移除 */
function pruneUnusedRoles(onRolesTab) {
  if (onRolesTab || !state.extraRoles.length) return;
  const used = new Set();
  for (const row of state.kar.rows) for (const nm of speakerNames(row.speaker)) used.add(nm.toLowerCase());
  const dropped = state.extraRoles.filter(e => !used.has(e.name.toLowerCase())).length;
  // 用上的角色已由字幕内容派生(不再需要额外登记), 没用上的判定作废 —— 离开角色栏时一律清除
  state.extraRoles = [];
  panel.setRoles(computeRoles());
  if (dropped) toast(`已移除 ${dropped} 个未使用的新角色`);
}

/**
 * 角色栏单击: 把播放头所在的字幕块说话人改成 name。
 * 播放头同时落在**多条重叠字幕**上时(源文件常有重复行), 弹窗让用户选是哪一条。
 */
function assignSpeakerAtPlayhead(name) {
  const t = video.currentTime;
  const hits = state.kar.rows.filter(r => t >= r.start - 1e-3 && t <= r.end + 1e-3);
  if (!hits.length) { toast('播放头不在任何字幕块内——先用播放/单击定位到要改的那句, 再点角色'); return; }
  if (hits.length === 1) { doAssignSpeaker(hits[0], name); return; }
  hits.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  panel.showRowPicker('检测到多条重叠的台词，请选择要设置角色的行：', hits.map(r => ({
    label: (r.zh ? r.zh.text : (r.en ? r.en.text : '')) || '(空)',
    name: (r.speaker || '').replace(/[[\]]/g, ''),
    color: r.color || null,
    row: r
  })), (row) => doAssignSpeaker(row, name));
}

/** 事件文本行首可见 [old] → [new]; 返回是否变更 */
function swapEventSpeakerTag(ev, fromRe, newTag) {
  const t = String(ev.text || '');
  const head = /^(?:\s*\{[^}]*\})*/.exec(t)[0];
  const rest = t.slice(head.length);
  const m = /^\s*\[([^\]]*)\]/.exec(rest);
  if (!m || !fromRe.test(m[1])) return false;
  fromRe.lastIndex = 0;
  state.assDoc.setEventText(ev, head + newTag + rest.slice(m[0].length));
  return true;
}

/** 全局重命名: 文本行首可见 [old] 与 Name 栏([old] 或裸名) → 新名; 并同步句子/行缓存 */
function renameRoleGlobally(oldName, newName) {
  const re = new RegExp('^(?:' + escapeReg(oldName) + ')$', 'i');      // Name 栏裸名整字段匹配
  const tagRe = new RegExp('^(?:\\s*' + escapeReg(oldName) + '\\s*)$', 'i'); // [ ] 内的名字
  const sub = '[' + newName + ']';
  let n = 0;
  for (const ev of state.assDoc.events) {
    let changed = false;
    if (ev.name) {
      const nm = String(ev.name).trim();
      if (re.test(nm)) { state.assDoc.setEventName(ev, newName); changed = true; }
      else if (/^\[.+\]$/.test(nm) && tagRe.test(nm.slice(1, -1))) { state.assDoc.setEventName(ev, newName); changed = true; }
    }
    if (swapEventSpeakerTag(ev, tagRe, sub)) changed = true;
    if (changed) n++;
  }
  for (const s of state.kar.sentences) {
    if (s.proto && s.proto.name && re.test(String(s.proto.name).trim())) s.proto.name = newName;
    if (s.speaker) s.speaker = s.speaker.replace(new RegExp('\\[' + escapeReg(oldName) + '\\]', 'gi'), sub);
    if (!s.words || !s.words.length) {
      const t = assPlainText(s.events[0].text);
      if (t !== s.text) s.text = t;
    }
  }
  for (const r of state.kar.rows) if (r.speaker) r.speaker = r.speaker.replace(new RegExp('\\[' + escapeReg(oldName) + '\\]', 'gi'), sub);
  return n;
}

/** 全局换色: 行首 {\c&H......&} 为该角色旧色的所有事件 → 新色; 无旧色时给该角色中文行补上色标 */
function recolorRoleGlobally(role, newHex) {
  const hexNorm = '#' + String(newHex).replace(/^#/, '').toLowerCase();
  const newAss = hexToAss(newHex);
  if (!newAss) return 0;
  const leadRe = /^(\s*\{[^}]*?\\c&H)([0-9A-Fa-f]{6})(&)/;
  let n = 0;
  if (role.color) {
    const oldAss = hexToAss(role.color);
    for (const ev of state.assDoc.events) {
      const m = leadRe.exec(ev.text || '');
      if (!m || m[2].toUpperCase() !== oldAss) continue;
      state.assDoc.setEventText(ev, ev.text.replace(leadRe, (all, a, b, c) => a + newAss + c));
      n++;
    }
    for (const s of state.kar.sentences) {
      if (s.color && s.color.toLowerCase() === role.color.toLowerCase()) s.color = hexNorm;
    }
    for (const r of state.kar.rows) {
      if (r.color && r.color.toLowerCase() === role.color.toLowerCase()) r.color = hexNorm;
    }
  } else {
    // 角色还没有颜色标记 → 给该角色所有中文字幕行的行首补上新颜色标签
    const names = new Set(speakerNames(role.raw).map(x => x.toLowerCase()));
    names.add(role.name.toLowerCase());
    for (const row of state.kar.rows) {
      const spk = speakerNames(row.speaker).map(x => x.toLowerCase());
      if (!spk.some(x => names.has(x))) continue;
      const zh = row.zh;
      if (zh) {
        for (const ev of zh.events) {
          if (leadRe.test(ev.text || '')) continue;
          state.assDoc.setEventText(ev, '{\\c&H' + newAss + '&}' + (ev.text || ''));
        }
        zh.color = hexNorm;
      }
      row.color = hexNorm;
      n++;
    }
  }
  return n;
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

// 右列表: 单击仅选中(不再跳转); 双击非文字区域才跳转到该条开始时间
panel.onSelect = (item) => selectItem(item, false);
panel.onSeek = (item) => {
  selectItem(item, false);
  if (item) video.currentTime = item.start + 0.001;
};
timeline.onSelect = (ref, opts) => {
  const item = state.itemByRef.get(ref);
  if (item) selectItem(item, opts && opts.seek);
};
timeline.onSeek = (t) => { video.currentTime = t; };

// 角色卡片单击 → 把播放头所在字幕块的说话人标签(Name 栏)改成该角色
panel.onAssignRole = (name) => {
  if (state.format !== 'ass' || !state.kar) { toast('角色标记仅支持 ASS 字幕'); return; }
  assignSpeakerAtPlayhead(name);
};
// 角色卡片右键 → 全局重命名: 所有 Name 栏 [旧] → [新]
panel.onRenameRole = (oldName, newName) => {
  if (state.format !== 'ass' || !state.kar) return;
  // 目标名称已存在 → 先确认: 是 = 继承并合并(台词+颜色都改成目标角色), 否 = 取消本次改名
  const target = computeRoles().find(r =>
    r.name.toLowerCase() === String(newName).toLowerCase() &&
    r.name.toLowerCase() !== String(oldName).toLowerCase());
  if (target) {
    panel.showConfirm('目标角色已存在',
      `「${target.name}」已经存在（${target.count} 条）。是否把角色「${oldName}」的台词全部继承到「${target.name}」，并合并为一个角色？`,
      '是，继承并合并', '取消', () => mergeRoleInto(oldName, target.name));
    return;
  }
  const n = renameRoleGlobally(oldName, newName);
  for (const ex of state.extraRoles) {
    if (ex.name.toLowerCase() === String(oldName).toLowerCase()) ex.name = newName;
  }
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  toast(`已将 [${oldName}] 重命名为 [${newName}]（${n} 行）`);
};
// 角色卡片右键 → 全局换色: 行首 {\c&H...} 为旧色的所有行 → 新色
panel.onRecolorRole = (name, hex) => {
  if (state.format !== 'ass' || !state.kar) return;
  const role = computeRoles().find(r => r.name.toLowerCase() === String(name).toLowerCase());
  if (!role) return;
  const n = recolorRoleGlobally(role, hex);
  for (const ex of state.extraRoles) {
    if (ex.name.toLowerCase() === role.name.toLowerCase()) ex.color = hex;
  }
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  toast(`已将 [${role.name}] 颜色改为 ${hex}（${n} 行）`);
};

timeline.isEditable = () => true;

/** 去掉一行的逐词效果: 英文切片合并成一条干净整句, 时间对齐中文行(同 main.py 的 remove_karaoke) */
function deKaraokeRow(row) {
  const en = row.en;
  if (!en || !en.words || !en.words.length) return false;
  const zh = row.zh;
  const s = zh ? zh.start : en.start;
  const e = zh ? zh.end : en.end;
  const text = en.text;
  // 预留逐词时间轴: 先备份词级时间, 待该句不再与其它字幕重叠时(用户「拉回」)
  // 由 reconcileKaraoke 自动还原, 避免 Shift 重叠去逐词后无法撤销(防止误操作)。
  row._karaokeBackup = {
    words: en.words.map(w => ({ w: w.w, s: w.s, e: w.e })),
    text
  };
  en.words = [];
  en.start = s; en.end = e;
  en.events = state.assDoc.replaceEvents(en.events, [{
    layer: en.proto.layer, style: en.style, name: en.proto.name,
    effect: en.proto.effect, margins: en.proto.margins,
    start: s, end: e, text
  }]);
  row.start = Math.min(zh ? zh.start : Infinity, en.start);
  row.end = Math.max(zh ? zh.end : 0, en.end);
  return true;
}

/** 还原一句的逐词效果: 用重叠去逐词时预留的备份恢复词级时间轴, 重建逐词切片 */
function restoreKaraokeRow(row) {
  const en = row.en;
  const bk = row._karaokeBackup;
  if (!en || !bk || !bk.words.length) return false;
  // 把备份词级时间放回, 再按当前句时间加权重算(时间若变了按比例缩放);
  // 文本若被改过, recalcWords 会按词数变化加权重新分配。
  en.words = bk.words.map(w => ({ w: w.w, s: w.s, e: w.e }));
  en.words = recalcWords(en, en.text, en.start, en.end);
  en.events = state.assDoc.replaceEvents(en.events, buildWordSpecs(en));
  if (row.zh) {
    row.start = Math.min(row.zh.start, en.start);
    row.end = Math.max(row.zh.end, en.end);
  } else {
    row.start = en.start; row.end = en.end;
  }
  delete row._karaokeBackup;
  return true;
}

/** 当前正在互相重叠的字幕行集合(供 reconcileKaraoke 判断是否需要保留去逐词) */
function computeOverlapRows() {
  const rows = state.kar.rows;
  const set = new Set();
  const order = rows.map((r, i) => i)
    .sort((a, b) => rows[a].start - rows[b].start || rows[a].end - rows[b].end);
  let curI = -1, curEnd = -Infinity;
  for (const i of order) {
    const r = rows[i];
    if (curI !== -1 && r.start < curEnd - 1e-3) { set.add(r); set.add(rows[curI]); }
    if (curI === -1 || r.end > curEnd) { curI = i; curEnd = r.end; }
  }
  return set;
}

/** 协调逐词状态: 凡因重叠被去逐词、而现已不再与任何字幕重叠的行, 自动还原逐词效果。
 *  用不动点迭代, 这样「互叠的两句被一起拉离」时, 后还原的那句也能正确解除。 */
function reconcileKaraoke() {
  if (state.format !== 'ass' || !state.kar) return 0;
  let restored = 0, changed = true;
  while (changed) {
    changed = false;
    const overlap = computeOverlapRows();
    for (const row of state.kar.rows) {
      if (!row._karaokeBackup) continue;
      if (overlap.has(row)) continue;
      if (restoreKaraokeRow(row)) { restored++; changed = true; }
    }
  }
  if (restored) assPlayer.updateNow(state.assDoc.serialize());
  return restored;
}

/** 拖动英文逐词的开始标记: 该词的起点 + 前一个词的结束一起移动(两词共享边界)。
 *  严格夹取——不越过前后词、不超出字幕块范围; **按住 Shift 也不放宽**。
 *  结果写回 ASS 的逐词切片(视频区高亮与导出都跟着变)。 */
const WORD_MIN_GAP = 0.02;    // 每个词至少保留的时长(秒)
timeline.onWordRetime = (row, idx, t, done) => {
  const en = row && row.en;
  const words = en && en.words;
  if (!words || !words[idx]) return;
  const w = words[idx];
  const lo = idx > 0
    ? words[idx - 1].s + WORD_MIN_GAP                      // 不能压到前一个词的起点
    : Math.max(row.start, en.start);                       // 第一个词: 不超出字幕块
  const hiRaw = Math.min(
    w.e - WORD_MIN_GAP,                                    // 不能晚于自己的结束
    (idx + 1 < words.length) ? words[idx + 1].s - WORD_MIN_GAP : Infinity   // 不能压过下一个词的起点
  );
  const hi = Math.max(lo, hiRaw);
  const nt = Math.min(Math.max(t, lo), hi);
  if (idx > 0) words[idx - 1].e = nt;                      // 共享边界: 前一个词的结束跟着移动
  w.s = nt;
  en.events = state.assDoc.replaceEvents(en.events, buildWordSpecs(en));
  if (done) {
    assPlayer.updateNow(state.assDoc.serialize());
    rebuildItemsAndLanes(true, true);
  } else {
    assPlayer.update(state.assDoc.serialize());
  }
};

timeline.onRetime = (row, s, e, done, shift) => {
  const item = state.itemByRef.get(row);
  if (!item) return;
  item.start = s; item.end = e;
  if (state.format === 'srt') {
    row.start = s; row.end = e;
  } else {
    if (row.zh) { row.zh.start = s; row.zh.end = e; state.assDoc.setEventTime(row.zh.events[0], s, e); }
    if (row.en) {
      if (row.en.words.length) {
        row.en.words = recalcWords(row.en, row.en.text, s, e);
        row.en.events = state.assDoc.replaceEvents(row.en.events, buildWordSpecs(row.en));
      } else {
        for (const ev of row.en.events) state.assDoc.setEventTime(ev, s, e);
      }
      row.en.start = s; row.en.end = e;
    }
    row.start = s; row.end = e;
    if (row.zh || row.en) assPlayer.update(state.assDoc.serialize());
  }
  if (state.selected === item) panel.select(item, false);
  if (!done) return;

  // 按住 Shift 拖出的重叠 → 涉及的行一律去掉逐词(整句化), 避免两句话的高亮糊在一起。
  // 去逐词前已预留词级时间轴(见 deKaraokeRow); 该句被「拉回」不再与其它字幕重叠时,
  // 下方 reconcileKaraoke 会自动还原逐词效果, 防止误操作丢失特效。
  let msg = '';
  if (shift && state.format === 'ass' && state.kar) {
    let cleared = 0;
    for (const r of state.kar.rows) {
      if (r.end <= s + 1e-3 || e <= r.start + 1e-3) continue;
      if (deKaraokeRow(r)) cleared++;
    }
    if (cleared) {
      assPlayer.updateNow(state.assDoc.serialize());
      msg += `重叠: 移除 ${cleared} 句逐词`;
    }
  }
  // 还原因「不再重叠」而应恢复逐词的行
  const restored = reconcileKaraoke();
  if (restored) msg += (msg ? '；' : '') + `还原 ${restored} 句逐词`;
  if (msg) toast(msg);
  rebuildItemsAndLanes(true, true);
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

panel.onApply = ({ item: editItem, start, end, dur, text }) => {
  // 以"正在编辑的那一条"为准(编辑期间选中项可能已被点走), 回退到当前选中项
  const item = editItem || state.selected;
  if (!item) return;
  let s = parseTime(start);
  const eForm = parseTime(end);
  const d = parseFloat(dur);
  if (isNaN(s)) { toast('开始时间格式无效'); return; }
  // 结束时间以输入框为准; 若用户改了"时长"(与 end-start 不一致)则以时长为准
  let e = eForm;
  if (!isNaN(d) && !isNaN(eForm) && Math.abs(d - (eForm - s)) > 1e-3) e = s + d;
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
  state.newRows.delete(item.ref);     // 有内容了 → 不再是"待输入的新字幕"
  reconcileKaraoke();
  rebuildItemsAndLanes(true, true);
  toast('已应用 #' + item.no);
};

panel.onDeleteCard = (item) => deleteItem(item);   // 字幕列表右键删除(与时间轴右键同一套逻辑)
panel.onTabChange = (name) => pruneUnusedRoles(name === 'roles');   // 离开角色栏 → 清掉没用上的新角色

/** 删除一条字幕(列表删除按钮 / 时间轴右键菜单共用) */
function deleteItem(item, silent) {
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
  state.newRows.delete(item.ref);
  state.selected = null;
  rebuildItemsAndLanes(true, true);
  toast(silent ? '未输入内容，已撤销这条新字幕' : '已删除 #' + item.no);
}

/** 新建的字幕一个字都没写就离开 → 撤销(不留空字幕) */
panel.onEmptyNew = (item) => deleteItem(item, true);

timeline.onDelete = (ref) => deleteItem(state.itemByRef.get(ref));

/** 为某样式在文档末尾追加一条新事件, 返回与 analyzeKaraoke 同构的句子对象 */
function appendSentence(style, start, end, text) {
  const evs = state.assDoc.sorted.filter(e => e.style === style);
  const anchor = evs.length ? evs[evs.length - 1] : null;
  if (!anchor) return null;
  const ev = state.assDoc.insertAfterEvent(anchor);
  if (!ev) return null;
  state.assDoc.setEventTime(ev, start, end);
  state.assDoc.setEventText(ev, text);
  const sent = sentenceFromEvent(style, ev, state.assDoc.format, start, end, text);
  state.kar.sentences.push(sent);
  return sent;
}

/** 在指定区间新建一个字幕块(时间轴空白处拖动) */
function createRowAt(start, end) {
  if (state.format === 'srt') {
    const cue = { id: 0, start, end, lines: [''] };     // 空文本: 列表里显示占位, 输入后才算数
    state.newRows.add(cue);
    state.srtCues.push(cue);
    state.srtCues.sort((a, b) => a.start - b.start || a.end - b.end);
    state.srtCues.forEach((c, i) => c.id = i + 1);
    overlay.setCues(state.srtCues);
    rebuildItemsAndLanes(true, true);
    const ni = state.itemByRef.get(cue);
    if (ni) { selectItem(ni, false); panel.startEdit(ni, 1); }   // 直接进入编辑, 让用户马上写内容
    toast(`已新建字幕 ${fmtTime(start)} → ${fmtTime(end)}，请在列表里输入内容`);
    return;
  }
  if (state.format !== 'ass' || !state.kar) return;
  const zhStyle = (state.kar.sentences.find(s => s.style !== state.kar.wordStyle) || {}).style || '';
  const enStyle = state.kar.wordStyle || '';
  const zh = zhStyle ? appendSentence(zhStyle, start, end, '') : null;
  const en = enStyle ? appendSentence(enStyle, start, end, '') : null;
  if (!zh && !en) { toast('新建失败: 文档里没有可用的字幕样式'); return; }
  const newRow = { zh, en, start, end, no: 0, color: (zh && zh.color) || null, speaker: (zh && zh.speaker) || '' };
  state.newRows.add(newRow);          // 空文本: 输入后保留, 空着离开则撤销
  state.kar.rows.push(newRow);
  state.kar.rows.sort((a, b) => a.start - b.start || a.end - b.end);
  state.kar.sentences.sort((a, b) => a.start - b.start || a.end - b.end);
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  const ni = state.itemByRef.get(newRow);
  if (ni) { selectItem(ni, false); panel.startEdit(ni, 1); }   // 直接进入编辑, 让用户马上写内容
  toast(`已新建字幕块 ${fmtTime(start)} → ${fmtTime(end)}，请在列表里输入内容`);
}
timeline.onCreate = (s, e) => createRowAt(s, e);

// 「▶ 播放」按钮已移除: 点击右侧列表条目即定位播放并进入编辑
// 右下角「插入 / 删除」按钮已移除: 时间轴空白处拖动=新建, 右键块=删除, 不再重复提供。

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

const rngFontVal = document.getElementById('rng-font-val');
rngFont.addEventListener('input', () => {
  overlay.setFontScale(parseFloat(rngFont.value));
  if (rngFontVal) rngFontVal.textContent = parseFloat(rngFont.value).toFixed(2) + ' ×';
});

/* F8: 显隐设置里的「示例 / 导出干净ASS·JSON」区(默认隐藏, 避免工具栏杂乱) */
const f8Section = document.getElementById('f8-section');
if (f8Section) {
  f8Section.hidden = true;     // 默认隐藏
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F8') return;
    e.preventDefault();
    const show = f8Section.hidden;
    f8Section.hidden = !show;
    if (show) panel.showTab('settings');   // 切到设置, 让用户看到刚展开的区域
    toast(show ? '已显示：示例 / 导出干净 ASS·JSON（再按 F8 隐藏）' : '已隐藏示例与导出区');
  });
}

/* 时间轴头部的 跟随 / + / − / 适配 按钮已移除:
   跟随默认开启, 缩放与适配走滚轮(Ctrl+滚轮)与键盘 (= / - / 0), 界面上不再放按钮。 */

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
    toast('跟随播放: ' + (timeline.follow ? '开' : '关'));
  },
  prevCue: () => jumpCue(-1),
  nextCue: () => jumpCue(1),
  selectPlayCue: () => { if (panel.playingItem) selectItem(panel.playingItem, false); },
  applyEdit: () => panel.applyEdit(),
  focusSearch: () => document.getElementById('search-box').focus(),
  exportSub: () => btnExport.click()
};

/* 空格(播放/暂停)冷却: 按住重复触发或快速连击会导致状态乱跳 */
const actionCooldown = { playPause: 0 };
const PLAY_COOLDOWN_MS = 250;

function isTypingTarget(t) {
  const tag = (t && t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!(t && t.isContentEditable);
}
/* 空格只由本应用的 keydown 处理一次:
 * 聚焦 <video> 时浏览器原生空格播放/暂停在 keyup 生效, 会造成"按住=暂停, 松开=播放"的反向行为
 * —— 捕获阶段吞掉空格的默认动作与冒泡(keyup 连冒泡一起断), 播放/暂停只走下方 keydown 一条路 */
document.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.code === 'Space') && !isTypingTarget(e.target)) e.preventDefault();
}, true);
document.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.code === 'Space') && !isTypingTarget(e.target)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  const combo = comboFromEvent(e);
  if (!combo) return;
  const id = shortcuts.actionForCombo(combo);
  if (!id) return;
  if (typing) return;                             // 输入框/行内编辑内不抢键(Ctrl+Enter 由编辑框自行处理)
  e.preventDefault();
  if (id === 'playPause') {
    const now = performance.now();
    if (e.repeat || now - actionCooldown.playPause < PLAY_COOLDOWN_MS) return;
    actionCooldown.playPause = now;
  }
  const fn = actions[id];
  if (fn) fn();
});

/* ─────────── 设置 Tab: 界面显示 + 时间轴灵敏度 ─────────── */
const FILM_KEY = 'ss-film';
const PAN_KEY = 'ss-pan-sens', ZOOM_KEY = 'ss-zoom-sens';
const setFilm = document.getElementById('set-film');
const setFilmVal = document.getElementById('set-film-val');
const setPan = document.getElementById('set-pan');
const setZoom = document.getElementById('set-zoom');
const setPanVal = document.getElementById('set-pan-val');
const setZoomVal = document.getElementById('set-zoom-val');
function applySensitivity() {
  const pan = parseFloat(localStorage.getItem(PAN_KEY));
  const zoom = parseFloat(localStorage.getItem(ZOOM_KEY));
  timeline.panSensitivity = isFinite(pan) ? pan : 120;
  timeline.zoomSensitivity = isFinite(zoom) ? zoom : 1.25;
  if (setPan) { setPan.value = timeline.panSensitivity; setPanVal.textContent = Math.round(timeline.panSensitivity) + ' px'; }
  if (setZoom) { setZoom.value = timeline.zoomSensitivity; setZoomVal.textContent = timeline.zoomSensitivity.toFixed(2) + ' ×'; }
}
if (setPan) setPan.addEventListener('input', () => {
  timeline.panSensitivity = parseFloat(setPan.value) || 120;
  localStorage.setItem(PAN_KEY, String(timeline.panSensitivity));
  setPanVal.textContent = Math.round(timeline.panSensitivity) + ' px';
});
if (setZoom) setZoom.addEventListener('input', () => {
  timeline.zoomSensitivity = parseFloat(setZoom.value) || 1.25;
  localStorage.setItem(ZOOM_KEY, String(timeline.zoomSensitivity));
  setZoomVal.textContent = timeline.zoomSensitivity.toFixed(2) + ' ×';
});
function applyFilmSetting() {
  const on = localStorage.getItem(FILM_KEY) === '1';   // 胶片预览图默认关
  timeline.showFilm = on;
  if (setFilm) setFilm.checked = on;
  if (setFilmVal) setFilmVal.textContent = on ? '开' : '关';
}
if (setFilm) setFilm.addEventListener('change', () => {
  localStorage.setItem(FILM_KEY, setFilm.checked ? '1' : '0');
  applyFilmSetting();
});
/** 字幕块区域高度(时间轴占屏幕高度): 设置里可调, 也可拖视频/时间轴中间那根线; 记住用户的舒适值 */
const TLH_KEY = 'ss-tl-h';
const setTlh = document.getElementById('set-tlh');
const setTlhVal = document.getElementById('set-tlh-val');
function setTlHeight(px, save) {
  const app = document.getElementById('app');
  const h = Math.round(Math.max(96, Math.min(window.innerHeight - 260, px)));
  app.style.setProperty('--tl-h', h + 'px');
  if (setTlh) setTlh.value = h;
  if (setTlhVal) setTlhVal.textContent = h + ' px';
  if (save) localStorage.setItem(TLH_KEY, String(h));
  overlay.fitToVideo();
}
if (setTlh) setTlh.addEventListener('input', () => setTlHeight(parseFloat(setTlh.value) || 232, true));
function applyTlHeight() {
  const v = parseFloat(localStorage.getItem(TLH_KEY));
  const cur = parseFloat(getComputedStyle(document.getElementById('app')).getPropertyValue('--tl-h')) || 232;
  setTlHeight(isFinite(v) && v > 0 ? v : cur, false);
}
applySensitivity();
applyFilmSetting();
applyTlHeight();

/* 调试钩子(测试用) */
window.__dbg = { state, assPlayer, overlay, timeline, panel, video, selectItem, buildCleanAss };

/* ═══════════ 主循环 ═══════════ */
function tick() {
  const t = video.currentTime;
  overlay.update(t);
  timeline.draw(t, !video.paused);
  panel.setPlayingByTime(t);
  tlCursor.textContent = fmtTime(t);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ═══════════ 示例自动加载 ═══════════ */
(async function boot() {
  panel.setBadge('未加载');
  panel.setFileName('');
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
