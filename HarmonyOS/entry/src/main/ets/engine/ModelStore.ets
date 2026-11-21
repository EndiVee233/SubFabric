/*
 * 内置模型：清单、完整性校验、从 HAP 解包。
 *
 * ============================ 为什么需要这个文件 ============================
 *
 * Parakeet TDT 0.6B 的编码器是 622 MB，无法「顺手」放进代码里，但它可以随
 * HAP 一起分发：hvigor 会把 `entry/src/main/resources/rawfile/` 下的所有文件
 * **原样打包进 HAP**。于是流程是：
 *
 *   rawfile/parakeet/encoder.ms   （在 HAP 内，只读）
 *        │  首次运行，流式拷贝
 *        ▼
 *   files/subfabric/models/parakeet/encoder.ms  （可写，MindSpore Lite 从这加载）
 *
 * ===================== 两个必须注意的技术点（已核实） =====================
 *
 * 1. **不能用 `getRawFileContent`。** 它会把整个文件读进 `Uint8Array`，
 *    622 MB 直接 OOM。必须用 `getRawFd`，它返回
 *    `RawFileDescriptor { fd, offset, length }` —— `fd` 指向**整个 HAP**，
 *    rawfile 的数据从 `offset` 开始、共 `length` 字节。
 *
 * 2. **不能用 `fileIo.copyFileSync` 拷 fd。** 那样会把整个 HAP 复制出来。
 *    必须自己按 `descriptor.length` 精确分块读写。
 *    另外 `ReadOptions.offset` 的语义是「当前文件指针 + offset」，
 *    不是绝对位置；这里采用**顺序读**（分块直到读满 length），最不容易错。
 *
 * ============================ 完整性校验 ============================
 *
 * 解包完必须校验 SHA-256，否则半途中断会留下一个「大小对但内容坏」的模型，
 * 而 MindSpore Lite 对这种模型的报错通常毫无指向性。校验失败的产物会被删除，
 * 下次启动重新解包。
 *
 * 清单写在 `rawfile/parakeet/manifest.json`，由 tools/embed_model.py 生成。
 */

import { resourceManager } from '@kit.LocalizationKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { Logger } from '../engine/Logger';

const TAG = 'EmbeddedModel';

/** rawfile 里的模型目录。 */
export const EMBEDDED_DIR: string = 'parakeet';

/** 单个内置文件。 */
export class EmbeddedFile {
  /** 在 rawfile/parakeet/ 下的相对名，例如 encoder.ms。 */
  name: string = '';
  /** 字节数（用于快速比对与进度显示）。 */
  size: number = 0;
  /** 小写十六进制 SHA-256；为空表示跳过校验。 */
  sha256: string = '';

  constructor(name: string = '', size: number = 0, sha256: string = '') {
    this.name = name;
    this.size = size;
    this.sha256 = sha256;
  }
}

/** 清单。 */
export class EmbeddedManifest {
  /** 模型标识，便于将来支持多个模型。 */
  model: string = '';
  /** 引擎类型：'tdt' 或 'ctc'。 */
  engine: string = 'tdt';
  /** mel 特征维度（0.6B v2 是 128）。 */
  melBins: number = 128;
  files: EmbeddedFile[] = [];

  /** 总字节数，用于提示用户剩余空间。 */
  get totalBytes(): number {
    let sum = 0;
    for (let i = 0; i < this.files.length; i++) {
      sum += this.files[i].size;
    }
    return sum;
  }
}

/** 解包结果。 */
export class UnpackResult {
  /** 是否全部就绪（含校验通过）。 */
  ok: boolean = false;
  /** 本次是否真的做了拷贝（false 表示命中缓存）。 */
  copied: boolean = false;
  /** 可读描述。 */
  message: string = '';
}

/** 进度回调：(已拷贝字节, 总字节, 当前文件名)。 */
export type UnpackProgress = (done: number, total: number, current: string) => void;

/**
 * 读取内置清单。
 * @returns 没有内置模型时返回 null（这是正常情况，不报错）
 */
