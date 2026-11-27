'use strict';

const { randomUUID } = require('node:crypto');
const { AssDoc } = require('./js/ass.js');
const {
  analyzeKaraoke, pairRows, editAnchorSentence, editWordSentence, retimeAssRow,
  moveAssWordBoundary, rebuildAssWordEvents
} = require('./js/karaoke.js');
const { parseSRT, serializeSRT, editSrtCue } = require('./js/srt.js');

const LEASE_MS = 15_000;
const MAX_RECEIPTS = 10_000;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 359_999.99;
const ASS_EVENT_COLUMNS = new Set(['layer', 'start', 'end', 'style', 'name',
  'marginl', 'marginr', 'marginv', 'effect', 'text']);
const validText = value => typeof value === 'string' && value.length <= 16_384 && !value.includes('\0');
const validTime = value => Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS;

function normalizeSubtitle(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function readDocument(format, text) {
  if (format === 'srt') return { rows: parseSRT(text), doc: null, wordStyle: null };
  const doc = new AssDoc(text);
  const { sentences, wordStyle } = analyzeKaraoke(doc);
  return { rows: pairRows(sentences, wordStyle), doc, wordStyle };
}

function eventLineMap(doc) {
  const map = new Map();
  let line = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.lines[i] !== null) map.set(i, line++);
  }
  return map;
}

function rowEventLines(row, lineMap) {
  const side = sentence => sentence ? sentence.events.map(ev => lineMap.get(ev.lineIdx)).sort((a, b) => a - b) : [];
  return { zh: side(row.zh), en: side(row.en) };
}

function rowKey(row, lineMap) {
  const { zh, en } = rowEventLines(row, lineMap);
  return JSON.stringify([zh, en]);
}

function describeRow(format, row, entry) {
  const { id, version } = entry;
  const { start, end } = row;
  if (format === 'srt') return { id, version, start, end, text: row.lines.join('\n') };
  const words = (row.en?.words || []).map(({ w, s, e }) => ({ text: w, start: s, end: e }));
  return { id, version, start, end, zh: row.zh?.text ?? null, en: row.en?.text ?? null, words };
}

function applyEdit(format, document, row, command) {
  const { doc, wordStyle } = document;
  if (command.op === 'time') {
    const { start, end } = command;
    const precision = format === 'ass' ? 100 : 1000;
    if (!validTime(start) || !validTime(end) || Math.round(end * precision) <= Math.round(start * precision)) return false;
    if (format === 'srt') editSrtCue(row, start, end);
    else retimeAssRow(doc, row, start, end);
    return true;
  }
  if (command.op === 'text') {
    const { text, side } = command;
    if (!validText(text)) return false;
    if (format === 'srt') {
      if (side !== undefined || !text.trim() || /\r?\n[^\S\r\n]*\r?\n/.test(text)) return false;
      editSrtCue(row, row.start, row.end, text);
    } else {
      if (!['zh', 'en'].includes(side) || !row[side] || /[\r\n]/.test(text)) return false;
      if (row[side].text === text) return true;
      if (side === 'zh') editAnchorSentence(doc, row.zh, row.zh.start, row.zh.end, text);
      else editWordSentence(doc, wordStyle, row.en, row.en.start, row.en.end, text);
    }
    return true;
  }
  if (command.op === 'word' && format === 'ass') {
    const { index, edge, time } = command;
    if (!Number.isInteger(index) || index < 0 || !['word-start', 'word-end'].includes(edge) || !validTime(time)) return false;
    if (!moveAssWordBoundary(doc, row, index, time, edge)) return false;
    rebuildAssWordEvents(doc, row.en);
    return true;
  }
  return false;
}

/**
 * 字幕会话的权威状态。调用方负责鉴权、排队、广播和文件替换。
 * persist 必须同步比较原文，内容有变时原子替换。在比较或写入失败时抛错。
 */
