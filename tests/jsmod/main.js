/** 主逻辑: 状态管理 + 视频/字幕加载 + 各模块联动 */
import { fmtTime, parseTime, escapeHtml } from './util.js';
import { parseSRT, serializeSRT, splitBilingual } from './srt.js';
import { AssDoc, assPlainText, isAssSubtitle } from './ass.js';
import { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs, buildCleanAss, sameTime, sentenceFromEvent, assColorToHex, speakerColorOf, speakerTagOf, speakerTextTagOf, HIGHLIGHT_COLORS, replaceWordHighlightColor, normalizeRoleGap, splitEnglishWords, eligibleForWordConversion, mergeRowParts, setSpeakerTagInText, UNASSIGNED_ROLE, isUnassignedRole, stripSpeakerTag, ghostZhRows,
  // ── 上游 2.1.13 新增的导出（角色换色串色修复 / 中文标点归一 / 中文行预览 / 角色排序）──
  // 这些纯函数放在 karaoke.js 里以便单测；main.js 必须**显式导入**，
  // 否则下面的调用会在运行时 ReferenceError（fork 一直没导入 → 上游改动无从生效）。
  speakerNames, sortRoles, normalizeZhPunctuation, normalizeZhPunctuationInSentences,
  buildAnchorText, recolorRoleInRows, setWordHighlightColor } from './karaoke.js';
import { SrtOverlay } from './overlay.js';
// 分段导入（多人协作）：把一段字幕并进已有稿件的**纯逻辑**判定（有 tests/region-merge-test.mjs）
import { planRegionMerge, rowLabel, mergeSummary, resolveFillOnly, resolveReplace } from '../region-merge.js';
import { parseRegionTime } from '../region.js';
// 逐词字幕修复：把"被清空/错位"的逐词文本搬回来（有 tests/repair-words-test.mjs）。
// 用户实测过这种损坏：逐词行变空、文本连高亮标签一起跑到了同时间戳的另一行上。
import { analyzeDamage, planRepair as planWordRepair, repairSummary } from '../repair-words.js';
// 分段导入的 ASS 解析：**必须把逐词行按"句"聚合**。
// 逐词 ASS 里一句英文是"每词一条 Dialogue"，一条当一行会把它拆成上千行
// （用户实测：226 句的稿件被读成「区间内 43 行」、逐词高亮全丢）。
import { groupAssRows } from '../ass-group.js';
import { AssPlayer } from './assplayer.js';
import { loadPostProcessConfig, savePostProcessConfig, applyPostProcess, stripEffectTagsSafe } from './postprocess.js';
import { Timeline } from './timeline.js';
import { EditorPanel } from './editor.js';
import { shortcuts, comboFromEvent } from './shortcuts.js';
import { initProjects } from './project.js';
import { initI18n, t } from './i18n.js';
import { ico } from './icons.js';
import { pickDanmaku, danmakuDuration, DUR_DEFAULT } from '../danmaku.js';
import { bindModalDrags } from './modal.js';
import { enhanceFontInput } from './font-picker.js';

/* ─────────── DOM ─────────── */
const video = document.getElementById('video');
const stage = document.getElementById('video-stage');
const stageHint = document.getElementById('stage-hint');
const statusFile = document.getElementById('status-file');
const btnExport = document.getElementById('btn-export');
const btnExportPack = document.getElementById('btn-export-pack');
const btnRegionImport = document.getElementById('btn-region-import');
const tlCursor = document.getElementById('tl-cursor-time');
const tlDuration = document.getElementById('tl-duration');
const rngFont = document.getElementById('rng-font');
const btnExportClean = document.getElementById('btn-export-clean');
const btnExportJson = document.getElementById('btn-export-json');
const btnExportZh = document.getElementById('btn-export-zh');
const btnExportEn = document.getElementById('btn-export-en');
const btnExportFull = document.getElementById('btn-export-full');
const btnFix = document.getElementById('btn-fix-subs');
const wordConvertStyle = document.getElementById('word-convert-style');
const wordConvertScope = document.getElementById('word-convert-scope');
const btnConvertWords = document.getElementById('btn-convert-words');
const wordConvertLoading = document.getElementById('word-convert-loading');
const wordConvertHint = document.getElementById('word-convert-hint');
const assStyleEls = {
  group: document.getElementById('ass-style-group'),
  status: document.getElementById('ass-style-status'),
  zhName: document.getElementById('ass-style-zh-name'),
  enName: document.getElementById('ass-style-en-name'),
  zhFont: document.getElementById('ass-style-zh-font'),
  enFont: document.getElementById('ass-style-en-font'),
  zhSize: document.getElementById('ass-style-zh-size'),
  enSize: document.getElementById('ass-style-en-size'),
  zhBold: document.getElementById('ass-style-zh-bold'),
  enBold: document.getElementById('ass-style-en-bold'),
  zhItalic: document.getElementById('ass-style-zh-italic'),
  enItalic: document.getElementById('ass-style-en-italic'),
  wordColor: document.getElementById('ass-style-word-color'),
  wordColorVal: document.getElementById('ass-style-word-color-val'),
  zhColor: document.getElementById('ass-style-zh-color'),
  zhColorVal: document.getElementById('ass-style-zh-color-val'),
  zhColor2: document.getElementById('ass-style-zh-color2'),
  zhColor2Val: document.getElementById('ass-style-zh-color2-val'),
  enColor: document.getElementById('ass-style-en-color'),
  enColorVal: document.getElementById('ass-style-en-color-val'),
  enColor2: document.getElementById('ass-style-en-color2'),
  enColor2Val: document.getElementById('ass-style-en-color2-val'),
  zhFontNote: document.getElementById('ass-style-zh-font-note'),
  enFontNote: document.getElementById('ass-style-en-font-note'),
  zhFontFile: document.getElementById('ass-style-zh-font-file'),
  enFontFile: document.getElementById('ass-style-en-font-file')
};

/* 双击视频默认会触发浏览器的原生全屏, 编辑字幕时很容易误触。这里禁掉：
 * ① controlsList 加 nofullscreen(控制条上不再有全屏按钮)
 * ② dblclick 阻止默认行为并记一个时间窗
 * ③ 兜底：万一浏览器还是进了全屏(不同版本对 preventDefault 的处理不一样), 立刻退出 */
let suppressVideoFsUntil = 0;
try {
  if (video.controlsList && typeof video.controlsList.add === 'function') video.controlsList.add('nofullscreen');
  else if ('controlsList' in video) video.setAttribute('controlslist', 'nofullscreen');
} catch {}
video.addEventListener('dblclick', (e) => {
  e.preventDefault();
  e.stopPropagation();
  suppressVideoFsUntil = Date.now() + 600;
  if (videoClickTimer) { clearTimeout(videoClickTimer); videoClickTimer = 0; }   // 双击: 取消单击的播放切换
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}, true);
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement && Date.now() < suppressVideoFsUntil) {
    document.exitFullscreen().catch(() => {});
  }
});

/* 点击视频区 = 播放/暂停（禁全屏不能把单击播放也禁掉）。
 * 双击已不再触发全屏，所以单击要等 ~240ms 排除双击，否则双击会连切两次等于没切。
 * 底部控制条区域交给原生控件，这里不拦。 */
let videoClickTimer = 0;
video.addEventListener('click', (e) => {
  if (!video.currentSrc) return;
  const r = video.getBoundingClientRect();
  if (r.bottom - e.clientY < 72) return;                       // 底部控制条: 原生控件自己处理
  if (videoClickTimer) { clearTimeout(videoClickTimer); videoClickTimer = 0; return; }
  videoClickTimer = setTimeout(() => {
    videoClickTimer = 0;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, 240);
});

/* ─────────── 模块实例 ─────────── */
const overlay = new SrtOverlay(document.getElementById('srt-overlay'), video);
const assPlayer = new AssPlayer(video, (msg) => {
  toast(msg);
  if (msg === 'ASS 渲染就绪' && state.format === 'ass' && assStyleEls.status) {
    assStyleEls.status.textContent = pendingFontNotice
      ? `ASS 预览已就绪；${pendingFontNotice}。`
      : 'ASS 预览已就绪，当前稿件样式已同步。';
    pendingFontNotice = '';
  }
});
/* 预览通道：带上编辑器已解析好的中英样式名（比纯样式名推断更准 —— 它会结合逐词分析） */
assPlayer.postProcessor = (text) => applyPostProcess(text, state.postProcessConfig, state.assStyleTargets);
const timeline = new Timeline(document.getElementById('timeline'), video);
const panel = new EditorPanel();
bindModalDrags();
/* 诊断用(见 initDiag): 暴露实例供页面状态快照读取 */
window.__timeline = timeline;
window.__panel = panel;

/* ─────────── 状态 ─────────── */
const state = {
  format: null,          // 'srt' | 'ass'
  fileName: '',
  srtCues: [],
  assDoc: null,
  assStyleTargets: null,
  postProcessConfig: loadPostProcessConfig(),
  items: [],             // 编辑面板视图模型
  itemByRef: new Map(),  // ref(cue|event) → item
  newRows: new Set(),    // 新建但还没输入内容的行(用户不输入就离开 → 撤销)
  extraRoles: [],        // 用户手动添加、还没用到任何字幕上的角色 [{name, color}]
  trackMode: 'single',   // 字幕轨模式: 'single'=单行轨(所有块挤一条) | 'double'=双行轨(重叠块自动分到第 2 条)
  selected: null,
  videoLoaded: false,
  project: null          // 项目模式: { id, meta, loadPeaks } (project.js 维护; null=未用项目管理)
};

/** 调试出口：URL 里带 debug（如 #/project/xxx?debug）时把 state 挂到 window。
 *  为什么留着：自动化测试（CDP）读不到模块内的 state，就只能靠 DOM 文字反推 ——
 *  而"列表里明明有字、程序却读成空"这类问题，光看 DOM 是查不出来的（本次就踩了）。
 *  带条件判断，平时不影响行为，也不会被误用。 */
if (/[#?&/]debug\b/.test(location.href || '')) window.__state = state;

// 行内编辑的临时轨道只存在内存中；ASS 文档及导出始终是最后一次提交的数据。
let editPreview = null;
let previewTrack = null;
let previewFrame = 0;
const pendingPlaybackRows = new Set(); // 非播放句已提交，但视频轨等待播放到该句才同步
const EDIT_SETTLE_MS = 260;

/* ─────────── Toast ───────────
 * 分四级(成功/警告/失败/信息)：按文案里的关键词自动判级, 所以 100+ 个调用点不用改；
 * 想强制某级就把第 2 参传成 'ok'|'warn'|'err'|'info'。图标 + 左侧色条见 ui.css 的 #toast。 */
let toastTimer = null;
function toast(msg, ms = 2600, forceKind) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';                 // 定位/动画/分级样式都在 style.css + ui.css 的 #toast 里
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  const text = t(msg);                    // 显示出口统一翻译(含服务端返回的中文消息)
  const kind = forceKind
    || (/^(✗|×)/.test(text) ? 'err'
      : /^(⚠)/.test(text) ? 'warn'
        : /^(✓|✅)/.test(text) ? 'ok'
          : /失败|错误|无法|不存在|未配置|超时/.test(text) ? 'err'
            : /警告|为空|注意|重试|跳过/.test(text) ? 'warn'
              : /完成|成功|已就绪|已保存|已删除|已恢复|已放回/.test(text) ? 'ok'
                : 'info');
  const icon = kind === 'err' ? 'xCircle' : kind === 'warn' ? 'alert' : kind === 'ok' ? 'checkCircle' : 'info';
  el.classList.remove('toast-ok', 'toast-warn', 'toast-err', 'toast-info');
  el.classList.add('toast-' + kind);
  el.innerHTML = ico(icon) + '<span></span>';   // 图标与文案分成两个节点: 文案仍可被词典整体替换
  el.lastElementChild.textContent = text;
  el.classList.remove('toast-out');
  el.classList.add('toast-in');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('toast-in');
    el.classList.add('toast-out');            // 动画结束后不用手动隐藏: 停在最后一帧(opacity 0)
  }, ms);
}

/* ─────────── 图标注入 ───────────
 * index.html / 动态模板里用 data-ico="名字" 声明图标（见 js/icons.js），运行时统一插成内联 SVG。
 * 为什么插在**最前面**：SVG 与文案是两个节点，i18n 按文本节点查词典不受影响；
 * 千万别把图标塞进文案中间（会拆散文本，词典匹配不上）。重复调用是安全的（已注入会跳过）。 */
function applyIcons(root = document) {
  for (const el of root.querySelectorAll('[data-ico]')) {
    const first = el.firstElementChild;
    if (first && first.classList && first.classList.contains('ico')) continue;
    const svg = ico(el.dataset.ico);
    if (svg) el.insertAdjacentHTML('afterbegin', svg);
  }
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

/* 波形加载的"代次"守卫: 切视频/换项目后, 旧请求回来不能再往新状态上挂波形。
 * (曾出现: 切视频的瞬间旧 peaks 返回 → 新视频的时间轴挂上旧视频的波形, 怎么都对不上) */
let waveLoadGen = 0;

async function loadWaveformFromServer() {
  const gen = ++waveLoadGen;
  timeline.setPeaks(null);
  timeline.setWaveform(null);
  // 项目模式: 波形来自项目缓存(peaks.bin), 不再对视频重新生成
  if (state.project && state.project.loadPeaks) {
    state.project.loadPeaks();
    return;
  }
  const stop = startWaveToast();
  const dur = await waitDuration();
  if (gen !== waveLoadGen) return;      // 已切走: 提示条归新调用管, 这里不 stop
  try {
    const name = decodeURIComponent(state.videoUrl.split('/').pop() || '');
    // 首选峰值数据(矢量绘制, 任意缩放都锐利)
    const rp = await fetch('/api/peaks?name=' + encodeURIComponent(name) + '&dur=' + dur + '&rate=100');
    if (gen !== waveLoadGen) return;
    if (rp.ok) {
      const data = new Uint8Array(await rp.arrayBuffer());
      if (gen !== waveLoadGen) return;
      timeline.setPeaks({ data, rate: parseFloat(rp.headers.get('X-Peak-Rate') || '100'), ch: +(rp.headers.get('X-Peak-Ch') || 2) });
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
      const blob = await resp.blob();
      if (gen !== waveLoadGen) return;
      timeline.setWaveform(URL.createObjectURL(blob));
      toast('波形图已生成', 2000);
    } catch { if (gen === waveLoadGen) toast('波形生成失败'); }
  }
  clearInterval(waveToastTimer);
  stop();
}
async function uploadWaveform(file) {
  const gen = ++waveLoadGen;
  timeline.setPeaks(null);
  timeline.setWaveform(null);
  const stop = startWaveToast();
  const dur = await waitDuration();
  if (gen !== waveLoadGen) return;
  try {
    // 首选峰值数据: 视频流式上传到服务端临时文件, 生成后立即删除(不保存)
    const rp = await fetch('/api/peaks-upload?dur=' + dur + '&rate=100', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    });
    if (gen !== waveLoadGen) return;
    if (!rp.ok) throw new Error('peaks HTTP ' + rp.status);
    const data = new Uint8Array(await rp.arrayBuffer());
    if (gen !== waveLoadGen) return;
    timeline.setPeaks({ data, rate: parseFloat(rp.headers.get('X-Peak-Rate') || '100'), ch: +(rp.headers.get('X-Peak-Ch') || 2) });
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
      const blob = await resp.blob();
      if (gen !== waveLoadGen) return;
      timeline.setWaveform(URL.createObjectURL(blob));
      toast('波形图已生成', 2000);
    } catch { if (gen === waveLoadGen) toast('波形生成失败'); }
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
  toast('正在打开视频：' + name);
  // 服务端直读磁盘原文件提取波形(示例视频是站内相对路径), 不产生任何视频副本
  if (url && !/^blob:/i.test(url)) loadWaveformFromServer();
}

function loadVideoFile(file) {
  loadVideoUrl(URL.createObjectURL(file), file.name);
  // 本地文件: 流式上传到服务端临时文件提取波形, 用完立即删除(服务端不保存视频)
  uploadWaveform(file);
}

/* ─────────── 播放音频源(项目模式) ───────────
 * 音频源=降噪后: 视频静音, 用项目里降噪后的 audio.wav(即 ASR 听到的音频)同步发声,
 * 方便用户直接试听判断降噪是否过头/不够; 音频源=原视频: 视频正常出声。 */
const altAudio = new Audio();
altAudio.preload = 'auto';
let altMode = null;                    // null=视频原声 | 'denoise'=audio.wav 接管发声
let altUrl = '';                       // 当前已加载的音频地址(避免重复 reload)
function setPlaybackAudioMode(mode, hasAudio, bustCache) {
  const useAlt = !!(mode === 'denoise' && hasAudio && state.project);
  altMode = useAlt ? 'denoise' : null;
  if (useAlt) {
    const url = `/api/projects/${state.project.id}/audio` + (bustCache ? '?v=' + Date.now() : '');
    if (altUrl !== url) {              // 重新生成后带时间戳参数强制换新音频
      altUrl = url;
      altAudio.src = url;
    }
    video.muted = true;
    if (!video.paused) { try { altAudio.currentTime = video.currentTime; } catch {} altAudio.play().catch(() => {}); }
  } else {
    altMode = null;
    altAudio.pause();
    if (altUrl) { altUrl = ''; altAudio.removeAttribute('src'); }
    video.muted = false;
  }
}
function altSync(hard) {
  if (altMode !== 'denoise' || !altAudio.src || altAudio.readyState === 0) return;
  if (hard || Math.abs(altAudio.currentTime - video.currentTime) > 0.18) {
    try { altAudio.currentTime = video.currentTime; } catch {}
  }
}
video.addEventListener('play', () => {
  if (altMode !== 'denoise') return;
  altAudio.playbackRate = video.playbackRate;
  altSync(true);
  altAudio.play().catch(() => {});
});
video.addEventListener('playing', () => {   // 视频已在播时才挂上 altAudio 的兜底
  if (altMode === 'denoise' && altAudio.paused) { altSync(true); altAudio.play().catch(() => {}); }
});
video.addEventListener('pause', () => { if (altMode === 'denoise') altAudio.pause(); });
video.addEventListener('seeking', () => altSync(true));
video.addEventListener('seeked', () => altSync(true));
video.addEventListener('ratechange', () => { if (altMode === 'denoise') altAudio.playbackRate = video.playbackRate; });
video.addEventListener('timeupdate', () => altSync(false));   // 软同步: 漂移 >0.18s 才对齐
video.addEventListener('volumechange', () => {
  if (altMode === 'denoise' && !video.muted) { video.muted = true; return; }  // 降噪模式: 视频保持静音, 防止用户用原生控件取消静音后双声
  altAudio.volume = video.volume;   // 只同步音量; muted 由 alt 模式自己管
});

video.addEventListener('loadedmetadata', () => {
  timeline.setDuration(video.duration);   // 内部会按"默认 30s 跨度"摆好视图
  timeline.setVideo(video);               // 确保胶片缩略图取到新的 currentSrc
  overlay.fitToVideo();
  tlDuration.textContent = fmtTime(video.duration);
});
window.addEventListener('resize', () => overlay.fitToVideo());

/* ═══════════ 字幕加载 ═══════════ */
const ASS_WORD_COLOR_META = 'SubFabricWordHighlightColor';
/* ASR 置信度元数据（server.js 写入 Script Info 注释；其它播放器会忽略这些 `;` 注释）。
 * 格式 `行号:分数:最差词下标` 逗号分隔 —— 行号对应字幕行顺序。
 * 阈值必须与 asr/confidence.py 的 LOW_CONFIDENCE 保持一致（后端判定与前端筛选同一口径）。
 * 注意：它声明在解析函数**之前** —— const 在声明前被引用会抛 TDZ 错误。 */
const ASS_CONFIDENCE_META = 'SubFabricConfidence';
const LOW_CONFIDENCE_UI = 0.60;   // 与 asr/confidence.py 的 LOW_CONFIDENCE 一致（真实样本扫出来的）

/** 解析置信度注释 → Map(行号 -> {score, low, worstWord})。
 *  容错优先：格式不对就跳过该条 —— 元数据坏了不能让整个字幕打不开。 */
function parseConfidenceMeta(assDoc) {
  const out = new Map();
  const raw = assDoc && assDoc.getScriptInfoComment
    ? assDoc.getScriptInfoComment(ASS_CONFIDENCE_META) : '';
  if (!raw) return out;
  for (const piece of String(raw).split(',')) {
    const f = piece.split(':');
    if (f.length < 2) continue;
    const idx = parseInt(f[0], 10);
    const score = parseFloat(f[1]);
    if (!Number.isInteger(idx) || idx < 0 || !Number.isFinite(score)) continue;
    const w = parseInt(f[2], 10);
    out.set(idx, {
      score: Math.max(0, Math.min(1, score)),
      low: score < LOW_CONFIDENCE_UI,
      worstWord: Number.isInteger(w) && w >= 0 ? w : null,
    });
  }
  return out;
}

function resolveAssStyleTargets(doc, kar) {
  const names = (doc.styleNames || []).filter((name, i, all) => all.findIndex(n => n.toLowerCase() === name.toLowerCase()) === i);
  if (names.length < 2) return null;
  const has = (name) => name && names.some(n => n.toLowerCase() === name.toLowerCase());
  let en = has(kar && kar.wordStyle) ? names.find(n => n.toLowerCase() === kar.wordStyle.toLowerCase()) : '';
  if (!en) en = names.find(n => /^(default|english|en|eng|英文)$/i.test(n))
    || names.find(n => /english|英文|(^|[-_])en([-_]|$)/i.test(n)) || '';
  let zh = names.find(n => n.toLowerCase() !== String(en).toLowerCase()
    && /chinese|中文|mandarin|(^|[-_])zh([-_]|$)|^(cn|chi)$/i.test(n)) || '';
  if (!en && zh) en = names.find(n => n.toLowerCase() !== zh.toLowerCase()) || '';
  if (!zh && en) zh = names.find(n => n.toLowerCase() !== en.toLowerCase()) || '';
  // 两个样式都没有可识别的语言线索时不按声明顺序猜，避免静默改错轨道。
  if (!en || !zh || en.toLowerCase() === zh.toLowerCase()) return null;
  return { zh, en };
}

function assHexToTag(hex) {
  const rgb = String(hex || '').replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(rgb) ? `{\\c&H${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&}` : '{\\c&H00FF00&}';
}

/** '#rrggbb' → ASS 的&HAABBGGRR(注意 BGR 顺序)。样式 Primary/SecondaryColour 直接吃这个值。 */
function assHexToBgr(hex) {
  const rgb = String(hex || '').replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(rgb)) return null;
  return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

/** ASS 里的 &HAABBGGRR(常见 8 位) / &HBBGGRR(6 位) → '#rrggbb'，认不出来时返回 fallback。
   *  必须取**末尾 6 位**: 8 位格式前面还有 2 位 alpha，直接取前 6 位会把 RGB 整体错位。 */
function assBgrToHex(raw, fallback) {
  const m = /&H([0-9A-Fa-f]{6,8})/i.exec(String(raw || ''));
  if (!m) return fallback;
  const h = m[1].slice(-6).toUpperCase();
  return assColorToHex(h);
}

/** hex 为 null 表示稿件里没读到有效颜色, 此时不动控件(保留 HTML 上的默认值)。 */
function setColorControl(input, label, hex) {
  if (!hex || !input) return;
  input.value = hex;
  if (label) label.textContent = hex.toUpperCase();
}

function assStyleFields(name) {
  const style = state.assDoc && state.assDoc.getStyle(name);
  if (!style) return null;
  const num = Number(style.fontsize);
  return {
    font: style.fontname || '', size: isFinite(num) && num > 0 ? num : 48,
    bold: Number(style.bold) < 0 || style.bold === '1',
    italic: Number(style.italic) < 0 || style.italic === '1',
    color: assBgrToHex(style.primarycolour, null),
    color2: assBgrToHex(style.secondarycolour, null)
  };
}

/* ─────────── 本机字体库(服务端读系统字体, 见 editor/fonts.js) ───────────
 * libass 在 Worker 里跑, 拿不到系统字体 —— 由本地服务把字体文件读出来喂给它。
 * 于是用户只要填字体名, 不用自己找 .ttf: 填「微软雅黑」就用微软雅黑。 */
const SYSTEM_FONTS = { promise: null, names: new Set() };
let pendingFontNotice = '';

/** 缓存的是**同一个 Promise**, 不是"已加载"布尔量 ——
 *  打开稿件时 setAssStyleControls 与 autoLoadSystemFonts 会同时要这份清单,
 *  若先置位再 await, 后到的那次会拿到还没填好的空集合, 于是"本机明明装了"却判成没装。 */
function loadSystemFontList() {
  if (SYSTEM_FONTS.promise) return SYSTEM_FONTS.promise;
  SYSTEM_FONTS.promise = (async () => {
    try {
      const r = await fetch('/api/fonts');
      if (!r.ok) return SYSTEM_FONTS;
      const j = await r.json();
      const list = Array.isArray(j.fonts) ? j.fonts : [];
      SYSTEM_FONTS.names = new Set(list.map(n => String(n).trim().toLowerCase()));
      const dl = document.getElementById('ass-font-list');
      if (dl && list.length) {
        dl.innerHTML = '';
        for (const n of list) {
          const o = document.createElement('option');
          o.value = n;
          dl.appendChild(o);
        }
      }
    } catch { /* 拿不到就用内置那几个候选 */ }
    return SYSTEM_FONTS;
  })();
  return SYSTEM_FONTS.promise;
}

/** 让这个字体名在预览里可用。
 *  @returns 'present'(本来就有) | 'loaded'(刚从本机字体库取来) | 'missing'(本机没装) */
async function ensureSystemFont(name) {
  const key = String(name || '').trim();
  if (!key) return 'missing';
  if (await assPlayer.isFontAvailable(key)) return 'present';
  const lib = await loadSystemFontList();
  if (!lib.names.has(key.toLowerCase())) return 'missing';
  try {
    const r = await fetch('/api/font-file?name=' + encodeURIComponent(key));
    if (!r.ok) return 'missing';
    const blob = await r.blob();
    await assPlayer.cacheFont(key, new File([blob], key + '.ttf', { type: 'font/ttf' }), false);
    return 'loaded';
  } catch { return 'missing'; }
}

/** 改完字体名: 先把它从本机字体库备好, 再套用样式(只重载一次预览) */
async function onFontNameChange(track) {
  const el = track === 'zh' ? assStyleEls.zhFont : assStyleEls.enFont;
  const name = (el.value || '').trim();
  if (!name) { applyAssStyleSettings(); return; }
  if (assStyleEls.status) assStyleEls.status.textContent = `正在查找本机字体「${name}」…`;
  const res = await ensureSystemFont(name);
  if (res === 'loaded') pendingFontNotice = `已从本机字体库载入「${name}」`;
  applyAssStyleSettings();
  if (res === 'loaded' && !assPlayer.ready && assStyleEls.status) {
    assStyleEls.status.textContent = `已从本机字体库载入「${name}」，预览重建中…`;
  }
}

/** 打开稿件后自动补齐: 样式里写的字体若本机装了, 直接喂给预览(用户不必手动选文件) */
async function autoLoadSystemFonts() {
  if (state.format !== 'ass' || !state.assStyleTargets) return;
  const targets = state.assStyleTargets;
  const names = [assStyleEls.zhFont.value, assStyleEls.enFont.value]
    .map(v => String(v || '').trim()).filter(Boolean);
  const loaded = [];
  for (const n of names) {
    const r = await ensureSystemFont(n);
    if (state.assStyleTargets !== targets) return;   // 期间换了稿件 → 作废
    if (r === 'loaded') loaded.push(n);
  }
  if (!loaded.length) { refreshFontNotes(); return; }
  pendingFontNotice = `已从本机字体库载入「${loaded.join('、')}」`;
  // 字体换了 → 整轨重建, 让新字体真正生效
  applyAssStyleSettings(true);
}

/** 如实标注每轨字体在**预览**里到底有没有字形。
 *  libass 只用自己 FS 里的字体文件: 只改字体名而没「载入字体」时, 它会回退到内置字体,
 *  画面看着"没变"并不是没同步, 而是压根没有那个字体 —— 这里把原因写在控件下面。 */
async function refreshFontNotes() {
  if (!state.assStyleTargets || !state.assDoc) return;
  const targets = state.assStyleTargets;
  const zhName = (assStyleEls.zhFont.value || '').trim();
  const enName = (assStyleEls.enFont.value || '').trim();
  const [zhOk, enOk] = await Promise.all([
    assPlayer.isFontAvailable(zhName),
    assPlayer.isFontAvailable(enName)
  ]);
  // 期间换了稿件/改了名字 → 这次结果作废
  if (state.assStyleTargets !== targets) return;
  if ((assStyleEls.zhFont.value || '').trim() !== zhName) return;
  const paint = (el, ok, name) => {
    if (!el) return;
    el.className = 'ass-style-font-note ' + (ok ? 'ok' : 'warn');
    el.textContent = ok
      ? (name.toLowerCase() === 'noto sans cjk sc' ? '预览已载入（内置字体）' : '预览已载入该字体')
      : '本机没装这个字体 → 预览会回退到内置字体（画面看着不变）；点「载入字体」挑一个 .ttf/.otf 也能用';
  };
  paint(assStyleEls.zhFontNote, zhOk, zhName);
  paint(assStyleEls.enFontNote, enOk, enName);
}

function setAssStyleControls() {
  const targets = state.format === 'ass' && state.assDoc
    ? resolveAssStyleTargets(state.assDoc, state.kar) : null;
  state.assStyleTargets = targets;
  const enabled = !!targets && !!state.assDoc.getStyle(targets.zh) && !!state.assDoc.getStyle(targets.en);
  if (assStyleEls.group) assStyleEls.group.classList.toggle('ass-style-disabled', !enabled);
  const controls = [assStyleEls.zhFont, assStyleEls.enFont, assStyleEls.zhSize, assStyleEls.enSize,
    assStyleEls.zhBold, assStyleEls.enBold, assStyleEls.zhItalic, assStyleEls.enItalic, assStyleEls.wordColor,
    assStyleEls.zhColor, assStyleEls.zhColor2, assStyleEls.enColor, assStyleEls.enColor2,
    document.getElementById('ass-style-zh-font-file-btn'), document.getElementById('ass-style-en-font-file-btn')];
  controls.forEach(el => { if (el) el.disabled = !enabled; });
  if (!enabled) {
    if (assStyleEls.zhName) assStyleEls.zhName.textContent = '';
    if (assStyleEls.enName) assStyleEls.enName.textContent = '';
    for (const note of [assStyleEls.zhFontNote, assStyleEls.enFontNote]) {
      if (note) { note.className = 'ass-style-font-note'; note.textContent = ''; }
    }
    if (assStyleEls.status) assStyleEls.status.textContent = state.format === 'srt'
      ? '当前是 SRT 字幕；ASS 样式只适用于 ASS/SSA。'
      : '此 ASS 未找到可分别设置的中英两种样式。';
    return;
  }
  const zh = assStyleFields(targets.zh), en = assStyleFields(targets.en);
  if (assStyleEls.zhName) assStyleEls.zhName.textContent = `(${targets.zh})`;
  if (assStyleEls.enName) assStyleEls.enName.textContent = `(${targets.en})`;
  if (assStyleEls.zhFont) assStyleEls.zhFont.value = zh.font;
  if (assStyleEls.enFont) assStyleEls.enFont.value = en.font;
  if (assStyleEls.zhSize) assStyleEls.zhSize.value = zh.size;
  if (assStyleEls.enSize) assStyleEls.enSize.value = en.size;
  if (assStyleEls.zhBold) assStyleEls.zhBold.checked = zh.bold;
  if (assStyleEls.enBold) assStyleEls.enBold.checked = en.bold;
  if (assStyleEls.zhItalic) assStyleEls.zhItalic.checked = zh.italic;
  if (assStyleEls.enItalic) assStyleEls.enItalic.checked = en.italic;
  // 样式里认不出的颜色(老稿件缺字段)别覆盖控件默认值, 保持HTML 上的初始值。
  setColorControl(assStyleEls.zhColor, assStyleEls.zhColorVal, zh.color);
  setColorControl(assStyleEls.zhColor2, assStyleEls.zhColor2Val, zh.color2);
  setColorControl(assStyleEls.enColor, assStyleEls.enColorVal, en.color);
  setColorControl(assStyleEls.enColor2, assStyleEls.enColor2Val, en.color2);
  let wordColor = state.assDoc.getScriptInfoComment(ASS_WORD_COLOR_META);
  if (!/^#[0-9a-f]{6}$/i.test(wordColor)) {
    const sentence = (state.kar && state.kar.sentences || []).find(s => s.style === state.kar.wordStyle && s.words.length);
    const m = sentence && /^\{\\c&H([0-9A-Fa-f]{6})&\}/.exec(sentence.highlightTag || '');
    wordColor = m ? assColorToHex(m[1].toUpperCase()) : '#00ff00';
  }
  wordColor = wordColor.toLowerCase();
  // 让 karaoke.js 记住这份稿件的逐词高亮色 —— 新建字幕/重新识别写回的高亮 span 都要取它,
  // 否则用户选了白色高亮, 新增出来的仍是绿的(用户报的 bug)。
  setWordHighlightColor(wordColor);
  if (assStyleEls.wordColor) assStyleEls.wordColor.value = wordColor;
  if (assStyleEls.wordColorVal) assStyleEls.wordColorVal.textContent = wordColor.toUpperCase();
  if (assStyleEls.status) assStyleEls.status.textContent = '修改会立即预览并写入文稿；项目自动保存，普通字幕请导出保存。';
  loadSystemFontList();      // 顺手把本机字体填进候选, 用户打字就有补全
  refreshFontNotes();
}

function applyAssStyleSettings(forceFontReload = false) {
  if (state.format !== 'ass' || !state.assDoc || !state.assStyleTargets) return false;
  const el = assStyleEls, targets = state.assStyleTargets;
  const oldZhFont = (state.assDoc.getStyle(targets.zh).fontname || '').trim();
  const oldEnFont = (state.assDoc.getStyle(targets.en).fontname || '').trim();
  const zhFont = (el.zhFont.value || '').trim(), enFont = (el.enFont.value || '').trim();
  const zhSize = Number(el.zhSize.value), enSize = Number(el.enSize.value);
  if (!zhFont || !enFont) { toast('字体名称不能为空'); return false; }
  if (!Number.isFinite(zhSize) || zhSize < 1 || zhSize > 200 || !Number.isFinite(enSize) || enSize < 1 || enSize > 200) {
    toast('字号请设置为 1–200'); return false;
  }
  let changed = state.assDoc.setStyleFields(targets.zh, {
    fontname: zhFont, fontsize: Math.round(zhSize), bold: el.zhBold.checked ? -1 : 0, italic: el.zhItalic.checked ? -1 : 0
  });
  changed = state.assDoc.setStyleFields(targets.en, {
    fontname: enFont, fontsize: Math.round(enSize), bold: el.enBold.checked ? -1 : 0, italic: el.enItalic.checked ? -1 : 0
  }) || changed;
  // 只改样式轨的 Primary/SecondaryColour 默认色, 不动行内\1c/\c 等覆盖标签 ——
  // 逐词高亮色与角色色是行内标签, 会在下面单独处理。
  const colorFields = [
    [targets.zh, el.zhColor, 'primarycolour'], [targets.zh, el.zhColor2, 'secondarycolour'],
    [targets.en, el.enColor, 'primarycolour'], [targets.en, el.enColor2, 'secondarycolour']
  ];
  for (const [styleName, input, key] of colorFields) {
    const bgr = assHexToBgr(input && input.value);
    if (bgr) changed = state.assDoc.setStyleFields(styleName, { [key]: bgr }) || changed;
  }
  for (const [input, label] of [[el.zhColor, el.zhColorVal], [el.zhColor2, el.zhColor2Val],
    [el.enColor, el.enColorVal], [el.enColor2, el.enColor2Val]]) {
    if (input && label) label.textContent = input.value.toUpperCase();
  }
  const color = (el.wordColor.value || '#00ff00').toLowerCase();
  setWordHighlightColor(color);      // 同步给 karaoke.js: 之后新建/重建的逐词 span 都用这个色
  const wordEvents = state.kar && state.kar.sentences
    ? [...new Set(state.kar.sentences
      .filter(sentence => sentence.style.toLowerCase() === targets.en.toLowerCase() && sentence.words && sentence.words.length)
      .flatMap(sentence => sentence.events || []))]
    : [];
  const wordColorChanged = replaceWordHighlightColor(state.assDoc, targets.en, color, wordEvents);
  const colorMetaChanged = state.assDoc.setScriptInfoComment(ASS_WORD_COLOR_META, color);
  if (state.kar && state.kar.sentences) {
    const tag = assHexToTag(color);
    for (const sentence of state.kar.sentences) if (sentence.style.toLowerCase() === targets.en.toLowerCase()) sentence.highlightTag = tag;
  }
  if (el.wordColorVal) el.wordColorVal.textContent = color.toUpperCase();
  const anyChanged = changed || wordColorChanged > 0 || colorMetaChanged;
  if (!anyChanged && !forceFontReload) return false;
  const text = state.assDoc.serialize();
  if (forceFontReload || oldZhFont.toLowerCase() !== zhFont.toLowerCase() || oldEnFont.toLowerCase() !== enFont.toLowerCase()) {
    assPlayer.load(text, [zhFont, enFont]);
  } else {
    assPlayer.updateNow(text);
  }
  if (state.project) Projects.scheduleSave();
  refreshFontNotes();
  if (assStyleEls.status) {
    const saveHint = state.project ? '项目字幕将自动保存。' : '点击“导出字幕”保存到文件。';
    assStyleEls.status.textContent = assPlayer.ready
      ? `样式已应用，视频预览已刷新；${saveHint}`
      : `样式已写入，ASS 渲染器就绪后同步预览；${saveHint}`;
  }
  return true;
}

