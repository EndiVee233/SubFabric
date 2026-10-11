/**
 * 本机字体库(服务端)
 *
 * 为什么需要它: libass 跑在 Web Worker 里(wasm), **只认自己 FS 里的字体文件** ——
 * 浏览器里能用的 CSS 字体、系统字体它一律拿不到。而本服务进程就在用户机器上、有磁盘权限,
 * 于是由它把系统字体读出来喂给页面, 用户只要填个字体名即可, 不必手动找 .ttf。
 *
 * 实测结论(2026-10-02, 无头 Edge + libass-wasm):
 *   · .ttf / .otf(含中文名「黑体」这种本地化家族名、含可变字体) → 直接可用
 *   · .ttc 集合字体(微软雅黑 / 宋体 / 微软正黑…) → wasm fontconfig **静默忽略**,
 *     必须先把其中一个 face 抽成独立 sfnt 再喂(本文件 extractFace 干这个)
 *
 * 安全: 对外只按「家族名」查表, 不接受任意路径 —— 见 server.js 的 /api/font-file。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc', '.otc']);

/** 系统字体目录(按平台) */
function fontDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts'));
  }
  return dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

/** 只读文件的一段, 不整份读 —— 397 个字体文件整读要几个 GB */
function readRange(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return n === len ? buf : buf.subarray(0, n);
}

/** UTF-16BE → 字符串。Node 的 Buffer **不支持 'utf16be' 编码**(只有 utf16le),
 *  直接传会抛 "Unknown encoding", 而字体扫描是逐文件 try/catch 的 —— 一个字节序写错
 *  就会让整个索引静默变成 0 条。这里手工换字节序后按 utf16le 解。 */
function utf16be(buf, start, len) {
  const even = len - (len % 2);
  const tmp = Buffer.allocUnsafe(even);
  for (let i = 0; i < even; i += 2) {
    tmp[i] = buf[start + i + 1];
    tmp[i + 1] = buf[start + i];
  }
  return tmp.toString('utf16le');
}

/** 解析 name 表: 收集家族名/全名/PostScript 名(含各语言, 中文名就在里面) */
function parseNameTable(buf) {
  const out = { families: [], fulls: [], postscript: '' };
  if (buf.length < 6) return out;
  const count = buf.readUInt16BE(2);
  const strOff = buf.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platformID = buf.readUInt16BE(r);
    const nameID = buf.readUInt16BE(r + 6);
    const len = buf.readUInt16BE(r + 8);
    const off = buf.readUInt16BE(r + 10);
    if (nameID !== 1 && nameID !== 4 && nameID !== 6) continue;
    // 只认 Windows(3) / Unicode(0) 平台: 都是 UTF-16BE, 不会出乱码
    if (platformID !== 3 && platformID !== 0) continue;
    const start = strOff + off;
    if (start + len > buf.length || len === 0) continue;
    const s = utf16be(buf, start, len).replace(/\0/g, '').trim();
    if (!s) continue;
    if (nameID === 1) { if (!out.families.includes(s)) out.families.push(s); }
    else if (nameID === 4) { if (!out.fulls.includes(s)) out.fulls.push(s); }
    else if (!out.postscript) out.postscript = s;
  }
  return out;
}

/** 读一个 sfnt 目录, 返回 name 表内容 */
function readFaceNames(fd, dirOff) {
  const head = readRange(fd, dirOff, 12);
  if (head.length < 12) return null;
  const numTables = head.readUInt16BE(4);
  if (!numTables || numTables > 512) return null;
  const dir = readRange(fd, dirOff + 12, numTables * 16);
  for (let i = 0; i < numTables; i++) {
    const rec = i * 16;
    if (rec + 16 > dir.length) break;
    if (dir.toString('latin1', rec, rec + 4) !== 'name') continue;
    const off = dir.readUInt32BE(rec + 8);
    const len = dir.readUInt32BE(rec + 12);
    if (!len || len > 8 * 1024 * 1024) return null;
    return parseNameTable(readRange(fd, off, len));
  }
  return null;
}

/** .ttc 的各个 face 在文件里的偏移; 不是集合字体返回 null */
function collectionOffsets(fd) {
  const head = readRange(fd, 0, 12);
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'ttcf') return null;
  const n = head.readUInt32BE(8);
  if (!n || n > 256) return null;
  const table = readRange(fd, 12, n * 4);
  const offs = [];
  for (let i = 0; i < n; i++) {
    if (i * 4 + 4 > table.length) break;
    offs.push(table.readUInt32BE(i * 4));
  }
  return offs.length ? offs : null;
}

/**
 * 把一个 face 从(可能是 .ttc 的)文件里抽成独立 sfnt 字节。
 * 只搬表数据 + 重写表目录偏移, 不重算 checkSum —— FreeType 不校验,
 * 但 head 的 checkSumAdjustment 会因此过期(预览/渲染不受影响)。
 */
