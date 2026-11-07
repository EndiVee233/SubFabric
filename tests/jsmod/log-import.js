/** Log-assisted import plans are read-only. Ambiguous history always requires review. */
import { AssDoc } from './ass.js';

const finite = x => x !== null && x !== '' && Number.isFinite(Number(x));
export const intersects = (a, b) => a.end > b.start + 0.001 && a.start < b.end - 0.001;
export const plainKey = text => String(text || '').replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' ')
  .replace(/^\s*\[[^\]]*\]\s*/, '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const cueKeys = c => (c.lines || [c.zh, c.en, c.l1, c.l2]).filter(Boolean).map(plainKey).filter(Boolean);
function range(a, b) { return finite(a) && finite(b) && Number(a) >= 0 && Number(b) > Number(a) ? { start: Number(a), end: Number(b) } : null; }

export function parseChangeLog(text) {
  if (text.length > 64 * 1024 * 1024) throw Error('操作日志超过 64 MB，请先按时间拆分');
  const source = text.replace(/^\uFEFF/, '').trim();
  let values;
  try { const j = JSON.parse(source); values = Array.isArray(j) ? j : Array.isArray(j.entries) ? j.entries : [j]; }
  catch { values = source.split(/\r?\n/).filter(s => s.trim()).map((s, i) => {
    try { return JSON.parse(s); } catch { throw Error(`操作日志第 ${i + 1} 行不是有效 JSON`); }
  }); }
  if (!values.length) throw Error('操作日志为空');
  let ops = 0;
  const records = values.map((record, i) => {
    const time = record && finite(record.created_ts) ? Number(record.created_ts) * 1000 : Date.parse(record?.t);
    if (!Number.isFinite(time)) throw Error(`操作日志第 ${i + 1} 条缺少有效修改时间`);
    const entries = Array.isArray(record.ops) ? record.ops.slice() : record.ops_truncated ? [] : [record];
    if (record.ops_truncated) entries.push({ op: 'unlocated_history' });
    if (entries.some(op => !op || typeof op !== 'object' || !(op.op || op.action))) throw Error(`操作日志第 ${i + 1} 条缺少操作内容`);
    ops += entries.length;
    return { time, ops: entries };
  });
  if (ops > 200000) throw Error('操作日志超过 200000 个操作，请先按时间拆分');
  return { records, first: records.reduce((n, r) => Math.min(n, r.time), Infinity), last: records.reduce((n, r) => Math.max(n, r.time), -Infinity), ops };
}

function opRange(op) {
  const a = op._affected_range;
  return range(op.new_start ?? a?.start_time ?? op.start ?? op.old_start, op.new_end ?? a?.end_time ?? op.end ?? op.old_end);
}

/** Empty endpoints leave that side unbounded; datetime-local values use the user's local zone. */
export function modificationWindow(start, end) {
  const since = start ? new Date(start).getTime() : -Infinity;
  const until = end ? new Date(end).getTime() : Infinity;
  if ((since !== -Infinity && !Number.isFinite(since)) || (until !== Infinity && !Number.isFinite(until))) {
    throw Error('修改时间格式无效，请重新选择日期和时间');
  }
  if (since >= until) throw Error('修改结束时间必须晚于开始时间');
  return { since, until };
}

/** No UUIDs survive ordinary ASS export. Match final sentences by direct time or role scope,
 * and force review for multi-sentence/unknown scopes; never use mutable file-order indices. */