async function loadAssStyleFont(language) {
  if (!state.assStyleTargets || state.format !== 'ass') return;
  const input = language === 'zh' ? assStyleEls.zhFontFile : assStyleEls.enFontFile;
  const family = (language === 'zh' ? assStyleEls.zhFont.value : assStyleEls.enFont.value).trim();
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!family) { toast('请先填写该字体的字体名称'); input.value = ''; return; }
  if (!/\.(?:ttf|otf)$/i.test(file.name)) { toast('字体文件仅支持 .ttf 或 .otf'); input.value = ''; return; }
  try {
    await assPlayer.cacheFont(family, file);
    applyAssStyleSettings(true);
    toast(`已载入字体：${family}`);
  } catch (e) { toast('字体载入失败：' + (e && e.message || e)); }
  finally { input.value = ''; }
}

/* ─────────── 字幕后处理特效 (微光 Glow / 词生长 Grow / 柔和淡入 Fade In) ─────────── */
const FX_LANGS = ['zh', 'en'];
const FX_CHANNELS = ['shadow', 'outline', 'both'];
const FX_TARGETS = ['zh', 'en', 'all', 'active_word'];

/** 某个生效范围下，哪些语言的参数块真的会被用到 */
const FX_SCOPE = {
  zh: { zh: true, en: false },
  en: { zh: false, en: true },
  all: { zh: true, en: true },
  active_word: { zh: false, en: true }   // 逐词高亮词在英文轨上，用英文参数
};

/**
 * 当前参数组合对应哪个预设按钮。
 * 判定顺序从「特效最多」往下走，保证全套全开时高亮的是最全的那个按钮，
 * 而不是先匹配到纯微光就把 grow/fadein 的开关状态显示丢了。
 */

function fxLangEls(lang) {
  const $ = (suffix) => document.getElementById(`fx-${lang}-${suffix}`);
  return {
    group: $( 'group'),
    head: $('head'),
    state: $('state'),
    enable: $('enable'),
    enableVal: $('enable-val'),
    channel: $('channel'),
    color: $('color'),
    colorVal: $('color-val'),
    radius: $('radius'),
    radiusVal: $('radius-val'),
    intensity: $('intensity'),
    intensityVal: $('intensity-val')
  };
}

const fxEls = {
  group: document.getElementById('ass-fx-group'),
  enable: document.getElementById('fx-enable'),
  enableVal: document.getElementById('fx-enable-val'),
  controls: document.getElementById('fx-controls'),
  glowEnable: document.getElementById('fx-glow-enable'),
  glowEnableVal: document.getElementById('fx-glow-enable-val'),
  glowTarget: document.getElementById('fx-glow-target'),
  statusNote: document.getElementById('fx-status-note'),
  lang: { zh: fxLangEls('zh'), en: fxLangEls('en') },
  glow: {
    block: document.getElementById('fx-glow-block')
  },
  grow: {
    block: document.getElementById('fx-grow-block'),
    enable: document.getElementById('fx-grow-enable'),
    enableVal: document.getElementById('fx-grow-enable-val'),
    scale: document.getElementById('fx-grow-scale'),
    scaleVal: document.getElementById('fx-grow-scale-val')
  },
  fadein: {
    block: document.getElementById('fx-fadein-block'),
    enable: document.getElementById('fx-fadein-enable'),
    enableVal: document.getElementById('fx-fadein-enable-val'),
    target: document.getElementById('fx-fadein-target'),
    from: document.getElementById('fx-fadein-from'),
    fromVal: document.getElementById('fx-fadein-from-val'),
    duration: document.getElementById('fx-fadein-duration'),
    durationVal: document.getElementById('fx-fadein-duration-val'),
    ratio: document.getElementById('fx-fadein-ratio'),
    ratioVal: document.getElementById('fx-fadein-ratio-val')
  }
};

function fxNormLang(block) {
  const b = block || {};
  return {
    enabled: b.enabled !== false,
    channel: FX_CHANNELS.includes(b.channel) ? b.channel : 'shadow',
    color: (b.color || '#00ff88').toLowerCase(),
    radius: Number(b.radius != null ? b.radius : 4.0),
    intensity: Number(b.intensity != null ? b.intensity : 100)
  };
}

/**
 * 词生长参数归一化（与 postprocess.js 的 normGrow 同一套夹取区间）。
 * 注意：旧存档的 scale 是「起始缩放」（恒 <100，配 `\t` 长到 100%）；
 * 新语义是「放大倍数」（恒 ≥100）。见到 <100 的旧值换成新默认，
 * 免得老用户升级后活动词反而变小。
 */
function fxNormGrow(block) {
  const b = block || {};
  const raw = Number.isFinite(+b.scale) ? Math.round(+b.scale) : 130;
  return {
    enabled: b.enabled === true,
    scale: raw < 100 ? 130 : Math.min(250, Math.max(100, raw))
  };
}

/** 柔和淡入参数归一化（\fade 是事件级标签，生效范围只有整行三档） */
function fxNormFadeIn(block) {
  const b = block || {};
  const cl = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? Math.round(+v) : d));
  return {
    enabled: b.enabled === true,
    target: (b.target === 'en' || b.target === 'all') ? b.target : 'zh',
    from: cl(b.from, 0, 100, 55),
    duration: cl(b.duration, 20, 3000, 300),
    ratio: cl(b.ratio, 5, 100, 70)
  };
}

function syncFxUi() {
  const cfg = state.postProcessConfig;
  if (!fxEls.enable) return;

  fxEls.enable.checked = !!cfg.enabled;
  if (fxEls.enableVal) fxEls.enableVal.textContent = cfg.enabled ? '开' : '关';
  if (fxEls.controls) fxEls.controls.hidden = !cfg.enabled;

  const glow = cfg.glow || {};
  if (fxEls.glowEnable) fxEls.glowEnable.checked = glow.enabled !== false;
  if (fxEls.glowEnableVal) fxEls.glowEnableVal.textContent = (glow.enabled !== false) ? '开' : '关';
  // 三个特效块视觉平级：关掉哪个就把哪个的参数区压暗（与 grow/fadein 同一套表现）
  if (fxEls.glow.block) fxEls.glow.block.classList.toggle('is-off', glow.enabled === false);

  const target = FX_TARGETS.includes(glow.target) ? glow.target : 'active_word';
  if (fxEls.glowTarget) fxEls.glowTarget.value = target;
  const scope = FX_SCOPE[target];

  for (const lang of FX_LANGS) {
    const els = fxEls.lang[lang];
    const b = fxNormLang(glow[lang]);

    if (els.enable) els.enable.checked = b.enabled;
    if (els.enableVal) els.enableVal.textContent = b.enabled ? '开' : '关';
    if (els.channel) els.channel.value = b.channel;
    if (els.color) els.color.value = b.color;
    if (els.colorVal) els.colorVal.textContent = b.color.toUpperCase();
    if (els.radius) els.radius.value = b.radius;
    if (els.radiusVal) els.radiusVal.textContent = `${b.radius.toFixed(1)} px`;
    if (els.intensity) els.intensity.value = b.intensity;
    if (els.intensityVal) els.intensityVal.textContent = `${Math.round(b.intensity)}%`;

    const inScope = !!(scope && scope[lang]);
    if (els.group) els.group.classList.toggle('is-out-of-scope', !inScope);
    if (els.state) els.state.textContent = inScope ? '生效中' : '当前范围用不到';
  }

  // ── 词生长（静态放大，只作用逐词高亮词）──
  const g = fxEls.grow;
  const gb = fxNormGrow(cfg.grow);
  if (g.enable) g.enable.checked = gb.enabled;
  if (g.enableVal) g.enableVal.textContent = gb.enabled ? '开' : '关';
  if (g.block) g.block.classList.toggle('is-off', !gb.enabled);
  if (g.scale) g.scale.value = gb.scale;
  if (g.scaleVal) g.scaleVal.textContent = `${gb.scale}%`;

  // ── 柔和淡入 ──
  const fd = fxEls.fadein;
  const fb = fxNormFadeIn(cfg.fadein);
  if (fd.enable) fd.enable.checked = fb.enabled;
  if (fd.enableVal) fd.enableVal.textContent = fb.enabled ? '开' : '关';
  if (fd.block) fd.block.classList.toggle('is-off', !fb.enabled);
  if (fd.target) fd.target.value = fb.target;
  if (fd.from) fd.from.value = Math.min(99, fb.from);
  if (fd.fromVal) fd.fromVal.textContent = `${Math.min(99, fb.from)}%`;
  if (fd.duration) fd.duration.value = Math.min(1200, fb.duration);
  if (fd.durationVal) fd.durationVal.textContent = `${Math.min(1200, fb.duration)} ms`;
  if (fd.ratio) fd.ratio.value = fb.ratio;
  if (fd.ratioVal) fd.ratioVal.textContent = `${fb.ratio}%`;
}

function updateFxConfig(mutateFn) {
  if (typeof mutateFn === 'function') mutateFn(state.postProcessConfig);
  savePostProcessConfig(state.postProcessConfig);
  syncFxUi();
  // 及时更新视频区 ASS 渲染
  if (state.format === 'ass' && state.assDoc) {
    assPlayer.updateNow(state.assDoc.serialize());
  }
}

/** 确保 cfg.glow[lang] 存在后执行 mutate */
function mutateFxLang(lang, mutateFn) {
  updateFxConfig(cfg => {
    if (!cfg.glow) cfg.glow = {};
    if (!cfg.glow[lang]) cfg.glow[lang] = {};
    mutateFn(cfg.glow[lang], cfg.glow);
  });
}

/** 确保 cfg.<key> 存在后执行 mutate（词生长/柔和淡入共用） */
function mutateFxEffect(key, mutateFn) {
  updateFxConfig(cfg => {
    if (!cfg[key] || typeof cfg[key] !== 'object') cfg[key] = {};
    mutateFn(cfg[key]);
  });
}

function initFxControls() {
  if (!fxEls.enable) return;

  syncFxUi();

  fxEls.enable.addEventListener('change', () => {
    updateFxConfig(cfg => { cfg.enabled = fxEls.enable.checked; });
  });

  if (fxEls.glowEnable) {
    fxEls.glowEnable.addEventListener('change', () => {
      updateFxConfig(cfg => {
        if (!cfg.glow) cfg.glow = {};
        cfg.glow.enabled = fxEls.glowEnable.checked;
      });
    });
  }

  if (fxEls.glowTarget) {
    fxEls.glowTarget.addEventListener('change', () => {
      updateFxConfig(cfg => {
        if (!cfg.glow) cfg.glow = {};
        cfg.glow.target = fxEls.glowTarget.value;
      });
    });
  }

  for (const lang of FX_LANGS) {
    const els = fxEls.lang[lang];

    if (els.enable) {
      els.enable.addEventListener('change', () => {
        mutateFxLang(lang, (b) => { b.enabled = els.enable.checked; });
      });
    }

    if (els.channel) {
      els.channel.addEventListener('change', () => {
        mutateFxLang(lang, (b) => { b.channel = els.channel.value; });
      });
    }

    if (els.color) {
      const onColor = () => mutateFxLang(lang, (b) => { b.color = els.color.value; });
      els.color.addEventListener('input', onColor);
      els.color.addEventListener('change', onColor);
    }

    if (els.radius) {
      const onRadius = () => mutateFxLang(lang, (b) => { b.radius = parseFloat(els.radius.value) || 4.0; });
      els.radius.addEventListener('input', onRadius);
      els.radius.addEventListener('change', onRadius);
    }

    if (els.intensity) {
      const onIntensity = () => mutateFxLang(lang, (b) => { b.intensity = parseFloat(els.intensity.value); });
      els.intensity.addEventListener('input', onIntensity);
      els.intensity.addEventListener('change', onIntensity);
    }
  }

  // ── 词生长（静态放大）──
  const g = fxEls.grow;
  if (g.enable) {
    g.enable.addEventListener('change', () => mutateFxEffect('grow', (b) => { b.enabled = g.enable.checked; }));
  }
  if (g.scale) {
    const onScale = () => mutateFxEffect('grow', (b) => { b.scale = parseInt(g.scale.value, 10) || 130; });
    g.scale.addEventListener('input', onScale);
    g.scale.addEventListener('change', onScale);
  }

  // ── 柔和淡入 ──
  const fd = fxEls.fadein;
  if (fd.enable) {
    fd.enable.addEventListener('change', () => mutateFxEffect('fadein', (b) => { b.enabled = fd.enable.checked; }));
  }
  if (fd.target) {
    fd.target.addEventListener('change', () => mutateFxEffect('fadein', (b) => { b.target = fd.target.value; }));
  }
  if (fd.from) {
    const onFrom = () => mutateFxEffect('fadein', (b) => { b.from = parseInt(fd.from.value, 10); });
    fd.from.addEventListener('input', onFrom);
    fd.from.addEventListener('change', onFrom);
  }
  if (fd.duration) {
    const onDur = () => mutateFxEffect('fadein', (b) => { b.duration = parseInt(fd.duration.value, 10) || 300; });
    fd.duration.addEventListener('input', onDur);
    fd.duration.addEventListener('change', onDur);
  }
  if (fd.ratio) {
    const onRatio = () => mutateFxEffect('fadein', (b) => { b.ratio = parseInt(fd.ratio.value, 10) || 70; });
    fd.ratio.addEventListener('input', onRatio);
    fd.ratio.addEventListener('change', onRatio);
  }
}

async function loadSubUrl(url, name) {
  const resp = await fetch(url);
  if (!resp.ok) { toast('字幕打开失败：' + resp.status); return; }
  const text = await resp.text();
  routeSub(text, name);
}

function routeSub(text, name) {
  if (isAssSubtitle(text, name)) {
    // 带特效的导出文件（微光/生长/淡入）直接进来会"字幕块破碎"：逐词 span 被特效标签污染,
    // 切片识别失败, 一句话的每个词都变成独立的块。先转成普通字幕再加载;
    // 转换异常/结果可疑 → stripEffectTagsSafe 会原样返回（硬塞, 宁可回到旧行为也不丢内容）。
    const { text: t, cleaned } = stripEffectTagsSafe(text);
    if (cleaned) toast('已把带特效的字幕转成普通字幕（微光/生长/淡入标签已剥离）', 5000);
    setAss(t, name);
  }
  else setSrt(text, name);
}

/* ─────────── SRT ─────────── */
function setSrt(text, name) {
  clearEditPreview(false);
  clearWordPreview(false);
  pendingPlaybackRows.clear();
  assPlayer.dispose();
  state.format = 'srt';
  state.fileName = name;
  state.assDoc = null;
  state.kar = null;
  updateWordConvertStyles();
  state.assStyleTargets = null;
  setAssStyleControls();
  state.srtCues = parseSRT(text);

  overlay.setCues(state.srtCues);
  overlay.show();

  panel.setBadge('SRT 双语', 'srt');
  panel.setFileName(name);
  panel.setRolesEnabled(false);   // SRT 没有角色(说话人)概念 → 禁用角色 Tab 与角色筛选
  frSetRolesAvailable(false);     // 批量替换里的角色页签同样不可进入
  panel.setModeOptions([
    { v: 'bi', t: '双语双行' },
    { v: 'first', t: '仅主语言' },
    { v: 'second', t: '仅副语言' }
  ], 'bi');
  timeline.clearRangeSel();      // 新文件 → 顺带取消批量选区
  timeline.resetView();          // 新文件 → 时间轴回到"默认 30s 跨度"
  rebuildItemsAndLanes(true);
  btnExport.disabled = false;
  if (btnExportPack) btnExportPack.disabled = false;
  btnExportClean.disabled = true;
  btnExportJson.disabled = true;
  statusFile.textContent = t(`${name} · ${state.srtCues.length} 条`);
  toast(`已打开 SRT：${state.srtCues.length} 条（双语）`);
}

/* ─────────── ASS ─────────── */
function updateWordConvertStyles() {
  if (!wordConvertStyle) return;
  wordConvertStyle.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = state.format === 'ass'
    ? '请选择英文样式（未确认不转换）' : '先打开 ASS 文件';
  wordConvertStyle.append(first);
  const styles = state.assDoc
    ? [...new Set([...state.assDoc.styleNames, ...state.assDoc.events.map(ev => ev.style)])]
    : [];
  for (const name of styles) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    wordConvertStyle.append(opt);
  }
  // 只有文件中真实存在逐词颜色 span 才自动沿用；纯时间关系的推断不能算用户确认。
  const hasTagged = state.assDoc && state.assDoc.events.some(ev =>
    ev.style === (state.kar && state.kar.wordStyle) && /\{\\c&H[0-9A-Fa-f]{6}&\}[^{}]+?\{\\c\}/.test(ev.text));
  wordConvertStyle.value = hasTagged ? state.kar.wordStyle : '';
  wordConvertStyle.disabled = !state.assDoc;
  if (btnConvertWords) btnConvertWords.disabled = !state.assDoc;
  if (wordConvertHint) wordConvertHint.textContent = wordConvertStyle.value
    ? `已检测到逐词颜色标签，英文样式为「${wordConvertStyle.value}」。仅转换尚未逐词化的英文句。`
    : '无法可靠判定英文样式：请先在上方明确选择，未选择时一律跳过，绝不猜测转换；中文和已转换行不改动。';
}
/** 规整 ASS 颜色标签, 加载时统一为**大写**十六进制。
 *
 *  为什么要大写: 上游工具(Subforges)解析 ASS 颜色标签时只认大写十六进制,
 *  小写(&H00ff00&)会被判为不认得 → 逐词高亮在那边整体失效, 工作流无法继承。
 *  libass 本身大小写通吃, 所以这纯粹是对上游的兼容, 不影响本工具的渲染。
 *
 *  处理两类历史问题:
 *  ① 旧版服务端写出过 {\c&H&bbggrr&&}(多一层 &H/&) —— libass 解析成黑/默认色, 且
 *     颜色解析/全局换色全都匹配不上, 规整为标准的 {\c&Hbbggrr&};
 *  ② 值里含小写十六进制 —— 一律转大写。
 *
 *  覆盖 \1c(PrimaryColour) / \2c / \3c(Outline) / \4c(Shadow) 与 \c, 逐词高亮
 *  {\c&H00ff00&}词{\c} 和行首角色色 {\c&H0b0be5&} 都会被规整。
 *
 *  @returns 改动的事件数 */
