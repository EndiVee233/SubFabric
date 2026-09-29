/* LLM 分角色（功能 B 的纯逻辑, CJS, 不依赖网络/服务端）
 *
 * 两步:
 *   ① 阵容推断: 用视频标题/简介/UP/标签 让 LLM 判断"可能出现哪些人物、有几个"
 *      → 用这个人数作为说话人分离的 SPK 数（diarize.py 的 num_clusters）
 *   ② SPK → 角色名: 把每个 SPK 的台词样本 + 阵容喂给 LLM, 判断 SPK 对应哪个角色
 *      → 把 SPKn 换成真实角色名; **没映射上的保留 SPKn**（识别出的说话人比角色多时就是这种）
 *
 * 设计原则:
 *   · 所有解析都容错（思维链/```围栏/寒暄/数组或对象/别名写法）
 *   · 任何一步失败都只是"没做成", 绝不打断初稿流水线（返回 error, 调用方照常往下走）
 *   · LLM 调用由调用方注入（call(messages) → 文本）, 因此整个流程可以离线用假 LLM 测
 *   · 提示词也在这里（改文案不用动服务端）
 */
'use strict';

const llmText = require('./llm-text.js');

const MAX_SPEAKERS = 12;          // 与 UI/后端的 1~12 一致
const CAST_MAX = 12;

