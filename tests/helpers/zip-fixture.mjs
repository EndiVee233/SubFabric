import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const { crcChunk } = createRequire(import.meta.url)('../../editor/project-pack.js');
export function zipFixture(files) {
  const locals = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), body = Buffer.from(f.body || ''), compressed = zlib.deflateRawSync(body);
    const crc = (crcChunk(0xffffffff, body) ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.declaredBytes ?? body.length, 22); local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(f.declaredBytes ?? body.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(f.attr ?? 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(c, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