function normalizeAssColorTags() {
  if (!state.assDoc) return 0;
  // ① 先修结构错误(多一层 &H/&), ② 再把所有颜色值转大写。
  // 用同一遍扫描完成: 每次替换都重新构造标签, 避免连续 replace 的匹配漂移。
  const bad = /\{\\(?:[1-4])?c&H&H?([0-9A-Fa-f]{6})&&\}/g;
  // 尾部 & 可选: 缺尾& 的 {\c&H00ff00} 同样要接上 —— karaoke.js 的 HL_RE 要求尾&,
  // 缺了就不被识别为逐词高亮。整段重建(而非局部 replace), 避免吃掉原有的尾&。
  const anyColor = /\{\\(?:[1-4])?c&H([0-9A-Fa-f]{6})&?\}/g;
  let n = 0;
  for (const ev of state.assDoc.events) {
    const t = ev.text || '';
    if (!/\{\\[1-4]?c&H/.test(t)) continue;
    bad.lastIndex = 0; anyColor.lastIndex = 0;
    if (!bad.test(t) && !anyColor.test(t)) continue;
    let next = t.replace(bad, (all, hex) => `{\\c&H${hex.toUpperCase()}&}`);
    next = next.replace(anyColor, (all, hex) => {
      const head = all.slice(0, all.indexOf('&H') + 2);   // 保留 {\c / {\1c 前缀
      return `${head}${hex.toUpperCase()}&}`;              // 统一补尾&
    });
    if (next !== t) { state.assDoc.setEventText(ev, next); n++; }
  }
  return n;
}

function setAss(text, name) {
  clearEditPreview(false);
  clearWordPreview(false);
  pendingPlaybackRows.clear();
  overlay.hide();
  overlay.setCues([]);
  state.format = 'ass';
  state.fileName = name;
  state.srtCues = [];
  state.assDoc = new AssDoc(text);
  /* ★ 载入即自愈：先修"逐词行被清空/文本错位"再往下分析。
   *   必须在下面 normalizeAssColorTags / analyzeKaraoke **之前** ——
   *   修好之后再分析，配对看到的才是干净数据；
   *   放在后面的话，行已经按坏数据配好对了，修了也白修。 */
  healWordRows('载入字幕');
  const savedWordColor = state.assDoc.getScriptInfoComment(ASS_WORD_COLOR_META);
  // 载入即确定本稿件的逐词高亮色(无元数据 → 回到默认绿, 不能沿用上一个文件的颜色)
  setWordHighlightColor(/^#[0-9a-f]{6}$/i.test(savedWordColor) ? savedWordColor : '#00ff00');
  const fixedColors = normalizeAssColorTags();   // 必须在分析/渲染之前
  // 双轨分析: 干净整句(编辑/列表/时间轴) + 词级映射; 原始逐词文档保留给视频渲染
  state.kar = analyzeKaraoke(state.assDoc);
  if (/^#[0-9a-f]{6}$/i.test(savedWordColor)) {
    const tag = assHexToTag(savedWordColor);
    for (const sentence of state.kar.sentences) if (sentence.style === state.kar.wordStyle) sentence.highlightTag = tag;
  }
  // 载入自愈: 清掉中文整句行里的中文标点 ，、。 (→ 空格)。外部工具(WhisperX 等)导入的存量稿件
  // 常带这些标点, 而本项目的约定是中文用空格分词。必须在 analyzeKaraoke 之后(wordStyle 已知,
  // 逐词样式行不能碰)、pairRows 之前(配对看到的就是干净文本)。
  const punctFixed = normalizeZhPunctuationInSentences(state.assDoc, state.kar.sentences, state.kar.wordStyle);
  // 跨语言配对: 中文整句 + 英文逐词句 → 一行(中英双行)
  state.kar.rows = pairRows(state.kar.sentences, state.kar.wordStyle);
  // 置信度：按行号挂到 row 上（界面据此显示徽标 / 筛选）。行数对不上就不挂，
  // 宁可没有置信度显示，也不能把分数标到错误的行上。
  const confMap = parseConfidenceMeta(state.assDoc);
  if (confMap.size) {
    state.kar.rows.forEach((row, i) => { if (confMap.has(i)) row.confidence = confMap.get(i); });
  }
  state.lowConfOnly = false;
  updateWordConvertStyles();
  // 角色名标签与正文之间恒为一个空格(用户要求 '[wato] 我') —— 老文件里粘在一起的先规范掉
  const gapFixed = normalizeAllRoleGaps();
  // 载入即自动对齐"中英起止不一致"(云端识别的存量文件常带这个毛病) —— 只挪时间、不动文本,
  // 后面的 rebuildItemsAndLanes + 自动保存会把结果写回项目文件。
  const spanAligned = autoAlignEnSpans();
  // 载入自愈: 清理「中文整句样式里残留的逐词切片」行(旧版脏数据, 画面上同一句中文出现两遍、
  // 列表里挤着几条没有英文的重复中文行)。判定从严(见 ghostZhRows): 漏判不影响播放, 误判才是事故。
  const ghosts = ghostZhRows(state.kar.rows);
  for (const g of ghosts) {
    state.assDoc.deleteEvents(g.zh.events);
    const si = state.kar.sentences.indexOf(g.zh);
    if (si !== -1) state.kar.sentences.splice(si, 1);
    const ri = state.kar.rows.indexOf(g);
    if (ri !== -1) state.kar.rows.splice(ri, 1);
  }
  if (ghosts.length) state.kar.rows.forEach((r, i) => r.no = i + 1);
  // 同源病灶: 1 号切片被改写成整句时继承了行首逐词绿标 → 整行中文被染成高亮绿。
  // 说话人色永不可能是逐词绿(speakerColorOf 已排除), 双语行的中文行首见绿即剥。
  let leadFixed = 0;
  for (const r of state.kar.rows) {
    if (!r.zh || !r.en || !r.zh.events || !r.zh.events.length) continue;
    const ev = r.zh.events[0];
    const m = /^\s*(\{\\c&H([0-9A-Fa-f]{6})&\})/.exec(ev.text || '');
    if (m && HIGHLIGHT_COLORS.has(assColorToHex(m[2].toUpperCase()))) {
      state.assDoc.setEventText(ev, (ev.text || '').slice(m[1].length));   // 只剥行首那一个标签
      leadFixed++;
    }
  }
  if (ghosts.length || leadFixed) {
    const msg = [];
    if (ghosts.length) msg.push(`清理 ${ghosts.length} 条重复的中文切片残留行`);
    if (leadFixed) msg.push(`剥掉 ${leadFixed} 行的逐词绿标(整行发绿的病灶)`);
    toast('已修复旧版逐词切片脏数据：' + msg.join('，'), 6000);
  }

  /* 逐词健康检查：**报告**而不是静默继续。
   * 起因：分段导入曾经有一条路径（fork.5 之前）会让英文逐词行变成**空行**、
   * 英文整句跑到中文行里 —— 一旦落盘就永久留在文件里，而且用户看不出来
   * （列表里显示"中英双行"，但英文列是空的）。
   * 这里只**报**不自动改：怎么修取决于内容，猜着改比报出来更危险。
   * 提示里给出条数，用户就知道该不该用导出包/备份回退。 */
  {
    const blankWordRows = state.kar.rows.filter(r =>
      r.en && !r.en.words.length && !String(r.en.text || '').trim());
    const enInZhRows = state.kar.rows.filter(r =>
      r.zh && !r.zh.words.length
      && /^[A-Za-z]/.test(String(r.zh.text || '').trim())
      && !/[\u3400-\u9fff]/.test(String(r.zh.text || '')));
    if (blankWordRows.length || enInZhRows.length) {
      const parts = [];
      if (blankWordRows.length) parts.push(`${blankWordRows.length} 行英文是空的`);
      if (enInZhRows.length) parts.push(`${enInZhRows.length} 行的英文跑到了中文行里`);
      console.error('[字幕健康] 这份字幕的逐词格式像是被旧版导入写坏过：' + parts.join('，')
        + '（在编辑器里搜这些行确认；需要的话用导出的项目包回退）');
      toast('⚠ 这份字幕有逐词格式损坏：' + parts.join('，')
        + '。建议从项目包或备份恢复；重新导入那一段也能修', 12000);
    }
  }

  panel.setBadge('ASS 特效', 'ass');
  panel.setFileName(name);
  applyRoleAnnot(false);    // 重读开关(初稿勾了「区分说话人」时创建页会帮用户打开) + 同步角色 Tab/筛选
  if (fixedColors) toast(`已把 ${fixedColors} 行的颜色标签统一为大写（兼容 Subforges 等只认大写的工具）`, 5000);
  if (punctFixed) toast(`已规范 ${punctFixed} 行中文标点（，、。 → 空格；! ? 保留）`, 5000);
  if (gapFixed) toast(`已规范 ${gapFixed} 行的角色名间距（[角色] 与正文之间一个空格）`, 4000);
  if (spanAligned) toast(`已自动对齐 ${spanAligned} 行的中英起止（英文逐词原来比中文行短一截）`, 5000);
  panel.setModeOptions([
    { v: 'bi', t: '中英双行' },
    { v: 'first', t: '仅中文' },
    { v: 'second', t: '仅英文' }
  ], 'bi');
  timeline.clearRangeSel();      // 新文件 → 顺带取消批量选区
  timeline.resetView();          // 新文件 → 时间轴回到"默认 30s 跨度"
  rebuildItemsAndLanes(true);
  setAssStyleControls();
  const renderFonts = state.assStyleTargets
    ? [state.assDoc.getStyle(state.assStyleTargets.zh).fontname, state.assDoc.getStyle(state.assStyleTargets.en).fontname]
    : [];
  assPlayer.load(state.assDoc.serialize(), renderFonts);
  autoLoadSystemFonts();     // 样式里写的字体若本机装了 → 自动喂给预览
  btnExport.disabled = false;
  if (btnExportPack) btnExportPack.disabled = false;
  if (btnExportFull) btnExportFull.disabled = false;
  // 反思纠错：只在项目模式可用（要用项目里保存的 audio.wav 重识别那几段）
  if (reflectEls.btn) reflectEls.btn.disabled = !state.project;
  // 分段导入：只要有稿件就能用（它不依赖音频，纯字幕合并）
  if (btnRegionImport) btnRegionImport.disabled = !state.format;
  /* 全片逐词重校对：同样要项目模式。**不**在这里判"有没有逐词行"——
   * 这段是热路径（每次重建列表都跑），而判重要遍历全部句子；
   * 真没有逐词行时点击后服务端会给出明确原因。
   * 用 typeof 保护：realignEls 定义在文件更靠后（const 有 TDZ），
   * 而 rebuildItemsAndLanes 可能在它初始化前就被调用（启动阶段）。 */
  if (typeof realignEls !== 'undefined' && realignEls.btn) realignEls.btn.disabled = !state.project;
  const hasKar = !!state.kar.wordStyle;
  btnExportClean.disabled = !hasKar;
  btnExportJson.disabled = !hasKar;
  btnExportZh.disabled = !hasKar;
  btnExportEn.disabled = !hasKar;
  // 拼接出来的状态行要分段过词典：整段拼接后无法命中任何键（词典层是整段匹配）
  statusFile.textContent = t(`${name} · ${state.kar.rows.length} 行 / ${state.kar.sentences.length} 句`)
    + (hasKar ? t('（逐词特效）') : '');
}

// 字体名: 先去本机字体库把字体备好再套用(用户不必手动选 .ttf)
for (const [el, track] of [[assStyleEls.zhFont, 'zh'], [assStyleEls.enFont, 'en']]) {
  if (el) el.addEventListener('change', () => onFontNameChange(track));
}

/* 字体名输入框加「带预览的下拉」（见 font-picker.js）：
 * 每个字体名用它自己的字形渲染，选之前就能看到长什么样 —— 原生 datalist 只能显示纯文字。
 * 输入框本身保留（仍可手打本机没装的字体名），只在右侧多一个 ▾ 按钮。
 * 组件内部是"设 value + 派发 change"，所以上面那个 change 监听照常工作，这里不用重复接线。 */
for (const el of [assStyleEls.zhFont, assStyleEls.enFont]) {
  if (el) enhanceFontInput(el);
}
for (const el of [assStyleEls.zhSize, assStyleEls.enSize,
  assStyleEls.zhBold, assStyleEls.enBold, assStyleEls.zhItalic, assStyleEls.enItalic]) {
  if (el) el.addEventListener('change', () => applyAssStyleSettings());
}
if (assStyleEls.wordColor) assStyleEls.wordColor.addEventListener('input', () => applyAssStyleSettings());
for (const el of [assStyleEls.zhColor, assStyleEls.zhColor2, assStyleEls.enColor, assStyleEls.enColor2]) {
  if (el) el.addEventListener('input', () => applyAssStyleSettings());
}
for (const [language, buttonId] of [['zh', 'ass-style-zh-font-file-btn'], ['en', 'ass-style-en-font-file-btn']]) {
  const button = document.getElementById(buttonId);
  const input = language === 'zh' ? assStyleEls.zhFontFile : assStyleEls.enFontFile;
  if (button && input) button.addEventListener('click', () => input.click());
  if (input) input.addEventListener('change', () => loadAssStyleFont(language));
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

/* ─────────── 异常行的**类别**（供筛选） ───────────
 * 为什么需要：`badReason` 是给人看的拼接字符串，直接拿它当筛选键太脆
 * （改一个字筛选就失效）。这里把原因文本映射成稳定的类别键。
 * 文案与 markBadRows() 里 push 的那些必须对得上 —— 有单测盯着（tests/bad-cats-test.mjs）。
 */
const BAD_CATS = [
  { k: 'time',   t: '时间异常',   hint: '句时长≤0 / 时间解析失败 / 结束早于开始 / 中英时间不一致' },
  { k: 'overlap', t: '字幕重叠',  hint: '与其它字幕时间相交，或英文行内部有重复切片' },
  { k: 'lang',   t: '缺语言行',   hint: '只有中文没有英文，或只有英文没有中文' },
  { k: 'role',   t: '角色问题',   hint: '英文行含 [方括号]，或中文字幕行首没标 [人物]' },
  { k: 'words',  t: '逐词缺词',   hint: '英文行逐词数量少于文本单词数（导出后会有词不高亮）' },
];

/** 原因文本 → 类别键。返回 null 表示认不出来（会归入「其它」，仍可被「只看异常行」筛到）。 */
function classifyBadReason(reason) {
  const s = String(reason || '');
  if (!s) return null;
  // 时间类：4 种文案
  if (/句时长≤0/.test(s)) return 'time';
  if (/无法解析/.test(s)) return 'time';
  if (/结束早于开始/.test(s)) return 'time';
  if (/中英时间不一致/.test(s)) return 'time';
  // 重叠类
  if (/英文行重叠/.test(s)) return 'overlap';
  if (/^字幕重叠$/.test(s)) return 'overlap';
  // 缺语言行
  if (/单中文行|单英文行/.test(s)) return 'lang';
  // 角色 / 方括号
  if (/英文行含方括号/.test(s)) return 'role';
  if (/未标注角色/.test(s)) return 'role';
  // 逐词缺词
  if (/英文行缺词/.test(s)) return 'words';
  return null;
}

/** 把 badReason（可能含多条，用 '; ' 或 ' / ' 分隔）拆成类别集合。 */
function badCatsOf(reason) {
  const out = new Set();
  for (const piece of String(reason || '').split(/;|\s\/\s/)) {
    const k = classifyBadReason(piece.trim());
    if (k) out.add(k);
  }
  return out;
}

/* ─────────── 坏行判定 ─────────── */
/**
 * 一条字幕句子的切片是否**时间交叠**(复制粘贴常造成 → 画面叠字)。
 * 按当前事件现算: 修复/编辑换了事件后徽标即时刷新, 不依赖分析时写入的 sent.overlap。
 */
function enSlicesOverlap(sent) {
  if (!sent || !sent.events || sent.events.length < 2) return false;
  const evs = sent.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < evs.length; i++) if (evs[i].start < evs[i - 1].end - 1e-3) return true;
  return false;
}

/**
 * 汇总坏行原因(供列表 ⚠ 筛选与 tooltip):
 *   · 字幕重叠 —— 与其它条目时间相交(两种格式都检测)
 *   · 仅 ASS: 时间异常(解析失败 / 结束早于开始) / 英文行含方括号 / 单中文行 / 单英文行
 *             / 未标注角色 / 英文行缺词 / 英文行重叠
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
      // 中文行(anchor)——**必须先声明**: 下面的"中英时间不一致"校验要用到它。
      //   （1.9.2 初版把它写在用到之后 → const 的暂时性死区抛 ReferenceError
      //     → 整个列表渲染中断, ASS 项目一条字幕都不显示, 而且不报错。已修。）
      const zhS = it.ref && it.ref.zh;
      if (it.badReason) reasons.push(it.badReason);
      if (/[[\]]/.test(it.l2 || '')) reasons.push('英文行含方括号');
      const hasL1 = !!it.l1, hasL2 = !!it.l2;
      if (hasL1 && !hasL2) reasons.push('单中文行(缺英文)');
      if (!hasL1 && hasL2) reasons.push('单英文行(缺中文)');
      // 中英时间不一致: 配成双行的中文整句与英文逐词句必须**同起止**。
      //   注意别拿 en.start/en.end 来比 —— analyzeKaraoke 分组时是直接把中文行(anchor)的
      //   时间赋给英文句的(见 karaoke.js 第 253 行), 所以界面上永远"看起来一致"、永远不报。
      //   要比就比英文**切片事件自己写在文件里的时间**: 那才是导出给播放器/别人看到的真值。
      //   常见来源: 云端识别(必剪/剪映)首词起点晚于句首 → 英文行整段比中文行短一截
      //   (用户报: 中文 0.00-2.88 / 英文 0.04-0.32, 却没标坏行)。已在 server.js 生成端贴齐,
      //   这里兜住存量脏文件与手工改过的行。
      const enS2 = it.ref && it.ref.en;
      if (zhS && enS2 && (enS2.events || []).length) {
        let eS = Infinity, eE = -Infinity;
        for (const ev of enS2.events) { if (ev.start < eS) eS = ev.start; if (ev.end > eE) eE = ev.end; }
        // 容差半厘秒: ASS 只写到厘秒, 同源写入的两条不该有更大差异
        if (Math.abs(eS - zhS.start) > 0.005 || Math.abs(eE - zhS.end) > 0.005) {
          const ds = eS - zhS.start, de = eE - zhS.end;
          reasons.push(`中英时间不一致(起${ds >= 0 ? '+' : ''}${ds.toFixed(2)}s 止${de >= 0 ? '+' : ''}${de.toFixed(2)}s)`);
        }
      }
      // 未标注角色: 角色身份 = 中文行文本行首可见的 [人物] 标记(见 karaoke.js speakerTextTagOf)。
      //   · 文本里没有该标记(如 "你知道" / 拼错的 "[Spoke}") → 画面上不显示角色, 标坏行;
      //   · 整行连 Name 栏裸名都没有(row.speaker 为空) → 同样算未标注。
      // 新建的空行(isNew)在用户输入前不算 —— 否则刚拖出来的块立刻变坏行。
      // 用户在设置里禁用角色标注时(state.roleAnnot === false)整类跳过。
      const hasRoleTag = !!speakerTextTagOf(zhS);
      if (state.roleAnnot !== false && !it.isNew && (!it.speaker || (zhS && !hasRoleTag))) reasons.push('未标注角色');
      // 英文行逐词缺词(切片数 < 单词数) —— 用户报的 bug#3(缺词无警告)。
      // 注: 反向的「逐词多余」(同一词被重复高亮) 在真实文件里很常见(本示例 57 行),
      //     全量点亮会淹掉 ⚠ 徽标, 因此不并入坏行; 交给「修复字幕」按需深度检测。
      if (it.enWordCount && it.enTokenCount && it.enWordCount < it.enTokenCount) {
        reasons.push(`英文行缺词（逐词 ${it.enWordCount} 个 / 文本 ${it.enTokenCount} 词）`);
      }
      // 英文行内部切片交叠(同一条字幕有两份事件互相压住 → 画面叠字)
      if (it.enOverlap) reasons.push('英文行重叠(重复字幕)');
    }
    if (overlap.has(i)) reasons.push('字幕重叠');
    it.bad = reasons.length > 0;
    it.badReason = reasons.join('; ');
    // 结构化类别（供「异常行筛选」多选）。刻意不解析 badReason 字符串再分类 ——
    // 这里直接拿刚刚 push 进去的 reasons，最准（badReason 是拼给人看的，格式会变）。
    it.badCats = it.bad ? [...badCatsOf(reasons.join('; '))] : [];
  }
}

/* ═══════════ 视图模型重建 ═══════════ */
/**
 * 把字幕行按「时间重叠」分装到多条轨上(双行字幕轨模式用):
 * 按开始时间依次放进**第一条不冲突的轨** —— 上轨那段时间已经被占了, 才落到下一条。
 * 贪心 = 最少轨数; 于是同一条轨里的块互不重叠, 每个块都完整可见。
 * 注意: 上轨那个位置能放下就**留在上轨**, 只有真正被挡住的块才往下掉
 * (重叠的两块 = 前者留在上轨、后者掉到下轨, 不是两块都下去)。
 * 返回 { laneOf: Map<行, 轨序号>, count }。
 */
function packTracks(rows) {
  const order = rows.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const ends = [];                       // 每条轨当前的"最后结束时间"
  const laneOf = new Map();
  for (const r of order) {
    let k = ends.findIndex(e => r.start >= e - 1e-3);   // 第一条接得上的轨
    if (k < 0) { k = ends.length; ends.push(-Infinity); }
    ends[k] = r.end;
    laneOf.set(r, k);
  }
  return { laneOf, count: Math.max(1, ends.length) };
}

/** 按当前「字幕轨模式」把 cue 装到 1 条(或 N 条)轨上; label = 单行轨时用的轨道名 */
function buildTimelineLanes(rows, cues, label) {
  const one = [{ label, merged: true, cues, color: '#5b6472' }];
  if (state.trackMode !== 'double' || !rows.length || !cues.length) return one;
  const { laneOf, count } = packTracks(rows);
  if (count <= 1) return one;
  const lanes = [];
  for (let i = 0; i < count; i++) lanes.push({
    label: i === 0 ? label : ('重叠' + (i > 1 ? ' ' + (i + 1) : '')),
    merged: true, cues: [], color: '#5b6472'
  });
  for (const c of cues) {
    const k = laneOf.has(c.row) ? laneOf.get(c.row) : 0;
    lanes[Math.min(k, count - 1)].cues.push(c);
  }
  for (const l of lanes) l.cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return lanes.filter(l => l.cues.length);
}

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
          badReason: [badReasonOf(zhS), badReasonOf(enS)].filter(Boolean).join(' / '),
          // 英文逐词缺词/重复/交叠检测用(用户报: 重复字幕被并成一句、缺词无警告)
          enWordCount: enS && enS.words ? enS.words.length : 0,
          enTokenCount: enS ? splitEnglishWords(enS.text.replace(/\[[^\]]+\]/g, '')).length : 0,
          enOverlap: enSlicesOverlap(enS),
          confidence: row.confidence || null      // ASR 置信度（没有该元数据时为 null）
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

  // 低置信度计数 → 工具栏的「只看低置信度」按钮（没有该元数据时恒为 0，按钮自动禁用）
  if (window.__refreshBadCat) setTimeout(window.__refreshBadCat, 0);   // 异常类别计数跟着列表刷新
  panel.setLowCount(state.items.filter(i => i.confidence && i.confidence.low).length,
    '只显示 ASR 置信度偏低的行（识别可能不准，建议复核）');

  // 坏行计数 → 搜索框旁的 ⚠ 按钮
  panel.setBadCount(state.items.filter(i => i.bad).length,
    state.format === 'ass'
      ? '时间异常 / 重叠 / 未标注角色 / 单语行 / 中英时间不一致 / 英文含方括号 / 英文缺词 / 英文行重叠'
      : '字幕重叠');

  // 时间轴车道: 每个样式一条轨道(中文 / 英文各归其位); 块内带文本
  if (state.format === 'srt') {
    // SRT 与 ASS 同款块样式: 一条合并轨(高度撑满), 块内中间灰色分隔线切两半
    //   · 上半区 = 主语言(lines[0])
    //   · 下半区 = 副语言(其余行)
    // SRT 不做逐词(无 words → 块内只画"主语言 / 分隔线 / 副语言")
    const cues = state.srtCues.map(c => {
      const { main, subs } = splitBilingual(c.lines);
      const it = state.itemByRef.get(c);
      return {
        start: c.start, end: c.end, ref: c, row: c,
        text2: (main || '').replace(/<[^>]+>/g, '').slice(0, 60),                 // 上半: 主语言
        text: subs.map(l => l.replace(/<[^>]+>/g, '')).join(' / ').slice(0, 60),  // 下半: 副语言
        bad: !!(it && it.bad), badReason: it ? (it.badReason || '') : ''
      };
    });
    // 兜底色用与 ASS 相同的中性石板灰(SRT 没有说话人颜色)
    timeline.setLanes(buildTimelineLanes(state.srtCues, cues, '双语字幕'));
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
      // 坏行(含重叠)标记下传到每个 cue, 时间轴据此在块上画警告(用户报的 bug#2:
      // 英文行重叠要在下半区也能看到)
      const item = state.itemByRef.get(row);
      const bad = !!(item && item.bad);
      const badReason = item ? (item.badReason || '') : '';
      if (zh && en && sameTime(zh, en)) {
        hasFull = true;
        cues.push({
          start: row.start, end: row.end, ref: row, row,
          text: (enText || '').slice(0, 60), text2: (zhText || '').slice(0, 60),
          words: (en && en.words && en.words.length) ? en.words : null,   // 词级时间: 时间轴块内逐词平铺
          color, speaker: row.speaker || '', bad, badReason
        });
      } else {
        if (zh) { hasTop = true; cues.push({ start: zh.start, end: zh.end, ref: row, row, text: zhText.slice(0, 60), color, half: 'top', bad, badReason }); }
        if (en) cues.push({
          start: en.start, end: en.end, ref: row, row,
          text: enText.slice(0, 60), color: en.color || color, half: 'bottom',
          words: (en.words && en.words.length) ? en.words : null,
          bad, badReason
        });
      }
    }
    // 命中测试/绘制都依赖按开始时间有序
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    if (cues.length) {
      // 纯单行文件里"中英双语"这个名字会不对, 按实际内容取标签
      const label = hasFull ? '中英双语' : (hasTop ? (zhStyle || '中文字幕') : (enStyle || 'Default'));
      // 兜底色用中性石板灰: 有说话人内联色时逐块覆盖, 没有时不至于被误读为某个说话人的颜色
      timeline.setLanes(buildTimelineLanes(state.kar.rows, cues, label));
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
  updateFixButton();
  // 批量选区的条目数可能因增删/改时间而变 → 重建后同步一下浮条(没有选区时什么都不做)
  if (timeline.rangeSel) refreshRangeBar();
  // 没载入字幕时「刷新字幕」不可点
  if (btnRefresh) btnRefresh.disabled = !state.format;
  // 项目模式: 数据真的变了(文本/时间/增删/角色) → 计划一次自动保存(内部脏检查, 重复触发无害)
  if (rebuildItems && state.project) Projects.scheduleSave();
}

/* ═══════════ 分段导入：把一段字幕并进已有稿件（多人协作）═══════════
 *
 * 场景：一个稿件分给几个人做，各人拿同一份参考视频、各自导出一份字幕。
 * **每份文件的时间轴都从 0 开始**，所以要显式告诉程序"我这份的 0:00 对应本稿的第几秒"。
 *
 * 做法（三条约定见 region-merge.js）：
 *   · 默认**只填空档** —— 碰到已有字幕就列出来问，绝不静默覆盖别人的成果
 *   · 平移量是显式输入，程序不猜
 *   · 写回**复用 addRecognizedRow**（反思纠错用的同一条路径），不另造一套
 */
const rimEls = {
  overlay: document.getElementById('rim-overlay'),
  fileName: document.getElementById('rim-file-name'),
  pick: document.getElementById('rim-pick'),
  file: document.getElementById('rim-file'),
  start: document.getElementById('rim-start'),
  end: document.getElementById('rim-end'),
  fromSel: document.getElementById('rim-from-sel'),
  rangeNote: document.getElementById('rim-range-note'),
  summary: document.getElementById('rim-summary'),
  list: document.getElementById('rim-list'),
  cancel: document.getElementById('rim-cancel'),
  recheck: document.getElementById('rim-recheck'),
  apply: document.getElementById('rim-apply'),
  applyForce: document.getElementById('rim-apply-force'),
};
/** 当前待导入的内容（解析一次、多次重算计划，避免每次改区间都重读文件） */
let rimCues = null;      // [{start, end, lines}]（**完整时间轴**，不做平移）
let rimName = '';
let rimPlan = null;
let rimSelTimer = 0;     // 盯着时间轴选区，拖完自动填（对话框不挡时间轴，用户随时能拖）

/** 从 SRT / ASS 文本里取出「一行字幕 = 起止时间 + 主/副语言」，交给 region-merge 做判定 */
function rimParseCues(text, name) {
  const isAss = /\.(ass|ssa)$/i.test(name || '');
  if (isAss) {
    const doc = new AssDoc(text);
    const evs = doc.events.filter(e => Number.isFinite(e.start) && Number.isFinite(e.end));
    if (!evs.length) return [];
    /* ⚠ 这里**不能**"一条 Dialogue 当一行字幕"。
     * 逐词 ASS 里一句英文是**每词一条 Dialogue**，一条当一行会把整句拆成上千行：
     * 用户实测 226 句的稿件被读成「区间内 43 行」、中英配对错乱、逐词高亮全丢。
     * 交给 ass-group.js 按"句"聚合（判据只看文本与时间，不依赖样式名）。 */
    const rows = evs.map(ev => ({
      start: ev.start, end: ev.end, style: ev.style || '',
      name: ev.name || '', text: ev.text || '',
    }));
    const g = groupAssRows(rows);
    if (!g.ok) return [];
    console.log(`[rim] ASS 解析：${rows.length} 条 Dialogue → ${g.lines.length} 句`
      + `（逐词 ${g.stats.wordRows} 条 / 整句 ${g.stats.sentRows} 条，逐词样式 ${JSON.stringify(g.stats.wordStyles)}）`);
    return g.lines;
  }
  const cues = parseSRT(text);
  return cues.map(c => ({ start: c.start, end: c.end, lines: c.lines }));
}

/** 读当前填的「这一段」。返回 { ok, start, end, error } */
function rimReadRange() {
  const rawS = String((rimEls.start || {}).value || '').trim();
  const rawE = String((rimEls.end || {}).value || '').trim();
  if (!rawS && !rawE) return { ok: false, empty: true, error: '先填「这一段」的起止时间（也可以先在时间轴上拖个选区，再点「用选区」）' };
  const s = parseRegionTime(rawS), e = parseRegionTime(rawE);
  if ((rawS && s === null) || (rawE && e === null)) {
    return { ok: false, error: '时间看不懂，用 秒（300）、分:秒（5:00）或 时:分:秒（1:02:03）' };
  }
  const a = s === null ? 0 : s;
  if (e === null) return { ok: false, error: '「这一段」需要一个结束时间' };
  if (e <= a) return { ok: false, error: `结束时间（${e}s）必须大于开始时间（${a}s）` };
  return { ok: true, start: a, end: e, error: '' };
}

/** 用当前区间重算计划并刷新预览 */
function rimRecheck() {
  if (!rimCues) { rimEls.apply.disabled = true; rimEls.applyForce.hidden = true; return; }
  const rg = rimReadRange();
  if (!rg.ok) {
    if (rimEls.rangeNote) { rimEls.rangeNote.textContent = rg.empty ? '' : rg.error; rimEls.rangeNote.className = 'np-region-note' + (rg.empty ? '' : ' bad'); }
    rimShowSummary('', false);
    if (rimEls.list) { rimEls.list.innerHTML = ''; rimEls.list.hidden = true; }
    rimEls.apply.disabled = true; rimEls.applyForce.hidden = true;
    return;
  }
  if (rimEls.rangeNote) { rimEls.rangeNote.textContent = ''; rimEls.rangeNote.className = 'np-region-note'; }
  const rows = (state.items || []).map(it => ({ start: it.start, end: it.end, text: it.l1 || it.l2 || '' }));
  rimPlan = planRegionMerge(rimCues, rows, rg.start, rg.end);
  if (!rimPlan.ok) {
    rimShowSummary(rimPlan.error, true);
    if (rimEls.list) { rimEls.list.innerHTML = ''; rimEls.list.hidden = true; }
    rimEls.apply.disabled = true; rimEls.applyForce.hidden = true;
    return;
  }
  rimShowSummary(mergeSummary(rimPlan), !rimPlan.picked);
  rimRenderList(rimPlan);
  const canFill = rimPlan.items.length > 0;
  rimEls.apply.disabled = !canFill;
  rimEls.apply.textContent = canFill ? `只导入空档（${rimPlan.items.length} 行）` : '没有可导入的行';
  // 有冲突才给"覆盖"这个选项 —— 平时不该出现破坏性按钮
  const hasClash = rimPlan.conflicts.length > 0;
  rimEls.applyForce.hidden = !hasClash;
  rimEls.applyForce.textContent = hasClash ? `重叠处也覆盖（${rimPlan.conflicts.length} 行）` : '';
  rimEls.recheck.hidden = false;
}

function rimShowSummary(text, bad) {
  if (!rimEls.summary) return;
  rimEls.summary.textContent = text;
  rimEls.summary.hidden = !text;
  rimEls.summary.classList.toggle('rim-bad', !!bad);
}

/** 预览用的行标签：双语行要把主/副语言都显示出来。
 *  只显示一行的话，用户看不出中英有没有配对上（而这正是分段导入最容易出错的地方）。 */
function rimRowLabel(r, max = 40) {
  const zh = String((r && r.zh) || '').trim();
  const en = String((r && r.en) || '').trim();
  if (zh && en) return rowLabel({ zh }, max) + ' ／ ' + rowLabel({ zh: en }, max);
  return rowLabel(r, max * 2);
}

function rimRenderList(plan) {
  const box = rimEls.list;
  if (!box) return;
  const rows = [];
  for (const r of plan.items.slice(0, 60)) {
    rows.push(`<div class="rim-item"><span class="rim-ok">可导入</span>`
      + `<span class="rim-t">${fmtTime(r.start)} → ${fmtTime(r.end)}</span>`
      + `<span class="rim-x">${escapeHtml(rimRowLabel(r, 40))}</span>`
      + (r.stretched ? '<span class="rim-note">零长行已撑宽</span>' : '') + '</div>');
  }
  for (const r of plan.conflicts.slice(0, 60)) {
    rows.push(`<div class="rim-item rim-clash"><span class="rim-no">重叠</span>`
      + `<span class="rim-t">${fmtTime(r.start)} → ${fmtTime(r.end)}</span>`
      + `<span class="rim-x">${escapeHtml(rimRowLabel(r, 40))}</span>`
      + `<span class="rim-note">本稿此处已有：${escapeHtml(rowLabel(r.with, 22))}</span></div>`);
  }
  const more = (plan.items.length + plan.conflicts.length) - rows.length;
  if (more > 0) rows.push(`<div class="rim-item"><span class="rim-note">另有 ${more} 行未列出</span></div>`);
  box.innerHTML = rows.join('');
  box.hidden = !rows.length;
}

/** 逐词字幕自愈开关（全局设置里那个勾，默认**开**）。
 *  默认开的原因：它会修的那种损坏一旦写进文件、界面上**看不出来**
 *  （列表显示"中英双行"，只是英文列是空的），而修复时机是"打开/导入"——
 *  那时对话框已经关了，用户没机会点。所以默认替用户兜着，但要给关掉的入口。 */
const HEAL_WORDS_KEY = 'ss-heal-words';
function healWordsEnabled() {
  try { return localStorage.getItem(HEAL_WORDS_KEY) !== '0'; } catch { return true; }
}
function initHealWordsToggle() {
  const cb = document.getElementById('cb-heal-words');
  if (!cb) return;
  cb.checked = healWordsEnabled();
  cb.addEventListener('change', () => {
    try { localStorage.setItem(HEAL_WORDS_KEY, cb.checked ? '1' : '0'); } catch { /* ignore */ }
    toast(cb.checked ? '已开启逐词字幕自愈' : '已关闭逐词字幕自愈（仍会在控制台提示）', 4200);
  });
}
initHealWordsToggle();

/** 逐词字幕自愈：把"被清空 / 错位"的逐词文本搬回来。
 *
 *  用户实测过这种损坏（逐行对比正常稿件与坏文件，时间戳一模一样）：
 *    · 逐词行的**文本被清空**（画面上英文永远整句亮着、没有逐词推进）
 *    · 那份文本（连 `{\c&H..&}` 高亮标签一起丢了）跑到了**同时间戳**的另一行上
 *  本函数按"同一时间戳 + 文本非空 + 唯一 + 非中文"把文本搬回去，
 *  任何不确定的情况都跳过（`analyzeDamage` 里已保证）。
 *
 *  安全性：**正常稿件里没有空行**，所以这里在正常稿件上是 no-op。
 *  实测：你的真实项目（3676 行）与 Downloads 里 140 多个 .ass 中，
 *  只有 1 个真坏的命中 —— 其余全部空转。
 *  调用点：分段导入之后（主要防线）+ 载入字幕之后（兜底）。
 *  开关：全局设置里的「逐词字幕自愈」（关掉后只提示不改）。
 *
 *  @returns {number} 实际修复的行数
 */
function healWordRows(where) {
  if (state.format !== 'ass' || !state.assDoc) return 0;
  const evs = state.assDoc.events;
  if (!evs || !evs.length) return 0;
  const rows = evs.map(ev => ({ ev, start: ev.start, end: ev.end, text: ev.text || '' }));
  const analysis = analyzeDamage(rows);
  if (!analysis.damaged) return 0;
  const plan = planWordRepair(analysis);
  if (!healWordsEnabled()) {
    // 关掉了开关：只提示、不动稿件。
    // 而且**不弹 toast**（关掉就是不想被打扰），但控制台一定留一条，
    // 否则用户永远不知道自己的文件是坏的。
    console.warn(`[heal] ${where || ''} 检测到逐词字幕错位 ${plan.edits.length} 行（自愈已关闭，未改动）；`
      + `在「全局设置 → 逐词字幕自愈」里可以打开`);
    return 0;
  }
  let n = 0;
  for (const e of plan.edits) {
    try { state.assDoc.setEventText(e.row.ev, e.text); n++; }
    catch (err) { console.warn('[heal] 写入失败', err); }
  }
  if (plan.deletes.length) {
    try { state.assDoc.deleteEvents(plan.deletes.map(d => d.row.ev)); }
    catch (err) { console.warn('[heal] 删除副本失败', err); }
  }
  const msg = repairSummary(analysis, plan);
  if (msg) {
    console.warn(`[heal] ${where || ''} ${msg}`);
    toast(`⚠ 检测到逐词字幕错位，已自动修好：${msg}`, 9000);
  }
  return n;
}

/** 打开对话框 */
function rimOpen() {
  if (!state.format) { toast('先打开一份字幕', 3600); return; }
  rimCues = null; rimName = ''; rimPlan = null;
  if (rimEls.fileName) { rimEls.fileName.textContent = '还没选'; rimEls.fileName.classList.remove('filled'); }
  if (rimEls.rangeNote) { rimEls.rangeNote.textContent = ''; rimEls.rangeNote.className = 'np-region-note'; }
  rimFillFromSel(true);
  rimShowSummary('', false);
  if (rimEls.list) { rimEls.list.innerHTML = ''; rimEls.list.hidden = true; }
  rimEls.apply.disabled = true; rimEls.applyForce.hidden = true; rimEls.recheck.hidden = true;
  rimEls.overlay.hidden = false;
  // 这个对话框不挡时间轴，用户随时可以拖选区 —— 每秒看一眼，拖完自动填进来
  if (rimSelTimer) clearInterval(rimSelTimer);
  rimSelTimer = setInterval(() => {
    if (rimEls.overlay.hidden) { clearInterval(rimSelTimer); rimSelTimer = 0; return; }
    rimFillFromSel(false);
  }, 500);
}

/** 时间轴上拖了选区就自动填进「这一段」（用户不用再找「用选区」按钮）。
 *  @param {boolean} force 打开对话框时用：有选区就填，没有就清空 */
function rimFillFromSel(force) {
  const sel = timeline.rangeSel;
  const btn = rimEls.fromSel;
  const has = !!(sel && sel.b > sel.a);
  if (btn) {
    btn.disabled = !has;
    btn.title = has ? '用时间轴上已拖出的选区填这两个框' : '先在时间轴上拖一段选区';
  }
  if (!has) { if (force) { if (rimEls.start) rimEls.start.value = ''; if (rimEls.end) rimEls.end.value = ''; } return; }
  const a = fmtTime(sel.a), b = fmtTime(sel.b);
  if (rimEls.start && rimEls.start.value === a && rimEls.end && rimEls.end.value === b) return;  // 没变就别动
  if (rimEls.start) rimEls.start.value = a;
  if (rimEls.end) rimEls.end.value = b;
  rimRecheck();
}

/** 执行导入。force=true 时把冲突处也覆盖（用户点了那个按钮才算数） */
function rimApply(force) {
  if (!rimPlan || !rimPlan.ok) return;
  const res = force ? resolveReplace(rimPlan) : resolveFillOnly(rimPlan);
  const add = res.add || [];
  if (!add.length) { toast('没有可导入的行', 3600); return; }
  const before = state.items.length;
  if (force && res.replace && res.replace.length) {
    // 先删被覆盖的（用与批量删除同一套 removeItemData, 不手改数组）
    for (const rg of res.replace) {
      for (const it of itemsInRange(rg.start, rg.end)) removeItemData(it);
    }
  }
  let added = 0;
  for (const r of add) {
    try {
      /* ★ 传**原文件的真实词级时间**（ass-group 从逐词行里提取的：那一行的起止就是那个词的时间）。
       * 不传的话 addRecognizedRow 会调 recalcWords 在句内均匀铺开 ——
       * 词序看着对，但节奏是假的（用户实测："逐词不准确，这不是原字幕里的逐词顺序吧"）。 */
      const row = addRecognizedRow({
        start: r.start, end: r.end, zh: r.zh, text: r.en,
        words: (r.words || []).map(w => ({ word: w.word, start: w.start, end: w.end })),
      });
      if (row) added++;
    } catch (e) {
      console.warn('[rim] 插入一行失败', e);
    }
  }
  // ★ 导入后自动自愈：把"被清空/错位"的逐词文本搬回来。
  //   放在这个位置的原因：损坏一旦写进文件就会永久留下（列表里看不出、画面只是
  //   "整句一直亮着"），所以每次导入都顺手体检一遍，而不是等用户发现再处理。
  const healed = healWordRows('分段导入后');
  rebuildItemsAndLanes(true);
  const rg = rimReadRange();
  const sum = `分段导入：进来 ${added} 行（原 ${before} 行 → 现 ${state.items.length} 行）`
    + (force && res.replace ? `，覆盖 ${res.replace.length} 处` : '')
    + (healed ? `；顺带修好 ${healed} 行错位的逐词文本` : '')
    + `；区间 ${rg.ok ? fmtTime(rg.start) + '~' + fmtTime(rg.end) : '?'}，来源 ${rimName}`;
  toast(sum, 8000);
  if (typeof logOp === 'function') logOp('导入', '分段字幕', sum);
  rimEls.overlay.hidden = true;
}

if (btnRegionImport) btnRegionImport.addEventListener('click', rimOpen);
if (rimEls.cancel) rimEls.cancel.addEventListener('click', () => {
  rimEls.overlay.hidden = true;
  if (rimSelTimer) { clearInterval(rimSelTimer); rimSelTimer = 0; }   // 停止盯选区
});
if (rimEls.pick) rimEls.pick.addEventListener('click', () => rimEls.file.click());
if (rimEls.file) rimEls.file.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let text = await f.text();
  // 带特效的导出行会污染解析（与创建页导入同一处理）
  if (/\.(ass|ssa)$/i.test(f.name)) {
    const { text: cleanedText } = stripEffectTagsSafe(text);
    text = cleanedText;
  }
  try {
    rimCues = rimParseCues(text, f.name);
  } catch (err) {
    rimCues = null;
    rimShowSummary('这个文件解析不了：' + (err && err.message ? err.message : err), true);
    return;
  }
  if (!rimCues.length) { rimShowSummary('这个文件里没解析出字幕行', true); return; }
  rimName = f.name;
  rimEls.fileName.textContent = `${f.name}（${rimCues.length} 行）`;
  rimEls.fileName.classList.add('filled');
  rimRecheck();
});
if (rimEls.start) rimEls.start.addEventListener('input', rimRecheck);
if (rimEls.end) rimEls.end.addEventListener('input', rimRecheck);
if (rimEls.fromSel) rimEls.fromSel.addEventListener('click', () => {
  const sel = timeline.rangeSel;
  if (!sel || sel.b <= sel.a) { toast('先在时间轴上拖出一段选区', 4200); return; }
  if (rimEls.start) rimEls.start.value = fmtTime(sel.a);
  if (rimEls.end) rimEls.end.value = fmtTime(sel.b);
  rimRecheck();
});
if (rimEls.recheck) rimEls.recheck.addEventListener('click', rimRecheck);
if (rimEls.apply) rimEls.apply.addEventListener('click', () => rimApply(false));
if (rimEls.applyForce) rimEls.applyForce.addEventListener('click', () => {
  rimApply(true);
});

/* ═══════════ 角色(说话人) ═══════════ */
/* speakerNames(取 Name 栏里的人物名列表) 已挪到 karaoke.js 并导出 —— 换色纯函数 recolorRoleInRows
 * 也要用它, 放在纯逻辑模块里才可单测。这里直接用导入的那份（见文件顶部 import）。 */

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
  // 排序统一交给 karaoke.js 的 sortRoles(按名称首字母升序, 大小写不敏感) ——
  // 以前这里按"出现次数降序", 高频角色会跳来跳去, 找一个不常出现的角色要扫全表(上游 2.1.13 改)。
  return sortRoles([...map.values()]);
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
    toast(`已添加角色「${name}」，点它就能应用到当前播放的那句`);
  });
};

/** 把事件文本行首可见的 [旧tag] 换成 tag(没有则补上); 不动 {\...} 覆盖标签 */
function setEventSpeakerTag(ev, tag) {
  // 纯逻辑在 karaoke.js 的 setSpeakerTagInText: "替换"与"插入"两条分支都保证标签与正文之间一个空格。
  // 以前插入分支直接拼 tag + 正文 → 初稿(没做说话人分离、没有角色名)后在编辑器里指定角色,
  // 会得到 "[Spoke]正文"(用户报的 bug)。
  state.assDoc.setEventText(ev, setSpeakerTagInText(ev.text || '', tag));
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
  if (!hits.length) { toast('播放头不在任何字幕块内。先用播放或点一下定位到要改的那句，再点角色'); return; }
  if (hits.length === 1) { doAssignSpeaker(hits[0], name); return; }
  hits.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  panel.showRowPicker('这里重叠了好几条字幕，选一条设置角色：', hits.map(r => ({
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

/** 全局换色: 把该角色**名下所有中文字幕行**的行首色标换成新色(原本没色标的补上)。
 *  核心逻辑在 karaoke.js 的 recolorRoleInRows(纯函数, 有单测) —— 按**角色名**定位,
 *  不按"旧颜色值"匹配: 旧实现在两个角色撞色时会改到别人身上(上游 2.1.13 修的 bug)。 */
function recolorRoleGlobally(role, newHex) {
  const names = speakerNames(role.raw);
  names.push(role.name);
  return recolorRoleInRows(state.assDoc, state.kar.rows, names, newHex);
}

/* ═══════════ 选中 / 编辑 ═══════════ */
function selectItem(item, seek = true) {
  state.selected = item;
  panel.select(item);
  timeline.setSelected(item.ref);
  updateFixButton();
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

/* ═══════════ 查找与批量替换 ═══════════
 * 顶部搜索框只做实时过滤; 这个弹窗做逐条定位与批量替换:
 *  正文 tab: 按关键词在中文/英文明文里查(范围/区分大小写/全词匹配), 逐条跳转或批量替换;
 *  角色 tab: 源角色必须是已有角色, 把它的台词替换成目标角色(可输入新名字=新建)。 */
const fr = { el: {}, tab: 'text', matches: [], cur: -1, srcRole: '' };

function frInit() {
  const ids = ['fr-overlay', 'fr-close', 'fr-tab-text', 'fr-tab-role', 'fr-text-opts',
    'fr-scope', 'fr-case', 'fr-word', 'fr-pane-text', 'fr-pane-role', 'fr-find', 'fr-repl',
    'fr-src', 'fr-src-dd', 'fr-src-menu', 'fr-dst', 'fr-dst-dd', 'fr-dst-menu',
    'fr-status', 'fr-prev', 'fr-next', 'fr-locate', 'fr-replace-one', 'fr-replace-all'];
  for (const id of ids) fr.el[id] = document.getElementById(id);
  if (!fr.el['fr-overlay']) return;
  fr.el['fr-tab-text'].addEventListener('click', () => frSetTab('text'));
  fr.el['fr-tab-role'].addEventListener('click', () => frSetTab('role'));
  fr.el['fr-close'].addEventListener('click', frClose);
  fr.el['fr-overlay'].addEventListener('pointerdown', (e) => { if (e.target === fr.el['fr-overlay']) frClose(); });
  fr.el['fr-find'].addEventListener('input', frScan);
  for (const id of ['fr-scope', 'fr-case', 'fr-word']) fr.el[id].addEventListener('change', frScan);
  fr.el['fr-find'].addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); frGo(1); } });
  fr.el['fr-prev'].addEventListener('click', () => frGo(-1));
  fr.el['fr-next'].addEventListener('click', () => frGo(1));
  fr.el['fr-locate'].addEventListener('click', frLocate);
  fr.el['fr-replace-one'].addEventListener('click', frReplaceCurrent);
  fr.el['fr-replace-all'].addEventListener('click', frReplaceAll);
  // 角色组合框: 输入(回车/失焦确认源角色) + 下拉候选
  fr.el['fr-src'].addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); frConfirmSrc(); } });
  fr.el['fr-src'].addEventListener('change', frConfirmSrc);
  fr.el['fr-src-dd'].addEventListener('click', (e) => { e.stopPropagation(); frToggleMenu('src'); });
  fr.el['fr-dst-dd'].addEventListener('click', (e) => { e.stopPropagation(); frToggleMenu('dst'); });
  document.addEventListener('click', (e) => {
    for (const w of ['src', 'dst']) {
      const menu = fr.el[w + '-menu'];
      if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== fr.el[w + '-dd']) menu.hidden = true;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !fr.el['fr-overlay'].hidden) { e.preventDefault(); e.stopPropagation(); frClose(); }
  }, true);
}

/** 角色标注关闭时, "查找与批量替换"里的角色页签**不可进入**（用户要求）。 */
function frSetRolesAvailable(on) {
  const btn = fr.el['fr-tab-role'];
  if (!btn) return;
  btn.disabled = !on;
  btn.title = on ? '' : t('已在设置里关闭「角色标注」，这个页签不可用');
  if (!on && fr.tab === 'role') frSetTab('text');
}

function frOpen() {
  if (state.format !== 'ass' || !state.kar) { toast('查找与批量替换仅支持 ASS 字幕'); return; }
  fr.el['fr-overlay'].hidden = false;
  frSetRolesAvailable(!!panel._rolesEnabled);
  frSetTab('text');
  setTimeout(() => fr.el['fr-find'].focus(), 0);
}
function frClose() { fr.el['fr-overlay'].hidden = true; }