export function changedCues(cues, log, since = -Infinity, until = Infinity) {
  if ((since !== -Infinity && !Number.isFinite(since)) || (until !== Infinity && !Number.isFinite(until)) || since >= until) {
    throw Error('修改时间范围无效');
  }
  const selected = new Map();
  let operations = 0, unresolved = 0, unmatched = 0, deletions = 0;
  const anchors = new Map();
  // Use the latest location of a stable group, rather than every historical position of a moved line.
  const records = log.records.slice().sort((a, b) => a.time - b.time);
  for (const record of records) for (const op of record.ops) {
    const id = op.group_uuid || op.groupUuid || op.line_uuid || op.lineUuid;
    const globalRole = ['role_color_replace', 'role_rename'].includes(op.op);
    const anchorId = id && !globalRole ? 'id:' + id : 'op:' + anchors.size;
    const inWindow = record.time > since && record.time <= until;
    // Later edits may move a selected sentence. Track its final position without selecting
    // sentences changed only outside the requested window or replaying historical text.
    if (!inWindow && !(record.time > until && id && !globalRole && anchors.has(anchorId))) continue;
    if (inWindow) {
      operations++;
      if ((op.op || op.action) === 'subtitle_delete') deletions++;
    }
    const previous = anchors.get(anchorId)?.previous || new Map();
    const old = range(op.old_start, op.old_end);
    if (old) {
      const key = plainKey(op.old_text || op.old_group);
      previous.set(`${old.start}:${old.end}:${key}`, { ...old, key });
    }
    anchors.set(anchorId, { op, previous });
  }
  const sorted = cues.map((c, index) => ({ c, index })).sort((a, b) => a.c.start - b.c.start);
  const ends = []; for (let i = 0; i < sorted.length; i++) ends[i] = Math.max(ends[i - 1] || 0, sorted[i].c.end);
  function near(rg) {
    let lo = 0, hi = ends.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (ends[mid] <= rg.start + 0.001) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < sorted.length && sorted[i].c.start < rg.end - 0.001; i++) if (intersects(sorted[i].c, rg)) out.push(sorted[i]);
    return out;
  }
  for (const { op, previous } of anchors.values()) {
      const kind = op.op || op.action;
      let hits = [], uncertain = false;
      const rg = opRange(op);
      if (kind === 'role_color_replace' || kind === 'role_rename') {
        const roles = [op.role, op.new_name, op.old_name].filter(Boolean).map(s => String(s).toLowerCase());
        hits = sorted.filter(({ c }) => (c.lines || []).some(text => {
          const name = /^\s*\[([^\]]+)\]/.exec(String(text).replace(/\{[^}]*\}/g, ''));
          return name && roles.includes(name[1].toLowerCase());
        }));
      } else if (rg) {
        hits = near(rg);
        // A single edited word affects its whole sentence; a multi-sentence window is reviewed.
        uncertain = hits.length > 1 || kind === 'subtitle_delete';
        if (!['assign_role', 'replace_dynamic_group', 'text_set', 'subtitle_delete', 'line_insert', 'subtitle_time_adjust'].includes(kind)) uncertain = true;
      } else if (op.scope?.ranges?.length) {
        const indices = new Map();
        for (const r of op.scope.ranges) { const valid = range(r.start, r.end); if (valid) for (const hit of near(valid)) indices.set(hit.index, hit); }
        hits = [...indices.values()];
      } else { unresolved++; continue; }
      if (!hits.length) unmatched++;
      for (const hit of hits) {
        const item = selected.get(hit.index) || { ...hit.c, sourceIndex: hit.index, uncertain: false, previous: [] };
        item.uncertain ||= uncertain;
        item.previous.push(...previous.values());
        selected.set(hit.index, item);
      }
  }
  const items = [...selected.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  // An unlocated operation may affect any selected sentence. Keep the comparison explicit.
  if (unresolved) for (const c of items) c.uncertain = true;
  return { items, operations, unresolved, unmatched, deletions };
}

function textRanges(text) {
  const result = [];
  const token = '(?:\\d+:)?\\d{1,3}:\\d{2}(?:[.,]\\d+)?';
  const seconds = s => s.replace(',', '.').split(':').reduce((n, part) => n * 60 + Number(part), 0);
  for (const m of String(text || '').matchAll(new RegExp('(' + token + ')\\s*[~～→]\\s*(' + token + ')', 'g'))) {
    const r = range(seconds(m[1]), seconds(m[2])); if (r) result.push(r);
  }
  return result;
}

/** Capture location while row numbers still refer to the live edit. Bulk/unknown scopes are global. */
export function captureLogScope(target, detail, why, items) {
  const ranges = textRanges([target, detail, why].join(' '));
  for (const m of String(target || '').matchAll(/第\s*(\d+)\s*条/g)) {
    const item = (items || []).find(r => r.no === Number(m[1]));
    const r = item && range(item.start, item.end); if (r) ranges.push(r);
  }
  const unique = [...new Map(ranges.map(r => [`${r.start}:${r.end}`, r])).values()];
  return { version: 1, global: !unique.length || unique.length > 32, ranges: unique.length > 32 ? [] : unique };
}

export function localProtection(entries) {
  if (!Array.isArray(entries)) throw Error('本稿操作日志格式无效');
  const ranges = []; let unknown = 0;
  for (const e of entries) {
    if (e?.scope?.version === 1) {
      const valid = (e.scope.ranges || []).map(r => range(r.start, r.end)).filter(Boolean);
      if (e.scope.global || !valid.length) unknown++; else ranges.push(...valid);
    } else {
      const valid = textRanges([e?.target, e?.why].join(' '));
      if (valid.length) ranges.push(...valid); else unknown++;
    }
  }
  return { ranges, unknown };
}

