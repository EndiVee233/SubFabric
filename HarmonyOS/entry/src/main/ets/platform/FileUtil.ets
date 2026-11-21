/*
 * 文件读写与路径工具。
 *
 * 统一用 `@kit.CoreFileKit` 的 fileIo。所有可能失败的操作都返回明确结果，
 * 避免把异常抛到 ArkUI 渲染路径上。
 */

import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { Logger } from '../engine/Logger';

const TAG = 'FileUtil';

/** 读取整个文本文件（UTF-8）。失败时抛错，由调用方决定如何提示。 */
export function readTextFile(path: string): string {
  const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
  try {
    const stat = fs.statSync(path);
    const buf = new ArrayBuffer(stat.size);
    const read = fs.readSync(file.fd, buf);
    const bytes = new Uint8Array(buf, 0, read);
    // 系统 TextDecoder 走原生解码；自定义逐字节解码在 8 MB ASS 上会阻塞数秒。
    try {
      return util.TextDecoder.create('utf-8').decodeToString(bytes);
    } catch (err) {
      return decodeUtf8(bytes);
    }
  } finally {
    fs.closeSync(file);
  }
}

/** 写入文本文件（UTF-8，覆盖）。 */
export function writeTextFile(path: string, text: string): void {
  const file = fs.openSync(path,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  try {
    fs.writeSync(file.fd, encodeUtf8(text));
  } finally {
    fs.closeSync(file);
  }
}

/**
 * 原子写文本文件：先写 .tmp、fsync，再 rename 覆盖。
 * 项目 cues.json 有几千条，直接 TRUNC 写入时若进程被杀会留下空/半截文件。
 */
export function writeTextFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  const file = fs.openSync(tmp,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  try {
    fs.writeSync(file.fd, encodeUtf8(text));
    fs.fsyncSync(file.fd);
  } finally {
    fs.closeSync(file);
  }
  try {
    fs.renameSync(tmp, path);
  } catch (err) {
    // 某些文件系统不允许 rename 覆盖：先删旧文件再改名。
    try {
      fs.unlinkSync(path);
    } catch (ignore) {
      // 目标不存在时忽略
    }
    fs.renameSync(tmp, path);
  }
}

/** 文件是否存在。 */
export function fileExists(path: string): boolean {
  try {
    return fs.accessSync(path);
  } catch (err) {
    return false;
  }
}

/** 文件大小（字节）；不存在返回 0。 */
export function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch (err) {
    return 0;
  }
}

export function ensureDir(path: string): void {
  try {
    if (!fileExists(path)) {
      fs.mkdirSync(path, true);
    }
  } catch (err) {
    const e = err as Error;
    Logger.warn(TAG, `创建目录失败 ${path}：${e.message}`);
  }
}

export function deleteFile(path: string): boolean {
  try {
    fs.unlinkSync(path);
    return true;
  } catch (err) {
    return false;
  }
}

/** 列出目录下的文件名。 */
export function listDir(path: string): string[] {
  try {
    return fs.listFileSync(path);
  } catch (err) {
    return [];
  }
}

/** 递归删除目录（包括子目录与文件）。不存在时返回 true。 */
export function deleteTree(path: string): boolean {
  if (!fileExists(path)) {
    return true;
  }
  try {
    const names: string[] = fs.listFileSync(path);
    for (let i = 0; i < names.length; i++) {
      const child: string = `${path}/${names[i]}`;
      if (fs.statSync(child).isDirectory()) {
        if (!deleteTree(child)) {
          return false;
        }
      } else {
        fs.unlinkSync(child);
      }
    }
    fs.rmdirSync(path);
    return true;
  } catch (err) {
    const e = err as Error;
    Logger.warn(TAG, `删除目录失败 ${path}：${e.message}`);
    return false;
  }
}

/** 应用的 files 目录（模型与项目数据的根）。 */
export function filesDir(context: common.UIAbilityContext): string {
  return context.filesDir;
}

/** 应用缓存目录（中间产物，可被系统清理）。 */
export function cacheDir(context: common.UIAbilityContext): string {
  return context.cacheDir;
}

/** 把用户的 picker URI 复制进应用沙箱，返回沙箱内路径。 */
export async function importToSandbox(context: common.UIAbilityContext, uri: string,
                                     destName: string): Promise<string> {
  const destDir = `${context.filesDir}/media`;
  ensureDir(destDir);
  const dest = `${destDir}/${destName}`;
  const src = fs.openSync(uri, fs.OpenMode.READ_ONLY);
  const dst = fs.openSync(dest,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  try {
    fs.copyFileSync(src.fd, dst.fd);
  } finally {
    fs.closeSync(src);
    fs.closeSync(dst);
  }
  Logger.info(TAG, `媒体已导入沙箱：${dest}（${fileSize(dest)} 字节）`);
  return dest;
}

// ---------------------------------------------------------------- UTF-8

/** 极简 UTF-8 解码（避免依赖 util.TextDecoder 的可用性差异）。 */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    let cp = 0;
    let extra = 0;
    if (b0 < 0x80) {
      cp = b0;
      extra = 0;
    } else if ((b0 & 0xE0) === 0xC0) {
      cp = b0 & 0x1F;
      extra = 1;
    } else if ((b0 & 0xF0) === 0xE0) {
      cp = b0 & 0x0F;
      extra = 2;
    } else if ((b0 & 0xF8) === 0xF0) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      // 非法起始字节，跳过。
      i++;
      continue;
    }
    if (i + extra >= n) {
      break;
    }
    let ok = true;
    for (let k = 1; k <= extra; k++) {
      const bk = bytes[i + k];
      if ((bk & 0xC0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bk & 0x3F);
    }
    if (ok) {
      out += String.fromCodePoint(cp);
      i += extra + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** 极简 UTF-8 编码。 */
export function encodeUtf8(text: string): ArrayBuffer {
  const bytes: number[] = [];
  for (let idx = 0; idx < text.length; idx++) {
    let cp = text.codePointAt(idx) ?? 0;
    if (cp > 0xFFFF) {
      idx++;   // 代理对占两个 UTF-16 单元
    }
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
        0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  return new Uint8Array(bytes).buffer;
}

/** 生成安全的文件名（去掉路径分隔符等）。 */
export function safeFileName(name: string, fallback: string = 'file'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}
