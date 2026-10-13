/**
 * 项目压缩包：导出 / 导入时的**文件分类与校验**（纯逻辑，不碰文件系统）。
 *
 * 为什么要分类而不是"整个目录打包"：
 *   · `audio.wav` 是**从视频现场抽出来的** 16kHz 单声道音频，一个 40 分钟的视频就是
 *     40~80 MB。它完全可以从视频重新生成，没有任何不可复制的信息 ——
 *     打进包里只会让"分享一个稿件"变成"传一个几百兆的东西"。
 *   · `peaks.bin` 波形包络同理，是 audio.wav 的派生数据。
 *   · 视频本体更不该进包（版权 + 体积，用户自己也说了"不包括视频本体"）。
 *   所以：**只带"人做出来的东西"**（字幕/译文/逐词时间/备注/操作日志），
 *   媒体相关的（视频/音频/波形）留给导入端从视频重新生成。
 *
 * 这个模块只回答"哪些文件该进包、哪些该被拒"，读写文件由调用方做。
 */

/** 要进包的文件（核心内容；缺了不报错，只是不写进去）。 */
const CORE_FILES = [
  'project.json',      // 项目元信息（名称/时长/来源/逐句置信度档位等）
  'subtitle.ass',      // 字幕（ASS，含逐词特效）
  'subtitle.srt',      // 字幕（SRT，二选一存在）
  'asr.json',          // 识别结果（含逐词时间轴 + 逐句置信度）
  'reseg.json',        // 语义分句
  'translation.json',  // 译文
  'notes.json',        // 备注
  'oplog.json',        // 用户操作日志（谁改了什么、为什么）
  'draft.log',         // 建稿流水线日志
];
const PACK_LIMITS = { entries: 128, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, directoryBytes: 256 * 1024 };
function zipManifest(directory, count, archiveBytes, directoryOffset, limits = PACK_LIMITS) {
  if (count > limits.entries || directory.length > limits.directoryBytes) throw new Error('项目包文件数量或目录超过上限');
  const entries = [], seen = new Set(); let at = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error('项目包目录损坏');
    const flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10);
    const compressed = directory.readUInt32LE(at + 20), bytes = directory.readUInt32LE(at + 24);
    const length = directory.readUInt16LE(at + 28), extra = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32);
    const offset = directory.readUInt32LE(at + 42), attr = directory.readUInt32LE(at + 38);
    if (at + 46 + length + extra + comment > directory.length || directory.readUInt16LE(at + 34)) throw new Error('项目包分卷或目录无效');
    const name = directory.subarray(at + 46, at + 46 + length).toString('utf8');
    if (!name || name.includes('\\') || name.includes('\0') || name.includes(':') || name.startsWith('/')
      || name.split('/').some(n => n === '.' || n === '..' || /[. ]$/.test(n)) || name.split('/').filter(Boolean).length > 2) throw new Error('项目包路径不合法');
    const key = name.toLowerCase(); if (seen.has(key)) throw new Error('项目包存在重复路径'); seen.add(key);
    if (flags & 1 || ![0, 8].includes(method) || ((attr >>> 16) & 0xf000) === 0xa000 || attr & 0x400) throw new Error('项目包包含加密、链接或不支持的文件');
    total += bytes;
    if (bytes > limits.fileBytes || total > limits.totalBytes || offset + 30 + compressed > directoryOffset || directoryOffset > archiveBytes) throw new Error('项目包解压大小或文件范围超过上限');
    entries.push({ name, bytes, compressed, offset, flags, method, crc: directory.readUInt32LE(at + 16), directory: name.endsWith('/') });
    at += 46 + length + extra + comment;
  }
  if (at !== directory.length) throw new Error('项目包目录尾部异常');
  const files = entries.filter(e => !e.directory);
  const wrapped = files.some(e => e.name.includes('/'));
  const wrapper = wrapped ? files[0].name.split('/')[0] : '';
  if (wrapped && files.some(e => e.name.split('/').length !== 2 || !e.name.startsWith(wrapper + '/'))) throw new Error('项目包外层目录结构不一致');
  const selected = files.map(e => ({ ...e, file: wrapped ? e.name.slice(wrapper.length + 1) : e.name })).filter(e => shouldPack(e.file));
  const manifest = validateManifest(selected.map(e => e.file));
  if (!manifest.ok) throw new Error(manifest.error);
  return { entries: selected, manifest };
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crcChunk(crc, bytes) { for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8); return crc >>> 0; }

/**
 * 派生/媒体文件：**不进包**，导入端从视频重新生成。
 * 单独列出来是为了能在导入时**主动拒绝**包里的这些文件 ——
 * 万一有人手工塞了 audio.wav 进包，不该拿它当权威数据（可能是别的视频的音频）。
 */
const DERIVED_FILES = ['audio.wav', 'peaks.bin', 'peaks.pcm', 'video.mp4', 'video.mkv', 'video.webm'];

/** 一律忽略的临时/锁文件 */
const JUNK_RE = /(\.tmp$|\.lock$|~$|^\.)/i;

/** 这个文件名该进包吗？ */
function shouldPack(name) {
  const n = String(name || '');
  if (!n) return false;
  if (JUNK_RE.test(n)) return false;
  if (DERIVED_FILES.includes(n)) return false;
  return CORE_FILES.includes(n);
}

/** 是不是派生文件（导入时要拒绝的） */
function isDerived(name) {
  return DERIVED_FILES.includes(String(name || ''));
}

/**
 * 校验一个"包内容清单"是否像个项目包。
 * @param {string[]} names 包内文件名（相对路径）
 * @returns {{ ok:boolean, error:string, present:string[], missing:string[] }}
 */
