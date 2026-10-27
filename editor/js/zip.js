/* 最小 ZIP 读写（store 模式，无第三方依赖）。
 *
 * 主题包导出需要把 theme.json 与四份页面布局 JSON 放进一个压缩包。浏览器端没有
 * 原生 zip API，这里实现 ZIP 的 store 子集：
 *   · 每个文件 method=0（不压缩）—— 主题包只有几十 KB，压缩收益有限；
 *   · UTF-8 文件名（general purpose flag bit 11）；
 *   · 写 local header + central directory + EOCD；
 *   · 读时只接受本应用写出的 store 条目，遇到 deflate 等外部压缩明确报错。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, day };
}
function u16(v) { const b = new Uint8Array(2); b[0] = v & 255; b[1] = (v >>> 8) & 255; return b; }
function u32(v) { const b = new Uint8Array(4); b[0] = v & 255; b[1] = (v >>> 8) & 255; b[2] = (v >>> 16) & 255; b[3] = (v >>> 24) & 255; return b; }
function viewU16(b, o) { return b[o] | (b[o + 1] << 8); }
function viewU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * 生成 ZIP Blob。
 * @param {{name:string,text?:string,bytes?:Uint8Array|ArrayBuffer}[]} files
 * @returns {Blob}
 */
export function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());
  for (const file of files) {
    const name = String(file.name || '').replace(/\\/g, '/');
    if (!name || name.split('/').some(p => p === '..' || p === '.')) throw new Error('ZIP 文件名无效');
    const nameBytes = enc.encode(name);
    const data = file.bytes instanceof Uint8Array ? file.bytes
      : file.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes)
        : enc.encode(String(file.text == null ? '' : file.text));
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data,
    ]);
    locals.push(local);
    centrals.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const central = concat(centrals);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return new Blob([concat([...locals, central, end])], { type: 'application/zip' });
}

/**
 * 读取本应用生成的 ZIP。返回 Map<文件名, Uint8Array>。
 * @param {ArrayBuffer} buffer
 */
export function readZip(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (b.length < 22) throw new Error('不是有效的压缩包');
  let end = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 0xffff; i--) {
    if (viewU32(b, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('不是有效的 ZIP（缺少目录结尾）');
  const count = viewU16(b, end + 10);
  const cdOffset = viewU32(b, end + 16);
  if (cdOffset >= b.length) throw new Error('ZIP 目录偏移无效');
  const files = new Map();
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (viewU32(b, at) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const method = viewU16(b, at + 10);
    const compSize = viewU32(b, at + 20);
    const nameLen = viewU16(b, at + 28);
    const extraLen = viewU16(b, at + 30);
    const commentLen = viewU16(b, at + 32);
    const localOffset = viewU32(b, at + 42);
    const name = dec.decode(b.subarray(at + 46, at + 46 + nameLen));
    if (method !== 0) throw new Error(`压缩包里的 ${name} 使用了不支持的压缩方式；请用本应用重新导出`);
    if (localOffset + 30 > b.length || viewU32(b, localOffset) !== 0x04034b50) throw new Error('ZIP 文件头损坏');
    const localNameLen = viewU16(b, localOffset + 26);
    const localExtraLen = viewU16(b, localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + compSize > b.length) throw new Error('ZIP 文件内容越界');
    files.set(name, b.slice(start, start + compSize));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export function textOf(bytes) {
  return dec.decode(bytes);
}
