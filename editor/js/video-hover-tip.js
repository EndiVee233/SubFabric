/**
 * 进度条悬浮时间提示：鼠标悬在**原生**播放器进度条上时，在上方显示该位置的时间。
 *
 * 为什么自己做：`<video controls>` 的控件在 UA shadow DOM 里，Chrome 不带 hover 时间
 * 预览，也没法往里插元素。
 *
 * ── 为什么监听能挂在 <video> 上（实测，不是推断）──────────────────────────
 * tools/probe_video_controls.mjs 用 CDP 在真实页面上从视频底边每 6px 派发一次
 * `Input.dispatchMouseEvent`，结果（840×515 的播放区、1280 窗口）：
 *
 *     距底  2~74px  elementFromPoint = video        ← 控制条整条带子都命中 video 本身
 *     距底 80~86px  elementFromPoint = cue-hit-shield（videoedit 的字幕接管层）
 *     点进度条 70% 处 → currentTime 30 → 1946.7      ← 原生控件确实接管了点击
 *
 * 也就是说：**控制条区域的事件目标就是 <video>**，一个 mousemove 监听就够，
 * 不需要自建控制条、也不需要往 shadow DOM 里塞东西。
 *
 * ── 几何 ────────────────────────────────────────────────────────────────
 * **横向**：进度条不是铺满 video 元素，而是左右对称内缩、约占元素宽 96%。
 * 这是**实测**出来的 —— 一开始我按"铺满整宽"写，用户立刻发现对不上：
 * 他鼠标在进度条上（播放器读数 10:22 / 3:59:54 ≈ 4.3%）时提示显示 14:38（≈ 6.1%），
 * 越靠左边差得越多。用 tools/probe_bar_fit.mjs 拖动滑块到多个已知像素位置、
 * 记下 (像素, currentTime) 做最小二乘拟合（采样点特意往两端挤，边界才定得准）：
 *
 *     元素宽 960 → 轨道 930.9（0.970）   元素宽 855 → 轨道 827.0（0.967）
 *     元素宽 760 → 轨道 733.0（0.965）   元素宽 560 → 轨道 536.9（0.959）
 *     → 按比例、不是固定像素，统一取 TRACK_FRAC = 0.96
 *
 * 另外实测到：元素明显比画面宽（长宽比不匹配、两侧有黑边）时，进度条会**贴画面**铺
 * —— 元素 855×334 / 画面 827 宽那次，拟合出的轨道边界 14.0 与 841.0 正好是画面边界。
 * 所以 trackRect() 分这两类处理，硬约束是"轨道不会比画面宽"。
 *
 * 残留不确定度：靠近两端时读数会被钳住（左右各约 2px 之内读数不变），
 * 拟合边界有 ±2px 量级的不确定度（45 分钟的视频上约合 ±6 秒）。判定带只在
 * 距底 34px 以内生效，所以这点误差不影响"悬停大致定位"的用途。
 *
 * **纵向**：进度条在距画面底 HOT_HI 以内（判定带见 HOT_LO/HOT_HI），
 * 上限与 videoedit 的 CTRL_BAR=72 同口径收口 —— 再往上就是画面内容/接管层地盘。
 *
 * 提示块底边固定离画面底 TIP_ABOVE px（在进度条上方），左右夹在舞台内不越界。
 * 时间文本：整段 <1 小时用 `m:ss`（与播放器自己的读数同口径），否则 `h:mm:ss`
 * （避免 5 小时直播回放显示成 `312:03`）；`title` 另给毫秒精度。
 *
 * ── 与 videoedit 的"字幕接管层"的关系 ──────────────────────────────────
 * 字幕行的下半截压到控制条上时，videoedit.js 会把 #cue-hit-shield 武装起来接管那一小块
 * （否则那半截字幕点不动）。此时指针目标是 shield 而不是 video，本模块收不到事件、
 * 提示不显示 —— 这是**有意的**：那一小块归字幕编辑管，不该再弹时间。
 * 接管层默认 pointer-events:none，所以绝大多数位置（画面里有字幕行、但没压到控制条上）
 * 提示照常。
 */