export async function readManifest(mgr: resourceManager.ResourceManager): Promise<EmbeddedManifest | null> {
  const path = `${EMBEDDED_DIR}/manifest.json`;
  try {
    const bytes = await mgr.getRawFileContent(path);
    // 注意：util.TextDecoder 的 decodeWithStream 已废弃，用 decodeToString。
    const text = new util.TextDecoder('utf-8').decodeToString(bytes);
    const raw = JSON.parse(text) as Record<string, Object>;
    const m = new EmbeddedManifest();
    m.model = String(raw['model'] ?? '');
    m.engine = String(raw['engine'] ?? 'tdt');
    m.melBins = Number(raw['melBins'] ?? 128);
    // JSON.parse returns plain objects, so normalize file entries before using
    // their numeric fields and the manifest getter.
    const files = raw['files'] as Object[];
    m.files = files.map((item: Object): EmbeddedFile => {
      const file = item as Record<string, Object>;
      return new EmbeddedFile(String(file['name']), Number(file['size']),
        String(file['sha256'] ?? ''));
    });
    if (m === null || m.files === undefined || m.files.length === 0) {
      Logger.warn(TAG, '内置清单为空，视为没有内置模型');
      return null;
    }
    Logger.info(TAG, `发现内置模型 ${m.model}（${m.files.length} 个文件，`
      + `${(m.totalBytes / 1048576).toFixed(1)} MB，engine=${m.engine}，melBins=${m.melBins}）`);
    return m;
  } catch (err) {
    // 没有内置模型时这里必然失败（rawfile 不存在），属预期路径。
    Logger.info(TAG, '未发现内置模型（rawfile 里没有 manifest.json）');
    return null;
  }
}

/**
 * 确保内置模型已解包到目标目录。
 *
 * 幂等：已经解包且校验通过的文件不会被重复拷贝。
 *
 * @param mgr 资源管理器
 * @param manifest 清单
 * @param targetDir 目标目录（通常是 files/subfabric/models/parakeet）
 */
export async function ensureUnpacked(mgr: resourceManager.ResourceManager,
                                    manifest: EmbeddedManifest,
                                    targetDir: string,
                                    onProgress?: UnpackProgress): Promise<UnpackResult> {
  const result = new UnpackResult();
  const total = manifest.totalBytes;
  let done = 0;

  // 目录准备
  try {
    if (!fs.accessSync(targetDir)) {
      fs.mkdirSync(targetDir, true);
    }
  } catch (err) {
    result.message = `无法创建模型目录：${targetDir}`;
    Logger.error(TAG, result.message);
    return result;
  }

  for (let i = 0; i < manifest.files.length; i++) {
    const file = manifest.files[i];
    const dest = `${targetDir}/${file.name}`;

    // 命中缓存：大小一致且校验通过
    if (fs.accessSync(dest)) {
      const cached = fs.statSync(dest).size;
      if (cached === file.size) {
        if (file.sha256.length === 0 || await sha256OfFile(dest) === file.sha256) {
          done += file.size;
          if (onProgress) {
            onProgress(done, total, file.name);
          }
          Logger.info(TAG, `复用已解包文件 ${file.name}`);
          continue;
        }
      }
      // 大小或内容不对，删掉重来
      Logger.warn(TAG, `${file.name} 校验不通过，重新解包`);
      try {
        fs.unlinkSync(dest);
      } catch (err) {
        Logger.warn(TAG, `删除损坏文件失败：${dest}`);
      }
    }

    if (onProgress) {
      onProgress(done, total, file.name);
    }
    const copied = await copyRawFile(mgr, `${EMBEDDED_DIR}/${file.name}`, dest,
      file.size, (n: number): void => {
        if (onProgress) {
          onProgress(done + n, total, file.name);
        }
      });
    if (!copied) {
      result.message = `解包 ${file.name} 失败`;
      Logger.error(TAG, result.message);
      return result;
    }

    // 校验
    if (file.sha256.length > 0) {
      const actual = await sha256OfFile(dest);
      if (actual !== file.sha256) {
        try {
          fs.unlinkSync(dest);
        } catch (err) {
          // 忽略
        }
        result.message = `${file.name} 校验失败（期望 ${file.sha256.substring(0, 12)}…，`
          + `实际 ${actual.substring(0, 12)}…）`;
        Logger.error(TAG, result.message);
        return result;
      }
    }

    done += file.size;
    if (onProgress) {
      onProgress(done, total, file.name);
    }
    Logger.info(TAG, `已解包 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）`);
  }

  result.ok = true;
  result.copied = true;
  result.message = `内置模型就绪（${(total / 1048576).toFixed(1)} MB）`;
  return result;
}

