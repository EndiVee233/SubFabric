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

/**
 * 导入时该怎么处理包里的 `project.json`：
 * 生成一个新的项目 id / 时间戳，并把"视频待重选"标出来。
 *
 * 为什么要新 id 而不是沿用包里的：同一个包可能被导入多次（或导入到已有同名项目的机器上），
 * 沿用 id 会覆盖已有项目。用户拿到的应该是一份**新副本**。
 */
function remapMeta(meta, newId, nowIso) {
  const m = Object.assign({}, meta || {});
  m.id = newId;
  m.createdAt = nowIso;
  m.modifiedAt = nowIso;
  // 视频与音频都还没生成 —— 导入端选好视频后跑 prepare 补上
  m.video = { path: '', name: (meta && meta.video && meta.video.name) || '' };
  m.prepare = { status: 'none' };
  m.imported = { at: nowIso, from: String((meta && meta.name) || '') };
  /* 逐词高亮色、逐句置信度档位这些**项目级设置原样保留** —— 它们是人做过的选择，
   * 不属于"可从视频重新生成的派生数据"。 */
  return m;
}

module.exports = {
  CORE_FILES, DERIVED_FILES,
  shouldPack, isDerived, validateManifest, remapMeta,
};