function frStatus(msg, hasMatch) {
  fr.el['fr-status'].textContent = msg;
  fr.el['fr-status'].classList.toggle('has-match', !!hasMatch);
}

function frSetTab(tab) {
  fr.tab = tab;
  fr.el['fr-tab-text'].classList.toggle('active', tab === 'text');
  fr.el['fr-tab-role'].classList.toggle('active', tab === 'role');
  fr.el['fr-text-opts'].hidden = tab !== 'text';
  fr.el['fr-pane-text'].hidden = tab !== 'text';
  fr.el['fr-pane-role'].hidden = tab !== 'role';
  fr.matches = []; fr.cur = -1;
  if (tab === 'text') frScan();
  else {
    fr.srcRole = '';
    fr.el['fr-src'].value = '';
    frStatus(t('输入或展开候选并确认一个源角色'));
  }
}

/** 由查找输入构造正则(已转义, 含大小写/全词选项), 无关键词返回 null */
function frRegex() {
  const q = fr.el['fr-find'].value;
  if (!q) return null;
  let src = escapeReg(q);
  if (fr.el['fr-word'].checked) src = '\\b(?:' + src + ')\\b';
  try { return new RegExp(src, fr.el['fr-case'].checked ? 'g' : 'gi'); } catch { return null; }
}

/** 重新扫描匹配(正文: 按关键词; 角色: 按已确认的源角色) */
function frScan() {
  fr.matches = []; fr.cur = -1;
  if (fr.tab === 'text') {
    const re = frRegex();
    if (!re) { frStatus(t('输入正文关键词后开始查找')); return; }
    const scope = fr.el['fr-scope'].value;
    const fields = scope === 'zh' ? ['zh'] : scope === 'en' ? ['en'] : ['zh', 'en'];
    let occ = 0;
    for (const row of state.kar.rows) {
      for (const f of fields) {
        const s = row[f] && row[f].text;
        if (!s) continue;
        const m = s.match(new RegExp(re.source, 'g' + (fr.el['fr-case'].checked ? '' : 'i')));
        if (m) { fr.matches.push({ row, field: f }); occ += m.length; }
      }
    }
    frStatus(fr.matches.length
      ? t(`找到 ${fr.matches.length} 行 / 共 ${occ} 处`)
      : t('没有找到匹配的字幕。试试关掉「区分大小写」或「全词匹配」'), fr.matches.length > 0);
  } else {
    if (!fr.srcRole) { frStatus(t('输入或展开候选并确认一个源角色')); return; }
    frScanRole();
  }
}

function frScanRole() {
  const key = fr.srcRole.toLowerCase();
  // 「未分配角色」是虚拟角色: 指代所有没有 [角色] 标签的行（不在角色列表里, 只在这个页签可选）
  fr.matches = (key === UNASSIGNED_ROLE.toLowerCase())
    ? state.kar.rows.filter(r => isUnassignedRole(r)).map(r => ({ row: r, field: null }))
    : state.kar.rows
      .filter(r => speakerNames(r.speaker).map(x => x.toLowerCase()).includes(key))
      .map(r => ({ row: r, field: null }));
  fr.cur = -1;
  frStatus(t(`「${fr.srcRole}」共 ${fr.matches.length} 行，可逐条跳转或替换`), fr.matches.length > 0);
}

function frGoto(m) {
  const item = state.itemByRef.get(m.row);
  if (item) selectItem(item, true);          // 选中 + 播放头跳过去
  else video.currentTime = m.row.start + 0.001;
}

function frGo(dir) {
  if (!fr.matches.length) { frScan(); if (!fr.matches.length) return; }
  fr.cur = ((fr.cur + dir) % fr.matches.length + fr.matches.length) % fr.matches.length;
  frGoto(fr.matches[fr.cur]);
  frStatus(t(`第 ${fr.cur + 1}/${fr.matches.length} 条`), true);
}
function frLocate() {
  if (!fr.matches.length) { frScan(); if (!fr.matches.length) return; }
  const time = video.currentTime;
  let idx = fr.matches.findIndex(m => time >= m.row.start - 1e-3 && time <= m.row.end + 1e-3);
  if (idx < 0) idx = fr.matches.findIndex(m => m.row.start > time);
  if (idx < 0) idx = fr.matches.length - 1;
  fr.cur = idx;
  frGoto(fr.matches[idx]);
  frStatus(t(`第 ${idx + 1}/${fr.matches.length} 条`), true);
}

/** 对一行的某个语言字段执行替换(在明文上替换, 经 apply*Sentence 重建事件/逐词); 返回替换处数 */
function frReplaceField(row, field, re, replText) {
  const sent = row[field];
  if (!sent) return 0;
  const txt = sent.text || '';
  if (!txt) return 0;
  const ms = txt.match(new RegExp(re.source, 'g' + (re.flags.includes('i') ? 'i' : '')));
  if (!ms) return 0;
  const nt = txt.replace(new RegExp(re.source, 'g' + (re.flags.includes('i') ? 'i' : '')), () => replText);
  if (field === 'zh') applyAnchorSentence(sent, row.start, row.end, nt);
  else applyWordSentence(sent, row.start, row.end, nt);
  return ms.length;
}

function frCommit() {
  if (state.format === 'ass' && state.assDoc) assPlayer.updateNow(state.assDoc.serialize());
  reconcileKaraoke();
  rebuildItemsAndLanes(true, true);
}

function frReplaceCurrent() {
  if (fr.tab === 'role') return frReplaceRole(false);
  if (!fr.matches.length) { frScan(); if (!fr.matches.length) { toast('没有可替换的匹配'); return; } }
  if (fr.cur < 0) fr.cur = 0;
  const re = frRegex();
  if (!re) { toast('先输入查找内容'); return; }
  const m = fr.matches[fr.cur];
  const n = frReplaceField(m.row, m.field, re, fr.el['fr-repl'].value);
  if (n) {
    frCommit();
    frScan();
    toast(t(`已替换 ${n} 处`));
  } else toast('该行没有匹配');
}

function frReplaceAll() {
  if (fr.tab === 'role') return frReplaceRole(true);
  const re = frRegex();
  if (!re) { toast('先输入查找内容'); return; }
  if (!fr.matches.length) frScan();
  if (!fr.matches.length) { toast('没有找到匹配的字幕'); return; }
  const repl = fr.el['fr-repl'].value;
  let occ = 0;
  for (const m of fr.matches) occ += frReplaceField(m.row, m.field, re, repl);
  frCommit();
  frScan();
  toast(t(`全部替换完成，共 ${occ} 处`));
}

/* ── 角色 tab ── */
function frToggleMenu(which) {
  const menu = fr.el['fr-' + which + '-menu'];
  if (!menu.hidden) { menu.hidden = true; return; }
  const other = fr.el[which === 'src' ? 'fr-dst-menu' : 'fr-src-menu'];
  if (other) other.hidden = true;
  const roles = computeRoles();
  // 虚拟角色「未分配角色」永远排在最前: 指代所有没有 [角色] 标签的行。
  // 它**不进** computeRoles / 角色列表 / 角色筛选, 只在这里可选(用户要求"角色列表不显示")。
  const unassigned = `<button type="button" class="fr-menu-item fr-menu-unassigned" data-name="${escapeHtml(t(UNASSIGNED_ROLE))}">
        <span class="pick-dot" style="background:#5b6472"></span>
        <span>${escapeHtml(t(UNASSIGNED_ROLE))}</span><span class="fr-menu-n">${unassignedCount()}</span>
      </button>`;
  menu.innerHTML = unassigned + (roles.length
    ? roles.map(r => `<button type="button" class="fr-menu-item" data-name="${escapeHtml(r.name)}">
        <span class="pick-dot" style="background:${r.color || '#5b6472'}"></span>
        <span>${escapeHtml(r.name)}</span><span class="fr-menu-n">${r.count}</span>
      </button>`).join('')
    : '');
  menu.hidden = false;
  menu.querySelectorAll('.fr-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      menu.hidden = true;
      const input = fr.el[which === 'src' ? 'fr-src' : 'fr-dst'];
      input.value = btn.dataset.name;
      if (which === 'src') frConfirmSrc();
    });
  });
}

function frConfirmSrc() {
  const name = fr.el['fr-src'].value.trim();
  if (!name) { fr.srcRole = ''; fr.matches = []; frStatus(t('输入或展开候选并确认一个源角色')); return; }
  // 虚拟角色「未分配角色」不是真角色, 但要能当源角色用
  if (name.toLowerCase() === t(UNASSIGNED_ROLE).toLowerCase()) {
    fr.srcRole = t(UNASSIGNED_ROLE);
    fr.el['fr-src'].value = fr.srcRole;
    frScanRole();
    return;
  }
  const role = computeRoles().find(r => r.name.toLowerCase() === name.toLowerCase());
  if (!role) {
    fr.srcRole = ''; fr.matches = [];
    frStatus(t(`「${name}」不是已有角色，源角色要从已有角色里选`));
    return;
  }
  fr.srcRole = role.name;
  fr.el['fr-src'].value = role.name;
  frScanRole();
}

/** 未分配角色 = 中文行没有 [角色] 标签的行数 */
function unassignedCount() {
  return state.kar ? state.kar.rows.filter(r => isUnassignedRole(r)).length : 0;
}

/** 把一行的角色标签去掉（"设为未分配角色"）：中文行去掉行首 [..]、Name 栏清空、speaker 字段清空。
 *  颜色**不动**（颜色不是标签的一部分, 要不要改色是另一件事）。 */
function clearRoleFromRow(row) {
  for (const s of [row.zh, row.en]) {
    if (!s) continue;
    if (s.proto) s.proto.name = '';
    s.speaker = '';
    for (const ev of s.events) {
      state.assDoc.setEventName(ev, '');
      if (s === row.zh) {
        const r = stripSpeakerTag(ev.text || '');
        if (r.removed) state.assDoc.setEventText(ev, r.text);
      }
    }
  }
  if (row.zh) row.zh.text = assPlainText(row.zh.events[0].text);
  row.speaker = '';
}

function frReplaceRole(all) {
  const dst = fr.el['fr-dst'].value.trim();
  if (!fr.srcRole) { toast('先确认一个源角色（输入后回车，或点 ▼ 选择）'); return; }
  if (!dst) { toast('先填写目标角色'); return; }
  if (!fr.matches.length) frScanRole();
  if (!fr.matches.length) { toast(`「${fr.srcRole}」没有台词`); return; }
  if (!all && fr.cur < 0) fr.cur = 0;
  // 目标是虚拟角色「未分配角色」→ 去掉角色标签（而不是写一个叫"未分配角色"的标签）
  const toUnassigned = dst.toLowerCase() === t(UNASSIGNED_ROLE).toLowerCase();
  const targets = all ? fr.matches.map(m => m.row) : [fr.matches[fr.cur].row];
  let n = 0;
  for (const row of targets) { if (toUnassigned) clearRoleFromRow(row); else applyRoleToRow(row, dst); n++; }
  frCommit();
  const srcGone = !computeRoles().some(r => r.name.toLowerCase() === fr.srcRole.toLowerCase());
  const dstLabel = toUnassigned ? t(UNASSIGNED_ROLE) : dst;
  if (all) {
    frStatus(t(`已把「${fr.srcRole}」的 ${n} 行替换为「${dstLabel}」`), true);
    toast(t(`已把「${fr.srcRole}」的 ${n} 行替换为「${dstLabel}」`));
    fr.srcRole = ''; fr.matches = []; fr.cur = -1;
    if (srcGone) fr.el['fr-src'].value = '';
  } else {
    frScanRole();
    toast(t(`已将 1 行替换为「${dstLabel}」`));
  }
}
frInit();
panel.onFindReplace = frOpen;

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

/** 行时间与其它行重叠 → 涉及的行一律去逐词(与 Shift 拖动同一约定), 返回受影响行数。
 *  不去逐词的话, 两行的逐词切片会在画面上同时渲染、叠在一起(用户截图的「逐词还在」)。
 *  词级时间已备份进 _karaokeBackup, 行被拉开后 reconcileKaraoke 自动还原。 */
function deKaraokeOverlaps(row) {
  if (state.format !== 'ass' || !state.kar) return 0;
  let cleared = 0;
  for (const r of state.kar.rows) {
    if (r.end <= row.start + 1e-3 || row.end <= r.start + 1e-3) continue;
    if (deKaraokeRow(r)) cleared++;
  }
  return cleared;
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
  // 快路径: 没有任何"被去逐词"的行时直接返回 —— 每次拖动/编辑都会调到这里,
  // 不动点循环里那次全量排序+扫描(computeOverlapRows)在无事可做时纯属浪费。
  if (!state.kar.rows.some(r => r._karaokeBackup)) return 0;
  let restored = 0, changed = true;
  let round = 0;
  const maxRounds = state.kar.rows.length + 2;   // restore 正常最多两轮收敛; 上限防病态数据打转
  while (changed) {
    changed = false;
    const overlap = computeOverlapRows();
    for (const row of state.kar.rows) {
      if (!row._karaokeBackup) continue;
      if (overlap.has(row)) continue;
      if (restoreKaraokeRow(row)) { restored++; changed = true; }
    }
    if (changed && ++round >= maxRounds) break;
  }
  if (restored) assPlayer.updateNow(state.assDoc.serialize());
  return restored;
}

/** 拖动英文逐词的开始标记: 该词的起点 + 前一个词的结束一起移动(两词共享边界)。
 *  严格夹取——不越过前后词、不超出字幕块范围; **按住 Shift 也不放宽**。
 *  结果写回 ASS 的逐词切片(视频区高亮与导出都跟着变)。 */
const WORD_MIN_GAP = 0.02;    // 每个词至少保留的时长(秒)
let wordPreviewFrame = 0;
let wordPreviewTrackRow = null;
function clearWordPreview(restore = true) {
  if (wordPreviewFrame) cancelAnimationFrame(wordPreviewFrame);
  wordPreviewFrame = 0;
  if (restore && wordPreviewTrackRow && state.format === 'ass' && state.assDoc) {
    assPlayer.updateNow(state.assDoc.serialize());
    pendingPlaybackRows.clear();
  }
  wordPreviewTrackRow = null;
}
timeline.onBeforeWordDrag = (row, cue) => {
  // document 的 pointerdown 处理发生在画布命中之后，必须在此同步提交而非等待失焦。
  if (panel.editItem) panel.commitEdit({ switching: true });
  if (row && row.en && cue) cue.words = row.en.words; // 词数变化时旧 cue 数组已失效
};

timeline.onWordRetime = (row, idx, t, done, edge, hiLimit, loLimit) => {
  const en = row && row.en;
  const words = en && en.words;
  if (!words || !words[idx]) return;
  const w = words[idx];
  if (edge === 'end') {
    // 拖末词的**结束**边界: 字幕块最后面 = 末词结束时间(块 end 同步延伸, 中英同行)
    const lo = w.s + WORD_MIN_GAP;                           // 不能压过自己的开始
    let hi = (video && video.duration) ? video.duration : Infinity;
    if (hiLimit != null) hi = Math.min(hi, hiLimit);         // 不越过后一个字幕块
    const nt = Math.min(Math.max(t, lo), Math.max(lo, hi));
    w.e = nt;
    if (idx + 1 < words.length) words[idx + 1].s = nt;       // 保险: 后一词起点贴上来
    en.end = nt;
    if (row.zh) {
      row.zh.end = nt;
      for (const ev of row.zh.events) state.assDoc.setEventTime(ev, row.zh.start, nt);
    }
    row.end = nt;
  } else {
    const blockEdge = edge === 'start' && idx === 0;         // 块左边缘拖首词: 字幕块起始时间跟着变
    const lo = idx > 0
      ? words[idx - 1].s + WORD_MIN_GAP                      // 不能压到前一个词的起点
      : (blockEdge
          ? (loLimit != null ? loLimit + 1e-3 : 0)           // 块边缘: 不越过前一个字幕块
          : Math.max(row.start, en.start));                  // 词把柄拖动: 保持原约束(不超出字幕块)
    const hiRaw = Math.min(
      w.e - WORD_MIN_GAP,                                    // 不能晚于自己的结束
      (idx + 1 < words.length) ? words[idx + 1].s - WORD_MIN_GAP : Infinity   // 不能压过下一个词的起点
    );
    const hi = Math.max(lo, hiRaw);
    const nt = Math.min(Math.max(t, lo), hi);
    if (idx > 0) words[idx - 1].e = nt;                      // 共享边界: 前一个词的结束跟着移动
    w.s = nt;
    if (blockEdge) {
      // 块最前面 = 首词开始时间: 整块起点(含中文行)同步前移/后移
      en.start = nt;
      row.start = nt;
      if (row.zh) {
        row.zh.start = nt;
        for (const ev of row.zh.events) state.assDoc.setEventTime(ev, nt, row.zh.end);
      }
    }
  }
  if (done) {
    const hadTransient = !!wordPreviewTrackRow;
    clearWordPreview(false);
    // mouseup / pointercancel 一律做最终单句重建，即使上一帧尚未送到渲染器。
    en.events = state.assDoc.replaceEvents(en.events, buildWordSpecs(en));
    if (editRowVisible(row) || hadTransient) {
      assPlayer.updateNow(state.assDoc.serialize());
      pendingPlaybackRows.clear();
    } else pendingPlaybackRows.add(row);
    rebuildItemsAndLanes(true, true);
  } else if (!wordPreviewFrame && editRowVisible(row)) {
    const doc = state.assDoc;
    wordPreviewFrame = requestAnimationFrame(() => {
      wordPreviewFrame = 0;
      if (state.format === 'ass' && state.assDoc === doc && row.en && editRowVisible(row)) {
        wordPreviewTrackRow = row;
        assPlayer.updateNow(doc.previewEvents(row.en, buildWordSpecs(row.en)));
        pendingPlaybackRows.clear();
      }
    });
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
      msg += `重叠：移除 ${cleared} 句逐词`;
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
  // 铁律: 整句样式一句话**只有一条事件**。若句子残留词级切片(events>1 或 words 非空 ——
  // 旧版脏数据, 表现是画面上同一句中文渲染两遍), 先把整句折叠回单事件再改写:
  // 词 2..n 的切片绝不能留在文档里, 否则重载后各自成行、继续上屏。
  if ((sent.words && sent.words.length) || sent.events.length > 1) {
    const keep = sent.events[0];
    let keepText = keep.text || '';
    // 切片行首的逐词绿标({\c&H00FF00&})不能被下面的"继承前置标签"逻辑捡走 ——
    // 否则整句被染成高亮绿。说话人色永不可能是逐词绿(speakerColorOf 已排除), 见绿即剥。
    const mLead = /^\s*(\{\\c&H([0-9A-Fa-f]{6})&\})/.exec(keepText);
    if (mLead && HIGHLIGHT_COLORS.has(assColorToHex(mLead[2].toUpperCase()))) keepText = keepText.slice(mLead[1].length);
    const p = sent.proto || { layer: keep.layer, name: keep.name, effect: keep.effect, margins: keep.margins };
    sent.events = state.assDoc.replaceEvents(sent.events, [{
      layer: p.layer, style: sent.style, name: p.name,
      effect: p.effect, margins: p.margins, start: s, end: e, text: keepText
    }]);
    sent.words = [];
  }
  const ev = sent.events[0];
  // 角色名标签与正文之间恒为**一个空格**（用户要求 '[wato] 我'）——编辑框随便打，落盘时规范
  let newText = normalizeRoleGap(text);
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
  // 铁律: 只有逐词样式(Default)才允许切片。整句样式(中文)走到这里只能是历史脏数据或行
  // 错位 —— 一律按整句折叠处理, 绝不给中文造逐词切片(画面上会出现两遍同一句)。
  if (!state.kar || !state.kar.wordStyle || sent.style !== state.kar.wordStyle) {
    applyAnchorSentence(sent, s, e, text);
    return;
  }
  text = normalizeRoleGap(text);                // 角色名标签与正文之间恒为一个空格（同上）
  sent.words = recalcWords(sent, text, s, e);   // 词数不变→保留原时间; 变化→加权重算
  sent.text = text;
  sent.start = s; sent.end = e;
  sent.events = state.assDoc.replaceEvents(sent.events, buildWordSpecs(sent));
}

/** 应用一行(中英双行)编辑: 中文整句 + 英文逐词句同步更新, 视频区立即重渲染 */
/** 用户文本 → ASS 安全文本(花括号/反斜杠转义): ASS 里 {…} 是覆盖标签, 不转义会被吃掉 */
const escAss = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

/** 该行此刻在视频区可见吗(播放头落在它时间范围内) —— 中/英任一有就算(以前只认英文行,
 *  于是中文单行块编辑时拿不到实时预览)。 */
function editRowVisible(row) {
  if (!row || state.format !== 'ass') return false;
  const sent = row.en || row.zh;
  return !!sent && video.currentTime >= sent.start && video.currentTime < sent.end;
}

/** 中文整句行的预览文本: 与 applyAnchorSentence **落盘时的构造完全一致**
 *  (补回被编辑框隐藏的 [角色] 标签 → 继承行首 {\c..&} 色标 → 换行转 \N),
 *  这样"预览看到的"和"提交后的"必然一致 —— 两者共用 karaoke.js 的 buildAnchorText。 */
function zhPreviewText(sent, text, tag) {
  const ev = sent && sent.events && sent.events[0];
  return buildAnchorText(ev ? ev.text : '', String(tag || '') + String(text == null ? '' : text));
}

/** 撤掉临时预览轨, 把真实字幕重新送进渲染器 */
function restoreRealTrack() {
  if (state.format !== 'ass' || !state.assDoc) return;
  assPlayer.updateNow(state.assDoc.serialize());
  pendingPlaybackRows.clear();
}

function clearEditPreview(restore = true) {
  if (editPreview) clearTimeout(editPreview.timer);
  editPreview = null;
  if (previewFrame) cancelAnimationFrame(previewFrame);
  previewFrame = 0;
  if (previewTrack && restore) restoreRealTrack();
  previewTrack = null;
}

function renderEditPreview() {
  previewFrame = 0;
  const draft = editPreview;
  if (!draft || draft.doc !== state.assDoc || !editRowVisible(draft.row)) {
    if (previewTrack) {
      previewTrack = null;
      if (state.format === 'ass' && state.assDoc) {
        assPlayer.updateNow(state.assDoc.serialize());
        pendingPlaybackRows.clear();
      }
    }
    return;
  }
  /* 中英两行**一起**预览 —— 不能"编辑哪行只预览哪行",
   * 否则按 Tab 切到另一行时前一行的草稿会在画面上消失(上游 2.1.13 的改进)。
   * 草稿结构 editPreview = { row, doc, version, timer, zh, en, specs, specsText, builtVersion }:
   *   zh = { text, tag }  中文行草稿(tag = 编辑框里被隐藏的 [角色] 标签，预览时要补回)
   *   en = { text }       英文行草稿
   * 兼容旧字段 draft.text / draft.specs（只有英文时）。 */
  const entries = [];
  const draftEnText = draft.en ? draft.en.text : draft.text;
  const wordsReady = draft.specs && draft.builtVersion === draft.version
    && (!draft.en || draft.specsText === draft.en.text);
  if (draft.row.zh && draft.zh) {
    entries.push({ sentence: draft.row.zh, text: zhPreviewText(draft.row.zh, draft.zh.text, draft.zh.tag) });
  }
  if (draft.row.en && draftEnText != null) {
    entries.push(wordsReady
      ? { sentence: draft.row.en, specs: draft.specs }
      : { sentence: draft.row.en, text: escAss(draftEnText) });
  }
  if (!entries.length) {
    if (previewTrack) { previewTrack = null; restoreRealTrack(); }
    return;
  }
  const mode = (draft.zh && draft.row.zh ? 'zh' : '')
    + (draft.row.en && draftEnText != null ? (wordsReady ? '+words' : '+plain') : '');
  if (previewTrack && previewTrack.row === draft.row && previewTrack.version === draft.version
      && previewTrack.mode === mode) return;
  const track = draft.doc.previewMulti(entries);
  // 唯一的可见版本；逐帧合并输入，永不把临时事件写回 AssDoc。
  if (draft === editPreview && draft.doc === state.assDoc && editRowVisible(draft.row)) {
    previewTrack = { row: draft.row, version: draft.version, mode };
    assPlayer.updateNow(track);
    pendingPlaybackRows.clear();
  }
}

function queueEditPreview() {
  if (!previewFrame) previewFrame = requestAnimationFrame(renderEditPreview);
}

function settleEditPreview(draft) {
  if (!draft || draft !== editPreview || draft.doc !== state.assDoc) return;
  const en = draft.row.en;
  if (!draft.en || !en) return;      // 没改英文行 → 不需要词级切片
  // 只计算这句的临时词时间与事件；提交之前不修改正文、时间或原始 ASS。
  if (state.kar && state.kar.wordStyle && en.style === state.kar.wordStyle) {
    const text = normalizeRoleGap(draft.en.text);
    const words = recalcWords(en, text, en.start, en.end);
    draft.specs = buildWordSpecs({ ...en, text, words });
    draft.specsText = draft.en.text;      // 这份切片对应的英文文本(文本没变就一直有效)
  } else { draft.specs = null; draft.specsText = null; }
  // 记下"这份切片是按哪个版本算的" —— renderEditPreview 靠它判断能否走词级预览
  draft.builtVersion = draft.version;
  if (draft === editPreview && editRowVisible(draft.row)) queueEditPreview();
}

/** 英文行行内草稿变化 → 临时预览(与中文行共用同一份 editPreview) */
panel.onEnglishInput = (item, text) => {
  if (state.format !== 'ass' || !state.assDoc || !item || !item.ref.en) return;
  const row = item.ref;
  if (editPreview && editPreview.row !== row) clearEditPreview();
  const normalized = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const draft = editPreview || { row, doc: state.assDoc, version: 0, timer: 0, specs: null, specsText: null, zh: null, en: null };
  if (draft.en && draft.en.text === normalized) return;
  draft.en = { text: normalized };
  draft.version++;
  draft.specs = null; draft.specsText = null;
  clearTimeout(draft.timer);
  editPreview = draft;
  if (editRowVisible(row)) queueEditPreview();
  else if (previewTrack) queueEditPreview(); // 播放头离开原句时撤销临时轨
  draft.timer = setTimeout(() => settleEditPreview(draft), EDIT_SETTLE_MS);
};

/** 中文行行内草稿变化 → 临时预览(以前中文要等退出编辑框才更新)。
 *  tag = 编辑框里被隐藏的 [角色] 标签, 预览时要补回, 否则角色名会在预览里消失。 */
panel.onChineseInput = (item, text, tag) => {
  if (state.format !== 'ass' || !state.assDoc || !item || !item.ref.zh) return;
  const row = item.ref;
  if (editPreview && editPreview.row !== row) clearEditPreview();
  const normalized = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const draft = editPreview || { row, doc: state.assDoc, version: 0, timer: 0, specs: null, specsText: null, zh: null, en: null };
  if (draft.zh && draft.zh.text === normalized && draft.zh.tag === (tag || '')) return;
  draft.zh = { text: normalized, tag: tag || '' };
  draft.version++;
  clearTimeout(draft.timer);
  editPreview = draft;
  if (editRowVisible(row)) queueEditPreview();
  else if (previewTrack) queueEditPreview(); // 播放头离开原句时撤销临时轨
  draft.timer = setTimeout(() => settleEditPreview(draft), EDIT_SETTLE_MS);
};
panel.onEditCancel = () => clearEditPreview();
panel.onEditFinish = () => clearEditPreview();

function applyAssRow(item, s, e, text) {
  const row = item.ref;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const zhText = (lines[0] || '').trim();
  const enText = lines.length > 1 ? lines.slice(1).join(' ').trim() : '';
  const timeChanged = Math.abs(row.start - s) > 1e-4 || Math.abs(row.end - e) > 1e-4;
  // 英文改动不能重写中文事件；停顿时生成的仅是草稿，提交时每个变动句至多替换一次。
  const oldZh = row.zh ? row.zh.text : '';
  const oldEn = row.en ? row.en.text : '';
  const oldStart = row.start, oldEnd = row.end;
  const zhChanged = !!row.zh && zhText !== oldZh;
  const enChanged = !!row.en && enText !== oldEn;
  if (row.zh && (timeChanged || zhText !== row.zh.text)) applyAnchorSentence(row.zh, s, e, zhText);
  if (row.en && (timeChanged || enText !== row.en.text)) applyWordSentence(row.en, s, e, enText);
  /* 操作日志：**编辑字幕文本**这一路以前完全没记（`logOp` 只在切分/合并/重排/重识别里调），
   * 而"我改了哪句、改成什么"恰恰是用户最想看的那一栏。
   * 只记真的变了的，并把「改前 → 改后」写进去（why 里带时间是否也动了）。 */
  if (zhChanged || enChanged || timeChanged) {
    const clip = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 60);
    const parts = [];
    if (zhChanged) parts.push(`中文「${clip(oldZh)}」→「${clip(zhText)}」`);
    if (enChanged) parts.push(`英文「${clip(oldEn)}」→「${clip(enText)}」`);
    logOp('edit',
      `第 ${row.no || '?'} 条 ${fmtTime(s)}~${fmtTime(e)}`,
      parts.length ? parts.join('；') : '只改了时间',
      timeChanged ? `时间 ${fmtTime(oldStart)}~${fmtTime(oldEnd)} → ${fmtTime(s)}~${fmtTime(e)}`
        : '在字幕列表里直接改的文本');
  }
  row.start = s; row.end = e;
  const hadTransient = !!previewTrack;
  clearEditPreview(false);
  if (editRowVisible(row) || hadTransient) {
    // 正在显示该句，或必须清掉残留的临时轨：立即切回真实逐词事件。
    assPlayer.updateNow(state.assDoc.serialize());
    pendingPlaybackRows.clear();
  } else {
    // 修改非播放句只更新 ASS 数据；播到该句时再把最新整轨送到 libass。
    pendingPlaybackRows.add(row);
  }
  return timeChanged;
}

panel.onApply = ({ item: editItem, start, end, dur, text, switching = false }) => {
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

  let timeChanged = false;
  if (item.kind === 'srt') {
    const cue = item.ref;
    cue.start = s; cue.end = e;
    cue.lines = text.replace(/\r\n?/g, '\n').split('\n');
    state.srtCues.sort((a, b) => a.start - b.start || a.end - b.end);
    state.srtCues.forEach((c, i) => c.id = i + 1);
    overlay.setCues(state.srtCues);
  } else {
    timeChanged = applyAssRow(item, s, e, text);
    // 仅改文字不能波及邻行；只有改变时间范围才需执行跨行重叠规则。
    if (timeChanged) {
      const cleared = deKaraokeOverlaps(item.ref);
      if (cleared) assPlayer.updateNow(state.assDoc.serialize());
    }
  }
  state.newRows.delete(item.ref);     // 有内容了 → 不再是"待输入的新字幕"
  if (!switching) {
    if (state.format === 'ass' && timeChanged) reconcileKaraoke();
    rebuildItemsAndLanes(true, true);
    toast('已应用 #' + item.no);
  } else {
    const [zh, ...en] = text.split('\n');
    item.l1 = zh || '';
    item.l2 = en.join(' ');
    item.textRaw = text;
    if (state.project) Projects.scheduleSave();
  }
};

panel.onDeleteCard = (item) => deleteItem(item);   // 字幕列表右键删除(与时间轴右键同一套逻辑)
panel.onTabChange = (name) => pruneUnusedRoles(name === 'roles');   // 离开角色栏 → 清掉没用上的新角色

/* ═══════════ 修复字幕(右键菜单) ═══════════ */
/** 行首角色色标(非绿)判定用: {\c&H......&} */
const EN_ROLE_COLOR_RE = /^\s*\{[^}]*?\\c&H([0-9A-Fa-f]{6})&/;

/* ─────────── 中英起止对齐 ───────────
 * 云端识别(必剪/剪映)常给出"首词起点晚于句首"或"整段英文只覆盖一小截"的结果：
 *   中文行 0.00–2.88 / 英文逐词 0.04–2.88（首词晚 40ms）
 *   中文行 0.00–2.88 / 英文逐词 0.04–0.32（整段只覆盖一小段）
 * 在 ASS 里这就是"中英时间不一致"的坏行，时间轴上也切不出整块。
 * 这里把英文逐词的时间**按比例映射到中文行的 [start, end]** —— 只改时间，不动文本与高亮标签。
 */
const SPAN_TOL = 0.005;      // ASS 只写到厘秒，同源写入的两条不该有更大差异

/** 读一行的中英跨度信息（不改任何东西）；没有中英双行/退化数据返回 null */
function enSpanInfo(row) {
  const zh = row && row.zh, en = row && row.en;
  if (!zh || !en || !en.words || !en.words.length) return null;
  if (!(zh.end > zh.start)) return null;
  let es = Infinity, ee = -Infinity;
  for (const w of en.words) { if (w.s < es) es = w.s; if (w.e > ee) ee = w.e; }
  if (!isFinite(es) || !isFinite(ee)) return null;
  return {
    zh, en, zs: zh.start, ze: zh.end, es, ee,
    mismatch: Math.abs(es - zh.start) > SPAN_TOL || Math.abs(ee - zh.end) > SPAN_TOL,
  };
}

/** 该行中英起止是否不一致（坏行判定与修复检测共用一处算法） */
function enSpanMismatch(row) { const i = enSpanInfo(row); return !!(i && i.mismatch); }

/** 把英文逐词的时间对齐到中文行的 [start, end]（按比例，保留词间相对关系）。
 *  返回 true 表示确实改过。**只动时间**：文本、高亮标签、样式一律不碰。 */
function alignEnSpanToZh(row) {
  const info = enSpanInfo(row);
  if (!info || !info.mismatch) return false;
  const { en, zs, ze, es, ee } = info;
  const n = en.words.length;
  const span = ee - es;
  if (span <= WORD_MIN_GAP * n) {
    // 退化成一根线（几乎所有词都挤在一点上）→ 按词数把中文行时长均匀铺开
    const dur = (ze - zs) / n;
    en.words.forEach((w, i) => { w.s = +(zs + i * dur).toFixed(3); w.e = +(zs + (i + 1) * dur).toFixed(3); });
  } else {
    // 按比例映射：首词晚 40ms 这种，前段微调、后段几乎不动
    const k = (ze - zs) / span;
    for (const w of en.words) {
      w.s = +(zs + (w.s - es) * k).toFixed(3);
      w.e = +(zs + (w.e - es) * k).toFixed(3);
    }
  }
  // 保底：首词贴句首、末词收句尾，且词与词之间不出现零宽/逆序
  en.words[0].s = zs;
  for (let i = 0; i < n; i++) {
    const w = en.words[i];
    if (i) w.s = Math.max(w.s, en.words[i - 1].e);
    if (w.e - w.s < WORD_MIN_GAP) w.e = +(w.s + WORD_MIN_GAP).toFixed(3);
  }
  en.words[n - 1].e = ze;
  en.start = zs;
  en.end = ze;
  if (en.events && en.events.length === n) {
    for (let i = 0; i < n; i++) state.assDoc.setEventTime(en.events[i], en.words[i].s, en.words[i].e);
  }
  en.overlap = enSlicesOverlap(en);
  return true;
}

/** 载入时规范"角色名标签 ↔ 正文"的间距（用户要求：'[wato] 我'，不许连着也不许两个空格）。
 *  做法：**每一条事件的明文都过一遍**（纯文本操作，不动时间、不动词表）；
 *  整句行（中文锚点）额外同步模型明文 —— 列表/时间轴/坏行检查看的是 `sent.text`。
 *  为什么逐词行不重建：加一个空格会改变词数 → 触发词级时间重排，反而把用户的逐词时间抹掉。 */
