/**
 * 长音频分片：静音优先切片 + 时间戳偏移合并 + 串行调度。
 *
 * 为什么要分片
 *   · 云端（必剪 / 剪映）：免费接口对长音频极不友好 —— 一个几小时的任务几乎必然超时或被限流/风控；
 *   · 本地（whisper.cpp / sherpa-onnx）：长音频对模型也不友好 —— 显存/内存占用大，出错重来代价高，
 *     whisper 尤其明显。切成 25 分钟一片，两边都稳。
 *
 * 约定（用户要求）
 *   · 每片目标 **25 分钟**；切点**优先落在静音中点**，找不到静音才退化成名义切点；
 *   · 片与片**不重叠**（切在静音里，不会把词切开），因此合并时不需要去重叠；
 *   · 云端**串行**执行，片间随机等 **10~15 秒**（模拟人类节奏，降低风控概率）；
 *   · 本地也串行，但**片间不等候**；
 *   · 每片的时间戳（句子与逐词）都加回该片起点偏移后合并。
 *
 * 这个文件不碰网络、不碰 ffmpeg、不碰文件系统 —— 纯计算 + 可注入的调度器，便于离线验证（见 tests/audio-chunk-test.mjs）。
 */

const CHUNK_SEC = 25 * 60;          // 目标片长
const MIN_TAIL_SEC = 60;            // 末尾不足 1 分钟就并进上一片
const SILENCE_SEARCH_SEC = 90;      // 在名义切点前后各 90 秒内找静音
const MIN_HEAD_SEC = 30;            // 一片最短 30 秒（避免切出碎渣）
const CLOUD_WAIT_MIN_MS = 10000;    // 云端片间等待下限
const CLOUD_WAIT_MAX_MS = 15000;    // 云端片间等待上限

/** ffmpeg silencedetect 输出 → [{start,end}]（末尾未闭合的静音按 duration 收尾） */
function parseSilences(text, duration) {
  const out = [];
  let open = null;
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Number(m[2]);
    if (!isFinite(t)) continue;
    if (m[1] === 'start') {
      if (open != null) out.push({ start: open, end: t });     // 上一段没收尾也认
      open = t;
    } else if (open != null) {
      if (t > open) out.push({ start: open, end: t });
      open = null;
    }
  }
  if (open != null) {
    const end = duration > open ? duration : open + 0.5;
    out.push({ start: open, end });
  }
  return out;
}

/** 在名义切点附近挑一个静音中点当地真切点；挑不到就返回名义切点。
 *  minChunk / searchSec 都由片长推导（见 planAudioChunks）：25 分钟片长时是 30 秒 / 90 秒，
 *  片长调小时会按比例收紧 —— 否则 12 秒的片长也会被吸到 30 秒外的静音上（离线探针抓到过）。 */
function snapCut(nominal, silences, { start, duration, searchSec, minTailSec, minChunk }) {
  let best = null, bestD = Infinity;
  for (const s of silences || []) {
    if (!(s.end > s.start)) continue;
    const mid = (s.start + s.end) / 2;
    if (mid < start + minChunk) continue;                      // 太靠前 → 会切出碎渣
    if (mid > duration - minTailSec) continue;                 // 太靠后 → 尾巴会太小
    const d = Math.abs(mid - nominal);
    // 优先离名义切点最近的静音；距离相同则挑更长的那段静音（切得更"空"）
    if (d < searchSec && (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && best && (s.end - s.start) > (best.end - best.start)))) {
      best = s; bestD = d;
    }
  }
  return best ? (best.start + best.end) / 2 : nominal;
}

/**
 * 规划分片。duration 未知(<=0) → 返回 []（表示"不分片，按整段处理"，由调用方决定）。
 * 返回 [{ index, start, end }]，**首尾相接、无重叠、完整覆盖 [0, duration]**。
 */
function planAudioChunks({ duration, silences = [], chunkSec = CHUNK_SEC, minTailSec = MIN_TAIL_SEC, searchSec = SILENCE_SEARCH_SEC } = {}) {
  const dur = Number(duration);
  if (!(dur > 0)) return [];
  // 最短片长与搜索窗口都随片长缩放：25 分钟片长 → 30 秒 / 90 秒（原来写死的值）
  const minChunk = Math.max(5, Math.min(MIN_HEAD_SEC, chunkSec * 0.5));
  const search = Math.min(searchSec, Math.max(3, chunkSec * 0.25));
  const out = [];
  let start = 0;
  let guard = 0;
  while (dur - start > chunkSec + minTailSec && guard++ < 1000) {
    const nominal = Math.min(start + chunkSec, dur - minTailSec);
    let cut = snapCut(nominal, silences, { start, duration: dur, searchSec: search, minTailSec, minChunk });
    if (!(cut > start + minChunk)) cut = nominal;               // 兜底：切点必须真的往后走
    if (!(cut > start + minChunk)) break;
    out.push({ index: out.length, start: +start.toFixed(3), end: +cut.toFixed(3) });
    start = cut;
  }
  out.push({ index: out.length, start: +start.toFixed(3), end: +dur.toFixed(3) });
  return out;
}