/** Connected overlap groups prevent a many-to-one conflict from deleting a kept sentence. */
export function planLogImport(cues, existing, protection) {
  const incoming = cues.map((c, key) => ({ ...c, key }));
  const parent = Array.from({ length: incoming.length + existing.length }, (_, i) => i);
  const root = x => parent[x] === x ? x : (parent[x] = root(parent[x]));
  const join = (a, b) => { parent[root(b)] = root(a); };
  const active = new Set();
  for (let i = 0; i < incoming.length; i++) {
    const c = incoming[i];
    for (let j = 0; j < existing.length; j++) {
      const r = existing[j];
      if (intersects(c, r) || (c.previous || []).some(old => intersects(old, r)
        && (cueKeys(r).includes(old.key) || !intersects(old, c)))) {
        join(i, incoming.length + j); active.add(j);
      }
    }
    for (let j = i + 1; j < incoming.length && incoming[j].start < c.end - 0.001; j++) if (intersects(c, incoming[j])) join(i, j);
  }
  const groups = new Map();
  const group = key => { if (!groups.has(key)) groups.set(key, { incoming: [], current: [] }); return groups.get(key); };
  incoming.forEach((c, i) => group(root(i)).incoming.push(c));
  for (const j of active) group(root(incoming.length + j)).current.push({ ...existing[j], key: j });
  return [...groups.values()].map((g, key) => {
    const protectedHere = protection.unknown > 0 || [...g.incoming, ...g.current].some(c => protection.ranges.some(r => intersects(c, r)));
    const partial = g.current.some(c => {
      let covered = 0, end = c.start;
      for (const r of g.incoming) { const a = Math.max(c.start, r.start, end), b = Math.min(c.end, r.end); if (b > a) covered += b - a; end = Math.max(end, b); }
      return covered < c.end - c.start - 0.03;
    });
    const review = protectedHere || partial || g.incoming.some(c => c.uncertain);
    return { ...g, key, protected: protectedHere, partial, review,
      keepIncoming: new Set(review ? [] : g.incoming.map(c => c.key)),
      keepCurrent: new Set(review ? g.current.map(c => c.key) : []) };
  });
}

export function resolveLogImport(groups) {
  const add = [], remove = [];
  for (const g of groups) {
    add.push(...g.incoming.filter(c => g.keepIncoming.has(c.key)));
    remove.push(...g.current.filter(c => !g.keepCurrent.has(c.key)));
  }
  return { add, remove };
}

/** Copy original ASS events (including k/kf, word gaps, colors, margins and names), not estimates. */
export function attachImportEvents(cues, source) {
  const index = new Map();
  const byLine = new Map(source.events.map(ev => [ev.lineIdx, ev]));
  for (const ev of source.events) { const key = plainKey(ev.text); if (!index.has(key)) index.set(key, []); index.get(key).push(ev); }
  return cues.map(c => {
    const events = new Map();
    for (const line of c.sourceIndices || []) {
      const ev = byLine.get(line);
      if (ev) events.set(ev.lineIdx, { ...ev,
        margins: Object.fromEntries(source.format.map((f, i) => [f, ev._rawParts[i]]).filter(([f]) => f.startsWith('margin'))) });
    }
    if (events.size) return { ...c, importEvents: [...events.values()].sort((a, b) => a.lineIdx - b.lineIdx) };
    for (const key of cueKeys(c)) for (const ev of index.get(key) || []) {
      if (ev.start >= c.start - 0.03 && ev.end <= c.end + 0.03) events.set(ev.lineIdx, {
        ...ev, margins: Object.fromEntries(source.format.map((f, i) => [f, ev._rawParts[i]]).filter(([f]) => f.startsWith('margin'))),
      });
    }
    return { ...c, importEvents: [...events.values()] };
  });
}

export function stageAssLogMerge(doc, removeEvents, add, styles) {
  const live = new Set(doc.events);
  if (removeEvents.some(ev => !live.has(ev))) throw Error('本稿字幕已变化，请重新检查');
  const lines = doc.lines.slice(), seen = new Set(), additions = [];
  for (const ev of removeEvents) lines[ev.lineIdx] = null;
  for (const c of add) {
    if (!c.importEvents?.length) throw Error('导入行缺少原始 ASS 事件，请重新选择 ASS 文件');
    for (const ev of c.importEvents) {
      if (seen.has(ev.lineIdx)) continue; seen.add(ev.lineIdx);
      const style = doc.styleNames.find(s => s.toLowerCase() === ev.style.toLowerCase())
        || (/[\u3400-\u9fff]/.test(plainKey(ev.text)) ? styles.zh : styles.en);
      if (!style) throw Error('本稿缺少对应语言样式，请先配置字幕样式');
      additions.push(doc._buildDialogueLine({ ...ev, style }));
    }
  }
  let at = lines.findIndex(line => /^\s*\[Events\]\s*$/i.test(line || ''));
  if (at < 0) throw Error('本稿缺少 Events 段');
  at++; while (at < lines.length && !/^\s*\[[^\]]+\]/.test(lines[at] || '')) at++;
  const next = new AssDoc([...lines.slice(0, at), ...additions, ...lines.slice(at)].filter(line => line !== null).join('\n'));
  if (next.events.length !== doc.events.length - new Set(removeEvents).size + additions.length) throw Error('合并字幕校验失败，原稿未改动');
  return next;
}