function normalizeAllRoleGaps() {
  if (state.format !== 'ass' || !state.kar || !state.kar.sentences) return 0;
  let n = 0;
  for (const sent of state.kar.sentences) {
    let ch = false;
    for (const ev of (sent.events || [])) {
      const fixed = normalizeRoleGap(ev.text);
      if (fixed !== ev.text) { state.assDoc.setEventText(ev, fixed); ch = true; }
    }
    if (!(sent.words && sent.words.length)) {
      const fixedTxt = normalizeRoleGap(sent.text || '');
      if (fixedTxt !== sent.text) { sent.text = fixedTxt; ch = true; }
    }
    if (ch) n++;
  }
  return n;
}

/** 载入时自动对齐（用户要求：以后遇到这种字幕直接自动修复）。返回修好的行数。
 *
 *  **只对"除起止不一致外没别的毛病"的双行动手**（用户明确要求：别误触重叠行与单语行）：
 *   · 与其它字幕重叠的行 → 一律跳过（这类行的逐词本来就不碰，避免两句话高亮糊在一起）；
 *   · 单语行（只有中文或只有英文）/ 没有中文锚点 → 跳过（没有对齐基准，也没必要改）；
 *   · 英文切片自己就重叠、词数与文本不符、英文行混进角色名 → 跳过（这些需要用户确认句子，
 *     交给右键「🛠 修复字幕」按需处理）。
 *  另：双行的块时间取自中文锚点（见 karaoke.js makeRow），所以这里只挪英文词的时间，
 *  **不会改变任何行的重叠关系**。 */
function autoAlignEnSpans() {
  if (state.format !== 'ass' || !state.kar || !state.kar.rows) return 0;
  const overlap = computeOverlapRows();
  let n = 0;
  for (const row of state.kar.rows) {
    if (overlap.has(row)) continue;
    const en = row.en;
    if (!row.zh || !en || !en.words || !en.words.length) continue;
    if (enSlicesOverlap(en)) continue;
    const clean = (en.text || '').replace(/^\s*\[[^\]]+\]\s*/, '').trim();
    const toks = splitEnglishWords(clean).length;
    if (toks && en.words.length !== toks) continue;
    if (/\[[^\]]+\]/.test(en.text || '')) continue;
    if (alignEnSpanToZh(row)) n++;
  }
  return n;
}

/**
 * 检测一行字幕有哪些问题(供右键「修复字幕」).
 * 返回 { issues, needConfirm, prefill }：
 *   issues 子集 { karaokeMissing(自动加逐词), overlapNoKaraoke(仅提示), roleName(自动删角色),
 *                 wordsMismatch(逐词与文本不一致), enOverlap(英文行重复/交叠) }
 *   needConfirm=true 表示 wordsMismatch/enOverlap —— 必须让用户确认这句话到底是什么再修。
 */
function detectRowProblems(row) {
  const issues = {};
  const en = row.en;
  let needConfirm = false, prefill = '';
  // ① 没有逐词效果
  if (en && (!en.words || !en.words.length)) {
    if (computeOverlapRows().has(row)) issues.overlapNoKaraoke = true;  // 重叠的不加逐词(会丢特效)
    else issues.karaokeMissing = true;                                  // 不重叠 → 可自动加
  }
  // ② 英文行含角色名([..]) 或 行首非绿角色色标
  if (en) {
    const txt = en.text || '';
    let roleName = /\[[^\]]+\]/.test(txt);
    if (!roleName && en.events) {
      for (const ev of en.events) {
        const m = EN_ROLE_COLOR_RE.exec(ev.text || '');
        if (m && !HIGHLIGHT_COLORS.has(assColorToHex(m[1].toUpperCase()))) { roleName = true; break; }
      }
    }
    if (roleName) issues.roleName = true;
  }
  // ③ 英文行逐词与文本不一致(缺词/多余) 或 英文行内部切片交叠(重复字幕) —— 都是英文行脏了,
  //    需要用户确认这句话到底是什么(用户明确要求), 才能重建出正确的逐词。
  if (en && en.words && en.words.length) {
    const clean = (en.text || '').replace(/^\s*\[[^\]]+\]\s*/, '').trim();
    const toks = splitEnglishWords(clean).length;
    if (toks && en.words.length !== toks) {
      issues.wordsMismatch = { text: clean, have: en.words.length, need: toks };
    }
    if (enSlicesOverlap(en)) issues.enOverlap = true;
    if (issues.wordsMismatch || issues.enOverlap) {
      needConfirm = true;
      prefill = (issues.wordsMismatch && issues.wordsMismatch.text) || clean || en.words.map(w => w.w).join(' ');
    }
  }
  // ④ 中英起止不一致：英文逐词句的跨度与中文行不等（云端识别的存量文件常见）。
  //    这一项**不需要**用户确认 —— 只挪时间、不动文本，按比例对齐即可（载入时已自动修过一轮，
  //    这里是给"载入后被手工改坏"的情况留的手动入口）。
  if (en && row.zh && enSpanMismatch(row)) issues.spanMismatch = true;
  return { issues, needConfirm, prefill };
}

/** 用目标文本重建英文逐词行: 逐词高亮回绿(用户 bug#1), 并整体替换该句全部切片。
 *  replaceEvents 会**换掉该句所有事件** → 重复/交叠的脏切片一并清除。
 *  clearName=true 时把角色名从 Name 栏也删掉(角色名在英文行时)。 */
function rebuildEnglishFromText(en, text, clearName) {
  if (clearName && en.proto) en.proto.name = '';
  en.text = text;
  en.highlightTag = '{\\c&H00FF00&}';
  en.words = recalcWords(en, en.text, en.start, en.end);
  en.events = state.assDoc.replaceEvents(en.events, buildWordSpecs(en));
  en.bad = false;   // 重建后时间一律合法, 清掉分析时可能留下的时间异常标记
  en.overlap = enSlicesOverlap(en);
}

/** 编辑后把行的说话人色/名重新算一遍(防改完行首标签后颜色/筛选没刷新) */
function refinalizeRow(row) {
  if (row.zh) { row.zh.color = speakerColorOf(row.zh); row.zh.speaker = speakerTagOf(row.zh); }
  if (row.en) { row.en.color = speakerColorOf(row.en); row.en.speaker = speakerTagOf(row.en); }
  row.color = (row.zh && row.zh.color) || (row.en && row.en.color) || null;
  row.speaker = (row.zh && row.zh.speaker) || (row.en && row.en.speaker) || '';
}

/** 应用修复: 按检测结果修复该行(不一致/重叠项用用户确认的句子) */
function fixRow(row, issues, confirmedText) {
  const en = row.en;
  if (!en) { toast('该行没有英文逐词行，无法修复'); return; }
  const done = [];
  const mismatch = issues.wordsMismatch || issues.enOverlap;
  if (issues.roleName || mismatch) {
    let target;
    if (mismatch) {
      // 逐词与文本不一致 / 英文行重复交叠 → 以用户确认的句子为准
      target = ((confirmedText != null ? confirmedText : '') || (issues.wordsMismatch ? issues.wordsMismatch.text : '')).trim();
    } else {
      // 仅角色名场景: 文本从词级时间轴重建(词才是逐词真值, 切片明文不可靠)
      target = (en.words && en.words.length) ? en.words.map(w => w.w).join(' ') : (en.text || '').trim();
    }
    target = target.replace(/^\s*\[[^\]]+\]\s*/, '');   // 防用户把角色名也带进来
    if (target) {
      rebuildEnglishFromText(en, target, !!issues.roleName);
      if (issues.roleName) done.push('已删除英文行角色名并校正逐词色');
      if (mismatch) done.push('已按确认句子重建逐词');
    }
  }
  if (issues.karaokeMissing) {
    const t = (en.text || assPlainText(en.events[0].text)).trim();
    rebuildEnglishFromText(en, t, false);
    done.push('已自动添加逐词效果');
  }
  if (issues.spanMismatch) {
    if (alignEnSpanToZh(row)) done.push('已把英文逐词起止对齐到中文行');
  }
  if (issues.overlapNoKaraoke) done.push('这句和别的字幕重叠，没有加逐词');
  if (!done.length) { toast('没有可修复的问题'); return; }
  refinalizeRow(row);
  assPlayer.updateNow(state.assDoc.serialize());
  reconcileKaraoke();
  rebuildItemsAndLanes(true, true);
  toast('修复完成：' + done.join('；'));
}

/** 右键「修复字幕」入口: 检测 → 弹窗 → 修复 */
function openFixForRow(ref) {
  if (state.format !== 'ass' || !state.kar) { toast('修复字幕仅支持 ASS 特效字幕'); return; }
  const row = ref;   // ASS 下 ref 即 karaoke row
  if (!row) { toast('没有找到这条字幕'); return; }
  const { issues, needConfirm, prefill } = detectRowProblems(row);
  if (!Object.keys(issues).length) { toast('这条字幕没有问题'); return; }
  const fixable = ['karaokeMissing', 'roleName', 'wordsMismatch', 'enOverlap'].filter(k => issues[k]);
  if (!fixable.length) {
    toast('这条字幕没有可自动修复的问题：它和别的字幕重叠，重叠时不加逐词');
    return;
  }
  panel.showFix(row.no, issues, needConfirm, prefill, (confirmedText) => fixRow(row, issues, confirmedText));
}

timeline.onFix = (ref) => openFixForRow(ref);         // 时间轴块右键「修复字幕」
panel.onFixCard = (item) => openFixForRow(item.ref); // 字幕卡片右键「修复字幕」

/** 删除一条字幕(列表删除按钮 / 时间轴右键菜单共用) */
/** 从文档/数据里摘掉一条字幕(**不重建界面**) —— 单条删除与批量删除共用, 批量时只重建一次 */
function removeItemData(item) {
  if (!item) return false;
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
  return true;
}

function deleteItem(item, silent) {
  if (!item) return;
  if (!removeItemData(item)) return;
  state.selected = null;
  rebuildItemsAndLanes(true, true);
  toast(silent ? '未输入内容，已撤销这条新字幕' : '已删除 #' + item.no);
}

/** 新建的字幕一个字都没写就离开 → 撤销(不留空字幕) */
panel.onEmptyNew = (item) => deleteItem(item, true);

timeline.onDelete = (ref) => {
  const it = state.itemByRef.get(ref);
  deleteItem(it);
  if (it) {
    logOp('delete', `第 ${it.no || '?'} 条 ${fmtTime(it.start)}~${fmtTime(it.end)}`,
      `删除字幕："${String(it.l2 || it.l1 || '').slice(0, 60)}"`, '用户在时间轴上右键删除');
  }
};

/* ─────────── 时间轴批量选区(Ctrl+左键在轨道上拖动框选 → 批量删除) ─────────── */
const rangeBar = document.getElementById('range-bar');
const rbCount = document.getElementById('rb-count');
const rbDelete = document.getElementById('rb-delete');

/** 与 [a,b] 时间范围**相交**的所有条目 —— 批量删除的作用对象(部分重叠也算) */
function itemsInRange(a, b) {
  return state.items.filter(it => it.end > a + 1e-3 && it.start < b - 1e-3);
}

/** 同步"批量选区"浮条: 贴着选区左上角, 显示会删掉几条; 拖动中 / 没有选区 → 收起。
 *  以后加「重新识别」按钮就放在这里(先按现有的 rangeSel 接口来实现即可)。 */
function refreshRangeBar() {
  if (!rangeBar) return;
  const sel = timeline.rangeSel;
  if (!sel || timeline._rangeDragging || sel.b <= sel.a) { rangeBar.hidden = true; return; }
  const n = itemsInRange(sel.a, sel.b).length;
  rbCount.textContent = n ? `已选 ${n} 条字幕` : '该区间没有字幕';
  rangeBar.title = `选区 ${fmtTime(sel.a)} → ${fmtTime(sel.b)} · 点别处取消选区`;
  if (rbDelete) rbDelete.disabled = n === 0;
  rangeBar.hidden = false;                     // 先显示再量尺寸(隐藏时 offsetWidth 为 0)
  const wrap = document.getElementById('tl-canvas-wrap');
  const r = wrap.getBoundingClientRect();
  const w = rangeBar.offsetWidth, h = rangeBar.offsetHeight;
  const x = Math.min(Math.max(r.left + timeline.t2x(sel.a), r.left + 4), Math.max(r.left + 4, r.left + r.width - w - 4));
  const y = Math.min(Math.max(r.top + timeline._laneTop(0) + 2, r.top + 2), Math.max(r.top + 2, r.top + r.height - h - 2));
  rangeBar.style.left = Math.round(x) + 'px';
  rangeBar.style.top = Math.round(y) + 'px';
}

timeline.onRangeSelect = () => refreshRangeBar();

let convertingWords = false;
if (wordConvertStyle) wordConvertStyle.addEventListener('change', () => {
  wordConvertHint.textContent = wordConvertStyle.value
    ? `仅转换「${wordConvertStyle.value}」样式中尚无逐词标签的英文句；中文和已转换句跳过。`
    : '请明确选择英文样式后再转换；无法可靠判定时绝不猜测。';
});
if (btnConvertWords) btnConvertWords.addEventListener('click', async () => {
  if (convertingWords || state.format !== 'ass' || !state.kar || !state.assDoc) return;
  const style = wordConvertStyle.value;
  if (!style) {
    wordConvertHint.textContent = '无法可靠判定英文样式。请在「英文样式」下拉框明确选择，未选择时不转换任何字幕。';
    toast('请先明确选择英文样式，转换已跳过', 5000);
    wordConvertStyle.focus();
    return;
  }
  if (state.kar.wordStyle && state.kar.wordStyle !== style && state.kar.sentences.some(s => s.words.length)) {
    toast('当前文件已有其它逐词样式，请选择现有逐词样式以免误转换', 5200);
    return;
  }
  if (panel.editItem) panel.commitEdit();
  const doc = state.assDoc;
  const scope = wordConvertScope.value;
  const selection = timeline.rangeSel;
  const chosen = scope === 'missing' ? state.kar.sentences.slice()
    : selection && selection.b > selection.a
      ? itemsInRange(selection.a, selection.b).flatMap(it => [it.ref.zh, it.ref.en].filter(Boolean))
      : state.selected ? [state.selected.ref.zh, state.selected.ref.en].filter(Boolean) : [];
  if (!chosen.length) {
    toast('请先选中字幕行、框选时间轴区间，或把转换范围改为「所有待转换英文行」', 5600);
    return;
  }
  convertingWords = true;
  btnConvertWords.disabled = true;
  wordConvertLoading.hidden = false;
  wordConvertHint.textContent = '正在检查英文样式、逐词状态和重叠；仅回写符合条件的句子…';
  // 先让浏览器绘制轻量 Loading，再做批量事件替换；不逐行重建界面。
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  try {
    if (doc !== state.assDoc) return;
    const grouped = pairRows(state.kar.sentences, style);
    const owner = new Map();
    for (const row of grouped) if (row.en) owner.set(row.en, row);
    const overlapping = new Set();
    for (let i = 0; i < grouped.length; i++) {
      for (let j = i + 1; j < grouped.length && grouped[j].start < grouped[i].end - 1e-3; j++) {
        if (grouped[j].end > grouped[i].start + 1e-3) {
          overlapping.add(grouped[i]); overlapping.add(grouped[j]);
        }
      }
    }
    const targets = [...new Set(chosen)]
      .filter(s => eligibleForWordConversion(s, style) && owner.has(s) && !overlapping.has(owner.get(s)))
      .sort((a, b) => b.events[0].lineIdx - a.events[0].lineIdx);
    if (!targets.length) {
      wordConvertHint.textContent = '未发现可转换的英文整句：已转换、中文、重叠或无法安全判断的句子均已跳过。';
      toast('未找到可安全转换的英文句；中文及已有逐词句保持不变', 5400);
      return;
    }
    const savedColor = doc.getScriptInfoComment(ASS_WORD_COLOR_META);
    for (const sent of targets) {
      if (/^#[0-9a-f]{6}$/i.test(savedColor)) sent.highlightTag = assHexToTag(savedColor);
      sent.words = recalcWords(sent, sent.text, sent.start, sent.end);
      sent.events = doc.replaceEvents(sent.events, buildWordSpecs(sent));
    }
    // 短文件达不到分析器的 6 条切片阈值；记住用户亲自确认的英文样式供重新打开时使用。
    doc.setScriptInfoComment('SubFabricWordStyle', style);
    const prior = state.selected && (state.selected.ref.en || state.selected.ref.zh);
    state.kar.wordStyle = style;
    state.kar.rows = pairRows(state.kar.sentences, style);
    clearEditPreview(false);
    assPlayer.updateNow(doc.serialize());
    rebuildItemsAndLanes(true, true);
    setAssStyleControls();
    btnExportClean.disabled = false;
    btnExportJson.disabled = false;
    btnExportZh.disabled = false;
    btnExportEn.disabled = false;
    if (prior) {
      const row = state.kar.rows.find(r => r.en === prior || r.zh === prior);
      const item = row && state.itemByRef.get(row);
      if (item) selectItem(item, false);
    }
    wordConvertHint.textContent = `已转换 ${targets.length} 句；其它句子及中文事件保持不变。`;
    toast(`已将 ${targets.length} 句英文转为逐词颜色标签`);
  } catch (e) {
    wordConvertHint.textContent = '转换中断；请检查字幕数据后重试。';
    toast('逐词转换失败：' + ((e && e.message) || e), 6500);
  } finally {
    convertingWords = false;
    wordConvertLoading.hidden = true;
    btnConvertWords.disabled = state.format !== 'ass';
  }
});
// 平移/缩放/改窗口后选区在屏幕上的位置会变, 浮条要跟着走
timeline.onLayout = () => { if (timeline.rangeSel) refreshRangeBar(); };

if (rbDelete) rbDelete.addEventListener('click', () => {
  const sel = timeline.rangeSel;
  if (!sel) return;
  const targets = itemsInRange(sel.a, sel.b);
  if (!targets.length) { timeline.clearRangeSel(); return; }
  for (const it of targets) removeItemData(it);   // 先全部摘掉, 最后只重建一次
  state.selected = null;
  timeline.clearRangeSel();                       // 删完取消选区(用户要求的流程)
  rebuildItemsAndLanes(true, true);
  toast(`已批量删除 ${targets.length} 条字幕`);
});

/* ─────────── 选区「重新识别」: 删选区内字幕块 → 切已保存音频重识别 → LLM 翻译 → 写回 ─────────── */
const rbReRecog = document.getElementById('rb-rerecog');
let reRecogBusy = false;

/** 按一条识别结果建字幕块: 中文整句 + 英文逐词句（用 ASR 给的真实词级时间） */
function addRecognizedRow(seg) {
  const s = seg.start, e = seg.end;
  // 与初稿写入同一约定: 中文译文里的逗号/顿号/句号替换成空格(! ? 保留)
  const zhText = String(seg.zh || '').replace(/[，、。]/g, ' ').trim();
  const enText = String(seg.text || '').trim();
  if (!zhText && !enText) return null;
  if (state.format === 'srt') {
    const cue = { id: 0, start: s, end: e, lines: zhText ? [zhText, enText] : [enText] };
    state.srtCues.push(cue);
    state.srtCues.sort((x, y) => x.start - y.start || x.end - y.end);
    state.srtCues.forEach((c, i) => c.id = i + 1);
    overlay.setCues(state.srtCues);
    return cue;
  }
  if (state.format !== 'ass' || !state.kar) return null;
  const zhStyle = (state.kar.sentences.find(x => x.style !== state.kar.wordStyle) || {}).style || '';
  const enStyle = state.kar.wordStyle || '';
  // ASS 里花括号是覆盖标签, 用户文本(译文/ASR)必须转义 —— 与服务端写初稿同一约定
  const zh = zhStyle ? appendSentence(zhStyle, s, e, escAss(zhText)) : null;
  const en = enStyle ? appendSentence(enStyle, s, e, escAss(enText)) : null;
  if (!zh && !en) return null;
  // 英文: 有 ASR 的**真实词级时间**就按它铺（逐词高亮跟着真实发音走）
  if (en) {
    const words = (seg.words || [])
      .map(w => ({ w: w.word, s: w.start, e: w.end }))
      .filter(w => w.e > w.s && w.s >= s - 0.05 && w.e <= e + 0.05);
    if (words.length) {
      en.words = words;
      en.events = state.assDoc.replaceEvents(en.events, buildWordSpecs(en));
    } else if (enText) {
      /* ★ 没有 ASR 词级时间时**也要铺逐词**。
       * 这里以前直接跳过 —— 于是"分段导入"进来的英文行成了**纯整句**，
       * 在逐词稿里那一行的逐词格式就是坏的（用户报"导入后逐词字幕格式损坏"）。
       * karaoke.js 的 recalcWords 对"原本不是逐词句（如刚插入的新行）"的处理
       * 正是**在句内均匀铺满**（见那里的注释），直接调它，不另写一套分摊逻辑。 */
      en.words = recalcWords(en, en.text, s, e);
      en.events = state.assDoc.replaceEvents(en.events, buildWordSpecs(en));
    }
  }
  return registerRecognizedRow({ zh, en, start: s, end: e, no: 0, color: (zh && zh.color) || null, speaker: (zh && zh.speaker) || '' });
}

/** 把建好的行挂进 karaoke 数据（rebuildItemsAndLanes 从 state.kar.rows 重建列表, 漏了就不显示） */
function registerRecognizedRow(row) {
  state.kar.rows.push(row);
  state.kar.rows.sort((a, b) => a.start - b.start || a.end - b.end);
  state.kar.sentences.sort((a, b) => a.start - b.start || a.end - b.end);
  return row;
}

/** 删掉 [a,b] 内原有字幕块, 再按识别结果逐段重建（rebuildItemsAndLanes 会触发自动保存） */
/**
 * 把重识别区间吸附到**字幕块的边界**上。
 *
 * 为什么必须吸附：删除判定是"只要与区间沾边就删整行"（itemsInRange 用 `end > a && start < b`）。
 * 于是区间边界切在某一行中间时，**整行被删掉，但重识别只覆盖了那一部分音频**，
 * 露在区间外的那一截内容就永久丢失了。
 *
 * 实测（41 行 / 7 段区间）：7 行被部分覆盖，其中一行右侧露出 6.51 秒的内容被白白删掉。
 *
 * 吸附规则：边界落在某一行内部时就扩展到该行的边缘，让每一行
 *   · 要么完全在区间内（整行替换 = 正确）
 *   · 要么完全在区间外（完全不动）
 * 两种状态之间没有"覆盖一半"。
 *
 * 代价是区间边界可能向外挪最多一行的时长（实测中位 5~6 秒，取决于念白速度），
 * 换来的是**不丢内容** —— 这个取舍是明确的。
 */
function snapRegionsToRows(regions, rows) {
  const list = (rows || []).filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
  return (regions || []).map(rg => {
    if (!Number.isFinite(rg.start) || !Number.isFinite(rg.end) || rg.end <= rg.start) return rg;
    let a = rg.start, b = rg.end;
    for (const r of list) {
      // 边界落在该行内部 → 扩到该行边缘
      if (r.start < a && a < r.end) a = r.start;
      if (r.start < b && b < r.end) b = r.end;
      // 该行**大部分**落在区间内（≥50%）→ 一并纳入，避免留下一条细碎残行
      const ov = Math.min(b, r.end) - Math.max(a, r.start);
      if (ov > 0 && ov >= (r.end - r.start) * 0.5 && (r.start < a || r.end > b)) {
        a = Math.min(a, r.start);
        b = Math.max(b, r.end);
      }
    }
    return { start: a, end: b };
  }).sort((x, y) => x.start - y.start);
}

/**
 * 把重识别结果写回字幕。
 *
 * `regions` 是**实际重识别过的区间列表**（单区间重识别传 null，等价于 [a,b]）。
 *
 * 为什么要按区间逐段处理，而不是删掉总跨度 [a,b] 再全部加回：
 * 批量纠错给出的是**多个互不相邻**的区间（例如 90~104s、168~181s、191~224s）。
 * 早期实现用 [首段起点, 末段终点] 这一个总跨度去"删掉范围内所有行"，
 * 于是**段与段之间那些从未被重识别的内容也被一起删掉，且永远不会被加回**——
 * 用户看到的就是"识别后出现大量空缺"（实测：跨度 134 秒里只有 67 秒真的重识别过）。
 *
 * 写回前还会把区间**吸附到字幕块边界**（见 snapRegionsToRows），
 * 否则边界上那些"只被覆盖一半"的行会整行被删、露出的一截内容永久丢失。
 */
function applyRecognized(a, b, segs, regions) {
  const segsArr = Array.isArray(segs) ? segs : [];
  let regs = (Array.isArray(regions) ? regions : [])
    .filter(r => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map(r => ({ start: r.start, end: r.end }))
    .sort((x, y) => x.start - y.start);
  if (!regs.length) regs = [{ start: a, end: b }];
  /* 吸附到字幕块边界：避免"整行被删、只补回一半"造成内容丢失。
   * 吸附可能让相邻两段扩到同一个字幕块上而**互相重叠**（实测：11~22 与 23~34
   * 都吸附到 10~25 与 20~35），所以吸附后必须**再求一次并** ——
   * 重叠区间会破坏"每段只跑一遍"，也会让 segment 归类出现空档。 */
  regs = snapRegionsToRows(regs, state.items || []);
  const mergedRegs = [];
  for (const r of regs) {
    const last = mergedRegs[mergedRegs.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else mergedRegs.push({ start: r.start, end: r.end });
  }
  regs = mergedRegs;

  // 每段各自认领落在自己范围内的识别结果（用中点判定，避免边界上的抖动）
  const byReg = regs.map(() => []);
  for (const seg of segsArr) {
    const mid = (Number(seg.start) + Number(seg.end)) / 2;
    let k = regs.findIndex(r => mid >= r.start && mid <= r.end);
    if (k < 0) {                                   // 落在缝隙里（服务端小抖动）→ 归最近的一段
      let best = 0, bd = Infinity;
      regs.forEach((r, i) => {
        const d = mid < r.start ? r.start - mid : mid - r.end;
        if (d < bd) { bd = d; best = i; }
      });
      k = best;
    }
    byReg[k].push(seg);
  }

  if (state.selected) state.selected = null;
  timeline.clearRangeSel();
  /* **降序**写回：applyRecognizedOnce 会按区间删行再插行，会改变后面行的下标。
   * 从后往前做，前面区间的下标才不受影响。 */
  let n = 0;
  const order = regs.map((r, i) => i).sort((x, y) => regs[y].start - regs[x].start);
  for (const i of order) {
    n += applyRecognizedOnce(regs[i].start, regs[i].end, byReg[i]);
  }
  reconcileKaraoke();
  // 视频区(libass 渲染层)必须同步重喂, 否则只有列表有新行、画面上还是旧的
  if (state.format === 'ass' && state.assDoc) assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  return n;
}

/** 单个区间的写回：删掉区间内的行，再把该区间的识别结果加回 */
function applyRecognizedOnce(a, b, segs) {
  // 向后兼容：老调用点可能传单个 seg 而不是数组
  const list = Array.isArray(segs) ? segs : (segs ? [segs] : []);
  const targets = itemsInRange(a, b);
  for (const it of targets) removeItemData(it);   // 先全部摘掉, 与批量删除同一套
  let n = 0;
  for (const seg of list) { if (addRecognizedRow(seg)) n++; }
  return n;
}

/** 后台任务轮询: 进度画在时间轴常驻区域上, 完成后写回字幕并提示 */
let reRecogPoll = 0;
function stopRerecogPoll() { clearInterval(reRecogPoll); reRecogPoll = 0; }
function setReRecogRegion(a, b, patch) {
  const cur = timeline.reRecogRegion || { a, b };
  if (a != null) cur.a = a;
  if (b != null) cur.b = b;
  timeline.reRecogRegion = Object.assign(cur, patch || {});
  timeline.touch();          // 区域/进度是直接改的 timeline 属性, 手动置脏才会立刻重绘
}
function clearReRecogRegion() { timeline.reRecogRegion = null; stopRerecogPoll(); timeline.touch(); }

/** 重开项目(含刷新页面)时接回后台还在跑的重新识别任务:
 *  否则时间轴上不显示那个紫区、任务跑完了也收不到结果(用户以为白跑了)。
 *
 *  同样走 /reidentify 而不是 /rerecognize：后者回的原始 job 没有 jobView 加工，
 *  批量任务会丢掉 regions，时间轴上就只画第一段（实测踩过）。 */
async function resumeRerecog(pid) {
  if (timeline.reRecogRegion || reRecogPoll) return;
  let j;
  try { j = (await (await fetch(`/api/projects/${pid}/reidentify`)).json()).job; } catch { return; }
  if (!j || j.status !== 'running' || !state.project || state.project.id !== pid) return;
  setReRecogRegion(j.start, j.end, {
    status: j.status, progress: j.progress, message: j.message,
    regions: (Array.isArray(j.regions) && j.regions.length > 1) ? j.regions : null,
  });
  startRerecogPoll(pid);
}

function startRerecogPoll(pid) {
  stopRerecogPoll();
  reRecogPoll = setInterval(async () => {
    if (!timeline.reRecogRegion) return stopRerecogPoll();
    if (!state.project || state.project.id !== pid) return clearReRecogRegion();   // 切了项目: 收掉
    let m;
    /* 轮询 /reidentify 而不是 /rerecognize：前者的 GET 走 jobView()，会带上
     * batch / regions / regionDone 这些批量字段；后者的 GET 直接回**原始 job**
     * （没有 jobView 加工），于是"第 N/M 段"这种进度信息在前端拿不到（实测踩过）。
     * 两者的任务存在同一个 Map 里，所以对单区间重识别同样有效。 */
    try { m = await (await fetch(`/api/projects/${pid}/reidentify`)).json(); } catch { return; }
    const j = m.job;
    if (!j) return clearReRecogRegion();                    // 服务重启, 任务没了
    setReRecogRegion(null, null, { status: j.status, progress: j.progress, message: j.message });
    // 右下角进度卡：批量的显示"第 N/M 段"，单区间的显示阶段与百分比
    if (j.status === 'running') {
      const isBatch = !!j.batch && (j.regionTotal | 0) > 1;
      const foot = isBatch
        ? `第 <b>${(j.regionIndex | 0) + 1}</b>/${j.regionTotal} 段 · 已完成 ${j.regionDone | 0} 段`
        : '正在重识别这一段；可以继续编辑其它字幕';
      jobCardShow(isBatch ? '纠错重识别 · 逐段进行' : '重新识别 · 进行中',
        j.message || '识别中…', j.progress, foot);
      return;
    }
    stopRerecogPoll();
    const a = timeline.reRecogRegion.a, b = timeline.reRecogRegion.b;
    if (j.status === 'done') {
      const segs = j.segments || [];
      /* 批量纠错返回**多个互不相邻**的区间，必须逐段写回（见 applyRecognized 的说明）——
       * 早期只传 [首段起点, 末段终点] 的总跨度，会把段与段之间未重识别的内容一起删掉，
       * 造成"识别后大量空缺"。 */
      const regs = (Array.isArray(j.regions) && j.regions.length) ? j.regions : null;
      const n = segs.length ? applyRecognized(a, b, segs, regs) : 0;
      clearReRecogRegion();
      // warning 里可能是「API Key 为空，未翻译」这类必须让用户看到的提示
      const span = regs
        ? `（${regs.length} 段，共 ${Math.round(regs.reduce((s, r) => s + (r.end - r.start), 0))} 秒音频）`
        : '';
      jobCardDone('重新识别 · 完成', `${n} 行已写回字幕${span}`
        + (j.warning ? ` —— ${j.warning}` : ''), true);
      toast(`重新识别已完成：${n} 行已写回字幕${span}` + (j.warning ? ' —— ' + j.warning : ''), 9000);
    } else {
      const err = j.error || '未知错误';
      clearReRecogRegion();
      jobCardDone('重新识别 · 失败', String(err).slice(0, 160), false);
      toast(`重新识别失败：${err}`, 6600);
    }
  }, 1000);
}

/**
 * 发起一次区间重新识别（切音频 → ASR → 翻译 → 写回）。
 *
 * 两个入口共用：时间轴上的**选区**按钮，和字幕列表里**每行**的「↻ 重识别」。
 * 每行按钮用该句自己的 [start,end]，所以这里只认区间、不关心谁调的。
 *
 * @param a,b    时间区间（秒）
 * @param why    日志/提示里说明来源（'选区' / '第 N 句'）
 */
async function startRerecog(a, b, why) {
  if (reRecogBusy) return false;
  if (!(b > a)) return false;
  if (!state.project) { toast('重新识别只在项目模式可用（需要项目里已保存的音频）', 4600); return false; }
  if (state.format !== 'ass' && state.format !== 'srt') { toast('当前字幕格式不支持重新识别'); return false; }
  if (timeline.reRecogRegion) { toast('已有一个重新识别任务在进行中，请等它结束', 3800); return false; }
  const pidAtStart = state.project.id;    // 下面的 await 期间用户可能切项目: 用捕获值, 返回前再校验
  // API Key 为空时明确告诉用户"只识别不翻译", 别让结果悄无声息地缺了中文
  let llmReadyNow = false;
  try { llmReadyNow = !!(await (await fetch('/api/translate/config')).json()).ready; } catch {}
  if (!state.project || state.project.id !== pidAtStart) return;   // 期间切走了: 静默放弃
  if (!llmReadyNow) toast('翻译未就绪（API Key 为空或本地模型缺失）：本次只重新识别、不翻译', 8000);
  reRecogBusy = true;
  try {
    const r = await fetch(`/api/projects/${pidAtStart}/rerecognize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: a, end: b })
    });
    const m = await r.json();
    if (!state.project || state.project.id !== pidAtStart) return;  // 响应回来前又切走了
    if (!r.ok) { toast(m.error || '重新识别启动失败', 5600); return false; }
    if (timeline.rangeSel) timeline.clearRangeSel();   // 选区收起; 常驻区域留在时间轴上直到任务结束
    setReRecogRegion(a, b, { status: 'running', progress: 2, message: '正在切出音频片段…' });
    startRerecogPoll(pidAtStart);
    toast(`重新识别已在后台开始（${why}），可以继续编辑其它字幕，完成后会提示`, 6600);
    return true;
  } catch (e) {
    toast('重新识别启动失败: ' + e.message, 5600);
    return false;
  } finally {
    reRecogBusy = false;
  }
}

/* ═══════════ 右下角进度卡（后台长任务的统一出口）═══════════════
 * 反思与纠错重识别都要跑几十秒到几分钟（本地模型更久）。原来只有：
 *   · 反思 —— 一个挡住编辑区的弹窗（还不能关，关了不知道跑没跑）
 *   · 重识别 —— 时间轴上的紫带 + 一条几秒就消失的 toast
 * 都不好用。这里统一成一张右下角的常驻小卡：不挡操作、进度持续可见、结束自动收起。
 *
 * 两种进度形态：
 *   · 确定进度 —— 有真实百分比（重识别按段推进）
 *   · 不确定进度 —— 拿不到真实进度时用条纹动画表示"在动"（反思是同步请求）
 */
const jobCardEls = {
  box: document.getElementById('job-card'),
  title: document.getElementById('jc-title'),
  bar: document.getElementById('jc-bar-in'),
  msg: document.getElementById('jc-msg'),
  foot: document.getElementById('jc-foot'),
  close: document.getElementById('jc-close'),
};
let jobCardHideTimer = 0;

/** 显示/更新进度卡。pct 传 null 表示"进度未知"，用条纹动画 */
function jobCardShow(title, msg, pct, foot) {
  const e = jobCardEls;
  if (!e.box) return;
  clearTimeout(jobCardHideTimer);
  e.box.hidden = false;
  e.box.classList.remove('jc-done', 'jc-err');
  if (e.title && title != null) e.title.textContent = String(title);
  if (e.msg) e.msg.textContent = String(msg == null ? '' : msg);
  const indet = !(typeof pct === 'number' && isFinite(pct));
  e.box.classList.toggle('jc-indet', indet);
  if (!indet && e.bar) e.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (e.foot) {
    if (foot) { e.foot.hidden = false; e.foot.innerHTML = foot; }
    else { e.foot.hidden = true; e.foot.innerHTML = ''; }
  }
}

/** 结束态：成功绿、失败红，停留几秒后自动收起（用户也能立刻手动关） */
function jobCardDone(title, msg, ok) {
  const e = jobCardEls;
  if (!e.box || e.box.hidden) return;
  if (e.title && title != null) e.title.textContent = String(title);
  if (e.msg) e.msg.textContent = String(msg == null ? '' : msg);
  e.box.classList.remove('jc-indet');
  e.box.classList.add(ok ? 'jc-done' : 'jc-err');
  if (e.bar) e.bar.style.width = '100%';
  clearTimeout(jobCardHideTimer);
  // 出错多留一会儿（用户要看原因），成功 4 秒足够
  jobCardHideTimer = setTimeout(jobCardHide, ok ? 4000 : 12000);
}

function jobCardHide() {
  clearTimeout(jobCardHideTimer);
  if (jobCardEls.box) jobCardEls.box.hidden = true;
}
if (jobCardEls.close) jobCardEls.close.addEventListener('click', jobCardHide);

/* ═══════════ 长稿反思纠错（预览优先）═══════════════
 * 流程：点「🧠 反思纠错」→ 服务端让 LLM **通读全片**（分批 + 相邻批重叠）
 *      → 返回建议清单 + 去重后的重识别区间 → 用户在预览里逐条勾选或全选
 *      → 确认后 POST /reidentify 批量重识别 → 轮询 → 一次写回。
 *
 * 为什么"全选"不是默认直接执行：一次纠错会改动几十行、烧掉一次模型调用，
 * 用户要先看到"要改哪些、为什么、代价多大"再决定 —— 这就是预览优先。
 *
 * 轮询复用 startRerecogPoll()：它跑完会调 applyRecognized(a, b, segs)，
 * 而那个函数是"删掉区间内所有目标行 + 把新行全部加回"，
 * 所以多段一次写回也成立（区间已求并，天然有序、不重叠）。
 */
let reflectData = null;        // 最近一次反思结果 { findings, regions, summary, notes, rows }
let reflectPicked = new Set(); // 勾选的下标（指向 findings）
let reflectApplying = false;   // "应用选中项"正在进行中（防重入，见 applyReflect）

const reflectEls = {
  overlay: document.getElementById('reflect-overlay'),
  msg: document.getElementById('reflect-msg'),
  conf: document.getElementById('reflect-conf'),
  confVal: document.getElementById('reflect-conf-val'),
  confNote: document.getElementById('reflect-conf-note'),
  summary: document.getElementById('reflect-summary'),
  allWrap: document.getElementById('reflect-all-wrap'),
  all: document.getElementById('reflect-all'),
  allNote: document.getElementById('reflect-all-note'),
  list: document.getElementById('reflect-list'),
  cancel: document.getElementById('reflect-cancel'),
  reload: document.getElementById('reflect-reload'),
  apply: document.getElementById('reflect-apply'),
  btn: document.getElementById('btn-reflect'),
};

function reflectShow(show) {
  if (reflectEls.overlay) reflectEls.overlay.hidden = !show;
}

/* 逐句置信度的档位文案（与全局设置页的措辞保持一致，别另起一套说法）。
 * 档位常量在这里**必须重新声明**：project.js 里那个 CONF_MODES 是 ES 模块作用域的
 * （project.js 由 main.js `import { initProjects }` 加载），跨模块看不见 ——
 * main.js 直接引用会 ReferenceError。服务端 CONFIDENCE_MODES 是同一套取值。 */
const CONF_MODES = ['off', 'fast', 'full'];
const CONF_MODE_TEXT = {
  off: { name: '关闭', note: '重识别只出文本，不标可信度（最快）' },
  fast: { name: '快速', note: '标出可信度，但不做稳定性重跑' },
  full: { name: '完整', note: '音频加噪重跑 2 遍做稳定性判定，识别约慢一倍' },
};

/**
 * 在预览里显示本次重识别会用的置信度档位。
 *
 * 用户要求"直接跟随全局设置"：服务端的 asrConfidenceFor() 已经是
 * 「项目级 → 全局」的链路（项目没单独设过就用全局），这里只是把它**显示出来** ——
 * 否则用户事后发现"怎么这次没有置信度"，却不知道去哪儿看。
 * 所以这里只读不写，要改得去全局设置（提示里给出路径）。
 */
async function reflectShowConfMode() {
  const e = reflectEls;
  if (!e.conf) return;
  // 项目级优先，其次全局；两者都读不到就不显示，别瞎猜
  let mode = null, projectLevel = false;
  try {
    const meta = (state.project && state.project.draft) || {};
    if (CONF_MODES.includes(meta.confidence)) { mode = meta.confidence; projectLevel = true; }
    if (!mode) {
      const r = await fetch('/api/asr/confidence', { signal: AbortSignal.timeout(6000) });
      if (r.ok) mode = (await r.json()).mode || null;
    }
  } catch { /* 读不到就不显示 */ }
  if (!CONF_MODES.includes(mode)) { e.conf.hidden = true; return; }
  const info = CONF_MODE_TEXT[mode] || { name: mode, note: '' };
  e.conf.hidden = false;
  if (e.confVal) e.confVal.textContent = info.name;
  if (e.confNote) {
    e.confNote.textContent = projectLevel
      ? `（本稿件单独设为「${info.name}」）${info.note}；改档位去「全局设置 → 识别增强」`
      : `（跟随全局设置）${info.note}；改档位去「全局设置 → 识别增强」`;
  }
}
function reflectEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const REFLECT_KIND = {
  merge:      { label: '合并重听', cls: 'chip-l1', tip: '这几行本该是一句，合并成一个区间重新识别' },
  reidentify: { label: '重识别',   cls: 'chip-conf-low', tip: '这段疑似听错/拼接，重新识别该区间' },
  // gap 现在**可执行**：补识别那段空档，把漏掉的内容找回来。
  // （早期它只是"提示"，因为那时只能靠模型报；模型看不到静音，实测漏掉了
  //   全片唯一一处 4.75 秒空档 —— 那段漏掉的话就永远补不回来。）
  gap:        { label: '补漏识别', cls: 'chip-bad', tip: '这一段音频没有识别出内容，补识别一次把它找回来' },
};

/** 找出某个 finding 对应哪一段重识别区间（用于在清单里显示"这段多长"） */
function reflectRegionOf(f, regions) {
  // gap 的区间是它自己那对精确时间（服务端 findTimeGaps 给的）
  if (f.kind === 'gap') {
    if (Number.isFinite(f.start) && Number.isFinite(f.end)) {
      return { start: f.start, end: f.end, dur: Number.isFinite(f.dur) ? f.dur : (f.end - f.start) };
    }
    // 模型报的 gap 没带时间（parseFindings 会尽量补上）；退回按行找
  }
  return (regions || []).find(r => f.from >= r.lo && f.to <= r.hi) || null;
}

function reflectRender() {
  const d = reflectData;
  if (!d || !reflectEls.list) return;
  const s = d.summary || {};
  const kindTxt = Object.entries(s.byKind || {}).map(([k, v]) => `${REFLECT_KIND[k] ? REFLECT_KIND[k].label : k} ${v}`).join(' · ');
  const secs = Number(s.audioSec) || 0;
  if (reflectEls.summary) {
    reflectEls.summary.hidden = false;
    reflectEls.summary.innerHTML =
      `通读 <b>${s.rows || 0}</b> 行（${s.batches || 1} 批）→ 建议 <b>${s.findings || 0}</b> 条：${reflectEsc(kindTxt)}<br>`
      + `实际需要重识别 <b>${s.regions || 0}</b> 段、共 <b>${secs.toFixed(1)}</b> 秒音频`
      + `（同段只跑一遍；模型 ${reflectEsc(s.model || '?')}）`
      + (s.dropped ? `<br><span style="color:var(--text-2)">已丢弃 ${s.dropped} 条与其它建议重复的条目</span>` : '')
      + ((d.notes && d.notes.length) ? `<br><span style="color:var(--text-2)">${reflectEsc(d.notes.join('；'))}</span>` : '');
  }
  // gap 也是可执行项了，所以参与"全选"与计数
  const actionable = (d.findings || []).length;
  if (reflectEls.allWrap) {
    reflectEls.allWrap.hidden = !actionable;
    if (reflectEls.allNote) {
      reflectEls.allNote.textContent = actionable
        ? `将重识别 ${d.regions.length} 段、共 ${secs.toFixed(0)} 秒音频；点了「应用」才会改字幕`
        : '没有需要动手的建议';
    }
  }
  reflectEls.list.hidden = !(d.findings || []).length;
  reflectEls.list.innerHTML = (d.findings || []).map((f, i) => {
    const k = REFLECT_KIND[f.kind] || { label: f.kind, cls: '', tip: '' };
    const reg = reflectRegionOf(f, d.regions);
    const isGap = f.kind === 'gap';
    const checked = reflectPicked.has(i) ? ' checked' : '';
    const oldLines = (state.items || []).slice(f.from - 1, f.to)
      .map(it => (it && (it.l2 || it.l1)) || '').filter(Boolean).join(' ／ ');
    return `<label class="reflect-item${isGap ? ' is-gap' : ''}" data-idx="${i}" title="${reflectEsc(k.tip)}">`
      + `<input type="checkbox" data-idx="${i}"${checked}>`
      + `<span class="ri-body">`
      + `<span class="ri-head">`
      + `<span class="cc-chip ${k.cls}">${reflectEsc(k.label)}</span>`
      + `<span class="ri-range">第 ${f.from}${f.to > f.from ? '~' + f.to : ''} 行 · 置信度 ${f.confidence}</span>`
      + (reg ? `<span class="ri-range">→ 重听 ${reg.start.toFixed(1)}~${reg.end.toFixed(1)}s（${Number(reg.dur).toFixed(1)}s）</span>` : '')
      + `</span>`
      + `<span class="ri-reason">${reflectEsc(f.reason)}</span>`
      + (oldLines ? `<span class="ri-text">${reflectEsc(oldLines.slice(0, 140))}</span>` : '')
      + `</span></label>`;
  }).join('');
  reflectUpdateApply();
}

function reflectUpdateApply() {
  if (!reflectEls.apply) return;
  const n = reflectPicked.size;
  reflectEls.apply.disabled = n === 0;
  reflectEls.apply.textContent = n ? `应用选中项（${n} 条）` : '应用选中项';
}

/**
 * 跑一遍反思。
 *
 * 进度放在**右下角进度卡**里，不弹窗挡住编辑区 —— 长稿（几十批）在本地模型上
 * 可能跑几分钟，弹窗会逼用户干等。跑完（或失败）才弹预览清单。
 *
 * 反思是同步请求，拿不到真实批次进度，所以用"不确定进度"条纹 + 已耗时秒数，
 * 至少让用户知道它**还在动**（早期只有一条静止的弹窗文案，被当成卡死）。
 */
async function startReflect() {
  if (!state.project) { toast('反思纠错需要项目模式（要用项目里保存的音频）', 4600); return; }
  if (reflectApplying) { toast('正在应用上一次的纠错结果，请等它结束', 3800); return; }
  if (reflectEls.btn) reflectEls.btn.disabled = true;
  reflectData = null;
  reflectPicked = new Set();
  reflectShow(false);                 // 先不弹窗：进度看右下角那张卡
  const t0 = Date.now();
  const tick = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    jobCardShow('反思纠错 · 通读全片', `正在让模型分批通读字幕…（已用 ${sec} 秒）`, null,
      '长稿可能要几分钟；跑完会自动弹出预览清单');
  }, 1000);
  jobCardShow('反思纠错 · 通读全片', '正在让模型分批通读字幕…', null,
    '长稿可能要几分钟；跑完会自动弹出预览清单');
  try {
    const r = await fetch(`/api/projects/${state.project.id}/reflect`, { method: 'GET' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    reflectData = j;
    /* 默认勾选"置信度 ≥0.8"的条目 —— 预览优先，但别让用户逐条点。
     * gap（补漏识别）是**确定性检出**的（扫时间轴空档，不靠模型），置信度恒为 0.9，
     * 所以自然会被勾上；不想补的取消即可。 */
    reflectPicked = new Set((j.findings || [])
      .map((f, i) => (f.confidence >= 0.8 ? i : -1))
      .filter(i => i >= 0));
    const sec = Math.round((Date.now() - t0) / 1000);
    const nf = (j.findings || []).length;
    jobCardDone('反思纠错 · 完成',
      nf ? `找到 ${nf} 条建议，用时 ${sec} 秒` : `没有发现明显问题，用时 ${sec} 秒`, true);
    // 现在才弹预览
    reflectShow(true);
    if (reflectEls.summary) reflectEls.summary.hidden = true;   // reflectRender 会重新填
    if (reflectEls.msg) {
      const nGap = (j.findings || []).filter(f => f.kind === 'gap').length;
      reflectEls.msg.textContent = nf
        ? ('下面是模型认为需要修正的地方。勾选要应用的条目，再点「应用选中项」。'
           + (nGap ? `其中 ${nGap} 条是「补漏识别」——那段音频没识别出内容，补识别能把它找回来。` : ''))
        : '模型通读全片后没有发现明显问题。';
    }
    if (reflectEls.all) reflectEls.all.checked = reflectPicked.size > 0;
    if (reflectEls.reload) reflectEls.reload.hidden = false;
    reflectShowConfMode();          // 显示本次重识别会用哪一档置信度（跟随全局）
    reflectRender();
  } catch (e) {
    jobCardDone('反思纠错 · 失败', String(e.message || e).slice(0, 160), false);
    // 仍弹窗，让用户在弹窗里看到完整原因（卡片的字体小、两行就截断了）
    reflectShow(true);
    if (reflectEls.msg) {
      reflectEls.msg.innerHTML = `<span style="color:var(--danger)">反思失败：${reflectEsc(e.message)}</span>`;
    }
    if (reflectEls.reload) reflectEls.reload.hidden = false;
  } finally {
    clearInterval(tick);
    if (reflectEls.btn) reflectEls.btn.disabled = false;
  }
}

/** 把选中的建议 → 区间求并 → POST /reidentify → 复用现有轮询写回 */
async function applyReflect() {
  const d = reflectData;
  // 重入保护：本函数一进来就把弹窗关掉，用户看到的是"已回到编辑页"，
  // 很容易再点一次（或双击）—— 第二个请求必然撞上服务端的互斥锁，
  // 弹出"这个稿件已有重新识别任务在跑"，看起来像是上一次失败了。
  if (reflectApplying) return;
  if (!d || !reflectPicked.size) return;
  // 与后端同一套规则：排序后合并重叠/相接的区间（保证每段只跑一次）
  // gap 也是可执行项（补识别那段空档），不再过滤掉
  const picked = [...reflectPicked].map(i => d.findings[i]).filter(Boolean);
  const regs = picked.map(f => reflectRegionOf(f, d.regions)).filter(Boolean);
  if (!regs.length) { toast('选中的条目没有可执行的区间', 4200); return; }
  const uniq = [];
  for (const r of regs.slice().sort((a, b) => a.start - b.start)) {
    const last = uniq[uniq.length - 1];
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end);
    else uniq.push({ start: r.start, end: r.end });
  }
  const total = uniq.reduce((s, r) => s + (r.end - r.start), 0);
  const spanSec = uniq[uniq.length - 1].end - uniq[0].start;
  reflectShow(false);
  reflectApplying = true;
  if (reflectEls.btn) reflectEls.btn.disabled = true;
  // 让用户先看到"要动多大一块、其中多少是真的要重听"——两者差别大时尤其要讲清楚，
  // 否则会以为整段都会被重识别。写回是按 uniq 各段做的，不受这个总跨度影响。
  if (uniq.length > 1 && spanSec > total * 1.25) {
    toast(`将重识别 ${uniq.length} 段 / 共约 ${total.toFixed(0)} 秒音频；`
      + `段与段之间的内容（约 ${(spanSec - total).toFixed(0)} 秒）不受影响`, 9000);
  }
  try {
    const r = await fetch(`/api/projects/${state.project.id}/reidentify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regions: uniq }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    // 时间轴上把那几段画出来。传**各段区间**（uniq）而不是首尾跨度：
    // 逐段画紫带，段与段之间的空隙不涂色，用户才能一眼看出真正在重听的是哪几块。
    const a0 = uniq[0].start, b0 = uniq[uniq.length - 1].end;
    setReRecogRegion(a0, b0, { status: 'running', progress: 1, regions: uniq, message: j.message || '纠错重识别中 …' });
    startRerecogPoll(state.project.id);
    toast(`纠错重识别已在后台开始：${uniq.length} 段、约 ${total.toFixed(0)} 秒音频，完成后会自动写回`, 8000);
    logOp('reflect', `应用 ${picked.length} 条反思建议`,
      `重识别 ${uniq.length} 段、共约 ${total.toFixed(0)} 秒音频`
      + `（${uniq.map(r => `${r.start.toFixed(1)}~${r.end.toFixed(1)}s`).join('、')}）`,
      `模型通读全片给出的建议（合并/重识别${(d.findings || []).some(f => f.kind === 'gap') ? '/补漏识别' : ''}），`
      + `用户勾选后应用；写回按段进行，段与段之间的内容不动`);
  } catch (e) {
    toast('纠错重识别启动失败: ' + e.message, 6000);
  } finally {
    reflectApplying = false;
    if (reflectEls.btn) reflectEls.btn.disabled = false;
  }
}

if (reflectEls.btn) reflectEls.btn.addEventListener('click', startReflect);
if (reflectEls.cancel) reflectEls.cancel.addEventListener('click', () => reflectShow(false));
if (reflectEls.reload) reflectEls.reload.addEventListener('click', startReflect);
if (reflectEls.apply) reflectEls.apply.addEventListener('click', applyReflect);
if (reflectEls.all) {
  reflectEls.all.addEventListener('change', () => {
    const d = reflectData;
    if (!d) return;
    reflectPicked = reflectEls.all.checked
      ? new Set((d.findings || []).map((f, i) => i))   // gap 也一起选上（它现在可执行）
      : new Set();
    reflectRender();
  });
}
if (reflectEls.list) {
  // 事件委托：清单是每次重建 innerHTML，逐个绑会失效
  reflectEls.list.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb || cb.type !== 'checkbox') return;
    const i = Number(cb.dataset.idx);
    if (!Number.isFinite(i)) return;
    if (cb.checked) reflectPicked.add(i); else reflectPicked.delete(i);
    const d = reflectData;
    // 全选框的状态要跟"所有可执行项"比 —— gap 现在也是可执行的
    const actionable = d ? (d.findings || []).length : 0;
    if (reflectEls.all) reflectEls.all.checked = actionable > 0 && reflectPicked.size === actionable;
    reflectUpdateApply();
  });
}
// Esc 关闭（与其它弹窗一致）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && reflectEls.overlay && !reflectEls.overlay.hidden) reflectShow(false);
});