import { fmtTime } from './util.js';

/* 进度条横向几何（实测拟合值，见文件头）：轨道宽约为 video 元素宽的 TRACK_FRAC 倍，
 * 左右对称内缩 (1−TRACK_FRAC)/2。**按比例**、不是固定像素 —— 四个元素宽下的拟合：
 *     宽 960 → 轨道 930.9   宽 855 → 827.0   宽 760 → 733.0   宽 560 → 536.9
 *     比例 0.970 / 0.967 / 0.965 / 0.959 → 取 0.96 作统一口径。 */
const TRACK_FRAC = 0.96;
/* 悬停判定带：距画面底 HOT_LO~HOT_HI px 内算"悬在进度条上"。
 * 实测：距底 8~20px 点击会跳转、26px 起不跳（控制条整条带子的事件目标仍是 video）。
 * 上界取 34 是"thumb 上沿 + 一点余量"；再往上就是画面内容，不该弹时间。 */
const HOT_LO = 1;
const HOT_HI = 34;
/* 提示块底边离画面底的距离：要落在进度条上方，且不遮住画面主体。 */
const TIP_ABOVE = 40;
/* 提示块的半边宽（贴住左右两端时用），与 CSS 里的 min-width 对应。 */
const TIP_HALF = 26;
/* 控制条带宽，与 videoedit.js 的 CTRL_BAR 同值（那边用它把"点视频=播放/暂停"让给控件）。
 * 这里只用来兜底：指针不能既算"在进度条上"又算"在接管层里"。 */
const CTRL_BAR = 72;

const CLS_ON = 'show';

