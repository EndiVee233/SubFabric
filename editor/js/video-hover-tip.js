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
 * 进度条铺满**画面**宽度（不是 video 元素宽度）：长宽比不匹配时画面两侧有黑边，
 * 原生控件也跟着铺在画面上。所以横向换算要用去掉黑边后的矩形，算法与
 * main.js 的 pictureRect() / SrtOverlay.fitToVideo 完全一致（这里自带一份，
 * 因为 main.js 无 export，而横向铺满的 bug 只在非 16:9 素材上才看得见）。
 *
 * 纵向：进度条在距画面底约 BAR_HINT px 处。取实测值 22px（上探针里那个从 30 跳到
 * 1946.7 的点击就落在距底 8px，那是滑块/凹槽的命中带；悬停判定放宽到一条薄带，
 * 见 HOT_LO/HOT_HI），并用与 videoedit.js 的 CTRL_BAR=72 一致的口径做上限约束 ——
 * 超过它就进了字幕接管层的地盘（那边要处理"字幕压住控制条"的双击）。
 *
 * ── 与 videoedit 的"字幕接管层"的关系 ──────────────────────────────────
 * 字幕行的下半截压到控制条上时，videoedit.js 会把 #cue-hit-shield 武装起来接管那一小块
 * （否则那半截字幕点不动）。此时指针目标是 shield 而不是 video，本模块收不到事件、
 * 提示不显示 —— 这是**有意的**：那一小块归字幕编辑管，不该再弹时间。
 * 接管层默认 pointer-events:none，所以绝大多数位置（画面里有字幕行、但没压到控制条上）
 * 提示照常。
 */
import { fmtTime } from './util.js';

/* 悬停判定带：距画面底 HOT_LO~HOT_HI px 内算"悬在进度条上"。
 * 上界 34 是"thumb 上沿 + 一点余量"，下界 1 是为了避开底边那 1px 边框噪声；
 * 再往上就是画面内容，不该弹时间。 */
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

  function hide() {
    hot = false;
    lastPct = -1;
    tip.classList.remove(CLS_ON);
    tip.hidden = true;
  }

  function show(pt) {
    // 指针位置 → 占比。用**相对 video 元素**的坐标，因为判定带是跟 video 对齐的。
    const vb = video.getBoundingClientRect();
    const pic = pictureRect();
    if (!pic) return;
    const px = pt.x - vb.left;
    const py = pt.y - vb.top;
    const fromBottom = vb.height - py;
    if (fromBottom < HOT_LO || fromBottom > Math.min(HOT_HI, CTRL_BAR)) { hide(); return; }
    if (px < pic.left - 1 || px > pic.left + pic.width + 1) { hide(); return; }

    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) { hide(); return; }

    const ratio = Math.max(0, Math.min(1, (px - pic.left) / pic.width));
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
    const cx = pic.left + ratio * pic.width;
    const w = tip.offsetWidth || TIP_HALF * 2;
    const left = Math.max(2, Math.min(stage.clientWidth - w - 2, cx - w / 2));
    tip.style.left = left + 'px';
    tip.style.bottom = Math.round(vb.height - (pic.top + pic.height) + TIP_ABOVE) + 'px';
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