if (rbReRecog) rbReRecog.addEventListener('click', () => {
  const sel = timeline.rangeSel;
  if (!sel) return;
  startRerecog(sel.a, sel.b, '时间轴选区');
});

/* 列表里每行的「↻ 重识别」：用**该句自己的区间**。
 * 事件委托挂在 #cue-spacer 上 —— 列表是虚拟滚动 + 每次重建 innerHTML，
 * 直接给按钮绑事件会随重建失效。 */
{
  const spacer = document.getElementById('cue-spacer');
  if (spacer) spacer.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.cc-rerecog');
    if (!btn || !spacer.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();               // 别让点击顺带选中/打开这一行
    const card = btn.closest('[data-idx]');
    if (!card) return;
    const it = panel.itemAt(Number(card.dataset.idx));
    if (!it) return;
    if (!(it.end > it.start)) { toast('这一句的时间区间无效，无法重识别', 4200); return; }
    // 行号：用列表里的显示序号更符合用户预期（卡片上没写序号，但提示里有更清楚）
    startRerecog(it.start, it.end, `第 ${Number(card.dataset.idx) + 1} 句`);
  });
}

// 点别处 = 取消选区。画布上的点击由 timeline 自己处理, 这里只管"画布之外"(列表/视频区/设置…)
document.addEventListener('pointerdown', (e) => {
  if (!timeline.rangeSel) return;
  if (rangeBar && rangeBar.contains(e.target)) return;   // 点浮条不算"别处"
  if (e.target === timeline.canvas) return;              // 画布内: 交给 timeline 的 pointerdown
  timeline.clearRangeSel();
}, true);

/* ─────────── 异常行筛选（按类别多选） ───────────
 * 与「⚠ 只看异常行」「◔ 只看低置信度」是**并列**条件（交集），互不覆盖。
 * 每类的计数来自当前列表的实际条目，所以能一眼看出哪类最多。
 */
function initBadCatFilter() {
  const wrap = document.getElementById('badcat-wrap');
  const btn = document.getElementById('btn-badcat');
  const panelEl = document.getElementById('badcat-panel');
  const cntEl = document.getElementById('badcat-count');
  if (!wrap || !btn || !panelEl) return;

  const selected = () => new Set([...panelEl.querySelectorAll('input:checked')].map(i => i.value));

  function renderPanel() {
    const items = state.items || [];
    const counts = new Map();
    for (const it of items) for (const k of (it.badCats || [])) counts.set(k, (counts.get(k) || 0) + 1);
    const total = items.filter(it => it.bad).length;

    // 没有异常行 → 整个下拉藏起来（避免误点）
    wrap.hidden = total === 0;
    if (total === 0) { panelEl.hidden = true; return; }   // 没有异常行 → 收起浮层，别留着飘

    const cur = selected();
    const rows = BAD_CATS.map(c => {
      const n = counts.get(c.k) || 0;
      return `<label class="badcat-item" title="${escapeHtml(c.hint)}">
        <input type="checkbox" value="${c.k}"${cur.has(c.k) ? ' checked' : ''}${n ? '' : ' disabled'}>
        <span>${escapeHtml(c.t)}</span><span class="n">${n}</span></label>`;
    }).join('');
    panelEl.innerHTML = rows
      + '<div class="badcat-sep"></div>'
      + '<div class="badcat-act">'
      + '<button type="button" class="btn btn-mini" id="badcat-clear">清空</button>'
      + '<button type="button" class="btn btn-mini" id="badcat-all">全选有问题的</button>'
      + '</div>';

    panelEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', apply);
    });
    const clr = document.getElementById('badcat-clear');
    if (clr) clr.addEventListener('click', () => {
      panelEl.querySelectorAll('input').forEach(i => { i.checked = false; });
      apply();
    });
    const all = document.getElementById('badcat-all');
    if (all) all.addEventListener('click', () => {
      panelEl.querySelectorAll('input').forEach(i => { i.checked = !i.disabled; });
      apply();
    });
  }

  function apply() {
    const sel = selected();
    panel.setBadCats(sel);
    btn.classList.toggle('active', sel.size > 0);
    if (cntEl) cntEl.textContent = sel.size ? ` ${sel.size}` : '';
    // 计数要跟着筛选后的条目数走，所以重绘面板；面板本来是开着的就别关（用户还在勾选），
    // 重绘会清掉内联尺寸，所以重绘后要重新摆一次位置。
    if (!panelEl.hidden) { renderPanel(); placePanel(); }
  }

  // 把浮层从工具栏里挪到 <body>：工具栏是 overflow 滚动容器（会裁切），
  // 而且它在层叠顺序上低于后面的 #cue-list，absolute + z-index 解决不了。
  if (panelEl.parentNode !== document.body) document.body.appendChild(panelEl);

  /** 按按钮位置摆浮层：右对齐按钮右缘，下方 4px；贴到视口边缘时自动翻到上方/内收。 */
  function placePanel() {
    if (panelEl.hidden) return;
    const b = btn.getBoundingClientRect();
    const w = panelEl.offsetWidth, h = panelEl.offsetHeight;
    let left = b.right - w;                       // 右对齐
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    let top = b.bottom + 4;
    if (top + h > window.innerHeight - 6) top = Math.max(6, b.top - h - 4);   // 下面放不下就翻上去
    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';
  }
  function openPanel() {
    panelEl.hidden = false;
    renderPanel();
    placePanel();
  }
  function closePanel() { panelEl.hidden = true; }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panelEl.hidden) openPanel(); else closePanel();
  });
  // 点面板内部不关；点别处关（capture 阶段，先于列表自己的点击处理）
  panelEl.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('pointerdown', (e) => {
    if (!panelEl.hidden && !wrap.contains(e.target) && !panelEl.contains(e.target)) closePanel();
  }, true);
  // 滚动/缩放后按钮位置会变：浮层是 fixed 定位，得跟着挪（否则会飘在别处）
  window.addEventListener('resize', placePanel);
  window.addEventListener('scroll', placePanel, true);
  const cueList = document.getElementById('cue-list');
  if (cueList) cueList.addEventListener('scroll', placePanel, { passive: true });

  // 列表每次重建（识别/编辑/筛选）后刷新计数（rebuildItemsAndLanes 会调它）
  window.__refreshBadCat = renderPanel;
  renderPanel();
}

/* ─────────── 手动刷新动态字幕(渲染层兜底) ─────────── */
const btnRefresh = document.getElementById('btn-refresh-subs');

function updateFixButton() {
  if (!btnFix) return;
  const enabled = state.format === 'ass' && !!state.kar && !!state.selected;
  btnFix.disabled = !enabled;
  btnFix.title = enabled
    ? '检查并修复当前选中的 ASS 字幕'
    : '请先选中一条 ASS 字幕';
}

/**
 * 按「字幕列表里的干净整句 + 词级时间(JSON)」重新生成动态字幕(逐词切片), 然后重新应用到视频区。
 * 用途: 某些路径漏了 update / 渲染器没初始化好时, 给用户一个手动兜底(重复点无副作用)。
 *
 * 只修**真的不一致**的行, 两类东西刻意不碰:
 *   · 零长事件(开始==结束): 文件里常见的空档填充, 不显示任何内容, 重建天然不会产生它 —— 不算漂移;
 *   · 「逐词多余/缺词」(模型词数与文本词数对不上): 已知脏数据, 交给「🛠 修复字幕」按需处理, 刷新不越权代修。
 * 于是对正常文件, 刷新 = 纯粹的"重新应用", 不会偷偷改数据。
 */
function refreshDynamicSubtitles() {
  if (state.format === 'srt') {                 // SRT: 叠加层重新灌一遍就是"重生成"
    overlay.setCues(state.srtCues);
    toast('已按字幕列表重新生成并应用到视频');
    return;
  }
  if (state.format !== 'ass' || !state.kar) { toast('当前没有可刷新的字幕'); return; }

  const near = (a, b) => Math.abs(a - b) < 5e-4;
  const live = (arr) => arr.filter(x => x.end - x.start > 0.004);   // 丢掉零长事件再比
  let words = 0, anchors = 0;
  for (const sent of state.kar.sentences) {
    if (!sent.events || !sent.events.length) continue;
    // 整句样式(中文)绝不重切片: 只有逐词样式的句子才允许走逐词重建分支,
    // 否则历史脏数据(中文句带词级时间)会在这里被重新切片, 画面上同一句中文出现两遍。
    if (sent.words && sent.words.length && sent.style === state.kar.wordStyle) {
      const txtWords = splitEnglishWords(sent.text || '').length;
      if (sent.words.length !== txtWords) continue;      // "逐词多余/缺词" 脏行 → 不代修
      const specs = live(buildWordSpecs(sent));
      const evs = live(sent.events);
      const drifted = specs.length !== evs.length || specs.some((sp, i) => {
        const ev = evs[i];
        return !ev || !near(sp.start, ev.start) || !near(sp.end, ev.end)
          || assPlainText(sp.text) !== assPlainText(ev.text);   // 只比"看得见的文字", 忽略色标大小写等
      });
      if (!drifted) continue;
      sent.events = state.assDoc.replaceEvents(sent.events, buildWordSpecs(sent));
      words++;
    } else {
      // 整句行: 文本(剥标签后)或时间与列表不一致才回写, 保留行首 {\c&H…&} 等等。
      // events>1 的整句句(残留切片)永远算"漂移" → applyAnchorSentence 会折叠回单事件。
      const ev = sent.events[0];
      if (sent.events.length === 1 && assPlainText(ev.text) === (sent.text || '') && near(ev.start, sent.start) && near(ev.end, sent.end)) continue;
      applyAnchorSentence(sent, sent.start, sent.end, sent.text || '');
      anchors++;
    }
  }

  const text = state.assDoc.serialize();
  const wasLoaded = assPlayer.loaded;
  if (wasLoaded) assPlayer.updateNow(text);
  else assPlayer.load(text);                    // 渲染器还没起来 → 顺便重建一次
  const changed = words + anchors;
  if (!changed) toast('动态字幕已是最新，已重新应用到视频');
  else toast(`已重新生成动态字幕：修正 ${words} 句逐词 / ${anchors} 句整句${wasLoaded ? '，并已应用' : '，并重建了渲染器'}`);
}

if (btnRefresh) btnRefresh.addEventListener('click', () => refreshDynamicSubtitles());
if (btnFix) btnFix.addEventListener('click', () => {
  if (!state.selected) { toast('请先选中一条字幕'); return; }
  openFixForRow(state.selected.ref);
});
updateFixButton();

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
    if (ni) { selectItem(ni, false); panel.startEdit(ni, 2); }   // 直接进编辑并落到**英文区**(2=英文行); 按 Tab 回中文区
    toast(`已新建字幕 ${fmtTime(start)} → ${fmtTime(end)}，在列表里输入内容`);
    return;
  }
  if (state.format !== 'ass' || !state.kar) return;
  const zhStyle = (state.kar.sentences.find(s => s.style !== state.kar.wordStyle) || {}).style || '';
  const enStyle = state.kar.wordStyle || '';
  const zh = zhStyle ? appendSentence(zhStyle, start, end, '') : null;
  const en = enStyle ? appendSentence(enStyle, start, end, '') : null;
  if (!zh && !en) { toast('新建失败：文档里没有可用的字幕样式'); return; }
  const newRow = { zh, en, start, end, no: 0, color: (zh && zh.color) || null, speaker: (zh && zh.speaker) || '' };
  state.newRows.add(newRow);          // 空文本: 输入后保留, 空着离开则撤销
  state.kar.rows.push(newRow);
  state.kar.rows.sort((a, b) => a.start - b.start || a.end - b.end);
  state.kar.sentences.sort((a, b) => a.start - b.start || a.end - b.end);
  // 新块压在现有行的时间上(双行轨下合法) → 与 Shift 拖动同一约定: 重叠行去逐词,
  // 否则旧行的逐词切片和新块会同时渲染、在画面上叠成一团(用户报的「逐词还在」)
  const cleared = deKaraokeOverlaps(newRow);
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  const ni = state.itemByRef.get(newRow);
  if (ni) { selectItem(ni, false); panel.startEdit(ni, 2); }   // 直接进编辑并落到**英文区**(2=英文行); 按 Tab 回中文区
  toast(`已新建字幕 ${fmtTime(start)} → ${fmtTime(end)}，在列表里输入内容`
    + (cleared ? `（与 ${cleared} 行重叠，已暂去逐词）` : ''));
}
timeline.onCreate = (s, e) => createRowAt(s, e);

/* ─────────── 英文行专属: Ctrl+回车 分句 / Ctrl+退格 与上一条合并 ───────────
 * 只从行内编辑器(editor.js)触发, 且只在**英文行**。两个动作都先 commitEdit():
 * 用户可能改了字还没离开编辑框, 先把最新文本落盘再动结构, 否则会丢改动。 */

/** 角色标记 [Spoke] 在**中文行**文本里(英文行不该有)。复制到新的中/英半句时,
 *  英文那半必须剥掉, 否则会触发「英文行含方括号」坏行告警。 */
function stripLeadSpeakerTag(text) {
  return String(text || '').replace(/^(\s*\{[^}]*\})*\s*\[[^\]]+\]\s*/, '');
}


/** 中文按英文词数比例切: 中英本来就是同一句的两种语言(或同一句的译文), 按词数比例最稳。 */
function splitZhText(zhText, k, nEn) {
  const zh = stripLeadSpeakerTag(zhText).trim();
  if (!zh || nEn < 1 || k <= 0 || k >= nEn) return [zh, ''];
  const cut = Math.max(1, Math.min(zh.length - 1, Math.round(zh.length * k / nEn)));
  return [zh.slice(0, cut).trim(), zh.slice(cut).trim()];
}

/** 在光标处把一条字幕切成两条:
 *  文本按光标所在的**词边界**切（`_splitPoint`，规范分词口径，与词级时间一致）；
 *  时间切点 = 前半最后一个词的结束与后半第一个词的开始之间的中点（没有词级时间时按词数比例）；
 *  英文词级时间**原样保留**在两半里（不重算），逐词卡拉OK效果不会被切分弄坏。
 *  实现上**前半就地改写原行**（复用它的两条事件），只有后半是新建的 —— 不能"先删原行再
 *  appendSentence 两次"：那个函数是在该样式最后一条事件之后插入，样式被删空（例如文件里只有这一条）
 *  会返回 null，两半一起消失（分句真机探针抓到过）。 */
