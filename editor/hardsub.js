/**
 * 视频导出：把稿件字幕烧进画面（硬字幕），或复制原片、导出字幕文件。
 *
 * 逻辑取自同作者的 hardsub-py（https://github.com/EndiVee233/hardsub-py），
 * 内嵌进 SubFabric 后不用用户再装一个 CLI：这里只保留服务端真正需要的那部分
 * —— 硬件编码探测与回退、ASS 垫背事件、滤镜链、进度解析、成片自检。
 *
 * 要点（都是 hardsub-py 踩过的坑，别"优化"掉）：
 *   1. **第一条字幕会被吞**：ffmpeg/libass 在事件数多时丢掉 [Events] 首条。
 *      解法是在 Format: 后插一条"空文本 + 10ms"的垫背事件，被吞的是它。
 *   2. **硬件链路常常"能列出编码器但跑不动"**：正式压之前先用真实视频试跑 0.5 秒，
 *      失败就自动回退 CPU；不试跑就会出现"白等一小时然后报错"。
 *   3. **Windows 路径进 -vf 必须转义冒号**（D\:/x/y.ass），否则盘符被当成滤镜选项分隔符。
 *   4. **CPU 路径不能带 hwdownload**，软解时那样必报错。
 *   5. `libsvtav1` 的 preset 必须是数字，写 medium 直接失败。
 *
 * 所有状态（任务表、子进程表）都放在模块作用域 —— 见 PROJECT_MAP §3.3 的错误示范。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/* ══════════════════════════════════════════════════════════════════════
 * 硬件编码表
 * ══════════════════════════════════════════════════════════════════════ */

const HW_ENCODERS = {
  nvidia: { h264: 'h264_nvenc', h265: 'hevc_nvenc', av1: 'av1_nvenc' },
  amd: { h264: 'h264_amf', h265: 'hevc_amf', av1: 'av1_amf' },
  intel: { h264: 'h264_qsv', h265: 'hevc_qsv', av1: 'av1_qsv' },
  cpu: { h264: 'libx264', h265: 'libx265', av1: 'libsvtav1' },
};

/** CPU 软编码器候选：按偏好排序，取第一个真实存在且能编的。 */
const CPU_ENCODER_CANDIDATES = {
  h264: ['libx264', 'libopenh264'],
  h265: ['libx265', 'libkvazaar'],
  av1: ['libsvtav1', 'libaom-av1', 'librav1e'],
};

const DEFAULT_QUALITY = { h264: 23, h265: 23, av1: 30 };
/** mp4/mov 容器能直接 copy 的音频编码；其余要转 AAC，否则封装失败。 */
const MP4_OK_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

/* 探测结果缓存：ffmpeg 的编码器列表与显卡列表在进程生命周期内不会变。
 * 放模块作用域，避免每次压片都重跑一遍（每次要 1–2 秒）。 */
let probeCache = null;

/**
 * 检查 ffmpeg / ffprobe 是否真的能跑。
 *
 * 为什么必须有这一步：`FFMPEG` 常量在没有环境变量、也没有常见安装路径时**回退成裸字符串
 * 'ffmpeg'**（交给 PATH 解析）。找不到时 spawn 会抛 ENOENT —— 而我们所有探测函数都吞掉异常，
 * 于是探测结果变成"没有可用编码器"，界面就会显示成**"未检测到硬件编码，将用 CPU"**：
 * 用户以为能压（只是慢），实际点下去必然失败。这个函数把"根本不可用"与"能用但只有 CPU"区分开。
 *
 * @returns {{ok: boolean, missing: string[], version: string, error: string}}
 */
function checkTools(ffmpeg, ffprobe) {
  const missing = [];
  let version = '';
  let error = '';
  for (const [name, bin] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
    const r = runCapture([bin, '-version'], 10000);
    if (r.code !== 0) {
      missing.push(name);
      if (!error) error = String(r.err || '').trim().split(/\r?\n/)[0] || `${name} 无法执行`;
    } else if (name === 'ffmpeg') {
      const m = /ffmpeg version (\S+)/.exec(r.out || '');
      version = m ? m[1] : '';
    }
  }
  return { ok: missing.length === 0, missing, version, error };
}