/** 把各片的识别结果按偏移合并成一条时间轴（句子与逐词都加 offset）*/
function mergeChunkSegments(parts) {
  const all = [];
  for (const p of parts || []) {
    const off = Number(p && p.offset) || 0;
    for (const s of ((p && p.segments) || [])) {
      const st = Number(s.start), en = Number(s.end);
      const text = String((s && s.text) || '').trim();
      if (!text || !(en > st)) continue;
      all.push({
        start: +(st + off).toFixed(3),
        end: +(en + off).toFixed(3),
        text,
        words: (Array.isArray(s.words) ? s.words : []).map(w => ({
          word: String(w.word == null ? '' : w.word).trim(),
          start: +(Number(w.start) + off).toFixed(3),
          end: +(Number(w.end) + off).toFixed(3),
        })).filter(w => w.word && w.end > w.start),
      });
    }
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const s of all) {
    const last = out[out.length - 1];
    // 边界去重：跨过切点的那句话会被相邻两片都识别到 —— 判据是「同文本 + 时间上重叠」，
    // 只看起点差不行（切点两侧的起点可能差好几秒）。同文本但不重叠的重复句（歌词副歌）不会被误删。
    if (last && s.text === last.text && s.start < last.end + 0.5) continue;
    out.push(s);
  }
  return out;
}

/** 云端片间等待：10~15 秒随机（rnd 可注入，便于测试）*/
function randomWaitMs(min = CLOUD_WAIT_MIN_MS, max = CLOUD_WAIT_MAX_MS, rnd = Math.random) {
  const r = Math.min(1, Math.max(0, Number(rnd()) || 0));
  return Math.round(min + (max - min) * r);
}

const fmtT = (t) => {
  const s = Math.max(0, Number(t) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
};

/**
 * 串行跑完所有片。
 * @param {object} o
 * @param {Array} o.chunks                 planAudioChunks 的结果
 * @param {function} o.runOne              async (chunk, i, n) → { segments, engine? }；切片的生成与识别都在里面
 * @param {function|null} o.waitBetweenMs  返回片间等待毫秒；null/0 表示不等候（本地识别）
 * @param {function} [o.onProgress]        (done, total, chunk) → 进度
 * @param {function} [o.log]               文本日志
 * @param {AbortSignal} [o.signal]
 * @param {function} [o.sleep]             可注入的 sleep（测试用）
 * @returns {Promise<{parts:Array, perChunk:Array}>}
 */
async function runChunks(o) {
  const chunks = o.chunks || [];
  const runOne = o.runOne;
  const log = o.log || (() => {});
  const onProgress = o.onProgress || (() => {});
  const sleep = o.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const parts = [], perChunk = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (o.signal && o.signal.aborted) throw new Error('已取消');
    log(`第 ${i + 1}/${chunks.length} 片（${fmtT(c.start)}–${fmtT(c.end)}，${Math.round(c.end - c.start)} 秒）`);
    const r = (await runOne(c, i, chunks.length)) || {};
    const segs = Array.isArray(r.segments) ? r.segments : [];
    parts.push({ offset: c.start, segments: segs });
    perChunk.push({ index: i, start: c.start, end: c.end, seconds: +(c.end - c.start).toFixed(3), segments: segs.length, engine: r.engine || '' });
    log(`第 ${i + 1}/${chunks.length} 片识别完成：${segs.length} 句`);
    onProgress(i + 1, chunks.length, c);
    if (i < chunks.length - 1 && o.waitBetweenMs) {
      const w = Math.max(0, Number(o.waitBetweenMs(i)) || 0);
      if (w > 0) {
        log(`等 ${(w / 1000).toFixed(1)} 秒再继续下一片（避免触发限流）`);
        await sleep(w);
      }
    }
  }
  return { parts, perChunk };
}

module.exports = {
  CHUNK_SEC, MIN_TAIL_SEC, SILENCE_SEARCH_SEC, CLOUD_WAIT_MIN_MS, CLOUD_WAIT_MAX_MS,
  parseSilences, planAudioChunks, mergeChunkSegments, randomWaitMs, runChunks, fmtT,
};