function createCollabSession({ format, text, persist, now = Date.now }) {
  if (!['ass', 'srt'].includes(format)) throw new TypeError('Unsupported subtitle format');
  if (typeof persist !== 'function') throw new TypeError('Missing subtitle persistence');
  const initial = readDocument(format, text);
  const { doc } = initial;
  if (!initial.rows.length || initial.rows.some(row => !validTime(row.start) || !validTime(row.end) || row.end <= row.start)) {
    throw new Error('No unambiguous editable cues');
  }
  if (format === 'ass') {
    const eventSections = normalizeSubtitle(text).split(/^\s*\[Events\]\s*$/gim);
    const eventSource = eventSections[1]?.split(/^[ \t]*\[/m, 1)[0] || '';
    if (eventSections.length !== 2 || (eventSource.match(/^\s*Format\s*:/gim) || []).length !== 1 ||
        doc.format.at(-1) !== 'text' || !['start', 'end', 'style'].every(name => doc.format.includes(name)) ||
        doc.format.some(name => !ASS_EVENT_COLUMNS.has(name)) || new Set(doc.format).size !== doc.format.length) {
      throw new Error('Unsupported ASS event format');
    }
    const events = initial.rows.flatMap(row => [...(row.zh?.events || []), ...(row.en?.events || [])]);
    if (new Set(events).size !== doc.events.length || events.length !== doc.events.length ||
        doc.lines.filter(line => /^\s*Dialogue\s*:/i.test(line)).length !== doc.events.length) {
      throw new Error('Unmapped subtitle events');
    }
  } else {
    const normalized = content => normalizeSubtitle(content).trimEnd();
    if (normalized(serializeSRT(initial.rows)) !== normalized(text)) throw new Error('SRT cannot round trip without changes');
  }

  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const separator = text.includes('\r\n') ? '\r\n' : '\n';
  const sessionId = randomUUID();
  let revision = 0;
  let entries = initial.rows.map((_, i) => ({ id: String(i + 1), version: 0 }));
  const leases = new Map();
  const receipts = new Map();
  let receiptBytes = 0;

  function snapshot() {
    const view = readDocument(format, text);
    const lines = view.doc ? eventLineMap(view.doc) : null;
    return {
      sessionId, revision, format, text,
      entries: view.rows.map((row, i) => {
        const result = describeRow(format, row, entries[i]);
        if (lines) result.eventLines = rowEventLines(row, lines);
        return result;
      })
    };
  }

  function lock(memberId, entryId, token) {
    if (!entries.some(entry => entry.id === entryId)) return { ok: false, reason: 'gone' };
    const lease = leases.get(entryId);
    const instant = now();
    const active = lease && lease.until > instant;
    if (token != null && (!active || lease.memberId !== memberId || lease.token !== token)) {
      return { ok: false, reason: 'expired' };
    }
    if (active && lease.memberId !== memberId) return { ok: false, reason: 'locked' };
    const next = { memberId, token: active ? lease.token : randomUUID(), until: instant + LEASE_MS };
    leases.set(entryId, next);
    return { ok: true, token: next.token, until: next.until };
  }

  function release(memberId, entryId, token) {
    const lease = leases.get(entryId);
    if (lease && lease.token === token && lease.memberId === memberId) leases.delete(entryId);
  }

  function releaseMember(memberId) {
    for (const [entryId, lease] of leases) {
      if (lease.memberId === memberId) leases.delete(entryId);
    }
  }

  function receipt(memberId, requestId) {
    const record = receipts.get(JSON.stringify([memberId, requestId]));
    return record ? structuredClone(record.result) : null;
  }

  function submit(memberId, command) {
    if (command?.sessionId !== sessionId || typeof command.requestId !== 'string' || !/^[\w-]{1,80}$/.test(command.requestId)) {
      return { ok: false, reason: 'invalid_request' };
    }
    const key = JSON.stringify([memberId, command.requestId]);
    const args = JSON.stringify([command.entryId, command.version, command.token, command.op, command.side,
      command.text, command.start, command.end, command.index, command.edge, command.time]);
    const receipt = receipts.get(key);
    if (receipt) return receipt.args === args ? structuredClone(receipt.result) : { ok: false, reason: 'request_reused' };
    if (receipts.size >= MAX_RECEIPTS) return { ok: false, reason: 'session_limit' };

    const index = entries.findIndex(entry => entry.id === command.entryId);
    if (index < 0) return { ok: false, reason: 'gone' };
    const lease = leases.get(command.entryId);
    if (!lease || lease.memberId !== memberId || lease.token !== command.token || lease.until <= now()) {
      return { ok: false, reason: 'expired' };
    }
    const document = readDocument(format, text);
    const row = document.rows[index];
    const entry = entries[index];
    if (entry.version !== command.version) return { ok: false, reason: 'conflict', current: describeRow(format, row, entry) };
    if (!applyEdit(format, document, row, command)) return { ok: false, reason: 'invalid_edit' };

    const ordered = document.rows.map((source, i) => ({ source, entry: entries[i] }));
    if (format === 'srt') ordered.sort((a, b) => a.source.start - b.source.start || a.source.end - b.source.end);
    const raw = format === 'ass' ? document.doc.serialize() : serializeSRT(ordered.map(x => x.source));
    const nextText = bom + normalizeSubtitle(raw).replace(/\n/g, separator);

    const reparsed = readDocument(format, nextText);
    let mapped;
    if (format === 'ass') {
      const newLines = eventLineMap(document.doc);
      const byKey = new Map(ordered.map(x => [rowKey(x.source, newLines), x.entry]));
      const reparsedLines = eventLineMap(reparsed.doc);
      mapped = reparsed.rows.map(source => byKey.get(rowKey(source, reparsedLines)));
    } else {
      mapped = ordered.map(x => x.entry);
      if (serializeSRT(reparsed.rows) !== serializeSRT(ordered.map(x => x.source))) {
        return { ok: false, reason: 'unstable_mapping' };
      }
    }
    if (mapped.length !== entries.length || mapped.some(value => !value) || new Set(mapped).size !== entries.length) {
      return { ok: false, reason: 'unstable_mapping' };
    }

    const unchanged = nextText === text;
    const nextRevision = revision + (unchanged ? 0 : 1);
    const updated = unchanged ? entry : { id: entry.id, version: nextRevision };
    const result = {
      ok: true, revision: nextRevision, requestId: command.requestId,
      entry: describeRow(format, reparsed.rows[mapped.indexOf(entry)], updated)
    };
    if (unchanged) result.unchanged = true;
    const size = Buffer.byteLength(key) + Buffer.byteLength(args) + Buffer.byteLength(JSON.stringify(result));
    if (receiptBytes + size > MAX_RECEIPT_BYTES) return { ok: false, reason: 'session_limit' };

    try {
      persist({ expected: text, text: nextText });
    } catch {
      return { ok: false, reason: 'save_failed' };
    }
    if (!unchanged) {
      text = nextText;
      revision = nextRevision;
      entries = mapped.map(value => value === entry ? updated : value);
    }
    receipts.set(key, { args, result });
    receiptBytes += size;
    return structuredClone(result);
  }

  return { sessionId, snapshot, lock, release, releaseMember, receipt, submit };
}

module.exports = { createCollabSession };