/** 清空探测缓存。ffmpeg 换了一份（例如刚自动下载完）之后必须调用，
 *  否则还会拿"旧 ffmpeg 一个编码器都没有"的结论去配方案。 */
function resetProbe() {
  probeCache = null;
}

function runCapture(cmd, timeoutMs = 20000) {
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    });
    return { code: r.status == null ? 127 : r.status, out: r.stdout || '', err: r.stderr || '' };
  } catch (e) {
    return { code: 127, out: '', err: String((e && e.message) || e) };
  }
}

function ffmpegVersion(ffmpeg) {
  const r = runCapture([ffmpeg, '-version']);
  const m = /ffmpeg version (\S+)/.exec(r.out || '');
  return m ? m[1] : '';
}

function listEncoders(ffmpeg) {
  const r = runCapture([ffmpeg, '-hide_banner', '-encoders']);
  const set = new Set();
  for (const line of String(r.out || '').split(/\r?\n/)) {
    // 形如 " V....D h264_nvenc   NVIDIA NVENC H.264 encoder"
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

/** 真编 3 帧验证驱动可用 —— 只看 -encoders 列表会误判（列出来了但驱动没装照样能列）。 */
function encoderWorks(ffmpeg, encoder) {
  const r = runCapture([
    ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=256x144:r=25:d=0.12', '-frames:v', '3',
    '-c:v', encoder, '-f', 'null', '-',
  ], 30000);
  return r.code === 0;
}

function pickCpuEncoder(ffmpeg, codec) {
  const available = listEncoders(ffmpeg);
  for (const name of (CPU_ENCODER_CANDIDATES[codec] || [])) {
    if (available.has(name)) return name;
  }
  return null;
}

function detectGpus() {
  if (process.platform !== 'win32') return [];
  const out = [];
  // PowerShell 而非 wmic：新系统上 wmic 已默认移除
  const r = runCapture(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name']);
  for (const line of String(r.out || '').split(/\r?\n/)) {
    const s = line.trim();
    if (s) out.push(s);
  }
  return out;
}

function vendorsIn(gpus) {
  const found = new Set();
  for (const g of gpus) {
    const s = String(g).toLowerCase();
    if (/nvidia|geforce|quadro|rtx|gtx/.test(s)) found.add('nvidia');
    if (/amd|radeon|ati /.test(s)) found.add('amd');
    if (/intel|arc|iris|uhd graphics/.test(s)) found.add('intel');
  }
  return [...found];
}

/**
 * 探测结果（带缓存）。返回：
 *   { ffmpeg, ffprobe, version, gpus, vendors,
 *     accelerators: { nvidia: bool, amd: bool, intel: bool, cpu: true },
 *     encoders: { amd: { h264: {encoder,usable}, h265: {...}, av1: {...} }, ... },
 *     cpu: { h264: {encoder,usable}, ... } }
 *
 * **必须按编码器逐个验证，不能只按厂商**：
 * 同一家显卡可能只有部分编码器真能跑（实测 RX550：h264_amf/hevc_amf 可以，av1_amf 不行）。
 * 若只记"AMD 可用"就去配 av1_amf，会白跑一次试压再掉回 CPU —— 而别的厂商（如 Intel QSV）
 * 可能本来就能压 AV1。encoders 里记下每个组合的真实结果，挑方案时按需查。
 */
function probe(ffmpeg, ffprobe, { refresh = false } = {}) {
  if (probeCache && !refresh) return probeCache;
  const available = listEncoders(ffmpeg);
  const gpus = detectGpus();
  const vendors = vendorsIn(gpus);
  const accelerators = { cpu: true };
  const encoders = {};
  for (const vendor of ['nvidia', 'amd', 'intel']) {
    const table = HW_ENCODERS[vendor] || {};
    encoders[vendor] = {};
    for (const [codec, name] of Object.entries(table)) {
      // 列表里没有就必然不可用；列表里有也要真编 3 帧才作数（驱动没装照样会列出编码器）
      const listed = available.has(name);
      encoders[vendor][codec] = listed
        ? { encoder: name, usable: encoderWorks(ffmpeg, name) }
        : { encoder: name, usable: false };
    }
    accelerators[vendor] = Object.values(encoders[vendor]).some(e => e.usable);
  }
  const cpu = {};
  for (const codec of Object.keys(CPU_ENCODER_CANDIDATES)) {
    const name = pickCpuEncoder(ffmpeg, codec);
    cpu[codec] = name && { encoder: name, usable: encoderWorks(ffmpeg, name) };
  }
  const tools = checkTools(ffmpeg, ffprobe);
  probeCache = {
    ffmpeg, ffprobe, version: tools.version || ffmpegVersion(ffmpeg),
    // tools.ok=false 表示 ffmpeg/ffprobe 根本跑不起来（没装 / 不在 PATH / 路径写错）。
    // 此时 accelerators 全是 false、cpu 全是 null —— 别把它读成"只能 CPU"。
    tools,
    gpus, vendors, accelerators, encoders, cpu,
  };
  return probeCache;
}

/**
 * 挑一个**真的能压这个编码格式**的加速方案，GPU 优先。
 *
 * 优先级：独显（NVIDIA > AMD）→ 核显（Intel）→ CPU。这是用户明确要求的口径：
 * "压制首先选用 GPU 而不是 CPU"。所以哪怕 CPU 软编码能跑，只要 GPU 支持该编码格式就用 GPU。
 *
 * @param {object} p          probe() 的结果
 * @param {string} codec      'h264' | 'h265' | 'av1'
 * @param {string} [requested] 用户显式指定的方案；'auto' 或空表示按上面的优先级自动挑
 * @returns {{accel: string, encoder: string, usable: boolean, fallback: boolean}}
 *          fallback=true 表示用户指定的方案压不了该编码格式，已自动降级
 */
function pickAccel(p, codec, requested) {
  // 工具不可用时一切方案都压不了 —— 明确报"不可用"，别返回 cpu 让人以为还能跑
  if (p.tools && p.tools.ok === false) {
    return { accel: 'cpu', encoder: '', usable: false, fallback: false, reason: 'ffmpeg/ffprobe 不可用' };
  }
  const usable = (vendor) => {
    const e = p.encoders && p.encoders[vendor] && p.encoders[vendor][codec];
    return !!(e && e.usable);
  };
  const GPU_ORDER = ['nvidia', 'amd', 'intel'];
  // CPU 是否真能压这个格式：encoders 全灭时不能默认"CPU 可以"
  const cpuUsable = !!(p.cpu && p.cpu[codec] && p.cpu[codec].usable);

  const explicit = requested && requested !== 'auto' ? requested : '';
  if (explicit && explicit !== 'cpu') {
    if (usable(explicit)) {
      return { accel: explicit, encoder: p.encoders[explicit][codec].encoder, usable: true, fallback: false };
    }
    // 指定了 GPU 但压不了这个格式 → 继续按 GPU 优先挑别的，最后才落 CPU
    for (const v of GPU_ORDER) {
      if (v !== explicit && usable(v)) {
        return { accel: v, encoder: p.encoders[v][codec].encoder, usable: true, fallback: true };
      }
    }
    return {
      accel: 'cpu', encoder: '', usable: cpuUsable, fallback: true,
      reason: cpuUsable ? '' : `没有可用的 ${codec} 编码器`,
    };
  }
  if (explicit === 'cpu') {
    return {
      accel: 'cpu', encoder: '', usable: cpuUsable, fallback: false,
      reason: cpuUsable ? '' : `这个 ffmpeg 没有可用的 ${codec} 编码器`,
    };
  }

  for (const v of GPU_ORDER) {
    if (usable(v)) return { accel: v, encoder: p.encoders[v][codec].encoder, usable: true, fallback: false };
  }
  return {
    accel: 'cpu', encoder: '', usable: cpuUsable, fallback: false,
    reason: cpuUsable ? '' : `这个 ffmpeg 没有可用的 ${codec} 编码器`,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 字幕预处理
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Windows 路径塞进 -vf 时必须：(1) 反斜杠全转正斜杠，(2) 盘符冒号转义成 "\:"，
 * (3) **整段用单引号包起来**。
 *
 * 三条缺一不可 —— 实测（ffmpeg 2026-08 完整构建）：
 *   subtitles=C\:/x/y.ass          → 盘符被吃掉，报 original_size 解析失败
 *   subtitles='C:/x/y.ass'         → 引号里不转义，同样报 original_size
 *   subtitles='C\:/x/y.ass'        → ✅ 唯一可行
 * 只有把引号一起带上，滤镜解析器才会按"一段字符串"而不是"选项串"来读冒号。
 */
function escapeFilterPath(p) {
  const posix = String(p).replace(/\\/g, '/').replace(/'/g, "\\'");
  return "'" + posix.replace(/:/g, '\\:') + "'";
}

const SACRIFICIAL_START = '0:00:00.00';
const SACRIFICIAL_END = '0:00:00.01';

/**
 * 在 ASS/SSA 的 [Events] Format: 行后插一条空文本事件当垫背。
 *
 * 为什么需要：实测事件 ≥100 条时，成片里文件里第一条字幕不出现（libass 首事件丢失）。
 * 加 Collisions、删 WrapStyle、把首条时间改成 0 都无效，只有插空事件有效。
 * 事件少时插进去也无副作用，所以无条件插。
 *
 * @returns {{text: string, inserted: boolean}}
 */
function injectSacrificialEvent(text) {
  const lines = String(text).split(/\r?\n/);
  const newline = /\r\n/.test(text) ? '\r\n' : '\n';
  const evStart = lines.findIndex(ln => ln.trim().toLowerCase().startsWith('[events]'));
  if (evStart < 0) return { text, inserted: false };

  let fields = null;
  let insertAt = evStart + 1;
  for (let i = evStart + 1; i < Math.min(evStart + 6, lines.length); i++) {
    const s = lines[i].trim();
    if (s.toLowerCase().startsWith('format:')) {
      const parts = s.slice(s.indexOf(':') + 1).split(',').map(p => p.trim());
      if (parts.length >= 5) { fields = parts; insertAt = i + 1; }
      break;
    }
  }
  if (!fields) return { text, inserted: false };

  const low = fields.map(f => f.toLowerCase());
  if (!low.includes('start') || !low.includes('end') || !low.includes('text')) {
    return { text, inserted: false };
  }

  const ev = {};
  for (const f of fields) ev[f] = '';
  ev[fields[low.indexOf('start')]] = SACRIFICIAL_START;
  ev[fields[low.indexOf('end')]] = SACRIFICIAL_END;
  if (low.includes('layer')) ev[fields[low.indexOf('layer')]] = '0';
  // 借用第一条真实事件的样式名，兼容性最好
  if (low.includes('style')) {
    for (let i = insertAt; i < lines.length; i++) {
      const s = lines[i].trim().toLowerCase();
      if (s.startsWith('dialogue:') || s.startsWith('comment:')) {
        const raw = lines[i];
        const vals = raw.slice(raw.indexOf(':') + 1).split(',');
        // 最后一列（text）可能自带逗号，只取到 fields.length - 1
        const picked = vals.slice(0, fields.length - 1)
          .concat([vals.slice(fields.length - 1).join(',')]);
        if (picked.length === fields.length) {
          ev[fields[low.indexOf('style')]] = String(picked[low.indexOf('style')] || '').trim();
        }
        break;
      }
    }
  }
  ev[fields[low.indexOf('text')]] = '';

  lines.splice(insertAt, 0, 'Dialogue: ' + fields.map(f => ev[f]).join(','));
  return { text: lines.join(newline), inserted: true };
}

/** SRT/VTT 也插一条空 cue 当垫背。 */
function injectSacrificialCue(text, kind) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  if (kind === 'srt') {
    if (!/\d{1,2}:\d{2}:\d{2},\d{3}/.test(text)) return { text, inserted: false };
    const cue = ['1', '00:00:00,000 --> 00:00:00,010', '', ''].join(nl);
    // 重新编号后续 cue 太麻烦也没必要 —— 播放器按时间读，序号不连续无影响
    return { text: cue + nl + String(text).replace(/^\uFEFF/, ''), inserted: true };
  }
  if (kind === 'vtt') {
    if (!/^WEBVTT/m.test(text)) return { text, inserted: false };
    const headEnd = String(text).indexOf(nl);
    if (headEnd < 0) return { text, inserted: false };
    const cue = nl + '00:00:00.000 --> 00:00:00.010';
    return { text: text.slice(0, headEnd) + cue + nl + text.slice(headEnd), inserted: true };
  }
  return { text, inserted: false };
}

/**
 * 把字幕文件准备到临时目录（垫背事件注入后的副本）。
 * 原文件绝不被改写 —— 用户的稿件是资产。
 */
function prepareSubtitle(subPath, workdir) {
  const ext = path.extname(subPath).toLowerCase();
  const kind = ext === '.srt' ? 'srt' : (ext === '.vtt' ? 'vtt' : 'ass');
  const notes = [];
  let text = fs.readFileSync(subPath, 'utf8').replace(/^\uFEFF/, '');

  if (kind === 'ass') {
    const r = injectSacrificialEvent(text);
    text = r.text;
    if (r.inserted) notes.push('已注入垫背事件（防止首条字幕被吞）');
    else notes.push('未找到 [Events] Format:，跳过垫背事件注入');
  } else {
    const r = injectSacrificialCue(text, kind);
    text = r.text;
    if (r.inserted) notes.push('已注入垫背 cue（防止首条字幕被吞）');
  }

  const out = path.join(workdir, 'sub' + (kind === 'ass' ? '.ass' : '.' + kind));
  fs.writeFileSync(out, text, 'utf8');
  return { path: out, kind, notes };
}

/** 字幕/视频旁边的 fonts/ 目录作为额外字体源（hardsub-py 的约定）。 */
function findFontsDir(...bases) {
  for (const base of bases) {
    if (!base) continue;
    const dir = path.join(base, 'fonts');
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* 不存在 */ }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 命令构造
 * ══════════════════════════════════════════════════════════════════════ */

function accelInputOpts(accel) {
  return {
    cpu: [],
    nvidia: ['-init_hw_device', 'cuda=cuda:0', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
    amd: ['-init_hw_device', 'd3d11va=dx', '-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11'],
    intel: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'],
  }[accel] || [];
}

function buildFilters(subFilter, accel) {
  if (accel === 'cpu') return subFilter + ',format=yuv420p';
  const tail = {
    nvidia: 'format=nv12,hwupload_cuda',
    amd: 'format=nv12,hwupload=derive_device=d3d11va',
    intel: 'format=nv12,hwupload=derive_device=qsv',
  }[accel];
  return 'hwdownload,' + subFilter + ',' + tail;
}

function subFilterOpts(subTmp, fontsDir) {
  let s = 'subtitles=' + escapeFilterPath(subTmp);
  if (fontsDir) s += ':fontsdir=' + escapeFilterPath(fontsDir);
  return s;
}

function defaultQualityFor(codec, accel) {
  if (codec === 'av1') return accel === 'cpu' ? 35 : DEFAULT_QUALITY.av1;
  return DEFAULT_QUALITY[codec] || 23;
}

function clampQuality(codec, q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return defaultQualityFor(codec, 'cpu');
  const base = Math.round(n);
  // av1 的合理区间偏大（SVT-AV1 常用 20–50）
  return codec === 'av1' ? Math.max(1, Math.min(63, base)) : Math.max(0, Math.min(51, base));
}

function buildPlan(ffmpeg, accel, codec, quality) {
  const encoders = HW_ENCODERS[accel] || HW_ENCODERS.cpu;
  if (accel === 'cpu') {
    const encoder = pickCpuEncoder(ffmpeg, codec);
    if (!encoder) throw new Error(`这个 ffmpeg 没有可用的 ${codec} 软编码器`);
    const params = ['-crf', String(quality)];
    // libsvtav1 的 preset 是数字（0–13），写 medium 直接报错
    params.push('-preset', encoder === 'libsvtav1' ? '8' : 'medium');
    return { accel, codec, encoder, inputOpts: [], encParams: params, quality };
  }
  const encoder = encoders[codec];
  if (!encoder) throw new Error(`${accel} 不支持 ${codec}`);
  let params;
  if (accel === 'nvidia') {
    params = ['-rc', 'vbr', '-cq', String(quality), '-b:v', '0', '-preset', 'p6'];
  } else if (accel === 'amd') {
    params = ['-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality),
      '-qp_b', String(quality), '-quality', 'quality'];
  } else {
    params = ['-global_quality', String(quality), '-look_ahead', '1'];
  }
  return { accel, codec, encoder, inputOpts: accelInputOpts(accel), encParams: params, quality };
}

function gopForFps(fps) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return 250;
  return Math.max(1, Math.round(f * 2));
}

function pickOutputExt(videoPath) {
  const ext = path.extname(videoPath).toLowerCase();
  // 沿用源容器最省事：h265/av1 在 mp4 里也能放，mkv 兼容性更好
  if (ext === '.mp4' || ext === '.mov' || ext === '.m4v') return '.mp4';
  return '.mkv';
}

function buildFfmpegCmd(ffmpeg, plan, media, subTmp, outPath, fontsDir, threads) {
  const filters = buildFilters(subFilterOpts(subTmp, fontsDir), plan.accel);
  const cmd = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-nostdin'];
  cmd.push(...plan.inputOpts);
  cmd.push('-i', media.path, '-map', `0:${media.vIndex}`);
  if (media.audio.length) cmd.push('-map', '0:a?');
  cmd.push('-map_metadata', '0', '-vf', filters, '-c:v', plan.encoder, ...plan.encParams);
  cmd.push('-g', String(gopForFps(media.fps)));
  // 硬件链路不能加 pix_fmt，否则会把 hw 帧拉回内存
  if (plan.accel === 'cpu') cmd.push('-pix_fmt', 'yuv420p');
  const ext = path.extname(outPath).toLowerCase();
  if (plan.codec === 'h265' && (ext === '.mp4' || ext === '.mov')) {
    cmd.push('-tag:v', 'hvc1');            // 让 QuickTime / 手机相册能认
  }
  if (media.audio.length) {
    const incompatible = media.audio.some(a => !MP4_OK_AUDIO.has(a));
    if ((ext === '.mp4' || ext === '.mov') && incompatible) {
      cmd.push('-c:a', 'aac', '-b:a', '192k');
    } else {
      cmd.push('-c:a', 'copy');
    }
  }
  if (ext === '.mp4' || ext === '.mov') cmd.push('-movflags', '+faststart');
  if (threads > 0) cmd.push('-threads', String(threads));
  cmd.push('-progress', 'pipe:1', '-nostats', outPath);
  return cmd;
}

/** 用真实视频试跑 0.5 秒整条链路；硬件链路"能列出编码器但跑不动"是常态。 */
function validateChain(ffmpeg, plan, media, subTmp, fontsDir) {
  const filters = buildFilters(subFilterOpts(subTmp, fontsDir), plan.accel);
  const cmd = [ffmpeg, '-hide_banner', '-v', 'error', '-y', ...plan.inputOpts,
    '-i', media.path, '-t', '0.5', '-an', '-vf', filters,
    '-c:v', plan.encoder, ...plan.encParams, '-f', 'null', '-'];
  const r = runCapture(cmd, 60000);
  if (r.code === 0) return { ok: true, error: '' };
  const tail = String(r.err || '').trim().split(/\r?\n/).filter(Boolean);
  return { ok: false, error: tail.length ? tail[tail.length - 1] : '未知错误' };
}

/* ══════════════════════════════════════════════════════════════════════
 * 媒体信息
 * ══════════════════════════════════════════════════════════════════════ */

function probeMedia(ffprobe, videoPath) {
  const r = runCapture([ffprobe, '-v', 'error', '-show_streams', '-show_format',
    '-of', 'json', videoPath], 30000);
  if (r.code !== 0) throw new Error('ffprobe 读不出视频信息：' + (r.err || '').slice(0, 300));
  let data;
  try { data = JSON.parse(r.out); } catch { throw new Error('ffprobe 输出无法解析'); }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const vIndex = streams.findIndex(s => s.codec_type === 'video');
  if (vIndex < 0) throw new Error('这个文件里没有视频轨');
  const v = streams[vIndex];
  const audio = streams
    .filter(s => s.codec_type === 'audio')
    .map(s => String(s.codec_name || '').toLowerCase())
    .filter(Boolean);
  let fps = 0;
  const rate = String(v.avg_frame_rate || v.r_frame_rate || '');
  const m = /^(\d+)\/(\d+)$/.exec(rate);
  if (m && Number(m[2]) > 0) fps = Number(m[1]) / Number(m[2]);
  const duration = Number((data.format && data.format.duration) || v.duration || 0) || 0;
  return {
    path: videoPath,
    vIndex,
    audio,
    fps,
    duration,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    videoCodec: String(v.codec_name || ''),
  };
}

function humanTime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '--:--';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/* ══════════════════════════════════════════════════════════════════════
 * 任务执行
 * ══════════════════════════════════════════════════════════════════════ */

function runEncode(cmd, duration, onProgress, signal) {
  return new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    let outBuf = '';
    let killed = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let settled = false;

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        try { proc.kill(); } catch { /* ignore */ }
      }, { once: true });
    }

    proc.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop() || '';
      for (const line of lines) {
        // -progress pipe:1 是 out_time_us=... / speed=... 这样的键值对
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (!m || !duration) continue;
        const sec = Number(m[1]) / 1e6;
        const pct = Math.max(0, Math.min(99, Math.round((sec / duration) * 100)));
        onProgress({ pct, time: humanTime(sec), duration: humanTime(duration) });
      }
    });
    proc.stderr.on('data', (chunk) => {
      if (stderrBuf.length < 20000) stderrBuf += chunk.toString('utf8');
    });
    proc.on('error', (e) => finish({ code: 127, error: String((e && e.message) || e) }));
    proc.on('close', (code) => {
      // cancelled 单独标出来：调用方据此区分"用户主动停止"和"真失败"，不要混成一条错误
      if (killed) return finish({ code: -1, cancelled: true, error: '已取消' });
      finish({ code: code == null ? 1 : code, cancelled: false, error: stderrBuf.trim() });
    });
  });
}

