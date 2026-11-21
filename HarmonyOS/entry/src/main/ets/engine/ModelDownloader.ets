/*
 * 应用内下载模型并部署到沙箱。
 *
 * ============================ 为什么需要这个 ============================
 *
 * Parakeet 0.6B 的 int8 模型约 656 MB。另外两条路各有问题：
 *
 *   - **内置进 HAP**：安装包 656 MB，安装/更新极慢，商店分发不友好，
 *     解包后设备上还会同时占两份（HAP 内只读 + 解包后）。
 *   - **手工 hdc 推送**：只有开发者能装，普通用户装完用不了。
 *
 * 应用内下载避开了两者的缺点：包体保持几百 KB，模型按需拉取，
 * 且能断点续传、校验完整性。
 *
 * ===================== 三个必须做对的技术点 =====================
 *
 * 1. **必须用 `requestInStream`，不能用 `request`。**
 *    `request` 会把整个响应读进内存（`HttpResponse.result`），
 *    622 MB 的 encoder 直接 OOM。流式接口通过 `on("dataReceive")`
 *    分块回调 `ArrayBuffer`，边收边写盘，内存占用恒定。
 *
 * 2. **断点续传用 `Range` 头；但没有 RangeResponse 可选，必须自己兜底。**
 *    续传时发 `Range: bytes=N-`。若服务端不支持，它会返回 200 并从 0 重发。
 *    `requestInStream` 没有 HTTP 响应头级别的成功/失败区分，只能靠
 *    「累计收到的字节数等于剩余长度」推断。**推断出被忽略时必须先
 *    `truncate(0)` 再写**，否则完整文件会被追加到半截文件后面 ——
 *    得到一个「长度正确但内容全错」的产物，而它在设备上表现为
 *    「识别结果全空」，极难定位。
 *
 * 3. **下载目标必须是 `.part` 临时文件，校验通过才改名。**
 *    否则一次中断就会留下一个看起来完整、实际损坏的模型。
 *
 * ============================ 远端清单格式 ============================
 *
 * 在服务器上放一个 JSON（`manifestUrl` 指向它）：
 *
 * ```json
 * {
 *   "version": "1",
 *   "model": "parakeet-tdt-0.6b-v2-int8",
 *   "engine": "tdt",
 *   "melBins": 128,
 *   "baseUrl": "https://example.com/parakeet/",
 *   "files": [
 *     { "name": "encoder.ms",       "size": 652214272, "sha256": "…" },
 *     { "name": "decoder_joint.ms", "size": 35651584,  "sha256": "…" },
 *     { "name": "vocab.txt",        "size": 9384,      "sha256": "…" }
 *   ]
 * }
 * ```
 *
 * `baseUrl` 缺省时取 manifestUrl 所在目录。文件地址 = baseUrl + 文件名。
 * 生成清单（含 SHA-256）：在 PC 上 `sha256sum encoder.ms decoder_joint.ms vocab.txt`。
 *
 * ⚠️ 服务端需要支持 **Range 请求** 才能续传。GitHub Releases、
 * 对象存储（OBS/S3/OSS）默认支持；nginx 需要 `Accept-Ranges: bytes`。
 */

import { http } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Logger } from './Logger';
import { sha256OfFile } from './ModelStore';

const TAG = 'ModelDownloader';

/** 写盘时的 fsync 间隔：字节数 / 毫秒，先到者触发。 */
const FS_SYNC_EVERY_BYTES: number = 16 * 1024 * 1024;
const FS_SYNC_EVERY_MS: number = 3000;
/** 速度统计窗口。 */
const SPEED_WINDOW_MS: number = 500;

// ---------------------------------------------------------------- 数据结构

/** 远端清单里的一个文件。 */
export class RemoteFile {
  name: string = '';
  size: number = 0;
  /** 小写十六进制 SHA-256；空字符串表示跳过校验（不建议）。 */
  sha256: string = '';

  constructor(name: string = '', size: number = 0, sha256: string = '') {
    this.name = name;
    this.size = size;
    this.sha256 = sha256;
  }
}

/** 远端清单。 */
export class RemoteManifest {
  version: string = '';
  model: string = '';
  engine: string = 'tdt';
  melBins: number = 128;
  /** 文件下载基地址；为空时取 manifest 所在目录。 */
  baseUrl: string = '';
  files: RemoteFile[] = [];