/**
 * 把 rawfile 里的一个文件流式拷贝到目标路径。
 *
 * 用 `getRawFd` 拿到 HAP 内的 fd，按 `descriptor.length` 顺序分块读写。
 * 注意**不要**用 `copyFileSync`：fd 指向整个 HAP，会把整个包复制出来。
 */
async function copyRawFile(mgr: resourceManager.ResourceManager, rawPath: string,
                           destPath: string, expectedSize: number,
                           onBytes?: (copied: number) => void): Promise<boolean> {
  let desc: resourceManager.RawFileDescriptor | null = null;
  let dst: fs.File | null = null;
  try {
    desc = await mgr.getRawFd(rawPath);
    // RawFileDescriptor points into the HAP container. Always seek to the
    // resource offset before the first chunk, especially for resources above
    // the 1 GB boundary.
    fs.lseek(desc.fd, desc.offset, fs.WhenceType.SEEK_SET);
    dst = fs.openSync(destPath,
      fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);

    const CHUNK = 4 * 1024 * 1024;   // 4 MB 一块
    let remaining = desc.length > 0 ? desc.length : expectedSize;
    let copied = 0;

    while (remaining > 0) {
      const want = remaining < CHUNK ? remaining : CHUNK;
      const buf = new ArrayBuffer(want);
      // 顺序读：上面已把文件指针定位到 rawfile 起点。
      const read = fs.readSync(desc.fd, buf);
      if (read <= 0) {
        Logger.error(TAG, `读取 rawfile 提前结束（已读 ${copied}，还需 ${remaining}）`);
        return false;
      }
      fs.writeSync(dst.fd, buf, { length: read });
      copied += read;
      remaining -= read;
      if (onBytes) {
        onBytes(copied);
      }
    }
    return true;
  } catch (err) {
    const e = err as Error;
    Logger.error(TAG, `拷贝 ${rawPath} 失败：${e.message}`);
    return false;
  } finally {
    if (dst !== null) {
      fs.closeSync(dst);
    }
    if (desc !== null) {
      // 官方要求用完必须关闭，避免 fd 泄漏
      try {
        await mgr.closeRawFd(rawPath);
      } catch (err) {
        Logger.warn(TAG, `关闭 rawfile fd 失败：${rawPath}`);
      }
    }
  }
}

/** 计算文件的 SHA-256（小写十六进制）。 */
export async function sha256OfFile(path: string): Promise<string> {
  const md = cryptoFramework.createMd('SHA256');
  let file: fs.File | null = null;
  try {
    file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    const CHUNK = 4 * 1024 * 1024;
    for (;;) {
      const buf = new ArrayBuffer(CHUNK);
      const read = fs.readSync(file.fd, buf);
      if (read <= 0) {
        break;
      }
      const slice = read === CHUNK ? buf : buf.slice(0, read);
      const blob: cryptoFramework.DataBlob = { data: new Uint8Array(slice) };
      await md.update(blob);
      if (read < CHUNK) {
        break;
      }
    }
    const out: cryptoFramework.DataBlob = await md.digest();
    return toHex(out.data);
  } catch (err) {
    const e = err as Error;
    Logger.error(TAG, `计算 SHA-256 失败：${e.message}`);
    return '';
  } finally {
    if (file !== null) {
      fs.closeSync(file);
    }
  }
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    s += h.length === 1 ? `0${h}` : h;
  }
  return s;
}