function init() {
  const video = document.getElementById('video');
  const stage = document.getElementById('video-stage');
  const tip = document.getElementById('video-hover-tip');
  if (!video || !stage || !tip) return;

  let hot = false;          // 指针当前是否落在进度条判定带内
  let lastPct = -1;

  /** 画面矩形（去掉黑边），相对 #video-stage；与 main.js pictureRect() 同一套算法。 */
  function pictureRect() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const w = video.clientWidth, h = video.clientHeight;
    if (!vw || !vh || !w || !h) return null;
    const vr = vw / vh, er = w / h;
    let rw = w, rh = h;
    if (er > vr) rw = Math.floor(h * vr); else rh = Math.floor(w / vr);
    const st = stage.getBoundingClientRect(), vb = video.getBoundingClientRect();
    return {
      left: (vb.left - st.left) + (w - rw) / 2,
      top: (vb.top - st.top) + (h - rh) / 2,
      width: rw,
      height: rh,
    };
  }

  /** 进度条**可拖动轨道**的横向范围，**相对 video 元素自身**（左偏移 + 宽度）。
   *
   * 两类情况（都有实测支撑，见文件头）：
   *  · 元素与画面形状接近（16:9 素材的常态）：轨道占元素宽的 TRACK_FRAC，左右对称内缩。
   *  · 元素明显比画面宽（长宽比不匹配、两侧有黑边）：实测进度条会**贴画面**两侧铺
   *    （元素 855×334、画面 827 宽时，拟合出的轨道边界正好 14.0 与 841.0 = 画面边界）。
   *    所以这时把轨道收进画面内。
   * 两式都不会让轨道宽于画面 —— 这是硬约束：进度条不可能画到画面外面去。
   */
  function trackRect() {
    const w = video.clientWidth;
    const inset = w * (1 - TRACK_FRAC) / 2;
    let left = inset, width = Math.max(1, w - inset * 2);
    const pic = pictureRect();
    if (pic) {
      const picLeftInElement = pic.left - (video.getBoundingClientRect().left -
        stage.getBoundingClientRect().left);
      if (picLeftInElement > left + 2) {          // 左侧有黑边 → 贴画面
        left = picLeftInElement;
        width = Math.max(1, pic.width);
      }
      // 兜底：任何情况下都不超出画面
      const maxW = pic.width;
      if (width > maxW) { width = maxW; left = Math.max(left, picLeftInElement); }
    }
    return { leftInElement: left, width };
  }

  function hide() {
    hot = false;
    lastPct = -1;
    tip.classList.remove(CLS_ON);
    tip.hidden = true;
  }

  function show(pt) {
    // 指针位置 → 占比。判定带与轨道都跟 video 元素对齐，所以用元素坐标。
    const vb = video.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const px = pt.x - vb.left;
    const py = pt.y - vb.top;
    const fromBottom = vb.height - py;
    if (fromBottom < HOT_LO || fromBottom > Math.min(HOT_HI, CTRL_BAR)) { hide(); return; }

    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) { hide(); return; }

    const tr = trackRect();
    if (px < tr.leftInElement - 1 || px > tr.leftInElement + tr.width + 1) { hide(); return; }

    const ratio = Math.max(0, Math.min(1, (px - tr.leftInElement) / tr.width));
    const sec = ratio * dur;
    // 只有占比真的变了才改 DOM / 动 class，避免每像素一次重排
    const pct = Math.round(ratio * 1000);
    if (hot && pct === lastPct) return;
    const wasHot = hot;
    hot = true;
    lastPct = pct;

    // 时间文本：整段时长不足 1 小时就用 m:ss（播放器自己的读数也是这个口径），
    // 否则退回 fmtTime 的 h:mm:ss —— 免得一个 5 小时的直播回放显示成 "312:03"。
    const t = Math.floor(sec);
    const h = Math.floor(t / 3600);
    const text = h > 0
      ? `${h}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
      : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    // title 给到毫秒精度：整秒读数定位不够准，按住想看精确值时能悬停读 title
    tip.title = `${fmtTime(sec)}（${(sec).toFixed(3)}s）`;

    tip.textContent = text;
    tip.hidden = false;
    // 提示块横向对准它所指的**轨道**位置（不是画面位置）
    const cx = (vb.left - stageBox.left) + tr.leftInElement + ratio * tr.width;
    const w = tip.offsetWidth || TIP_HALF * 2;
    const left = Math.max(2, Math.min(stage.clientWidth - w - 2, cx - w / 2));
    tip.style.left = left + 'px';
    const pic = pictureRect();
    const picBottom = pic ? pic.top + pic.height : video.clientHeight;
    tip.style.bottom = Math.round(vb.height - picBottom + TIP_ABOVE) + 'px';
    // 复活动效：hint 用 [hidden] 切显示，:not([hidden]) 上的 animation 只在插入时跑一次，
    // 所以离开判定带再回来时靠重挂 class 让它重播（缓存 offsetWidth 读值即可强制重排）。
    if (!wasHot) { tip.classList.remove(CLS_ON); void tip.offsetWidth; }
    tip.classList.add(CLS_ON);
  }

  // mousemove 在 video 上就能拿到控制条区域的事件（见文件头实测）。
  // 用 passive 监听：这里绝不 preventDefault —— 一旦拦截，原生控制条自己就收不到手势了。
  video.addEventListener('mousemove', show, { passive: true });
  video.addEventListener('mouseleave', hide);
  video.addEventListener('emptied', hide);
  video.addEventListener('loadstart', hide);
  // 窗口/面板尺寸变化会让画面矩形变，缓存不用留（每次现算），但提示要继续跟手：
  // 指针不动时不该留一个位置过时的提示块。
  window.addEventListener('resize', hide, { passive: true });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (hot) hide(); }).observe(stage);
  }
  // 开始播放/跳转后自动收起：鼠标可能停在进度条上没动，但位置语义已经变了
  video.addEventListener('seeking', hide);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