/* 活动任务：projectId → { variants, ... }。放模块作用域（跨请求可见）。 */
const exportJobs = new Map();

function jobState(projectId) {
  return exportJobs.get(projectId) || null;
}

function setJob(projectId, patch) {
  const cur = exportJobs.get(projectId) || {};
  const next = Object.assign({}, cur, patch, { updatedAt: Date.now() });
  exportJobs.set(projectId, next);
  return next;
}

module.exports = {
  HW_ENCODERS,
  CPU_ENCODER_CANDIDATES,
  DEFAULT_QUALITY,
  MP4_OK_AUDIO,
  probe,
  resetProbe,
  probeMedia,
  prepareSubtitle,
  injectSacrificialEvent,
  injectSacrificialCue,
  escapeFilterPath,
  findFontsDir,
  buildPlan,
  buildFfmpegCmd,
  buildFilters,
  subFilterOpts,
  validateChain,
  accelInputOpts,
  defaultQualityFor,
  clampQuality,
  pickOutputExt,
  gopForFps,
  humanTime,
  runEncode,
  exportJobs,
  jobState,
  setJob,
  ffmpegVersion,
  listEncoders,
  encoderWorks,
  pickCpuEncoder,
  pickAccel,
  checkTools,
  detectGpus,
  vendorsIn,
};