function validateManifest(names) {
  const list = (Array.isArray(names) ? names : [])
    .map(n => String(n || '').replace(/\\/g, '/').replace(/^\.\//, ''))
    // 只认顶层的核心文件（不递归 —— 项目目录本来就是平的）
    .filter(n => !n.includes('/'));
  const present = CORE_FILES.filter(f => list.includes(f));
  const missing = CORE_FILES.filter(f => !list.includes(f));
  if (!present.length) {
    return {
      ok: false, present, missing,
      error: '这不是 SubFabric 项目包：里面没有任何已知的项目文件'
        + `（应有 ${CORE_FILES.slice(0, 3).join(' / ')} 之一）`,
    };
  }
  // 至少要有一份字幕，否则导入出来是个空项目
  if (!present.includes('subtitle.ass') && !present.includes('subtitle.srt')) {
    return { ok: false, present, missing, error: '包里没有字幕文件（subtitle.ass / subtitle.srt）' };
  }
  return { ok: true, error: '', present, missing };
}

/** 项目目录内允许出现的**字幕文件名**白名单。
 *  为什么必须白名单：project.json 来自**别人给的项目包**，其中 subtitle.file
 *  会被 `path.join(projDir(id), ...)` 直接使用 —— 放行 "../../asr/settings.json"
 *  就等于允许写到项目目录之外（2026-10-11 实测可复现的任意文件写入）。 */
const SUBTITLE_FILES = ['subtitle.ass', 'subtitle.srt'];
/** 音频提取模式的合法取值（与 server.js startPrepare 的取值一致） */
const AUDIO_MODES = ['raw', 'denoise'];

/** 从任意输入取一个**项目内合法文件名**：不含路径分隔符、不含 ..、且在白名单里。
 *  取不到返回 null（调用方按"没有这个文件"处理）。 */
function safeInnerFile(v, allowed) {
  const n = String(v == null ? '' : v).replace(/\\/g, '/').trim();
  if (!n || n.includes('/') || n.includes('..') || n.length > 64) return null;
  return allowed.includes(n) ? n : null;
}

/**
 * 导入时该怎么处理包里的 `project.json`：
 * 生成一个新的项目 id / 时间戳，并把"视频待重选"标出来。
 *
 * ⚠ **按白名单重建，不再整体拷贝**。旧实现是 `Object.assign({}, meta)` 再覆写几个字段，
 *    于是包里 project.json 的 `subtitle.file`（以及 audio.file / peaks.file）被**原样留下**，
 *    随后字幕保存接口 `path.join(projDir(id), meta.subtitle.file)` 就把请求体写到了
 *    项目目录之外 —— 实测可复现的任意文件写入（第三轮审查 新-1，2026-10-11）。
 *    现在只搬运**已知且安全**的字段，路径类字段一律过白名单，未知字段一律丢弃。
 *
 * 为什么要新 id 而不是沿用包里的：同一个包可能被导入多次（或导入到已有同名项目的机器上），
 * 沿用 id 会覆盖已有项目。用户拿到的应该是一份**新副本**。
 */
function remapMeta(meta, newId, nowIso) {
  const src = (meta && typeof meta === 'object') ? meta : {};
  const m = {
    id: newId,
    name: String(src.name || '').slice(0, 200),
    nameCustomized: !!src.nameCustomized,
    createdAt: nowIso,
    modifiedAt: nowIso,
    // 视频与音频都还没生成 —— 导入端选好视频后跑 prepare 补上
    video: { path: '', name: String((src.video && src.video.name) || '').slice(0, 260) },
    prepare: { status: 'none' },
    imported: { at: nowIso, from: String(src.name || '').slice(0, 200) },
  };
  // 字幕文件：只接受项目目录内的合法文件名（越界 / 未知名一律忽略）
  const sub = (src.subtitle && typeof src.subtitle === 'object') ? src.subtitle : {};
  const sf = safeInnerFile(sub.file, SUBTITLE_FILES);
  if (sf) m.subtitle = { format: sf.endsWith('.srt') ? 'srt' : 'ass', file: sf, name: sf };

  /* 逐词高亮色、卡拉OK 形态、音频提取模式这些**项目级设置原样保留** ——
   * 它们是人做过的选择，不属于"可从视频重新生成的派生数据"。（都不是路径字段） */
  if (src.kar && typeof src.kar === 'object' && typeof src.kar.wordStyle === 'string') {
    m.kar = { wordStyle: src.kar.wordStyle.slice(0, 120) };
  }
  if (src.audio && typeof src.audio === 'object' && AUDIO_MODES.includes(src.audio.mode)) {
    m.audio = { mode: src.audio.mode };      // 只带"选择"，不带 file（audio.wav 不在包里）
  }
  if (src.region && typeof src.region === 'object') {
    const rs = Number(src.region.start);
    const re = src.region.end == null ? null : Number(src.region.end);
    if (Number.isFinite(rs) && rs >= 0 && (re === null || (Number.isFinite(re) && re > rs))) {
      m.region = { start: rs, end: re, importedAt: nowIso };
    }
  }
  if (src.autoPost) m.autoPost = true;

  /* ⚠ 有意**不带过来**的字段（不是遗漏）：
   *   peaks —— 派生数据（波形包络），导入端从视频重建；且 peaks.file 同样是路径字段
   *   draft —— 别的机器上的流水线中间态，带过来只会显示成"正在识别"
   *   source—— 下载来源元信息，与导入的稿子无关
   *   其余未知字段一律丢弃 —— 这正是本函数存在的意义：不信任包里的 project.json。 */
  return m;
}

module.exports = {
  PACK_LIMITS, zipManifest, crcChunk,
  CORE_FILES, DERIVED_FILES, SUBTITLE_FILES, AUDIO_MODES,
  shouldPack, isDerived, validateManifest, remapMeta, safeInnerFile,
};