function splitRowAt(item, enPlainText, caret) {
  if (!item) return false;
  panel.commitEdit();                      // 先把编辑框里的最新文本落盘
  const row = item.ref;
  if (!row || !state.kar || state.kar.rows.indexOf(row) === -1) { toast('这条字幕不能分句'); return false; }
  const enPlain = String(enPlainText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  // 词数必须用**规范分词**(空白 + , . ? ! —— 与 _splitPoint / 词级时间同一个口径), 不能按空格数:
  // "wood,need" 在规范分词里是**两个**词, 按空格切却只算一个 —— k 与文本切点于是错位, 分句会多切一个词
  // (用户报的: 光标在 "…my house|oh my god" 却被切成 "…my house oh / my god")。
  const toks = splitEnglishWords(enPlain);
  const totW = toks.length;
  const sp = panel._splitPoint ? panel._splitPoint(enPlain, caret) : null;
  if (!enPlain || !sp || totW < 2) { toast('把光标放在句子中间再按 Ctrl+回车 才能分句'); return false; }
  const k = sp.k;
  // 文本按**原字符位置**切(保留原始空格: "wood,need" 不会被改写成 "wood, need"); k 只用来分配词级时间
  const enA = enPlain.slice(0, sp.sp).trim();
  const enRest = enPlain.slice(sp.sp).trim();

  const t0 = row.start, t1 = row.end;
  const enS = row.en;
  let st = null;                           // 切点时间
  if (enS && enS.words && enS.words.length === totW && totW > k) {
    st = (enS.words[k - 1].e + enS.words[k].s) / 2;
  } else {
    st = t0 + (t1 - t0) * k / totW;
  }
  st = Math.max(t0 + 0.02, Math.min(t1 - 0.02, st));      // 两半都要有可见时长
  if (!(st > t0 && st < t1)) { toast('切分点太靠近边缘，无法分句'); return false; }

  const zhText = row.zh ? (row.zh.text || '') : '';
  // 行首标签块(颜色覆盖 + 说话人名字标签 [..]): 分句后前后段都应保留同样的名字标签
  const zhTagM = /^\s*(\{\\[^}]*\})*\s*(\[[^\]]+\]\s*)?/.exec(zhText);
  const zhTag = zhTagM ? zhTagM[0] : '';
  // 中文行的行首内联标签(角色色 {\c&H..&} 之类)在**事件文本**里 —— sent.text 是纯文本, 抠不到。
  // 前半就地改写时 applyAnchorSentence 会从原事件继承, 但后半是新建事件、没有来源, 必须显式带上,
  // 否则那一半丢掉角色颜色(用户报的分句后两半变黄)。
  const zhLead = (row.zh && row.zh.events[0]) ? (((/^\s*(\{\\[^}]*\})/.exec(row.zh.events[0].text) || [])[1]) || '') : '';
  const zhBody = zhText.slice(zhTag.length);
  const [zhA0, zhB0] = splitZhText(zhBody, k, totW);
  // 行首前缀 = 事件里的色标 + 纯文本里的角色名(splitZhText 会把角色名剥掉, 这里补回; 两半都要带)
  const zhName = (zhTag || '').replace(/^\s*(\{\\[^}]*\})*\s*/, '');   // zhTag 里只取 [..] 那段, 色标用 zhLead
  const zhPrefix = zhLead + zhName;
  const zhA = (zhPrefix + zhA0).trim();
  const zhB = (zhPrefix + zhB0).trim();
  if (!enA || !enRest) { toast('切分点太靠近边缘，无法分句'); return false; }

  const zhStyle = row.zh ? row.zh.style : ((state.kar.sentences.find(s => s.style !== state.kar.wordStyle) || {}).style || '');
  const enStyle = row.en ? row.en.style : (state.kar.wordStyle || '');
  const color = row.color, speaker = row.speaker, wasNew = state.newRows.has(row);

  // ── 前半: 就地改写原行(保留它自己的事件与颜色/角色标签) ──
  if (row.zh) {
    applyAnchorSentence(row.zh, t0, st, zhA || row.zh.text);
    row.zh.words = [];                     // 中文行只是整句, 不造逐词切片
  }
  if (row.en) applyWordSentence(row.en, t0, st, enA || row.en.text);
  row.start = t0;
  row.end = st;

  // ── 后半: 新建(此刻该样式已有前半这条锚点事件, 所以 appendSentence 一定有地方可插) ──
  const zh2 = zhStyle ? appendSentence(zhStyle, st, t1, zhB) : null;
  const en2 = enStyle ? appendSentence(enStyle, st, t1, enRest) : null;
  if (row.en && en2) en2.highlightTag = row.en.highlightTag || en2.highlightTag;   // 高亮色沿用原行(默认是绿)
  const row2 = { zh: zh2, en: en2, start: st, end: t1, no: 0, color, speaker };

  // 词级时间: 原样分给两半(用原来的词, 不重算) —— 逐词效果得以保留。
  // 注意: applyWordSentence 已经重建过一次切片(用的是它自己重排出来的时间), 事件数早已不是 1,
  // 所以这里**不能**再拿 events.length === 1 当守卫(那会让覆盖白做、所有词被重排 —— 合并那边踩过同一个坑)。
  const allW = (enS && enS.words) ? enS.words : [];
  const hasWords = allW.length === totW && totW > k;
  if (row.en) {
    row.en.words = hasWords ? allW.slice(0, k).map(w => ({ w: w.w, s: w.s, e: w.e }))
                            : recalcWords(row.en, row.en.text, t0, st);
    row.en.events = state.assDoc.replaceEvents(row.en.events, buildWordSpecs(row.en));
  }
  if (en2) {
    en2.words = hasWords ? allW.slice(k).map(w => ({ w: w.w, s: w.s, e: w.e }))
                         : recalcWords(en2, enRest, st, t1);
    en2.events = state.assDoc.replaceEvents(en2.events, buildWordSpecs(en2));
  }
  if (wasNew) state.newRows.add(row2);

  state.kar.rows.push(row2);
  state.kar.rows.sort((a, b) => a.start - b.start || a.end - b.end);
  state.kar.sentences.sort((a, b) => a.start - b.start || a.end - b.end);
  state.selected = null;
  reconcileKaraoke();
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  const ni = state.itemByRef.get(row);                // 光标留在前半的英文行, 接着往下切
  if (ni) { selectItem(ni, false); panel.startEdit(ni, 2); }
  toast(`已在 ${fmtTime(st)} 处分为两条字幕`, 2600);
  logOp('split', `第 ${row.no || '?'} 条 → ${fmtTime(t0)}~${fmtTime(st)} / ${fmtTime(st)}~${fmtTime(t1)}`,
    `按光标位置拆成两条："${enA.slice(0, 40)}" ｜ "${enRest.slice(0, 40)}"`,
    `切点取第 ${k}/${totW} 个词的词间中点（${fmtTime(st)}），逐词时间原样分配给两半、不重算`);
  return true;
}

/** 与**上一个**字幕块合并: 时间取并集; 文本与词级时间交给纯函数 mergeRowParts(karaoke.js)。
 *  规则(用户定): 中文后段以**纯文本**并入且中文行**不造逐词切片**(否则每个词会被包一层绿高亮 ——
 *  用户报的「合句把颜色标签一起合上去」); 英文**不重排**词级时间, 只把上句末词的结束接到本句开始。
 *  做法: **就地改写上一条**, 只摘掉本条 —— 不能"删掉两条再 appendSentence":
 *  那个函数是在该样式最后一条事件之后插入, 样式被删空(例如只剩这两条)时会返回 null, 两条一起消失。 */
function mergeRowWithPrev(item) {
  if (!item) return false;
  panel.commitEdit();
  const row = item.ref;
  if (!row || !state.kar) return false;
  if (state.format !== 'ass' || !state.assDoc) { toast('合并只支持 ASS 特效字幕'); return false; }
  const rows = state.kar.rows;
  const i = rows.indexOf(row);
  if (i <= 0) { toast('这是第一条字幕，前面没有可合并的块'); return false; }
  const prev = rows[i - 1];

  const parts = mergeRowParts(prev, row);
  const start = parts.start, end = parts.end;
  const wasNew = state.newRows.has(prev) || state.newRows.has(row);

  removeItemData(item);                       // 只摘掉本条; 上一条保留下来就地改
  if (prev.zh) {
    applyAnchorSentence(prev.zh, start, end, parts.zhText || prev.zh.text);
    prev.zh.words = [];                       // 中文行只是整句: 不造词级时间/切片
  }
  if (prev.en) {
    applyWordSentence(prev.en, start, end, parts.enText || prev.en.text);
    // 用保留下来的真实词级时间**覆盖** recalcWords 的重排结果，然后按这些词重建切片。
    // 注意：applyWordSentence 已经重建过一次切片（用的是它自己重排出来的时间），事件数早已不是 1，
    // 所以这里不能再拿 events.length === 1 当守卫 —— 那会让覆盖白做（实测所有词被重排）。
    prev.en.words = parts.enWords;
    prev.en.events = state.assDoc.replaceEvents(prev.en.events, buildWordSpecs(prev.en));
  }
  prev.start = start;
  prev.end = end;
  if (wasNew) state.newRows.add(prev);
  refinalizeRow(prev);                        // 颜色/说话人与其它编辑路径一致地重算
  state.selected = null;
  reconcileKaraoke();
  assPlayer.updateNow(state.assDoc.serialize());
  rebuildItemsAndLanes(true, true);
  const ni = state.itemByRef.get(prev);       // 光标回到合并处, 方便继续往前并
  if (ni) { selectItem(ni, false); panel.startEdit(ni, 2); }
  toast(`已与上一条合并为一条字幕（${fmtTime(start)} → ${fmtTime(end)}）`, 2600);
  logOp('merge', `第 ${prev.no || '?'} 条 ← 合并第 ${row.no || '?'} 条`,
    `合并为 ${fmtTime(start)}~${fmtTime(end)}；中文以纯文本并入、英文保留真实词级时间`,
    '用户手动合并（Ctrl+退格）：两行本是同一句');
  return true;
}

panel.onSplitRow = (item, enText, caret) => {
  try { splitRowAt(item, enText, caret); }
  catch (e) { toast('分句失败: ' + ((e && e.message) || e), 4200); }
};
panel.onMergePrev = (item) => {
  try { mergeRowWithPrev(item); }
  catch (e) { toast('合并失败: ' + ((e && e.message) || e), 4200); }
};

/** 右键「重新翻译」: 取该条英文行 → LLM 翻译成中文 → 保留原行首标签(颜色/[角色])回填中文行 */
async function retranslateRow(item) {
  if (!item) return;
  const row = item.ref;
  if (!row) return;
  const enText = String(row.en ? row.en.text : '').replace(/\s+/g, ' ').trim();
  if (!enText) { toast('这一条没有英文内容，无法翻译'); return; }
  toast('正在重新翻译该行…', 2400);
  try {
    const r = await fetch('/api/translate/one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: enText })
    });
    const m = await r.json().catch(() => ({}));
    if (!r.ok || !m.zh) { toast('翻译失败: ' + (m.error || '空结果'), 4600); return; }
    // 行首 {\c...} 颜色标签由 applyAnchorSentence 自动从原事件继承; 这里补回 [角色] 名字前缀
    const zhRaw = row.zh ? (row.zh.text || '') : '';
    const tagM = /^\s*(\{\\[^}]*\})*\s*(\[[^\]]+\]\s*)?/.exec(zhRaw);
    const tag = tagM ? tagM[0] : '';
    if (row.zh) applyAnchorSentence(row.zh, row.start, row.end, (tag + m.zh).trim());
    assPlayer.updateNow(state.assDoc.serialize());
    rebuildItemsAndLanes(true, true);
    toast('已重新翻译该行');
    logOp('retranslate', `第 ${row.no || '?'} 条 ${fmtTime(row.start)}~${fmtTime(row.end)}`,
      `英文：「${enText.slice(0, 50)}」→ 中文：「${String(m.zh).slice(0, 50)}」`,
      '用户右键重新翻译该行（调用字幕翻译用的同一个模型）');
  } catch (e) {
    toast('翻译失败: ' + ((e && e.message) || e), 4600);
  }
}
/* ═══════════ 逐词时间重对齐（用 TTS 合成 + 重新识别得到的节奏） ═══════════
 *
 * 场景：某条字幕的**逐词时间戳糊了**（拖动过、或识别时把词边界摊平了），但文本是对的。
 * 做法：让服务端把这条字幕念一遍、再识别那段合成语音，得到一份干净的参考节奏，
 *       按比例铺回原字幕的时长。**只改逐词时间，绝不动文本。**
 *
 * 为什么值得单独做：逐词时间糊掉时，视频上的逐词高亮会跟读不对，
 * 但整句时间往往是对的 —— 重新识别整段代价大、还可能把正确的文本改坏。
 */
let realignBusy = false;