  get totalBytes(): number {
    let sum = 0;
    for (let i = 0; i < this.files.length; i++) {
      sum += this.files[i].size;
    }
    return sum;
  }

  /** 把相对文件名解析成完整 URL。 */
  urlOf(name: string): string {
    const base = this.baseUrl.length > 0 ? this.baseUrl : '';
    if (base.length === 0) {
      return name;
    }
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
  }
}

/** 下载阶段。 */
export class DownloadStage {
  static readonly CHECKING: string = 'checking';
  static readonly DOWNLOADING: string = 'downloading';
  static readonly VERIFYING: string = 'verifying';
  static readonly DONE: string = 'done';
  static readonly CANCELLED: string = 'cancelled';
  static readonly FAILED: string = 'failed';
}

/** 下载进度。 */
export class DownloadProgress {
  stage: string = DownloadStage.CHECKING;
  /** 当前文件名。 */
  file: string = '';
  /** 整体已下载字节（跨文件累计）。 */
  doneBytes: number = 0;
  /** 整体总字节。 */
  totalBytes: number = 0;
  /** 当前速度（字节/秒），滑动窗口平滑。 */
  speedBps: number = 0;
  message: string = '';

  get ratio(): number {
    if (this.totalBytes <= 0) {
      return 0;
    }
    return Math.min(1, this.doneBytes / this.totalBytes);
  }

  /** 预估剩余秒数；速度未知时返回 -1。 */
  get etaSeconds(): number {
    if (this.speedBps <= 0 || this.totalBytes <= 0) {
      return -1;
    }
    return Math.max(0, (this.totalBytes - this.doneBytes) / this.speedBps);
  }
}

/** 下载结果。 */
export class DownloadResult {
  ok: boolean = false;
  cancelled: boolean = false;
  message: string = '';
  /** 成功时，已就绪的模型目录。 */
  targetDir: string = '';
}

export type DownloadProgressListener = (p: DownloadProgress) => void;

// ---------------------------------------------------------------- 下载器

/** 单文件下载结果。 */
class DlOutcome {
  readonly ok: boolean;
  readonly error: string;

  constructor(ok: boolean, error: string) {
    this.ok = ok;
    this.error = error;
  }
}

/**
 * 模型下载器。
 *
 * 顺序下载（不并发）：总共只有 3 个文件、其中一个占 99% 体积，
 * 并发只会互相抢带宽并把进度语义搞复杂。
 */