function extractFace(buf, dirOff) {
  // 损坏字体的目录/表长度可能离谱(length 可达 4GB) —— 直接 Buffer.alloc / copy 会 OOM 或 RangeError。
  // 只要目录本身越界、或任一表的 offset+length 超出文件范围, 就整体判定"该 face 不可用"(返回 null),
  // 由调用方决定怎么处理: readFontBytes 抛错、--dump 报错退出。buildIndex 只读 name 表, 不受影响。
  if (!(dirOff >= 0) || dirOff + 12 > buf.length) return null;
  const numTables = buf.readUInt16BE(dirOff + 4);
  if (!numTables || numTables > 512 || dirOff + 12 + numTables * 16 > buf.length) return null;
  const recs = [];
  for (let i = 0; i < numTables; i++) {
    const rec = dirOff + 12 + i * 16;
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset > buf.length || offset + length > buf.length) return null;
    recs.push({
      tag: buf.toString('latin1', rec, rec + 4),
      checkSum: buf.readUInt32BE(rec + 4),
      offset,
      length
    });
  }
  let cursor = 12 + numTables * 16;
  for (const r of recs) {
    r.newOffset = cursor;
    cursor += r.length;
    if (cursor % 4) cursor += 4 - (cursor % 4);
  }
  const out = Buffer.alloc(cursor);
  buf.copy(out, 0, dirOff, dirOff + 4);            // sfntVersion(0x00010000 / 'OTTO')
  out.writeUInt16BE(numTables, 4);
  const pow2 = Math.floor(Math.log2(numTables));
  out.writeUInt16BE(16 * (2 ** pow2), 6);          // searchRange
  out.writeUInt16BE(pow2, 8);                      // entrySelector
  out.writeUInt16BE(numTables * 16 - 16 * (2 ** pow2), 10); // rangeShift
  recs.forEach((r, i) => {
    const rec = 12 + i * 16;
    out.write(r.tag, rec, 4, 'latin1');
    out.writeUInt32BE(r.checkSum, rec + 4);
    out.writeUInt32BE(r.newOffset, rec + 8);
    out.writeUInt32BE(r.length, rec + 12);
    buf.copy(out, r.newOffset, r.offset, r.offset + r.length);
  });
  return out;
}

let _index = null;   // [{ file, face, families, fulls, postscript }]

function buildIndex() {
  const entries = [];
  for (const dir of fontDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      const ext = path.extname(name).toLowerCase();
      if (!FONT_EXTS.has(ext)) continue;
      const file = path.join(dir, name);
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const offs = collectionOffsets(fd) || [0];
        offs.forEach((dirOff, face) => {
          const names = readFaceNames(fd, dirOff);
          if (!names || (!names.families.length && !names.fulls.length)) return;
          entries.push({ file, face, ...names });
        });
      } catch { /* 个别字体读不了就跳过 */ }
      finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
    }
  }
  return entries;
}

function index() {
  if (!_index) _index = buildIndex();
  return _index;
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * 按用户填的字体名找字体。命中优先级: 家族名(含中文名) > 全名 > PostScript 名;
 * 同优先级下"名字完全相等"优先于"包含"。
 */
function findFont(name) {
  const key = norm(name);
  if (!key) return null;
  const all = index();
  let best = null, bestRank = 99;
  for (const e of all) {
    const cands = [
      ...e.families.map(v => [v, 0]),
      ...e.fulls.map(v => [v, 1]),
      e.postscript ? [e.postscript, 2] : null
    ].filter(Boolean);
    for (const [value, kind] of cands) {
      const v = norm(value);
      if (v === key) { const rank = kind; if (rank < bestRank) { bestRank = rank; best = e; } }
      else if (bestRank > 5 && v.includes(key) && v.length <= key.length + 8) {
        if (5 < bestRank) { bestRank = 5; best = e; }
      }
    }
  }
  return best;
}

/** 取字体的可喂给 libass 的字节(集合字体自动抽 face) */
function readFontBytes(entry) {
  const buf = fs.readFileSync(entry.file);
  if (entry.face === 0 && buf.length >= 4 && buf.toString('latin1', 0, 4) !== 'ttcf') return buf;
  const offs = collectionOffsets2(buf);
  const dirOff = offs && offs[entry.face] != null ? offs[entry.face] : 0;
  const out = extractFace(buf, dirOff);
  if (!out) throw new Error('字体 face 不可用（表偏移/长度越界）: ' + path.basename(entry.file));
  return out;
}

function collectionOffsets2(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'ttcf') return null;
  const n = buf.readUInt32BE(8);
  const offs = [];
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 4;
    if (p + 4 > buf.length) break;
    offs.push(buf.readUInt32BE(p));
  }
  return offs.length ? offs : null;
}

/** 给前端的字体清单(按家族名去重, 便于做下拉候选) */
function listFonts() {
  const seen = new Map();
  for (const e of index()) {
    for (const fam of (e.families.length ? e.families : e.fulls)) {
      const k = norm(fam);
      if (!seen.has(k)) seen.set(k, { family: fam, faces: 0, file: path.basename(e.file), collection: e.face > 0 || path.extname(e.file).toLowerCase() === '.ttc' });
      seen.get(k).faces++;
    }
  }
  return [...seen.values()].sort((a, b) => a.family.localeCompare(b.family, 'zh-Hans-CN'));
}

module.exports = { fontDirs, listFonts, findFont, readFontBytes, buildIndex, extractFace, collectionOffsets2 };

/* CLI: node editor/fonts.js --list | --dump <字体文件> <face> <输出路径> */
if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === '--list') {
    const list = listFonts();
    console.log('共 ' + list.length + ' 个家族');
    list.slice(0, 40).forEach(f => console.log('  ' + f.family + (f.collection ? '  [集合]' : '')));
  } else if (cmd === '--dump') {
    const face = Number(b) || 0;
    const buf = fs.readFileSync(a);
    const offs = collectionOffsets2(buf);
    const dirOff = offs && offs[face] != null ? offs[face] : 0;
    const out = extractFace(buf, dirOff);
    if (!out) { console.error('该 face 不可用（表偏移/长度越界）: ' + a); process.exit(1); }
    fs.writeFileSync(c, out);
    console.log('已导出 face ' + face + ': ' + c + ' (' + out.length + ' 字节)');
  } else {
    console.log('用法: node editor/fonts.js --list | --dump <字体文件> <face> <输出路径>');
  }
}