/* ─────────── 通用: 从文本里取第一个完整闭合的 JSON 对象 ─────────── */
function extractJsonObject(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 文本 → 对象。先剥思维链, 再剥 ```围栏, 再平衡扫描; 失败返回 null。 */
function parseJsonObject(text) {
  const cleaned = llmText.stripReasoning(text);
  if (!cleaned) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  const body = fence ? fence[1].trim() : cleaned;
  const cand = extractJsonObject(body) || extractJsonObject(cleaned);
  if (!cand) return null;
  try {
    const v = JSON.parse(cand);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/* ─────────── ① 阵容推断 ─────────── */
const CAST_SYSTEM = [
  '你在帮一个字幕工具判断视频里会出现哪些"说话的角色"。',
  '只看用户给的视频信息（标题、简介、UP 主、标签），推断视频里可能开口说话的人物。',
  '',
  '要求：',
  '1) 只输出一个 JSON 对象，不要解释、不要 Markdown 围栏，形如',
  '   {"characters":[{"name":"角色名","aliases":["别名"],"evidence":"依据"}]}',
  '2) 人物的粒度按"说话人"算：同一个人不同称呼算一个（写进 aliases）；只被提到但不会说话的人不要。',
  '3) name 用视频里最常用的叫法（中文视频用中文名，英文视频用英文名）；游戏/影视按角色名，',
  '   真人视频按人名或称呼（如"主持人"、"旁白"）。',
  '4) 判断不了就少写：宁可 1~2 个有把握的，也不要凑数。最多 12 个。',
  '5) 简介或标题为空时，只能根据标题里的线索给最少的人物（通常 1~2 个）。',
].join('\n');

/** 视频信息 → LLM 输入文本（也给测试用） */
function sourceBrief(source) {
  const s = source || {};
  const lines = [];
  const put = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') lines.push(k + '：' + String(v).trim()); };
  put('标题', s.title);
  put('UP 主/频道', s.uploader);
  put('时长', s.duration ? (Math.round(Number(s.duration)) + ' 秒') : '');
  put('标签', Array.isArray(s.tags) ? s.tags.slice(0, 20).join('、') : s.tags);
  const desc = String(s.description || '').trim();
  if (desc) lines.push('简介：\n' + desc.slice(0, 2000));
  return lines.join('\n');
}

function castMessages(source) {
  const brief = sourceBrief(source);
  return [
    { role: 'system', content: CAST_SYSTEM },
    { role: 'user', content: (brief ? brief + '\n\n' : '（没有任何视频信息）\n\n') + '请给出这个视频里可能出现的人物列表。' },
  ];
}

/** 清洗一个角色项 → {name, aliases, evidence} 或 null */
function normalizeCharacter(raw) {
  let name = '', aliases = [], evidence = '';
  if (typeof raw === 'string') name = raw;
  else if (raw && typeof raw === 'object') {
    name = raw.name || raw.character || raw.role || raw.speaker || raw['角色'] || raw['人物'] || '';
    const al = raw.aliases || raw.alias || raw.aka || raw['别名'] || [];
    aliases = Array.isArray(al) ? al : String(al || '').split(/[、,，/]/);
    evidence = raw.evidence || raw.reason || raw['依据'] || '';
  }
  name = String(name || '').trim().replace(/^\[|\]$/g, '').replace(/\s{2,}/g, ' ');
  if (!name) return null;
  if (name.length > 40) name = name.slice(0, 40);
  // "未知/不确定/无法判断" 这类占位不算角色
  if (/^(未知|不确定|无法判断|无法确定|unknown|n\/?a|none|待定|\?+)$/i.test(name)) return null;
  aliases = (aliases || [])
    .map((x) => String(x || '').trim())
    .filter((x) => x && x !== name && x.length <= 40)
    .slice(0, 6);
  return { name, aliases, evidence: String(evidence || '').trim().slice(0, 200) };
}

/** LLM 回复 → {characters, error}（永不抛） */
function parseCastReply(text) {
  const obj = parseJsonObject(text);
  let list = null;
  if (obj) {
    for (const k of ['characters', 'roles', 'people', 'speakers', 'cast', '人物', '角色']) {
      if (Array.isArray(obj[k])) { list = obj[k]; break; }
    }
    if (!list && Array.isArray(obj.list)) list = obj.list;
    if (!list) {
      // {"SPK1": "名字"} 这类写法也接受
      const vals = Object.keys(obj).filter((k) => typeof obj[k] === 'string' && /^spk/i.test(k));
      if (vals.length) list = vals.map((k) => ({ name: obj[k] }));
    }
  }
  if (!list) {
    const arr = llmText.parseJsonArray(text);
    if (Array.isArray(arr)) list = arr;
  }
  if (!Array.isArray(list)) return { characters: [], error: '没能从模型回复里读到人物列表' };

  const out = [], seen = new Set();
  for (const raw of list) {
    const c = normalizeCharacter(raw);
    if (!c) continue;
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= CAST_MAX) break;
  }
  if (!out.length) return { characters: [], error: '模型给出的人物列表是空的' };
  return { characters: out, error: '' };
}

/** 阵容 → SPK 数（钳在 1~12） */
function speakerCountFromCast(characters, fallback) {
  const n = Array.isArray(characters) ? characters.length : 0;
  if (!n) return Math.max(0, Math.min(MAX_SPEAKERS, parseInt(fallback, 10) || 0));
  return Math.max(1, Math.min(MAX_SPEAKERS, n));
}

/* ─────────── ② SPK → 角色名 ─────────── */
const MAP_SYSTEM = [
  '你在帮一个字幕工具把"说话人编号"对应到真实角色名。',
  '工具已经按角色数量做了说话人分离，得到 SPK1、SPK2…；每个 SPK 的台词样本会给你。',
  '',
  '要求：',
  '1) 只输出一个 JSON 对象，不要解释、不要 Markdown 围栏，形如',
  '   {"mapping":{"SPK1":"角色名","SPK2":"角色名"}}',
  '2) 角色名必须从"候选角色"里选；实在判断不出某个 SPK 是谁，就把它写成 null 或干脆不写。',
  '3) 可能出现"一个角色的台词被拆成两个 SPK"：那就把两个 SPK 都映射到这个角色名。',
  '4) 说话人可能比候选角色多（背景音、群杂、串音）：多出来的保持 null，不要硬套。',
  '5) 只看台词内容与称呼线索（谁叫谁的名字、自我介绍、语气），不要编造。',
].join('\n');

/** 按 SPK 采样台词（给 LLM 看的样本, 受字数预算约束） */
function sampleBySpeaker(segments, opts) {
  const o = opts || {};
  const maxPerSpeaker = o.maxPerSpeaker || 8;
  const perLineChars = o.perLineChars || 60;
  const totalChars = o.totalChars || 3600;
  const bySpk = new Map();
  const list = Array.isArray(segments) ? segments : [];
  for (const s of list) {
    if (s == null || s.speaker == null) continue;
    const key = 'SPK' + (Number(s.speaker) + 1);
    let e = bySpk.get(key);
    if (!e) { e = { key, lines: [], seconds: 0, first: null, count: 0 }; bySpk.set(key, e); }
    e.count++;
    const dur = Math.max(0, Number(s.end) - Number(s.start)) || 0;
    e.seconds += dur;
    if (e.first == null || Number(s.start) < e.first) e.first = Number(s.start);
    const t = String(s.text || '').trim().replace(/\s+/g, ' ');
    if (t && e.lines.length < maxPerSpeaker) {
      e.lines.push(t.length > perLineChars ? t.slice(0, perLineChars) + '…' : t);
    }
  }
  // 人数多时按字数预算裁：优先保留说话时间长的 SPK
  const keys = Array.from(bySpk.keys()).sort((a, b) => bySpk.get(b).seconds - bySpk.get(a).seconds);
  let used = 0;
  const out = {};
  for (const k of keys) {
    const e = bySpk.get(k);
    const picked = [];
    for (const line of e.lines) {
      if (used + line.length > totalChars) break;
      picked.push(line);
      used += line.length;
    }
    out[k] = {
      samples: picked,
      lines: e.count,
      seconds: Math.round(e.seconds * 10) / 10,
      firstAt: e.first == null ? null : Math.round(e.first * 10) / 10,
    };
  }
  return out;
}

/** 素材 → LLM 输入 */
function mapMessages(source, characters, samples) {
  const cast = (characters || []).map((c) => c.name + (c.aliases && c.aliases.length ? '（别名：' + c.aliases.join('、') + '）' : ''));
  const keys = Object.keys(samples || {});
  const body = keys.map((k) => {
    const e = samples[k];
    const head = k + '：约 ' + e.lines + ' 句 / 说话 ' + e.seconds + ' 秒 / 首次出现 ' + (e.firstAt == null ? '?' : e.firstAt + 's');
    const lines = e.samples.length ? e.samples.map((x) => '  · ' + x).join('\n') : '  ·（没有可用的台词样本）';
    return head + '\n' + lines;
  }).join('\n');
  return [
    { role: 'system', content: MAP_SYSTEM },
    {
      role: 'user',
      content: [
        '【视频信息】',
        sourceBrief(source) || '（无）',
        '',
        '【候选角色】' + (cast.length ? cast.join('、') : '（无，可根据台词自行判断）'),
        '',
        '【说话人与其台词样本】',
        body || '（无）',
        '',
        '请给出 mapping：把每个判断得出的 SPK 映射到角色名，判断不出的写 null。',
      ].join('\n'),
    },
  ];
}

/** LLM 回复 → {map, extra, unlisted, error}（永不抛；map 的键只保留合法的 SPKn） */
function parseMapReply(text, spkKeys, castNames) {
  const valid = new Set((spkKeys || []).map((k) => String(k).toUpperCase()));
  const known = new Set((castNames || []).map((n) => String(n || '').toLowerCase()));
  const obj = parseJsonObject(text);
  let pairs = [];
  let rawList = null;

  if (obj) {
    for (const k of ['mapping', 'map', 'speakers', 'spk', 'assignments', '对应', '映射']) {
      const v = obj[k];
      if (Array.isArray(v)) { rawList = v; break; }
      if (v && typeof v === 'object') {
        pairs = Object.keys(v).map((kk) => [kk, v[kk]]);
        break;
      }
    }
    if (!pairs.length && !rawList) {
      // 顶层直接就是 {SPK1: "名字"}
      const ks = Object.keys(obj).filter((k) => /^(spk\s*)?\d+$/i.test(k.trim()));   // SPK1 / spk 1 / 1 都认
      if (ks.length) pairs = ks.map((k) => [k, obj[k]]);
    }
  }
  if (!pairs.length && !rawList) {
    const arr = llmText.parseJsonArray(text);
    if (Array.isArray(arr)) {
      rawList = arr.every((x) => Array.isArray(x)) ? arr.map((p) => ({ spk: p[0], name: p[1] })) : arr;
    }
  }
  if (rawList) {
    for (const it of rawList) {
      if (Array.isArray(it)) { pairs.push([it[0], it[1]]); continue; }
      if (it && typeof it === 'object') {
        const k = it.spk || it.speaker || it.key || it.id || it['说话人'] || '';
        const v = it.name || it.character || it.role || it.value || it['角色'] || null;
        pairs.push([k, v]);
      }
    }
  }
  if (!pairs.length) return { map: {}, extra: [], unlisted: [], error: '没能从模型回复里读到 SPK 对应关系' };

  const map = {}, unlisted = [];
  for (const p of pairs) {
    let k = String(p[0] == null ? '' : p[0]).trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d+$/.test(k)) k = 'SPK' + k;                       // "1" → "SPK1"
    if (!valid.has(k)) continue;                              // 不认识/多余的键丢掉
    const v = p[1];
    if (v === null || v === undefined) continue;              // 明确 null = 不映射（保留 SPKn）
    const name = String(v).trim().replace(/^\[|\]$/g, '');
    if (!name || /^(null|none|未知|不确定|无法判断|unknown)$/i.test(name)) continue;
    map[k] = name.slice(0, 40);
    if (known.size && !known.has(name.toLowerCase())) unlisted.push(k + '→' + name);
  }
  const keys = (spkKeys || []).map((k) => String(k).toUpperCase());
  const extra = keys.filter((k) => !map[k]);
  return { map, extra, unlisted, error: '' };
}

/* ─────────── 两步（流水线在说话人分离前后各调一次） ─────────── */

/** ① 阵容推断: 视频信息 → {characters, speakerCount}（分离**之前**用, 决定 SPK 数） */
async function inferCast(p) {
  const o = p || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const userCount = Math.max(0, Math.min(MAX_SPEAKERS, parseInt(o.userCount, 10) || 0));
  const out = { usedLlm: false, characters: [], speakerCount: userCount, error: '' };
  if (typeof o.call !== 'function') { out.error = '没有可用的模型调用'; return out; }
  if (!sourceBrief(o.source)) { out.error = '没有视频信息（标题/简介），跳过阵容推断'; return out; }

  out.usedLlm = true;
  let reply = '';
  try {
    reply = await o.call(castMessages(o.source));
  } catch (e) {
    out.error = '推断人物失败: ' + ((e && e.message) || e);
    return out;
  }
  const parsed = parseCastReply(reply);
  if (!parsed.characters.length) {
    out.error = parsed.error || '没推断出人物';
    return out;
  }
  out.characters = parsed.characters;
  out.speakerCount = speakerCountFromCast(parsed.characters, userCount);
  log('推断出 ' + parsed.characters.length + ' 个人物: ' + parsed.characters.map((c) => c.name).join('、')
    + '（说话人分离按 ' + out.speakerCount + ' 人）');
  return out;
}

/** ② SPK → 角色名（分离**之后**用, segments 里已经有 speaker） */
async function mapSpeakers(p) {
  const o = p || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const out = { map: {}, extra: [], unlisted: [], usedLlm: false, error: '' };
  const characters = Array.isArray(o.characters) ? o.characters : [];
  if (typeof o.call !== 'function') { out.error = '没有可用的模型调用'; return out; }
  if (!characters.length) { out.error = '没有候选角色，跳过角色对应'; return out; }

  const samples = sampleBySpeaker(o.segments, o.sampleOpts);
  const keys = Object.keys(samples);
  if (!keys.length) { out.error = '没有可用的说话人样本'; return out; }

  out.usedLlm = true;
  let reply = '';
  try {
    reply = await o.call(mapMessages(o.source, characters, samples));
  } catch (e) {
    out.error = '对应角色失败: ' + ((e && e.message) || e);
    return out;
  }
  const parsed = parseMapReply(reply, keys, characters.map((c) => c.name));
  if (parsed.error) { out.error = parsed.error; return out; }
  out.map = parsed.map;
  out.extra = parsed.extra;
  out.unlisted = parsed.unlisted;
  log('角色对应: ' + (Object.keys(parsed.map).length
    ? Object.keys(parsed.map).map((k) => k + '→' + parsed.map[k]).join('、')
    : '（没有可确定的对应）')
    + (parsed.extra.length ? '；保留编号: ' + parsed.extra.join('、') : ''));
  return out;
}

/** 便捷入口: 两步一起跑（离线测试与「重新分角色」用） */
async function runCastFlow(p) {
  const o = p || {};
  const out = { usedLlm: false, cast: { characters: [] }, map: {}, extra: [], speakerCount: 0, error: '' };
  const a = await inferCast(o);
  out.usedLlm = a.usedLlm || out.usedLlm;
  out.cast = { characters: a.characters };
  out.speakerCount = a.speakerCount;
  if (!a.characters.length) { out.error = a.error; return out; }
  const b = await mapSpeakers({ source: o.source, characters: a.characters, segments: o.segments, call: o.call, log: o.log, sampleOpts: o.sampleOpts });
  out.usedLlm = b.usedLlm || out.usedLlm;
  out.map = b.map;
  out.extra = b.extra;
  out.error = b.error;
  return out;
}

/** SPKn → 显示名（没映射上就返回 SPKn —— 识别出的说话人比角色多时就是这种） */
function roleNameFor(map, n) {
  const key = 'SPK' + Number(n);
  const v = map && map[key];
  return (typeof v === 'string' && v.trim()) ? v.trim() : key;
}

module.exports = {
  MAX_SPEAKERS,
  extractJsonObject, parseJsonObject,
  sourceBrief, castMessages, parseCastReply, speakerCountFromCast, normalizeCharacter,
  mapMessages, sampleBySpeaker, parseMapReply,
  inferCast, mapSpeakers, runCastFlow, roleNameFor,
};