export class ModelDownloader {
  private cancelled: boolean = false;
  private current: http.HttpRequest | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 30000) {
    this.timeoutMs = timeoutMs;
  }

  /** 请求取消；正在进行的流会尽快中断（已下载的 .part 保留，可续传）。 */
  cancel(): void {
    this.cancelled = true;
    const req = this.current;
    if (req !== null) {
      try {
        req.destroy();
      } catch (err) {
        Logger.warn(TAG, '中断请求失败（忽略）');
      }
    }
  }

  /**
   * 下载并部署。
   *
   * 幂等：已经存在且校验通过的文件会被跳过，所以中断后重跑即可续上。
   *
   * @param manifestUrl 远端清单 URL
   * @param targetDir 目标目录（通常是 files/subfabric/models/parakeet）
   */
  async run(manifestUrl: string, targetDir: string,
            onProgress?: DownloadProgressListener): Promise<DownloadResult> {
    this.cancelled = false;
    const result = new DownloadResult();
    result.targetDir = targetDir;
    const progress = new DownloadProgress();

    const report = (stage: string, message: string, file: string = ''): void => {
      progress.stage = stage;
      progress.message = message;
      if (file.length > 0) {
        progress.file = file;
      }
      if (onProgress) {
        onProgress(progress);
      }
    };

    // ---- 目录
    try {
      if (!fs.accessSync(targetDir)) {
        fs.mkdirSync(targetDir, true);
      }
    } catch (err) {
      result.message = `无法创建目录：${targetDir}`;
      report(DownloadStage.FAILED, result.message);
      return result;
    }

    // ---- 清单
    report(DownloadStage.CHECKING, '正在获取模型信息…');
    let manifest: RemoteManifest;
    try {
      manifest = await this.fetchManifest(manifestUrl);
    } catch (err) {
      const e = err as Error;
      result.message = `获取模型信息失败：${e.message}`;
      report(DownloadStage.FAILED, result.message);
      return result;
    }
    if (manifest.files.length === 0) {
      result.message = '模型清单里没有文件';
      report(DownloadStage.FAILED, result.message);
      return result;
    }
    progress.totalBytes = manifest.totalBytes;
    Logger.info(TAG, `清单 ${manifest.model}：${manifest.files.length} 个文件，`
      + `${(manifest.totalBytes / 1048576).toFixed(1)} MB`);

    // ---- 逐文件
    let doneBytes = 0;
    for (let i = 0; i < manifest.files.length; i++) {
      if (this.cancelled) {
        result.cancelled = true;
        result.message = '已取消';
        report(DownloadStage.CANCELLED, result.message);
        return result;
      }
      const file = manifest.files[i];
      const finalPath = `${targetDir}/${file.name}`;
      const partPath = `${finalPath}.part`;

      // 已就绪则跳过
      if (fs.accessSync(finalPath) && fs.statSync(finalPath).size === file.size) {
        if (file.sha256.length === 0 || await sha256OfFile(finalPath) === file.sha256) {
          doneBytes += file.size;
          progress.doneBytes = doneBytes;
          report(DownloadStage.DOWNLOADING, `${file.name} 已就绪`, file.name);
          Logger.info(TAG, `复用已下载文件 ${file.name}`);
          continue;
        }
        Logger.warn(TAG, `${file.name} 校验不通过，重新下载`);
        try {
          fs.unlinkSync(finalPath);
        } catch (err) {
          // 忽略
        }
      }

      // 续传起点
      let resumeAt = 0;
      if (fs.accessSync(partPath)) {
        const partSize = fs.statSync(partPath).size;
        if (partSize > 0 && partSize < file.size) {
          resumeAt = partSize;
          Logger.info(TAG, `${file.name} 从 ${(resumeAt / 1048576).toFixed(1)} MB 处续传`);
        } else {
          try {
            fs.unlinkSync(partPath);
          } catch (err) {
            // 忽略
          }
        }
      }

      const outcome = await this.downloadOne(manifest.urlOf(file.name), partPath,
        file.size, resumeAt, doneBytes, progress, onProgress);
      if (!outcome.ok) {
        if (this.cancelled) {
          result.cancelled = true;
          result.message = '已取消（已下载部分保留，下次可续传）';
          report(DownloadStage.CANCELLED, result.message, file.name);
        } else {
          result.message = `下载 ${file.name} 失败：${outcome.error}`;
          report(DownloadStage.FAILED, result.message, file.name);
        }
        return result;
      }

      // ---- 校验
      if (file.sha256.length > 0) {
        report(DownloadStage.VERIFYING, `正在校验 ${file.name}…`, file.name);
        const actual = await sha256OfFile(partPath);
        if (actual !== file.sha256) {
          try {
            fs.unlinkSync(partPath);
          } catch (err) {
            // 忽略
          }
          result.message = `${file.name} 校验失败（期望 ${file.sha256.substring(0, 12)}…，`
            + `实际 ${actual.substring(0, 12)}…），已删除，请重试`;
          report(DownloadStage.FAILED, result.message, file.name);
          return result;
        }
      }

      // ---- 校验通过才改名
      try {
        fs.renameSync(partPath, finalPath);
      } catch (err) {
        const e = err as BusinessError;
        result.message = `重命名 ${file.name} 失败：${e.message}`;
        report(DownloadStage.FAILED, result.message, file.name);
        return result;
      }

      doneBytes += file.size;
      progress.doneBytes = doneBytes;
      Logger.info(TAG, `${file.name} 完成（${(file.size / 1048576).toFixed(1)} MB）`);
    }

    result.ok = true;
    result.message = `模型已就绪（${(manifest.totalBytes / 1048576).toFixed(1)} MB）`;
    report(DownloadStage.DONE, result.message);
    return result;
  }

  // -------------------------------------------------------------- 清单

  /** 取远端清单（小文件，普通 request 即可）。 */
  private async fetchManifest(url: string): Promise<RemoteManifest> {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: this.timeoutMs,
        readTimeout: this.timeoutMs,
        expectDataType: http.HttpDataType.STRING,
        usingCache: false
      });
      if (resp.responseCode !== 200) {
        throw new Error(`HTTP ${resp.responseCode}`);
      }
      const text = typeof resp.result === 'string' ? resp.result : '';
      const parsed = JSON.parse(text) as RemoteManifest;
      if (parsed.files === undefined || parsed.files === null) {
        throw new Error('清单缺少 files 字段');
      }
      // JSON.parse 返回的是普通对象：必须重新装配成 RemoteManifest/RemoteFile，
      // 否则 `m.urlOf()` 与 `totalBytes` 这类原型方法/访问器都不存在。
      const m = new RemoteManifest();
      m.version = parsed.version !== undefined ? parsed.version : '';
      m.model = parsed.model !== undefined ? parsed.model : '';
      m.engine = parsed.engine !== undefined ? parsed.engine : 'tdt';
      m.melBins = parsed.melBins !== undefined ? parsed.melBins : 128;
      m.baseUrl = parsed.baseUrl !== undefined && parsed.baseUrl !== null ? parsed.baseUrl : '';
      m.files = [];
      for (let i = 0; i < parsed.files.length; i++) {
        const f = parsed.files[i];
        if (f === null || f === undefined || f.name === undefined || f.name.length === 0) {
          throw new Error(`清单第 ${i + 1} 个文件缺少 name`);
        }
        if (f.size === undefined || f.size === null || !(f.size >= 0)) {
          throw new Error(`清单文件 ${f.name} 缺少有效的 size`);
        }
        m.files.push(new RemoteFile(f.name, f.size,
          f.sha256 !== undefined && f.sha256 !== null ? f.sha256 : ''));
      }
      if (m.baseUrl.length === 0) {
        const slash = url.lastIndexOf('/');
        m.baseUrl = slash >= 0 ? url.substring(0, slash) : '';
      }
      return m;
    } finally {
      req.destroy();
    }
  }

  // -------------------------------------------------------------- 单文件

  /**
   * 流式下载一个文件到 `.part`。
   *
   * 断点续传的两个关键点：
   *   1. `Range: bytes=N-` 发出去后，服务端遵守时返回 **206**；
   *      若返回 **200**，说明它忽略了 Range 并重发整个文件。此时
   *      关闭句柄、从 0 重新下载一次，不能把完整文件追加到半截文件后面。
   *   2. `fs.writeSync` 的 `offset` 是「filePointer + offset」，而刚
   *      `open` 的 filePointer 在 0，不是 EOF。因此改用
   *      `RandomAccessFile.setFilePointer(resumeAt)` 显式定位，再顺序写入；
   *      否则续传会从文件开头覆盖，得到「长度对、SHA-256 错」的产物。
   */
  private async downloadOne(url: string, partPath: string, expectedSize: number,
                            resumeAt: number, doneBefore: number,
                            progress: DownloadProgress,
                            onProgress?: DownloadProgressListener): Promise<DlOutcome> {
    const req = http.createHttp();
    let dst: fs.RandomAccessFile | null = null;
    /** 本次流收到的总字节（不含续传已存在的部分）。 */
    let received = 0;
    let lastSyncBytes = 0;
    let lastSyncAt = Date.now();
    let windowStart = Date.now();
    let windowBytes = 0;
    let speed = 0;
    let writeError = '';

    /** 已落盘的有效字节数（用于长度核对与续传点推进）。 */
    const totalWritten = (): number => resumeAt + received;
    /** 已处理的逻辑字节数（用于进度显示）。 */
    const shownBytes = (): number => resumeAt + received;

    try {
      const headers: Record<string, string> = {};
      if (resumeAt > 0) {
        headers['Range'] = `bytes=${resumeAt}-`;
      }

      dst = fs.createRandomAccessFileSync(partPath, resumeAt > 0
        ? (fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE)
        : (fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC));
      const file = dst;
      // RandomAccessFile.writeSync 始终从 filePointer 写起；续传必须显式
      // 把指针移到已有内容的末尾，否则会从文件开头覆盖（实测会导致
      // 长度正确但 SHA-256 不符）。
      file.setFilePointer(resumeAt);

      req.on('dataReceive', (chunk: ArrayBuffer): void => {
        if (this.cancelled || writeError.length > 0) {
          return;
        }
        const size = chunk.byteLength;
        received += size;

        // ---- 写入（顺序写，filePointer 自动前进）
        try {
          file.writeSync(chunk, { length: size });
        } catch (err) {
          const e = err as BusinessError;
          writeError = `写盘失败：${e.message}`;
          return;
        }

        // ---- 定期 fsync，保证中断后 .part 长度可信（续传点才不会错位）
        const now = Date.now();
        if (totalWritten() - lastSyncBytes >= FS_SYNC_EVERY_BYTES
          || now - lastSyncAt >= FS_SYNC_EVERY_MS) {
          try {
            fs.fsyncSync(file.fd);
          } catch (err) {
            Logger.warn(TAG, 'fsync 失败（忽略）');
          }
          lastSyncBytes = totalWritten();
          lastSyncAt = now;
        }

        // ---- 速度与进度
        windowBytes += chunk.byteLength;
        if (now - windowStart >= SPEED_WINDOW_MS) {
          speed = (windowBytes * 1000) / (now - windowStart);
          windowStart = now;
          windowBytes = 0;
        }
        progress.doneBytes = doneBefore + Math.min(shownBytes(), expectedSize);
        progress.speedBps = speed;
        progress.stage = DownloadStage.DOWNLOADING;
        progress.message = `正在下载 ${baseName(partPath)}  `
          + `${(shownBytes() / 1048576).toFixed(1)} / `
          + `${(expectedSize / 1048576).toFixed(1)} MB`;
        if (onProgress) {
          onProgress(progress);
        }
      });

      this.current = req;
      const code: number = await req.requestInStream(url, {
        method: http.RequestMethod.GET,
        header: headers,
        connectTimeout: this.timeoutMs,
        // 读超时是「两次数据到达之间的间隔」上限，不是总时长
        readTimeout: 120000,
        usingCache: false
      });
      this.current = null;

      if (this.cancelled) {
        return new DlOutcome(false, '已取消');
      }
      if (writeError.length > 0) {
        return new DlOutcome(false, writeError);
      }
      if (code !== 200 && code !== 206) {
        return new DlOutcome(false, `HTTP ${code}`);
      }
      // 续传时服务端若忽略 Range，会用 200 把整个文件重发。此时 .part 的
      // 前半段是旧内容、后半段又被本次数据覆盖，不能直接追加收尾；
      // 关掉当前句柄后从 0 重新下载一次（TRUNC 会清空旧内容）。
      if (code === 200 && resumeAt > 0) {
        Logger.warn(TAG, `${baseName(partPath)} 服务端忽略了 Range（HTTP 200），从 0 重新下载`);
        const old = dst;
        dst = null;
        if (old !== null) {
          try {
            old.close();
          } catch (err) {
            // 忽略
          }
        }
        return await this.downloadOne(url, partPath, expectedSize, 0,
          doneBefore, progress, onProgress);
      }

      const finalSize = totalWritten();
      if (expectedSize > 0 && finalSize !== expectedSize) {
        // 长度不对：保留 .part 供续传
        return new DlOutcome(false,
          `长度不符：收到 ${finalSize}，期望 ${expectedSize}（可重试续传）`);
      }
      // 落盘长度已确定为 expectedSize，把 .part 截到精确长度。
      if (expectedSize > 0 && dst !== null) {
        try {
          fs.truncateSync(dst.fd, expectedSize);
        } catch (err) {
          Logger.warn(TAG, '收尾截断失败（忽略）');
        }
      }
      return new DlOutcome(true, '');
    } catch (err) {
      const e = err as BusinessError;
      if (this.cancelled) {
        return new DlOutcome(false, '已取消');
      }
      Logger.error(TAG, `下载 ${url} 出错：${e.code} ${e.message}`);
      return new DlOutcome(false, e.message);
    } finally {
      this.current = null;
      if (dst !== null) {
        try {
          fs.fsyncSync(dst.fd);
        } catch (err) {
          Logger.warn(TAG, '收尾 fsync 失败（忽略）');
        }
        dst.close();
      }
      req.off('dataReceive');
      req.off('dataEnd');
      req.destroy();
    }
  }
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.substring(slash + 1) : path;
  return name.endsWith('.part') ? name.substring(0, name.length - 5) : name;
}