async function realignRow(item) {
  if (realignBusy) { toast('正在重排另一条，请稍等', 3200); return; }
  if (!state.project) { toast('重排逐词时间需要项目模式（要用项目里保存的音频与模型）', 4600); return; }
  /* 句子对象在 `item.ref` 上（`item.ref.en` / `item.ref.zh`），**不是** item.l1/l2。
   * ⚠ 这里踩过：item.l1/l2 是**文本字符串**（见 rebuildItemsAndLanes 里的 `l1: zhText`），
   *   于是 `item.l1.words` 永远 undefined —— 每条都误报"还没有逐词时间"。 */
  const row = item && item.ref;
  // 中英双行：逐词挂在**英文**那句上（中文是整句锚点句）
  const en = (row && row.en) || null;
  const hasWords = !!(en && Array.isArray(en.words) && en.words.length);
  if (!hasWords) {
    const canConvert = !!(en && en.style && state.kar && en.style === state.kar.wordStyle);
    toast(canConvert
      ? '这条还没有逐词时间。到左侧「设置」页最下方「逐词转换」里点「转逐词」，再回来重排'
      : '这条没有可重排的逐词轨（没有英文行，或英文样式不是逐词样式）', 7000);
    return;
  }
  const text = String(en.text || '').trim();
  if (!text) { toast('这条没有英文文本，没法合成朗读', 4200); return; }
  /* 用**句子**的时间而不是整行的时间：逐词时间必须落在句子自己的区间里。
   * （中英双行时整行区间可能比英文句略宽，用整行会把词铺出句子外。） */
  const start = Number(en.start), end = Number(en.end);
  if (!(end > start)) { toast('这条英文句的时间区间无效', 4200); return; }

  // 记下旧逐词时间：写进操作日志，事后看得出"改成了什么样"
  const beforeWords = en.words.map(w => ({ w: w.w, s: w.s, e: w.e }));

  realignBusy = true;
  const pid = state.project.id;
  const secs = (end - start).toFixed(1);
  jobCardShow('重排逐词时间', `正在朗读并重新识别这条字幕（${secs} 秒）…`, null,
    '服务端要用系统语音念一遍、再用识别模型听一遍；通常几秒');
  try {
    const r = await fetch(`/api/projects/${pid}/realign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: [{ text, start, end }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    if (!state.project || state.project.id !== pid) return;     // 期间切了项目
    const b = (j.blocks || [])[0];
    if (!b) throw new Error('服务端没有返回结果');
    if (!b.ok || !(b.words || []).length) {
      throw new Error(b.note || '这次对齐不可信，未改动');
    }
    /* 写回：**先剥掉原有的逐词高亮标签再写 words**。
     * 原文里每个词都带 `{\c...}` 标签，若把它拼进词表，
     * splitEnglishWords 会把标签当成词，切出来的片数就与词表对不上。 */
    const inner = text
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/[\u200b\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    en.text = inner;                       // 文本内容不变，只是去掉渲染标签
    en.words = b.words.map(w => ({ w: w.w, s: w.s, e: w.e }));
    en.events = state.assDoc.replaceEvents(en.events, buildWordSpecs(en));
    reconcileKaraoke();
    rebuildItemsAndLanes(true, true);
    if (state.format === 'ass' && state.assDoc) assPlayer.updateNow(state.assDoc.serialize());
    const msec = Math.round((end - start) * 1000);
    jobCardDone('重排逐词时间 · 完成', `${b.words.length} 个词已重排（锚点 ${b.anchors}，${msec}ms 区间）`, true);
    toast(`已重排逐词时间：${b.words.length} 个词（文本未改动）`, 5200);
    /* 操作日志：记清"哪一条、多少词、依据是什么"。
     * why 里带上锚点率与 TTS 发音人 —— 这是判断"这次重排可不可信"的关键依据，
     * 事后复盘时没有它就只能猜。 */
    logOp('realign', `第 ${(row && row.no) || '?'} 条 ${fmtTime(start)}~${fmtTime(end)}`,
      `重排 ${b.words.length} 个词的逐词时间（文本未改动）`
      + `；旧值 ${beforeWords.length} 词。识别听到：${String(b.heard || '').slice(0, 80)}`,
      `TTS 朗读→重新识别→序列对齐：锚点 ${b.anchors}/${b.words.length}（${Math.round((b.ratio || 0) * 100)}%），`
      + `发音人 ${b.voice || '系统默认'}${b.rate ? `，语速 ${b.rate > 0 ? '+' : ''}${b.rate}` : ''}`);
  } catch (e) {
    const msg = String((e && e.message) || e);
    jobCardDone('重排逐词时间 · 失败', msg.slice(0, 160), false);
    toast('重排失败：' + msg, 6600);
    logOp('realign', `第 ${(row && row.no) || '?'} 条 ${fmtTime(start)}~${fmtTime(end)}`,
      '重排逐词时间失败，未改动', msg.slice(0, 200));
  } finally {
    realignBusy = false;
  }
}

panel.onRealignCard = (item) => { realignRow(item); };
timeline.onRealign = (cue) => { realignRow(state.itemByRef.get(cue && cue.ref)); };

/* ═══════════ 全片逐词重校对 ═══════════
 *
 * 与上面的「重排逐词时间」是一套东西，区别在**判定谁需要改**：
 *   · 单条重排：用户自己去发现"这句的词时间不对"，右键点名改。
 *   · 全片重校对：逐句 TTS 朗读 + 重新识别，给每句算一个**对齐置信度**，
 *     只对达标的句子改。几百句的稿子肉眼看不出来哪句糊了，让程序体检一遍。
 *
 * 硬约束同单条：**只改逐词时间戳**，不动文本、不动整句起止。
 *
 * 为什么走后台作业 + 轮询：全片几百句、每句一次 TTS + 一次识别（实测 1~2 秒），
 * 整片要几分钟到十几分钟，同步请求必超时。
 */
const realignEls = {
  overlay: document.getElementById('realign-overlay'),
  msg: document.getElementById('realign-msg'),
  conf: document.getElementById('realign-conf'),
  confVal: document.getElementById('realign-conf-val'),
  confNote: document.getElementById('realign-conf-note'),
  summary: document.getElementById('realign-summary'),
  allWrap: document.getElementById('realign-all-wrap'),
  all: document.getElementById('realign-all'),
  allNote: document.getElementById('realign-all-note'),
  list: document.getElementById('realign-list'),
  cancel: document.getElementById('realign-cancel'),
  reload: document.getElementById('realign-reload'),
  apply: document.getElementById('realign-apply'),
  btn: document.getElementById('btn-realign-full'),
};
let realignData = null;          // { items, threshold, total, usable }
let realignPicked = new Set();   // 勾选的 items 下标
let realignRunning = false;
let realignPollTimer = 0;

function realignShow(show) {
  if (realignEls.overlay) realignEls.overlay.hidden = !show;
}

/** 置信度分档：复用反思页既有的 chip 配色（chip-l1 绿 / chip-conf 黄 / chip-conf-low 红），
 *  别为这一处另造一套颜色。 */
function confChip(c) {
  const n = Number(c) || 0;
  if (n >= 0.85) return { cls: 'chip-l1', word: '高' };
  if (n >= 0.7) return { cls: 'chip-conf', word: '中' };
  return { cls: 'chip-conf-low', word: '低' };
}

function renderRealignList() {
  const box = realignEls.list;
  if (!box || !realignData) return;
  const its = realignData.items || [];
  box.innerHTML = its.map((it, k) => {
    const c = Number(it.confidence) || 0;
    const chip = confChip(c);
    const pc = Math.round(c * 100);
    const picked = realignPicked.has(k);
    const off = !it.ok;
    return `<label class="reflect-item${off ? ' is-off' : ''}${picked ? ' is-on' : ''}" data-k="${k}"`
      + ` title="${off ? '置信度未达门槛，会保留原逐词时间' : '勾选后应用它的新逐词时间'}">`
      + `<input type="checkbox" data-k="${k}"${picked ? ' checked' : ''}${off ? ' disabled' : ''}>`
      + `<span class="ri-body">`
      + `<span class="ri-head">`
      + `<span class="cc-chip ${chip.cls}">置信度${chip.word} ${pc}%</span>`
      + `<span class="ri-range">${escapeHtml(it.target || '')} · ${fmtTime(it.start)} ~ ${fmtTime(it.end)}</span>`
      + `<span class="ri-range">锚点 ${it.anchors}/${(it.words || []).length} 词</span>`
      + `</span>`
      + `<span class="ri-text">${escapeHtml(String(it.text || '').slice(0, 140))}</span>`
      + (it.note
        ? `<span class="ri-reason">${escapeHtml(it.note)}</span>`
        : (it.heard ? `<span class="ri-reason">识别听到：${escapeHtml(String(it.heard).slice(0, 90))}</span>` : ''))
      + `</span></label>`;
  }).join('');
}

function syncRealignApply() {
  const n = realignPicked.size;
  if (realignEls.apply) {
    realignEls.apply.disabled = n === 0;
    realignEls.apply.textContent = n ? `应用选中项（${n} 句）` : '应用选中项';
  }
  if (realignEls.all) {
    const usable = (realignData && realignData.items || []).filter(i => i.ok).length;
    realignEls.all.checked = usable > 0 && n === usable;
  }
}

function realignFinishUi() {
  realignRunning = false;
  clearTimeout(realignPollTimer);
  if (realignEls.btn) realignEls.btn.disabled = !state.project;
  if (realignEls.reload) realignEls.reload.hidden = false;
}

/** 轮询后台作业 */
function pollRealignFull(pid) {
  clearTimeout(realignPollTimer);
  realignPollTimer = setTimeout(async () => {
    if (!state.project || state.project.id !== pid) return;
    try {
      const r = await fetch(`/api/projects/${pid}/realign-full`, { signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      const job = j.job;
      if (!job) { realignFinishUi(); return; }
      if (realignEls.msg) {
        realignEls.msg.textContent = `${job.msg || '处理中…'}（${job.pct || 0}%）`;
      }
      jobCardShow('全片逐词重校对', job.msg || '处理中…', job.pct, '每句一次 TTS 朗读 + 重新识别，全片要几分钟');
      if (job.status === 'running' || job.status === 'pending') {
        pollRealignFull(pid);
        return;
      }
      jobCardHide();
      realignFinishUi();
      if (job.status === 'error') {
        if (realignEls.msg) realignEls.msg.textContent = '失败：' + (job.error || '');
        toast('全片重校对失败：' + (job.error || ''), 6600);
        return;
      }
      showRealignResult(job);
    } catch (e) {
      if (realignEls.msg) realignEls.msg.textContent = '轮询失败：' + ((e && e.message) || e);
      realignFinishUi();
    }
  }, 900);
}

function showRealignResult(job) {
  const items = job.items || [];
  realignData = { items, threshold: job.threshold || 0.7, total: job.total || items.length, usable: job.usable || 0 };
  // 默认只勾选**达标**的（不达标的本来就 disabled）
  realignPicked = new Set(items.map((it, k) => (it.ok ? k : -1)).filter(k => k >= 0));
  const thr = Math.round((realignData.threshold || 0) * 100);
  if (realignEls.conf) realignEls.conf.hidden = false;
  if (realignEls.confVal) realignEls.confVal.textContent = `≥ ${thr}%`;
  if (realignEls.confNote) {
    realignEls.confNote.textContent = `低于这个分数的句子**原样保留**（可在「全局设置 → 重排逐词时间」里改）`;
  }
  if (realignEls.summary) {
    realignEls.summary.hidden = false;
    realignEls.summary.textContent = `共 ${realignData.total} 句：` +
      `${realignData.usable} 句达标（会重排逐词时间）、${realignData.total - realignData.usable} 句未达标（保留原样）`;
  }
  if (realignEls.allWrap) realignEls.allWrap.hidden = false;
  if (realignEls.allNote) realignEls.allNote.textContent = '只改逐词时间戳，文本与整句时间不动';
  if (realignEls.list) realignEls.list.hidden = false;
  if (realignEls.msg) realignEls.msg.textContent = '校对完成，确认后应用（未达标的不可勾选）';
  renderRealignList();
  syncRealignApply();
}

async function startRealignFull() {
  if (realignRunning) { toast('全片重校对已经在跑了', 3200); return; }
  if (!state.project) { toast('全片重校对需要项目模式', 4200); return; }
  const pid = state.project.id;
  realignRunning = true;
  if (realignEls.btn) realignEls.btn.disabled = true;
  realignData = null;
  realignPicked = new Set();
  if (realignEls.list) { realignEls.list.hidden = true; realignEls.list.innerHTML = ''; }
  if (realignEls.summary) realignEls.summary.hidden = true;
  if (realignEls.allWrap) realignEls.allWrap.hidden = true;
  if (realignEls.conf) realignEls.conf.hidden = true;
  if (realignEls.reload) realignEls.reload.hidden = true;
  if (realignEls.apply) realignEls.apply.disabled = true;
  if (realignEls.msg) realignEls.msg.textContent = '正在启动…';
  realignShow(true);
  jobCardShow('全片逐词重校对', '正在启动…', null, '每句一次 TTS 朗读 + 重新识别，全片要几分钟');
  try {
    const r = await fetch(`/api/projects/${pid}/realign-full`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    pollRealignFull(pid);
  } catch (e) {
    jobCardHide();
    realignFinishUi();
    const msg = String((e && e.message) || e);
    if (realignEls.msg) realignEls.msg.textContent = '无法开始：' + msg;
    toast('无法开始全片重校对：' + msg, 6600);
  }
}

/** 应用选中项：**只写逐词时间**（文本与整句起止都不碰） */
let realignApplying = false;
async function applyRealignFull() {
  if (realignApplying || !realignData || !state.project) return;
  const picks = [...realignPicked].filter(k => realignData.items[k] && realignData.items[k].ok);
  if (!picks.length) return;
  realignApplying = true;
  if (realignEls.apply) realignEls.apply.disabled = true;
  const pid = state.project.id;
  try {
    /* 项目里的句子顺序 = state.kar.sentences 的顺序，服务端 readSegments 读的是同一份
     * asr.json，所以 item.index 可以直接当 sentences 的下标用。
     * 不放心的话再用**时间**校对一次：序号对不上就按时间找最接近的那句。 */
    const sents = (state.kar && state.kar.sentences) || [];
    let n = 0, miss = 0;
    const detail = [];
    for (const k of picks) {
      const it = realignData.items[k];
      let sent = sents[it.index];
      if (!sent || !Array.isArray(sent.words) || !sent.words.length
          || Math.abs(Number(sent.start) - Number(it.start)) > 0.05) {
        sent = sents.find(s2 => Array.isArray(s2.words) && s2.words.length
          && Math.abs(Number(s2.start) - Number(it.start)) <= 0.05) || null;
      }
      if (!sent) { miss++; continue; }
      sent.words = (it.words || []).map(w => ({ w: w.w, s: w.s, e: w.e }));
      sent.events = state.assDoc.replaceEvents(sent.events, buildWordSpecs(sent));
      n++;
      detail.push(`${fmtTime(it.start)} 置信度 ${Math.round((it.confidence || 0) * 100)}%`);
    }
    reconcileKaraoke();
    rebuildItemsAndLanes(true, true);
    if (state.format === 'ass' && state.assDoc) assPlayer.updateNow(state.assDoc.serialize());
    if (state.project && state.project.id === pid && Projects && Projects.scheduleSave) {
      Projects.scheduleSave();
    }
    toast(`已重排 ${n} 句的逐词时间${miss ? `（${miss} 句没对上，已跳过）` : ''}（文本未改动）`, 6200);
    logOp('realign', `全片逐词重校对：应用 ${n} 句`,
      `重排了 ${n} 句的逐词时间（文本与整句时间未改动）`,
      `TTS 朗读 → 重新识别 → 序列对齐；置信度门槛 ${Math.round((realignData.threshold || 0) * 100)}%，`
      + `达标的 ${realignData.usable}/${realignData.total} 句。示例：${detail.slice(0, 3).join('、')}`);
    realignShow(false);
  } catch (e) {
    toast('应用失败：' + ((e && e.message) || e), 6600);
  } finally {
    realignApplying = false;
    syncRealignApply();
    if (realignEls.btn) realignEls.btn.disabled = !state.project;
  }
}

if (realignEls.btn) realignEls.btn.addEventListener('click', startRealignFull);
if (realignEls.cancel) realignEls.cancel.addEventListener('click', () => { realignShow(false); });
if (realignEls.reload) realignEls.reload.addEventListener('click', startRealignFull);
if (realignEls.apply) realignEls.apply.addEventListener('click', applyRealignFull);
if (realignEls.list) {
  realignEls.list.addEventListener('change', (e) => {
    const lab = e.target.closest('.reflect-item');
    if (!lab) return;
    const k = Number(lab.dataset.k);
    if (e.target.checked) realignPicked.add(k); else realignPicked.delete(k);
    lab.classList.toggle('is-on', e.target.checked);
    syncRealignApply();
  });
}
if (realignEls.all) {
  realignEls.all.addEventListener('change', () => {
    if (!realignData) return;
    realignPicked = realignEls.all.checked
      ? new Set(realignData.items.map((it, k) => (it.ok ? k : -1)).filter(k => k >= 0))
      : new Set();
    renderRealignList();
    syncRealignApply();
  });
}

panel.onRetranslateCard = (item) => {
  try { retranslateRow(item); }
  catch (e) { toast('翻译失败: ' + ((e && e.message) || e), 4600); }
};
timeline.onRetranslate = (ref) => {
  const item = state.itemByRef.get(ref);
  if (!item) return;
  try { retranslateRow(item); }
  catch (e) { toast('翻译失败: ' + ((e && e.message) || e), 4600); }
};

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
    const raw = state.assDoc.serialize();
    const out = applyPostProcess(raw, state.postProcessConfig, state.assStyleTargets);
    download(state.fileName.replace(/\.(ass|ssa)$/i, '') + '_edited.ass', out);
  }
});

/* 导出项目压缩包：字幕 / 识别结果 / 译文 / 备注 / 操作日志 / 建稿日志。
 * **不含**视频与 audio.wav / peaks.bin —— 那能从视频重新生成，打进去只会让包变成几百兆。
 * 走服务端打包（Windows 自带 bsdtar），前端只负责触发下载。 */
if (btnExportPack) btnExportPack.addEventListener('click', async () => {
  if (!state.project) { toast('先打开一个项目（项目包要带上项目里的识别结果与日志）', 4200); return; }
  const old = btnExportPack.textContent;
  btnExportPack.disabled = true; btnExportPack.textContent = '打包中…';
  try {
    const r = await fetch(`/api/projects/${state.project.id}/export-pack`);
    if (!r.ok) {
      const m = await r.json().catch(() => ({}));
      toast('导出失败: ' + (m.error || r.status), 5000);
      return;
    }
    const blob = await r.blob();
    // 文件名优先用响应头里的（服务端做了中文与非法字符处理）
    let fname = '';
    const cd = r.headers.get('Content-Disposition') || '';
    const mStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (mStar) { try { fname = decodeURIComponent(mStar[1]); } catch { fname = ''; } }
    if (!fname) fname = `subfabric-${state.project.id}.zip`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`已导出项目包（${(blob.size / 1024).toFixed(0)} KB）：字幕 / 识别结果 / 译文 / 备注 / 日志；不含视频与音频`, 7000);
    if (typeof logOp === 'function') logOp('导出', '项目包', `${(blob.size / 1024).toFixed(0)} KB`);
  } catch (e) {
    toast('导出失败: ' + e.message, 5000);
  } finally {
    btnExportPack.disabled = false; btnExportPack.textContent = old;
  }
});

/* 按语言过滤导出 ASS: lang='zh' 只保留中文整句样式行, lang='en' 只保留英文逐词样式行 */
function buildLangAss(doc, sentences, wordStyle, lang) {
  const cut = doc.eventsFormatLineIdx != null ? doc.eventsFormatLineIdx + 1 : doc.lines.length;
  const head = doc.lines.slice(0, cut).filter(l => l !== null);
  const body = sentences
    .filter(sent => lang === 'zh' ? (sent.style !== wordStyle) : (sent.style === wordStyle))
    .map(sent => {
      const ev = sent.events[0];
      return doc._buildDialogueLine({
        layer: sent.proto.layer, style: sent.style, name: sent.proto.name,
        effect: sent.proto.effect, margins: sent.proto.margins,
        start: sent.start, end: sent.end, text: ev.text
      });
    });
  return head.concat(body).join('\r\n');
}

/* 导出无逐词效果的干净 ASS */
btnExportClean.addEventListener('click', () => {  if (state.format !== 'ass' || !state.kar) return;
  const clean = buildCleanAss(state.assDoc, state.kar.sentences);
  const out = applyPostProcess(clean, state.postProcessConfig, state.assStyleTargets);
  download(state.fileName.replace(/\.(ass|ssa)$/i, '') + '_clean.ass', out);
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
  toast('已导出逐词时间轴 JSON');
});

/* 导出仅中文 ASS */
btnExportZh.addEventListener('click', () => {
  if (state.format !== 'ass' || !state.kar) return;
  const ass = buildLangAss(state.assDoc, state.kar.sentences, state.kar.wordStyle, 'zh');
  const out = applyPostProcess(ass, state.postProcessConfig, state.assStyleTargets);
  download(state.fileName.replace(/\.(ass|ssa)$/i, '') + '_zh.ass', out);
  toast('已导出仅中文 ASS');
});

/* 导出仅英文 ASS */
btnExportEn.addEventListener('click', () => {
  if (state.format !== 'ass' || !state.kar) return;
  const ass = buildLangAss(state.assDoc, state.kar.sentences, state.kar.wordStyle, 'en');
  const out = applyPostProcess(ass, state.postProcessConfig, state.assStyleTargets);
  download(state.fileName.replace(/\.(ass|ssa)$/i, '') + '_en.ass', out);
  toast('已导出仅英文 ASS');
});

/* 导出逐词字幕(设置面板里的入口, 与顶部「导出字幕」同一逻辑) */
if (btnExportFull) btnExportFull.addEventListener('click', () => btnExport.click());

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
/* ── 托盘「完全退出」→ 页面收尾 ──────────────────────────────
 * 托盘右键「完全退出」后, 服务端会在 /api/lifecycle 广播 shutdown(见 server.js):
 * ① 先手动派发一次 beforeunload —— 复用 project.js 里那条 sendBeacon 兜底保存,
 *    把最后 1.2 秒防抖窗口里的改动补存出去(服务端留了 600ms 才动手);
 * ② 再尝试关掉本窗口(Edge 应用模式窗口多数情况下允许 window.close());
 * ③ 浏览器不允许脚本关窗时, 给一条提示条 —— 否则用户对着一个死界面会以为卡住了。 */
(function initLifecycle() {
  if (typeof EventSource === 'undefined') return;
  const showExited = () => {
    try {
      if (document.getElementById('app-exited')) return;
      const bar = document.createElement('div');
      bar.id = 'app-exited';
      bar.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:10000;'
        + 'background:#b3261e;color:#fff;padding:10px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);'
        + 'font:13px/1.5 system-ui,sans-serif;';
      bar.textContent = t('SubFabric 已完全退出，可以关闭这个窗口了');
      (document.body || document.documentElement).appendChild(bar);
    } catch {}
  };
  let es;
  try { es = new EventSource('/api/lifecycle'); } catch { return; }
  es.addEventListener('shutdown', () => {
    try { es.close(); } catch {}
    try { window.dispatchEvent(new Event('beforeunload')); } catch {}
    try { window.close(); } catch {}
    setTimeout(showExited, 1200);
  });
})();

/* 服务日志 → UI「日志」页: EventSource 实时流(连接即回放历史, 之后追加) */
(function initLogView() {
  const view = document.getElementById('log-view');
  const follow = document.getElementById('cb-log-follow');
  const empty = document.getElementById('log-empty');
  if (!view || typeof EventSource === 'undefined') return;
  const syncEmpty = () => { if (empty) empty.hidden = view.childElementCount > 0; };
  const append = (line) => {
    try {
      const div = document.createElement('div');
      div.className = 'log-line ' + (line.level === 'error' ? 'log-err'
        : line.level === 'warn' ? 'log-warn' : 'log-info');
      div.textContent = '[' + line.t + '] ' + t(line.msg);   // 服务端消息也过词典(日志页签文案可改)
      view.appendChild(div);
      while (view.childElementCount > 800) view.removeChild(view.firstChild);
      if (!follow || follow.checked) view.scrollTop = view.scrollHeight;
      syncEmpty();
    } catch {}
  };
  const clearBtn = document.getElementById('btn-log-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { view.innerHTML = ''; syncEmpty(); });
  syncEmpty();
  try {
    const es = new EventSource('/api/logs/stream');
    es.onmessage = (ev) => { try { append(JSON.parse(ev.data)); } catch {} };
    es.onerror = () => { /* 断线自动重连(EventSource 内置 retry) */ };
  } catch {}
})();

/* ═══════════ 用户操作日志 ═══════════
 *
 * 记录"谁改了什么、为什么" —— 与服务运行日志分开（那个是 console 镜像、重启即清）。
 * 落盘在项目里（projects/<id>/oplog.json），所以跨重启留存、跟着项目走。
 *
 * 为什么要有：批量改完之后很难回忆"这条为什么变成这样了"。带原因的记录能在
 * 事后复盘（尤其是对齐/纠错这类**有依据**的操作：锚点率、命名依据、模型判断）。
 */
let opLogPending = [];            // 攒一小批再发，避免每次编辑都打一次请求
let opLogFlushTimer = 0;

/** 记一条用户操作。detail = 做了什么，why = 为什么/依据。失败静默（日志不该挡住编辑）。 */
function logOp(action, target, detail, why) {
  if (!state.project) return;     // 非项目模式没有地方存
  opLogPending.push({ action, target, detail, why });
  if (opLogPending.length >= 20) return flushOpLog();
  clearTimeout(opLogFlushTimer);
  opLogFlushTimer = setTimeout(flushOpLog, 1500);
}

function flushOpLog() {
  clearTimeout(opLogFlushTimer);
  if (!opLogPending.length || !state.project) return;
  const pid = state.project.id;
  const batch = opLogPending;
  opLogPending = [];
  try {
    // 用 sendBeacon：页面正在关/切走时也能发出去，且不阻塞
    const blob = new Blob([JSON.stringify({ entries: batch })], { type: 'application/json' });
    if (!navigator.sendBeacon(`/api/projects/${pid}/oplog`, blob)) throw new Error('beacon 被拒');
  } catch {
    fetch(`/api/projects/${pid}/oplog`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
    }).catch(() => {});
  }
  if (opLogViewVisible()) loadOpLog();
}
// 页面隐藏/关闭前把攒着的一起发掉（否则最后一次操作会丢）
document.addEventListener('visibilitychange', () => { if (document.hidden) flushOpLog(); });
window.addEventListener('pagehide', flushOpLog);

const OP_ACTION_LABEL = {
  edit: '编辑字幕', split: '分句', merge: '合并', 'delete': '删除', insert: '新建',
  realign: '重排逐词', retranslate: '重新翻译', rerecog: '重新识别',
  reflect: '反思纠错', confidence: '置信度', role: '角色', style: '样式',
  export: '导出', import: '导入', other: '其它',
};

function opLogViewVisible() {
  const p = document.getElementById('log-pane-op');
  return !!(p && !p.hidden);
}

function renderOpLog(entries) {
  const box = document.getElementById('oplog-view');
  const empty = document.getElementById('oplog-empty');
  if (!box) return;
  const list = Array.isArray(entries) ? entries.slice().reverse() : [];   // 新的在上面
  if (empty) empty.hidden = list.length > 0;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map((e) => {
    // 时间只显示 时:分:秒（完整日期占地方、日常排查用不上）
    const d = new Date(e.t);
    const hh = isNaN(d) ? String(e.t || '').slice(11, 19)
      : d.toLocaleTimeString('zh-CN', { hour12: false });
    const act = OP_ACTION_LABEL[e.action] || e.action || '操作';
    return `<div class="oplog-row">`
      + `<span class="oplog-t">${escapeHtml(hh)}</span>`
      + `<span class="oplog-act" title="${escapeHtml(e.action || '')}">${escapeHtml(act)}</span>`
      + `<span class="oplog-body">`
      + (e.target ? `<span class="oplog-target">${escapeHtml(e.target)}</span>` : '')
      + (e.detail ? (e.target ? ' · ' : '') + `<span class="oplog-detail">${escapeHtml(e.detail)}</span>` : '')
      + (e.why ? `<br><span class="oplog-why">原因：${escapeHtml(e.why)}</span>` : '')
      + `</span></div>`;
  }).join('');
}

let opLogLoading = false;
async function loadOpLog() {
  if (!state.project || opLogLoading) return;
  opLogLoading = true;
  try {
    const r = await fetch(`/api/projects/${state.project.id}/oplog`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    renderOpLog(j.entries);
  } catch (e) {
    const box = document.getElementById('oplog-view');
    if (box) box.innerHTML = `<div class="oplog-empty-row">读取操作日志失败：${escapeHtml(String((e && e.message) || e))}</div>`;
  } finally {
    opLogLoading = false;
  }
}

/* 两个板块的切换 */
(function initLogSubTabs() {
  const tabs = [...document.querySelectorAll('.log-subtab')];
  if (!tabs.length) return;
  const panes = {
    app: document.getElementById('log-pane-app'),
    op: document.getElementById('log-pane-op'),
    note: document.getElementById('log-pane-note'),
  };
  const show = (which) => {
    for (const tb of tabs) tb.classList.toggle('active', tb.dataset.log === which);
    for (const [k, el] of Object.entries(panes)) if (el) el.hidden = (k !== which);
    if (which === 'op') loadOpLog();                     // 只在真要看时才拉
    if (which === 'note' && window.__onNotesShown) window.__onNotesShown();
  };
  for (const tb of tabs) tb.addEventListener('click', () => show(tb.dataset.log));
  const rf = document.getElementById('btn-oplog-refresh');
  if (rf) rf.addEventListener('click', () => { loadOpLog(); toast('已刷新操作日志', 2000); });
  // 切到日志页且停在某个板块时也要拉一次（首次进入不会触发子标签的 click）
  window.__onLogsTabShown = () => {
    if (panes.op && !panes.op.hidden) loadOpLog();
    if (panes.note && !panes.note.hidden && window.__onNotesShown) window.__onNotesShown();
  };
})();

/* F8: 显隐「导出词级 JSON」区(默认隐藏, 避免设置面板杂乱) */
const f8Section = document.getElementById('f8-section');
if (f8Section) {
  f8Section.hidden = true;     // 默认隐藏
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F8') return;
    e.preventDefault();
    const show = f8Section.hidden;
    f8Section.hidden = !show;
    if (show) panel.showTab('settings');   // 切到设置, 让用户看到刚展开的区域
    toast(show ? '已显示导出逐词 JSON，再按 F8 隐藏' : '已隐藏导出逐词 JSON');
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

/* 空格(播放/暂停)的按键去重。
 *
 * ⚠ 这里以前是 250ms 冷却，会**吞掉正常的快速按键**（用户实测："开始播放后立刻按空格不会暂停，
 *   要等一下才行"）。当初写的理由是"按住重复触发或快速连击会导致状态乱跳"，但这两点其实
 *   各有一个更准确的解法：
 *     · 按住不放 → 浏览器会连续派发带 `e.repeat=true` 的 keydown，**用它挡就行**，
 *       不需要时间窗（这正是"按住=暂停、松开=播放"那个反向行为的成因，见下面捕获阶段的注释）
 *     · 快速连击 → 用户**本来就想连按**（播→停→播），不该挡
 *   所以冷却窗口从 250ms 收到 40ms：只用来吃掉某些浏览器/输入法把**同一次物理按键**
 *   重复派发出来的事件，人手动两连按（实测约 100ms 以上）不再受影响。 */
const actionCooldown = { playPause: 0 };
const PLAY_DEDUP_MS = 40;

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
    // e.repeat = 按住不放的自动重复（必须挡，否则状态乱跳）；
    // PLAY_DEDUP_MS 只挡同一次按键被重复派发，不挡用户连按。
    if (e.repeat || now - actionCooldown.playPause < PLAY_DEDUP_MS) return;
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
  timeline.touch();                                    // 直接改属性 → 手动置脏
  if (setFilm) setFilm.checked = on;
  if (setFilmVal) setFilmVal.textContent = on ? '开' : '关';
}
if (setFilm) setFilm.addEventListener('change', () => {
  localStorage.setItem(FILM_KEY, setFilm.checked ? '1' : '0');
  applyFilmSetting();
});
/** 字幕轨模式: 单行(默认, 现状) / 双行(重叠块自动分到下面第二条轨)。切换后立刻重排时间轴。 */
const TRACKS_KEY = 'ss-track-mode';
const setTracks = document.getElementById('set-tracks');
const setTracksVal = document.getElementById('set-tracks-val');
function applyTrackMode(rebuild) {
  state.trackMode = localStorage.getItem(TRACKS_KEY) === 'double' ? 'double' : 'single';
  const on = state.trackMode === 'double';
  if (setTracks) setTracks.checked = on;
  if (setTracksVal) setTracksVal.textContent = on ? '双行' : '单行';
  // 只重排轨道, 不重建条目(rebuildItems=false) → 不动用户的编辑结果与滚动位置
  if (rebuild) rebuildItemsAndLanes(false, true);
}
if (setTracks) setTracks.addEventListener('change', () => {
  localStorage.setItem(TRACKS_KEY, setTracks.checked ? 'double' : 'single');
  applyTrackMode(true);
});
/* ─────────── 主题色(界面强调色) ───────────
 * 数学与套用都在 js/accent.js（head 里的经典脚本, 首屏已按用户存的颜色套过一次），
 * 这里只做设置面板交互：点色块换色 / 拖色盘实时预览 / 一键恢复默认。
 * 自定义色用 input 事件做实时预览, change(松手) 时才重画选中态。 */
const ACC = window.SSAccent;
function renderThemeSwatches() {
  const box = document.getElementById('theme-swatches');
  if (!box || !ACC) return;
  const cur = ACC.current();
  box.innerHTML = ACC.PRESETS.map(p =>
    `<button type="button" class="theme-sw${p.hex === cur ? ' active' : ''}" data-hex="${p.hex}" title="${escapeHtml(p.name)}" style="background:${p.hex}"></button>`).join('');
  box.querySelectorAll('.theme-sw').forEach(b => {
    b.addEventListener('click', () => { ACC.set(b.dataset.hex); renderThemeSwatches(); });
  });
}
if (ACC) {
  renderThemeSwatches();
  const ci = document.getElementById('theme-color');
  if (ci) {
    ci.value = ACC.current();
    ci.addEventListener('input', () => { ACC.set(ci.value); });                  // 拖色盘即时预览
    ci.addEventListener('change', () => { ACC.set(ci.value); renderThemeSwatches(); });
  }
  const rb = document.getElementById('theme-reset');
  if (rb) rb.addEventListener('click', () => {
    ACC.reset(); renderThemeSwatches();
    if (ci) ci.value = ACC.DEFAULT;
    toast('已恢复默认主题色');
  });
}

/** 字幕块区域高度(时间轴占屏幕高度): 设置里可调, 也可拖视频/时间轴中间那根线; 记住用户的舒适值 */
const TLH_KEY = 'ss-tl-h';
/* 面板高度的合理区间:
 *   下限 132px —— 刻度(20) + 波形(>=24) + 字幕块(>=24) + 胶片/间距, 再矮波形与块都展不开;
 *   上限取屏幕高的 45% 且不超过 420px —— 太高则字幕块被拉得很高而内容仍只占两行,
 *   块内大片留白、逐词标记离中文行太远(反之则视频区被压得没法看)。
 * 上限用 min() 而不是固定值: 小屏上 420 可能正好, 大屏上又太占地方。 */
const TLH_MIN = 132;
const TLH_MAX = () => Math.max(TLH_MIN, Math.min(420, Math.round(window.innerHeight * 0.45)));
const setTlh = document.getElementById('set-tlh');
const setTlhVal = document.getElementById('set-tlh-val');
function setTlHeight(px, save) {
  const app = document.getElementById('app');
  const h = Math.round(Math.max(TLH_MIN, Math.min(TLH_MAX(), px)));
  app.style.setProperty('--tl-h', h + 'px');
  if (setTlh) {
    setTlh.min = String(TLH_MIN);
    setTlh.max = String(TLH_MAX());
    setTlh.value = h;
  }
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

/* 角色标注开关: 启用=现状(坏行标「未标注角色」+ 角色 Tab/筛选)；禁用=两者都藏、不再标。
 * 字幕里已有 [角色] 标签时禁用需要二次确认 —— 标签本身保留，只是不再参与判定与列表。 */
const ROLE_KEY = 'ss-role-annot';
const setRole = document.getElementById('set-role');
const setRoleVal = document.getElementById('set-role-val');
/** 字幕里是否已有 [角色] 标签（决定禁用时是否二次确认） */
function subtitleHasRoleTags() {
  if (state.format !== 'ass' || !state.kar) return false;
  return state.kar.sentences.some(s => s.style !== state.kar.wordStyle && speakerTextTagOf(s));
}
function applyRoleAnnot(rebuild) {
  state.roleAnnot = localStorage.getItem(ROLE_KEY) !== '0';   // 默认启用 = 保持现状
  const on = state.roleAnnot;
  if (setRole) setRole.checked = on;
  if (setRoleVal) setRoleVal.textContent = on ? '开' : '关';
  // SRT 本来就没有角色概念；ASS 且禁用时把角色 Tab 与筛选一起藏掉
  panel.setRolesEnabled(state.format === 'ass' && on);
  frSetRolesAvailable(state.format === 'ass' && on);   // 批量替换里的角色页签跟着开关
  if (rebuild) rebuildItemsAndLanes(true, true);              // 重建会重算坏行标记
}
if (setRole) setRole.addEventListener('change', () => {
  if (!setRole.checked && subtitleHasRoleTags()) {
    setRole.checked = true;                                    // 先还原, 确认后再真正切
    panel.showConfirm('禁用角色标注',
      '当前字幕里已经有 [角色] 标签。\n'
      + '禁用后：坏行不再标「未标注角色」、「角色」页与角色筛选会隐藏；\n'
      + '已有的标签不会被删除，画面显示不变。\n确认禁用？',
      '禁用', '取消', () => {
        localStorage.setItem(ROLE_KEY, '0');
        applyRoleAnnot(true);
      });
    return;
  }
  localStorage.setItem(ROLE_KEY, setRole.checked ? '1' : '0');
  applyRoleAnnot(true);
});
applyRoleAnnot(false);

/* 字幕列表跟随播放进度: timeupdate 节流触发 selectByTime, 开关在字幕列表工具栏 */
const FOLLOW_KEY = 'sf-follow-playback';
const cbFollowToolbar = document.getElementById('cb-follow-toolbar');
function applyFollowToolbar() {
  panel.followPlayback = localStorage.getItem(FOLLOW_KEY) !== '0';   // 默认开启
  if (cbFollowToolbar) cbFollowToolbar.checked = panel.followPlayback;
}
if (cbFollowToolbar) cbFollowToolbar.addEventListener('change', () => {
  panel.followPlayback = cbFollowToolbar.checked;
  localStorage.setItem(FOLLOW_KEY, panel.followPlayback ? '1' : '0');
});
applyFollowToolbar();

let _followRaf = null;
video.addEventListener('timeupdate', () => {
  if (!panel.followPlayback || _followRaf) return;
  _followRaf = requestAnimationFrame(() => {
    _followRaf = null;
    if (panel.followPlayback) panel.selectByTime(video.currentTime);
  });
});

/* ═══════════ 备注（时间点留言 → 播放时当置顶弹幕） ═══════════
 *
 * 用途：看到某处有问题，**不想中断播放**去改字幕 —— 在视频下方写一句，
 * 自动记下当时的播放位置；播放到那里时以弹幕浮在画面**顶部**。
 *
 * 为什么要"置顶弹幕"而不是普通 toast：备注和**画面内容**是对应的
 * （"这里口型对不上""这句翻译怪"），必须和画面同时可见才有意义；
 * 而且它跟着播放进度走，播到哪儿显示哪条。
 *
 * 行为约定（用户明确要求）：
 *   · 持续跟随播放时长（每条 2~5 秒可调，默认 2.5 秒）
 *   · **暂停时不消失** —— 停下来正是为了看清它，这时消失反而没法用
 */
(function initNotes() {
  const bar = document.getElementById('note-bar');
  const input = document.getElementById('note-input');
  const atEl = document.getElementById('note-at');
  const durSel = document.getElementById('note-dur');
  const sendBtn = document.getElementById('btn-note-send');
  const cbDanmaku = document.getElementById('cb-danmaku');
  const layer = document.getElementById('danmaku-layer');
  const listBox = document.getElementById('note-view');
  const listEmpty = document.getElementById('note-empty');
  const cntEl = document.getElementById('note-cnt');
  if (!bar || !input || !layer) return;

  let notes = [];               // 当前项目的全部备注
  let loadedFor = null;         // 已加载的项目 id（切项目要重载）
  let showing = null;           // 当前弹幕显示的那条（"闩住"而不是每次重算，见 danmaku.js）
  let flashId = null;           // 刚写下的那条 → 高亮

  const durOf = danmakuDuration;   // 与服务端 clampDur 同一套范围（2~5 秒）

  /* ── 输入条上的"当前播放位置" ── */
  function refreshAtLabel() {
    if (!atEl) return;
    const t0 = Number(video.currentTime) || 0;
    atEl.textContent = fmtTime(t0).replace(/\.(\d)\d\d$/, '.$1');   // 秒数保留一位就够
    atEl.title = `备注会记下这个播放位置（${fmtTime(t0)}）`;
  }
  video.addEventListener('timeupdate', refreshAtLabel);
  video.addEventListener('seeked', refreshAtLabel);
  refreshAtLabel();

  /* ── 弹幕层 ── */
  function hideDanmaku() {
    showing = null;
    layer.replaceChildren();
  }

  function paintDanmaku(n) {
    const at = fmtTime(Number(n.at) || 0).replace(/^00:/, '');
    layer.innerHTML = `<div class="dmk${n.id === flashId ? ' is-new' : ''}">`
      + `<span class="dmk-at">${escapeHtml(at)}</span>${escapeHtml(n.text)}</div>`;
    flashId = null;
  }

  /** 播放位置 → 该显示哪条备注。判定逻辑在 ../danmaku.js（纯函数，可离线测）。
   *  "闩住"模型而不是每帧重算：**暂停时位置不变 → 窗口不会走完 → 弹幕保持显示**，
   *  这正是用户要的"暂停不消失"。 */
  function tickDanmaku() {
    if (!cbDanmaku || !cbDanmaku.checked) { if (showing) hideDanmaku(); return; }
    const t0 = Number(video.currentTime) || 0;
    const next = pickDanmaku(notes, t0, showing);
    if (!next) { if (showing) hideDanmaku(); return; }
    if (showing && showing.id === next.id) { showing = next; return; }   // 还在窗口内，不重绘（重绘会重放动画、看着在闪）
    showing = next;
    paintDanmaku(next);
    markCurrentRow();
  }
  video.addEventListener('timeupdate', tickDanmaku);
  video.addEventListener('seeked', () => { hideDanmaku(); tickDanmaku(); });
  if (cbDanmaku) {
    cbDanmaku.addEventListener('change', () => {
      if (layer) layer.classList.toggle('is-off', !cbDanmaku.checked);
      try { localStorage.setItem('sf.danmaku', cbDanmaku.checked ? '1' : '0'); } catch {}
      if (cbDanmaku.checked) tickDanmaku(); else hideDanmaku();
    });
    try {
      const saved = localStorage.getItem('sf.danmaku');
      if (saved === '0') { cbDanmaku.checked = false; layer.classList.add('is-off'); }
    } catch {}
  }

  /* ── 备注列表（日志页第三个板块）── */
  function markCurrentRow() {
    if (!listBox) return;
    const cur = showing ? showing.id : null;
    for (const row of listBox.querySelectorAll('.note-row')) {
      row.classList.toggle('is-here', !!cur && row.dataset.id === cur);
    }
  }

  function renderList() {
    if (!listBox) return;
    const sorted = notes.slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    if (listEmpty) listEmpty.hidden = sorted.length > 0;
    if (cntEl) { cntEl.textContent = sorted.length ? String(sorted.length) : ''; cntEl.hidden = !sorted.length; }
    if (!sorted.length) { listBox.innerHTML = ''; return; }
    listBox.innerHTML = sorted.map((n) => {
      const at = Number(n.at) || 0;
      const d = durOf(n);
      return `<div class="note-row" data-id="${escapeHtml(n.id)}">`
        + `<span class="note-t" data-seek="${at}" title="跳到 ${fmtTime(at)}">${escapeHtml(fmtTime(at).replace(/^00:/, ''))}</span>`
        + `<span class="note-text">${escapeHtml(n.text)}`
        + `<span class="note-meta">停留 ${d} 秒 · ${escapeHtml(String(n.createdAt || '').replace('T', ' ').slice(0, 16))}</span>`
        + `</span>`
        + `<button type="button" class="note-go" data-seek="${at}" title="跳到该位置">${ico('play')}</button>`
        + `<button type="button" class="note-del" data-del="${escapeHtml(n.id)}" title="删除这条备注">${ico('trash')}</button>`
        + `</div>`;
    }).join('');
    markCurrentRow();
  }

  async function loadNotes(force) {
    const pid = state.project && state.project.id;
    if (!pid) {
      notes = []; loadedFor = null; renderList(); hideDanmaku();
      if (listBox) listBox.innerHTML = '<div class="note-empty-row">备注需要项目模式（备注存在项目目录里）</div>';
      return;
    }
    if (!force && loadedFor === pid) return;
    try {
      const r = await fetch(`/api/projects/${pid}/notes`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      notes = Array.isArray(j.notes) ? j.notes : [];
      loadedFor = pid;
      renderList();
    } catch (e) {
      if (listBox) listBox.innerHTML = `<div class="note-empty-row">读取备注失败：${escapeHtml(String((e && e.message) || e))}</div>`;
    }
  }

  async function sendNote() {
    if (!state.project) { toast('备注需要项目模式（备注存在项目目录里）', 4600); return; }
    const text = String(input.value || '').trim();
    if (!text) { input.focus(); return; }
    const at = Number(video.currentTime) || 0;
    const danmaku = durSel ? Number(durSel.value) || DUR_DEFAULT : DUR_DEFAULT;
    const pid = state.project.id;
    sendBtn.disabled = true;
    try {
      const r = await fetch(`/api/projects/${pid}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at, text, danmaku }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      notes = Array.isArray(j.notes) ? j.notes : notes.concat(j.note ? [j.note] : []);
      loadedFor = pid;
      input.value = '';
      flashId = j.note ? j.note.id : null;
      showing = null;                     // 立刻重算：新备注多半就在当前时间点
      renderList();
      tickDanmaku();
      logOp('note', `备注 @${fmtTime(at)}`, text.slice(0, 120), '用户在播放中随手记下（不改字幕）');
      toast(`备注已记在 ${fmtTime(at)}（停留 ${danmaku} 秒）`, 3200);
    } catch (e) {
      toast('备注保存失败：' + ((e && e.message) || e), 5200);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener('click', sendNote);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNote(); }
    // 别让空格在这里触发播放/暂停（输入框里打字时）
    e.stopPropagation();
  });

  /* 列表里的跳转 / 删除（事件委托，列表会重绘） */
  if (listBox) {
    listBox.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const id = del.dataset.del;
        const note = notes.find(n => n.id === id);
        if (!note) return;
        if (!confirm(`删除这条备注？\n\n${note.text.slice(0, 120)}`)) return;
        try {
          const pid = state.project.id;
          const r = await fetch(`/api/projects/${pid}/notes?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          notes = Array.isArray(j.notes) ? j.notes : notes.filter(n => n.id !== id);
          if (showing && showing.id === id) hideDanmaku();
          renderList();
          toast('已删除该备注', 2400);
        } catch (err) { toast('删除失败：' + ((err && err.message) || err), 4600); }
        return;
      }
      const go = e.target.closest('[data-seek]');
      if (go) {
        const t0 = Number(go.dataset.seek) || 0;
        // 停在备注**开始时**：这样它正好落在弹幕窗口里，不会被判成过期
        try { video.currentTime = t0; } catch {}
        hideDanmaku();
        tickDanmaku();
        toast(`已跳到 ${fmtTime(t0)}`, 1800);
      }
    });
  }

  const rf = document.getElementById('btn-note-refresh');
  if (rf) rf.addEventListener('click', async () => { await loadNotes(true); toast('已刷新备注', 1800); });

  // 进入「备注列表」时按需加载；切项目由 project.js 打开项目时调 __notesReload() 重载
  const pane = document.getElementById('log-pane-note');
  window.__onNotesShown = () => { loadNotes(false); };
  window.__notesReload = () => { loadNotes(true); };
  if (pane && !pane.hidden) loadNotes(false);
})();

/* 界面语言: 只有中文(zh-CN)。工具是给国人做双语字幕的, 英文 UI 没有意义, 已移除。
 * 文案层(js/i18n.js)保留 —— 它的另一个用途是 lang/zh-CN.json(键=原文, 值可改) 让用户自己润色措辞。 */
applySensitivity();
applyFilmSetting();
applyTrackMode(false);
applyTlHeight();
initFxControls();

/* 调试钩子(测试用) */
initBadCatFilter();

window.__dbg = { state, assPlayer, overlay, timeline, panel, video, selectItem, buildCleanAss, detectRowProblems, fixRow, openFixForRow, deleteItem, itemsInRange, refreshRangeBar, refreshDynamicSubtitles, buildWordSpecs, assPlainText };

/* ═══════════ 项目系统接线 ═══════════ */
const Projects = initProjects({
  state, video, timeline, panel, toast, routeSub, loadVideoUrl, setPlaybackAudioMode, resumeRerecog
});

/* ═══════════ 主循环 ═══════════ */
function tick() {
  window.__tickCount = (window.__tickCount || 0) + 1;
  const t = video.currentTime;
  overlay.update(t);
  // 非播放句编辑仅更新数据；第一次播入被修改句时再同步真实 ASS 轨。
  if (pendingPlaybackRows.size && !previewTrack && !wordPreviewTrackRow
    && !(editPreview && editRowVisible(editPreview.row))
    && [...pendingPlaybackRows].some(editRowVisible)) {
    assPlayer.updateNow(state.assDoc.serialize());
    pendingPlaybackRows.clear();
  }
  // 播放头进出正在编辑的句子时切换临时轨；离开即恢复真实 ASS。
  if (editPreview && editRowVisible(editPreview.row) !== !!previewTrack) queueEditPreview();
  if (wordPreviewTrackRow && !editRowVisible(wordPreviewTrackRow)) clearWordPreview();
  timeline.drawIfNeeded(t, !video.paused);
  panel.setPlayingByTime(t);
  tlCursor.textContent = fmtTime(t);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ── 诊断上报: 页面状态快照回传服务端 → .diag.json(排查渲染问题用, 无副作用) ──
 * 沙箱里没法直连 localhost 跑浏览器, 于是让用户浏览器把真实数据交回来:
 * 刷新页面 6s/12s 后自动上报; 控制台也可手动 window.__diag()。 */
(function initDiag() {
  const errs = [];
  window.addEventListener('error', (e) => {
    errs.push('error: ' + (e.message || '') + ' @' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', (e) => {
    errs.push('reject: ' + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason).slice(0, 300));
  });
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), display: getComputedStyle(el).display };
  };
  const snap = () => {
    try {
      const app = document.getElementById('app');
      const cs = app ? getComputedStyle(app) : null;
      const cv = document.getElementById('timeline');
      const lc = document.getElementById('log-view');
      const act = document.querySelector('.ptab.active');
      return {
        stamp: String(window.__BUILD_STAMP || ''),
        href: location.href,
        win: window.innerWidth + 'x' + window.innerHeight,
        tlH: cs ? cs.getPropertyValue('--tl-h').trim() : '',
        gridRows: cs ? cs.gridTemplateRows : '',
        tickCount: window.__tickCount || 0,
        tlPanel: rect(document.getElementById('timeline-panel')),
        wrap: rect(document.getElementById('tl-canvas-wrap')),
        canvas: cv ? Object.assign(rect(cv), { attrW: cv.width, attrH: cv.height }) : null,
        // 虚拟滚动后 DOM 里只有可视窗口那些卡, 总数要看 panel.filtered
        cueCards: document.querySelectorAll('.cue-card').length,
        cueCardsTotal: (window.__dbg && window.__dbg.panel && window.__dbg.panel.filtered) ? window.__dbg.panel.filtered.length : null,
        logView: lc ? Object.assign(rect(lc), { lines: lc.childElementCount }) : null,
        /* 「日志」页排查用：三个板块各自的可见性/尺寸/内容量。
         * 用户报"日志栏完全空的"，而 logView.lines 明明 > 0 —— 说明内容在、
         * 但看不见。必须把**每个 pane 的几何与 display** 都回传，才能分清是
         * "没数据"还是"有数据但高度/显示出了问题"。 */
        logPanel: (() => {
          const t = document.getElementById('tab-logs');
          if (!t) return { missing: true };
          const one = (id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const cs = getComputedStyle(el);
            const b = el.getBoundingClientRect();
            return {
              hidden: !!el.hidden, display: cs.display, vis: cs.visibility,
              flex: cs.flex, minH: cs.minHeight, overflowY: cs.overflowY,
              w: Math.round(b.width), h: Math.round(b.height),
              kids: el.childElementCount,
            };
          };
          /** 从元素往上数到 #app，把每层的 id/class/display 都带出来。
           *  这是判断"内容在但被祖先隐藏了"最直接的证据。 */
          const chain = (el) => {
            const out = [];
            let n = el;
            while (n && n !== document.documentElement) {
              const cs = getComputedStyle(n);
              const b = n.getBoundingClientRect();
              out.push({
                tag: n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
                  + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/).join('.') : ''),
                display: cs.display, vis: cs.visibility, overflow: cs.overflow,
                w: Math.round(b.width), h: Math.round(b.height),
              });
              if (n.id === 'app') break;
              n = n.parentElement;
            }
            return out;
          };
          const csT = getComputedStyle(t);
          return {
            tabDisplay: csT.display, tabActive: t.classList.contains('active'),
            tabH: Math.round(t.getBoundingClientRect().height),
            tabParentChain: chain(t),
            editorPanelActiveTab: (window.__panel && window.__panel._tab) || null,
            panes: { app: one('log-pane-app'), op: one('log-pane-op'), note: one('log-pane-note') },
            views: { log: one('log-view'), oplog: one('oplog-view'), note: one('note-view') },
            empties: {
              log: one('log-empty'), oplog: one('oplog-empty'), note: one('note-empty'),
            },
            subtabs: [...document.querySelectorAll('.log-subtab')].map(b => ({
              t: b.dataset.log, active: b.classList.contains('active'),
              hidden: !!b.hidden, h: Math.round(b.getBoundingClientRect().height),
            })),
            subtabCount: document.querySelectorAll('.log-subtab').length,
            // 前几条运行日志的文字（确认到底渲染了什么）
            sample: lc ? [...lc.children].slice(0, 3).map(d => (d.textContent || '').slice(0, 90)) : null,
            opCount: (document.getElementById('oplog-view') || {}).childElementCount,
            noteCount: (document.getElementById('note-view') || {}).childElementCount,
          };
        })(),
        errors: errs.slice(-6),
        activeTab: act ? act.dataset.tab : null,
        tabs: [...document.querySelectorAll('#panel-tabs .ptab')].map(b => ({
          t: b.dataset.tab, active: b.classList.contains('active'), hidden: !!b.hidden })),
        tabBodies: [...document.querySelectorAll('.tab-body')].map(b => ({
          id: b.id, active: b.classList.contains('active'), display: getComputedStyle(b).display })),
        panelTab: (window.__panel && window.__panel._tab) || null,
        panelTabBtns: (window.__panel && window.__panel._tabBtns) ? window.__panel._tabBtns.length : null,
        appChildren: (() => {
          const app = document.getElementById('app');
          if (!app) return null;
          return [...app.children].map(el => {
            const b = el.getBoundingClientRect();
            const c = getComputedStyle(el);
            return {
              tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''),
              area: c.gridArea, row: c.gridRowStart, col: c.gridColumnStart,
              pos: c.position, display: c.display,
              y: Math.round(b.y), h: Math.round(b.height),
            };
          });
        })(),
        appBox: (() => {
          const app = document.getElementById('app');
          return app ? { clientH: app.clientHeight, scrollH: app.scrollHeight, bodyScrollH: document.body.scrollHeight } : null;
        })(),
        timelineInfo: (() => {
          const tl = window.__timeline;
          if (!tl) return null;
          return {
            duration: tl.duration, scale: tl.scale, t0: tl.t0,
            lanes: tl.lanes ? tl.lanes.length : null,
            cues: tl.lanes ? tl.lanes.reduce((n, l) => n + (l.cues ? l.cues.length : 0), 0) : null,
            hasDraw: typeof tl.draw === 'function',
          };
        })(),
        logClients: null,
        errors: errs.slice(0, 20),
      };
    } catch (e) { return { diagError: String((e && e.message) || e) }; }
  };
  const post = () => {
    try {
      fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snap()) }).catch(() => {});
    } catch {}
  };
  window.__diag = post;
  setTimeout(post, 6000);
  setTimeout(post, 12000);
})();

/* ── 首页版本号 + 代码更新提示 ──
 * 必须是模块级: 首页/项目/编辑器三种路由都要生效。曾经放在 boot() 的 #/editor
 * 分支之后 —— 首页与项目模式会提前 return, 于是标题版本号永远是 HTML 里的硬编码值。 */
(function initVersionCheck() {
  const pageStamp = String(window.__BUILD_STAMP || '');
  let banner = null;
  const showBanner = () => {
    if (banner) return;
    banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9999;'
      + 'background:#2563eb;color:#fff;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);'
      + 'font:13px/1.4 system-ui,sans-serif;display:flex;gap:10px;align-items:center;cursor:pointer;';
    banner.innerHTML = '已发布新版本，点击此处刷新页面 <b style="text-decoration:underline">刷新</b>';
    banner.addEventListener('click', () => location.reload(true));
    (document.body || document.documentElement).appendChild(banner);
  };
  // 缺 libass 渲染器时的警示横幅（可关闭；依赖补上后由轮询自动撤掉）
  let vendorBanner = null, vendorDismissed = false;
  const hideVendorBanner = () => { if (vendorBanner) { vendorBanner.remove(); vendorBanner = null; } };
  const showVendorBanner = (hint) => {
    if (vendorBanner || vendorDismissed) return;
    vendorBanner = document.createElement('div');
    vendorBanner.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9998;'
      + 'max-width:min(760px,92vw);background:#b45309;color:#fff;padding:10px 14px;border-radius:8px;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.35);font:13px/1.5 system-ui,sans-serif;display:flex;'
      + 'gap:12px;align-items:flex-start;';
    const text = document.createElement('div');
    text.textContent = hint || '视频区不显示字幕：缺少 libass 渲染器，请运行 node editor/scripts/fetch-vendor.js';
    const close = document.createElement('button');
    close.textContent = '知道了';
    close.style.cssText = 'flex:none;background:rgba(255,255,255,.18);color:#fff;border:0;'
      + 'border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;';
    close.addEventListener('click', () => { vendorDismissed = true; hideVendorBanner(); });
    vendorBanner.appendChild(text);
    vendorBanner.appendChild(close);
    (document.body || document.documentElement).appendChild(vendorBanner);
  };

  const tick = async () => {
    try {
      const r = await fetch('/api/version', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.version) {
        const lv = document.getElementById('app-version');
        if (lv) lv.textContent = 'v' + j.version;   // 版本号永远跟运行中的服务端一致(不用改 HTML)
      }
      if (pageStamp && j && String(j.stamp) !== pageStamp) showBanner();
      // 渲染依赖自检：缺 libass 时视频区不会有字幕，且用户很难想到原因。
      // 挂在同一个轮询上 → 跑完 fetch-vendor.js 后横幅**自动消失**，不必重启。
      if (j && j.vendorOk === false) showVendorBanner(j.vendorHint);
      else hideVendorBanner();
    } catch {}
  };
  tick();                       // 立即填一次, 别等 4 秒
  setTimeout(tick, 4000);
  setInterval(tick, 30000);
})();

/* ═══════════ 示例自动加载(仅 #/editor 直开时; 正常入口是项目主界面 #/home) ═══════════ */
(async function boot() {
  await initI18n();                      // 载入 lang/zh-CN.json(用户可改措辞的词典) + 应用到静态 DOM
  applyIcons();                          // 把 data-ico 声明的地方插成内联 SVG 图标
  panel.setBadge('还没打开');
  panel.setFileName('');
  timeline.setDuration(0);

  // 路由由 project.js 接管: 首页 / 新建 / 全局设置 / 项目编辑器；#/editor 保留旧直开模式
  if ((location.hash || '#/home') !== '#/editor') {
    Projects.applyHash();
    return;
  }

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
  // 示例按钮已从设置面板移除(可能为 null): 仅为旧 DOM 兼容保留空保护
  if (!firstVideo && btnV) btnV.disabled = true;
  if (!firstSrt && btnS) btnS.disabled = true;
  if (!firstAss && btnA) btnA.disabled = true;
  if (firstVideo && btnV) btnV.addEventListener('click', () => loadVideoUrl(firstVideo.url, firstVideo.name));
  if (firstSrt && btnS) btnS.addEventListener('click', () => loadSubUrl(firstSrt.url, firstSrt.name));
  if (firstAss && btnA) btnA.addEventListener('click', () => loadSubUrl(firstAss.url, firstAss.name));

  // 自动加载示例视频 + 示例 SRT, 开箱即用
  // 延迟到 window load 之后: 避免大视频流阻塞页面 load 事件
  const autoLoad = async () => {
    if (firstVideo) loadVideoUrl(firstVideo.url, firstVideo.name);
    if (firstSrt) await loadSubUrl(firstSrt.url, firstSrt.name);
  };
  if (document.readyState === 'complete') setTimeout(autoLoad, 100);
  else window.addEventListener('load', () => setTimeout(autoLoad, 100));
})();
