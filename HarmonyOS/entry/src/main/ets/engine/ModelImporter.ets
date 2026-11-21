/*
 * 从本地压缩包导入模型。
 *
 * 场景：PC 上用 tools/convert.py 转出 `.ms` 后打包成 `parakeet-ms.zip`，
 * 用 `hdc file send` 推到手机，再在 App 的「模型」页选它导入。
 * 这条路不依赖网络，也不依赖 HuggingFace，适合离线或内网环境。
 *
 * 流程：
 *   1. 用 DocumentViewPicker 选一个 .zip
 *   2. **把选中的文件分块复制进沙箱缓存**（见下方⚠️，这一步不能省）
 *   3. zlib.decompressFile 解到一个临时目录，随即删掉临时 zip 腾空间
 *   4. 递归找到 encoder.ms / encoder.msw / decoder_joint.ms / vocab.txt
 *   5. 若包里带 manifest.json，按里面的 size 与 SHA-256 逐个校验
 *   6. 全部通过后才复制进模型目录，最后清理临时目录
 *
 * ⚠️ 第 2 步为什么必须做（真机上踩过）：
 *   `zlib.decompressFile` 的 inFile **必须是应用沙箱路径**。而
 *   DocumentViewPicker 返回的是 URI（`file://docs/...`）。
 *   直接把 URI 传进去会报 `900001 The input source file is invalid`。
 *   `fs.openSync` 恰好认 URI，所以先用它把内容复制到缓存目录，
 *   再把沙箱路径交给 decompressFile。
 *
 * ⚠️ 空间需求（模型包 2 GB 级别，必须留意）：
 *   峰值占用 ≈ 临时 zip(2.1G) + 解压产物(2.1G) + 最终模型(2.1G) ≈ 6.3 GB。
 *   为了压低峰值，解压完成后**立即删除临时 zip**（省 2.1 GB），
 *   而不是等 finally 里一起清。缓存目录所在分区需要有足够空间。
 *
 * 与另两条路的关系：
 *   - 应用内下载（ModelDownloader）：从远端拉，断点续传
 *   - 内置进 HAP（ModelStore）：随包分发，首启解包
 *   三者都写同一个模型目录，可混用；`prepareModels()` 只在本地为空时
 *   才去解包内置资源，不会互相覆盖。
 *
 * ⚠️ 安全：解压前不信任压缩包内容。这里靠两点兜底：
 *   a) 只在解压后的目录树里按**固定文件名**查找，不执行包里的任何路径；
 *   b) 复制时只按白名单文件名复制，不会把任意路径写到模型目录。
 */

import { zlib } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Logger } from './Logger';
import { sha256OfFile } from './ModelStore';
import { readTextFile } from '../platform/FileUtil';

const TAG = 'ModelImporter';

/**
 * 必需的文件名白名单。
 *
 * ⚠️ `encoder.msw` **不在必需列表里**，因为它是**可选**的：
 *   - 用 `converter_lite --saveType=MINDIR_LITE` 转 fp32 大模型时，权重会被
 *     外置成同名 `.msw`（encoder 约 2 GB），此时必须有它；
 *   - 但**自包含**的 `.ms`（例如权重量化后的产物）把权重内联在图里，
 *     没有 `.msw` 也完整。
 *
 * 真机实测（Kirin 9020）发现一个更要紧的事实：
 * **带外部 `.msw` 的 encoder 用不了** —— `model.getInputs()` 返回 `undefined`
 * （`model` 上零个可枚举属性），拿不到输入张量就无法构造 `predict()` 入参。
 * 而自包含的 `decoder_joint.ms` 一切正常。所以 `.msw` 的存在与否
 * 直接决定模型能不能跑，绝不能一刀切要求。
 */
const REQUIRED: string[] = ['encoder.ms', 'decoder_joint.ms', 'vocab.txt'];

/** 可选的附带文件。 */
const OPTIONAL: string[] = ['encoder.msw', 'manifest.json'];

/** 导入结果。 */
export class ImportResult {
  ok: boolean = false;
  cancelled: boolean = false;
  message: string = '';
  /** 成功时写入的文件名。 */
  installed: string[] = [];
}

/** 导入阶段，供 UI 显示进度。 */
export class ImportStage {
  static readonly PICKING: string = 'picking';
  static readonly COPYING: string = 'copying';
  static readonly EXTRACTING: string = 'extracting';
  static readonly VERIFYING: string = 'verifying';
  static readonly INSTALLING: string = 'installing';
  static readonly DONE: string = 'done';
}

/**
 * 导入进度。
 *
 * 导入 2 GB 级的模型要几十秒到几分钟（复制 + 解压 + SHA-256 校验），
 * 没有反馈用户会以为卡死。所有阶段都通过这个对象上报。
 */
export class ImportProgress {
  stage: string = ImportStage.PICKING;
  /** 当前处理的文件名。 */
  file: string = '';
  /** 当前文件已处理比例 0..1；未知时为 -1。 */
  fileRatio: number = -1;
  /** 整体比例 0..1；未知时为 -1。 */
  ratio: number = -1;
  message: string = '';
}

export type ImportProgressListener = (p: ImportProgress) => void;

/** 清单里的一个文件（与 ModelDownloader.RemoteFile 同构）。 */
class ManifestFile {
  name: string = '';
  size: number = 0;
  sha256: string = '';
}

class ImportManifest {
  version: string = '';
  model: string = '';
  files: ManifestFile[] = [];
}

/**
 * 选择并导入一个模型压缩包。
 *
 * ⚠️ 真机实测：这条路径在部分 HarmonyOS 版本上会被 zlib 以
 * `900003 压缩包内文件名含非法路径` 拒绝，即使 zip 结构完全合法
 * （Python `zipfile.testzip()` 通过、文件名全平铺无 `../`）。
 * 所以同时提供了 {@link pickAndImportFiles}（多选文件，不解压），
 * 那条路不依赖 zlib，更稳。
 *
 * @param context UIAbilityContext（picker 需要）
 * @param modelDir 目标模型目录
 * @param onProgress 进度回调
 */
export async function pickAndImportModel(context: common.UIAbilityContext,
                                        modelDir: string,
                                        onProgress?: ImportProgressListener)
  : Promise<ImportResult> {
  const result = new ImportResult();
  const progress = new ImportProgress();
  const report = (stage: string, message: string, file: string = '',
                  ratio: number = -1): void => {
    progress.stage = stage;
    progress.message = message;
    if (file.length > 0) {
      progress.file = file;
    }
    progress.ratio = ratio;
    if (onProgress) {
      onProgress(progress);
    }
  };

  // ---- 1) 选文件
  report(ImportStage.PICKING, '请选择模型压缩包…');
  let uri = '';
  try {
    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.fileSuffixFilters = ['模型压缩包|.zip'];
    const viewPicker = new picker.DocumentViewPicker(context);
    const uris = await viewPicker.select(options);
    if (uris.length === 0) {
      result.cancelled = true;
      result.message = '已取消';
      report(ImportStage.DONE, result.message);
      return result;
    }
    uri = uris[0];
  } catch (err) {
    const e = err as BusinessError;
    result.message = `选择文件失败：${e.message}`;
    Logger.error(TAG, result.message);
    report(ImportStage.DONE, result.message);
    return result;
  }

  // ---- 2) 准备临时目录
  const tmpRoot = `${context.cacheDir}/model_import_${Date.now()}`;
  try {
    fs.mkdirSync(tmpRoot, true);
  } catch (err) {
    const e = err as BusinessError;
    result.message = `无法创建临时目录：${e.message}`;
    Logger.error(TAG, result.message);
    report(ImportStage.DONE, result.message);
    return result;
  }

  try {
    // ---- 3) 把选中的文件复制进沙箱，再解压
    //
    // ⚠️ 这一步不能省。`zlib.decompressFile` 的 inFile **必须是应用沙箱路径**
    // （SDK 文档原文：The path must be an application sandbox path），
    // 而 DocumentViewPicker 返回的是 URI（`file://docs/...`）。
    // 直接把 URI 传进去会报 `900001 The input source file is invalid`
    // ——真机上实测就是这个错。
    // `fs.openSync` 认 URI，所以先用它把内容分块复制到缓存目录。
    const localZip = `${tmpRoot}/package.zip`;
    Logger.info(TAG, `复制到沙箱：${uri} -> ${localZip}`);
    report(ImportStage.COPYING, '正在把压缩包复制进沙箱…');
    try {
      copyFile(uri, localZip);
      const zipSize = fs.statSync(localZip).size;
      Logger.info(TAG, `已复制 ${(zipSize / 1048576).toFixed(1)} MB`);
      if (zipSize === 0) {
        result.message = '选中的文件是空的';
        report(ImportStage.DONE, result.message);
        return result;
      }
    } catch (err) {
      const e = err as BusinessError;
      result.message = `无法读取选中的文件：${e.message}`;
      Logger.error(TAG, result.message);
      report(ImportStage.DONE, result.message);
      return result;
    }

    // ---- 4) 解压（现在传的是沙箱路径）
    report(ImportStage.EXTRACTING, '正在解压（2 GB 级模型需一到几分钟）…');
    try {
      await zlib.decompressFile(localZip, tmpRoot);
    } catch (err) {
      const e = err as BusinessError;
      result.message = `解压失败（${e.code}）：${describeZlibError(e.code)}`;
      Logger.error(TAG, `${result.message} 原始信息：${e.message}`);
      report(ImportStage.DONE, result.message);
      return result;
    }

    // 解压完立刻删掉临时 zip。2 GB 级的包如果不删，峰值占用会到 6 GB+，
    // 见到过缓存分区被写满导致后续复制失败的案例。
    try {
      fs.unlinkSync(localZip);
      Logger.info(TAG, '已删除临时 zip，释放空间');
    } catch (err) {
      Logger.warn(TAG, '删除临时 zip 失败（忽略，finally 还会清理）');
    }

    // ---- 5) 找文件
    const found = new Map<string, string>();
    findFiles(tmpRoot, found, 0);
    const missing = REQUIRED.filter((n): boolean => !found.has(n));
    if (missing.length > 0) {
      result.message = `压缩包缺少文件：${missing.join('、')}`
        + `（已找到：${Array.from(found.keys()).join('、') || '无'}）`;
      Logger.error(TAG, result.message);
      report(ImportStage.DONE, result.message);
      return result;
    }

    // ---- 6) 校验（包里带 manifest 才校验）
    const manifestPath = found.get('manifest.json');
    if (manifestPath !== undefined) {
      const manifest = readManifest(manifestPath);
      if (manifest !== null) {
        for (let i = 0; i < manifest.files.length; i++) {
          const mf = manifest.files[i];
          const p = found.get(mf.name);
          if (p === undefined) {
            continue;   // 清单里有但包里没有：跳过（可能是别的模型的文件）
          }
          if (mf.size > 0 && fs.statSync(p).size !== mf.size) {
            result.message = `${mf.name} 大小不符：`
              + `期望 ${mf.size}，实际 ${fs.statSync(p).size}`;
            Logger.error(TAG, result.message);
            report(ImportStage.DONE, result.message);
            return result;
          }
          if (mf.sha256.length > 0) {
            Logger.info(TAG, `校验 ${mf.name}…`);
            // SHA-256 要读完整个文件，2 GB 的文件这里是耗时大头，必须报进度
            report(ImportStage.VERIFYING,
              `正在校验 ${mf.name}（${(mf.size / 1048576).toFixed(0)} MB）…`,
              mf.name, i / manifest.files.length);
            const actual = await sha256OfFile(p);
            if (actual !== mf.sha256) {
              result.message = `${mf.name} 校验失败（期望 ${mf.sha256.substring(0, 12)}…，`
                + `实际 ${actual.substring(0, 12)}…），文件可能损坏`;
              Logger.error(TAG, result.message);
              report(ImportStage.DONE, result.message);
              return result;
            }
          }
        }
        Logger.info(TAG, '清单校验全部通过');
      }
    } else {
      Logger.warn(TAG, '压缩包里没有 manifest.json，跳过 SHA-256 校验');
    }

    // ---- 7) 安装（必需 + 可选的 .msw）
    try {
      if (!fs.accessSync(modelDir)) {
        fs.mkdirSync(modelDir, true);
      }
    } catch (err) {
      const e = err as BusinessError;
      result.message = `无法创建模型目录：${e.message}`;
      report(ImportStage.DONE, result.message);
      return result;
    }

    const toInstall: string[] = REQUIRED.concat(OPTIONAL.filter((n): boolean => n !== 'manifest.json'));
    for (let i = 0; i < toInstall.length; i++) {
      const name = toInstall[i];
      const src = found.get(name);
      if (src === undefined) {
        continue;
      }
      const dst = `${modelDir}/${name}`;
      report(ImportStage.INSTALLING, `正在写入 ${name}…`, name, i / toInstall.length);
      copyFile(src, dst);
      result.installed.push(name);
      Logger.info(TAG, `已导入 ${name}（${(fs.statSync(dst).size / 1048576).toFixed(1)} MB）`);
    }

    result.ok = true;
    result.message = `导入成功：${result.installed.join('、')}`;
    report(ImportStage.DONE, result.message, '', 1);
    return result;
  } finally {
    // ---- 7) 清理临时目录（成败都清）
    try {
      fs.rmdirSync(tmpRoot);
    } catch (err) {
      Logger.warn(TAG, `清理临时目录失败（忽略）：${tmpRoot}`);
    }
  }
}

/**
 * 多选文件导入（**不经过解压**）。
 *
 * 为什么需要它：真机上 `zlib.decompressFile` 会以
 * `900003 压缩包内文件名含非法路径` 拒绝结构完全合法的 zip，
 * 这条路彻底绕开解压，只做「选文件 -> 复制 -> 校验」。
 *
 * 用法：让用户一次性选中这四个文件（从「文件管理」的下载目录里多选）：
 *     encoder.ms / encoder.msw / decoder_joint.ms / vocab.txt
 * 顺序不限，按文件名识别。
 *
 * 校验强度说明：这条路径**没有 manifest**，所以无法做 SHA-256 校验，
 * 只能核对文件大小是否合理（见 SIZE_HINTS）。想要完整校验就走
 * 压缩包那条路，或让用户额外选上 manifest.json —— manifest 存在时
 * 会照常做 SHA-256 校验。
 */
export async function pickAndImportFiles(context: common.UIAbilityContext,
                                        modelDir: string,
                                        onProgress?: ImportProgressListener)
  : Promise<ImportResult> {
  const result = new ImportResult();
  const progress = new ImportProgress();
  const report = (stage: string, message: string, file: string = '',
                  ratio: number = -1): void => {
    progress.stage = stage;
    progress.message = message;
    if (file.length > 0) {
      progress.file = file;
    }
    progress.ratio = ratio;
    if (onProgress) {
      onProgress(progress);
    }
  };

  // ---- 1) 多选文件
  report(ImportStage.PICKING, '请选中模型文件（可多选，含 manifest.json 更好）…');
  let uris: string[] = [];
  try {
    const options = new picker.DocumentSelectOptions();
    // 4 个模型文件 + manifest.json
    options.maxSelectNumber = 6;
    // 不限制后缀：部分系统的文件管理会把 .ms 识别成未知类型而选不中
    const viewPicker = new picker.DocumentViewPicker(context);
    uris = await viewPicker.select(options);
  } catch (err) {
    const e = err as BusinessError;
    result.message = `选择文件失败：${e.message}`;
    Logger.error(TAG, result.message);
    report(ImportStage.DONE, result.message);
    return result;
  }
  if (uris.length === 0) {
    result.cancelled = true;
    result.message = '已取消';
    report(ImportStage.DONE, result.message);
    return result;
  }
  Logger.info(TAG, `用户选了 ${uris.length} 个文件`);

  // ---- 2) 复制进沙箱并按名字归类
  const tmpRoot = `${context.cacheDir}/model_files_${Date.now()}`;
  try {
    fs.mkdirSync(tmpRoot, true);
  } catch (err) {
    const e = err as BusinessError;
    result.message = `无法创建临时目录：${e.message}`;
    report(ImportStage.DONE, result.message);
    return result;
  }

  try {
    const found = new Map<string, string>();
    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      const name = baseName(uri);
      // 只认已知文件名，避免把无关文件也复制进来占空间
      const known = REQUIRED.indexOf(name) >= 0 || OPTIONAL.indexOf(name) >= 0;
      if (!known) {
        Logger.warn(TAG, `跳过不认识的选中项：${name}`);
        continue;
      }
      const dst = `${tmpRoot}/${name}`;
      report(ImportStage.COPYING,
        `正在复制 ${name}（${i + 1}/${uris.length}）…`, name, i / uris.length);
      try {
        copyFile(uri, dst);
        const size = fs.statSync(dst).size;
        found.set(name, dst);
        Logger.info(TAG, `已复制 ${name}（${(size / 1048576).toFixed(1)} MB）`);
      } catch (err) {
        const e = err as BusinessError;
        result.message = `复制 ${name} 失败：${e.message}`;
        Logger.error(TAG, result.message);
        report(ImportStage.DONE, result.message);
        return result;
      }
    }

    // ---- 3) 必需文件检查
    const missing = REQUIRED.filter((n): boolean => !found.has(n));
    if (missing.length > 0) {
      result.message = `缺少文件：${missing.join('、')}。`
        + `请至少选中 encoder.ms、decoder_joint.ms、vocab.txt 三个文件`
        + `（如果 encoder 是 fp32 外部权重版本，还要带上 encoder.msw）`;
      Logger.error(TAG, result.message);
      report(ImportStage.DONE, result.message);
      return result;
    }

    // ---- 4) 有 manifest 就做完整校验，没有就只核对大小
    const manifestPath = found.get('manifest.json');
    const manifest = manifestPath !== undefined ? readManifest(manifestPath) : null;
    if (manifest !== null) {
      for (let i = 0; i < manifest.files.length; i++) {
        const mf = manifest.files[i];
        const p = found.get(mf.name);
        if (p === undefined) {
          continue;
        }
        report(ImportStage.VERIFYING, `正在校验 ${mf.name}…`, mf.name,
          i / manifest.files.length);
        if (mf.size > 0 && fs.statSync(p).size !== mf.size) {
          result.message = `${mf.name} 大小不符：期望 ${mf.size}，实际 ${fs.statSync(p).size}`;
          report(ImportStage.DONE, result.message);
          return result;
        }
        if (mf.sha256.length > 0) {
          const actual = await sha256OfFile(p);
          if (actual !== mf.sha256) {
            result.message = `${mf.name} 校验失败（期望 ${mf.sha256.substring(0, 12)}…，`
              + `实际 ${actual.substring(0, 12)}…），文件可能损坏或选错了`;
            Logger.error(TAG, result.message);
            report(ImportStage.DONE, result.message);
            return result;
          }
        }
      }
      Logger.info(TAG, '清单校验通过');
    } else {
      report(ImportStage.VERIFYING, '正在核对文件大小（无 manifest，跳过 SHA-256）…');
      const bad = checkSizes(found);
      if (bad.length > 0) {
        result.message = `文件大小异常：${bad.join('；')}。可能选错了文件`;
        Logger.error(TAG, result.message);
        report(ImportStage.DONE, result.message);
        return result;
      }
    }

    // ---- 5) 安装
    try {
      if (!fs.accessSync(modelDir)) {
        fs.mkdirSync(modelDir, true);
      }
    } catch (err) {
      const e = err as BusinessError;
      result.message = `无法创建模型目录：${e.message}`;
      report(ImportStage.DONE, result.message);
      return result;
    }
    const toInstall: string[] = REQUIRED.concat(OPTIONAL.filter((n): boolean => n !== 'manifest.json'));
    for (let i = 0; i < toInstall.length; i++) {
      const name = toInstall[i];
      const src = found.get(name);
      if (src === undefined) {
        continue;
      }
      report(ImportStage.INSTALLING, `正在写入 ${name}…`, name, i / toInstall.length);
      copyFile(src, `${modelDir}/${name}`);
      result.installed.push(name);
      Logger.info(TAG, `已写入 ${name}`);
    }

    result.ok = true;
    result.message = `导入成功：${result.installed.join('、')}`;
    report(ImportStage.DONE, result.message, '', 1);
    return result;
  } finally {
    try {
      fs.rmdirSync(tmpRoot);
    } catch (err) {
      Logger.warn(TAG, `清理临时目录失败（忽略）：${tmpRoot}`);
    }
  }
}

/**
 * 各文件的大小区间（字节），用于在没有 manifest 时做基本核对。
 *
 * ⚠️ 上下限必须覆盖**所有可能的模型规格**，不能只按某一个模型设。
 * 这里踩过一次坑：上限按 0.6B 的量化版设成 64 MB，结果 110M 的 fp32
 * encoder（410.7 MB）被误判为「大小异常」而拒绝导入。
 *
 * 参考实际产物：
 *   encoder.ms      0.6B 量化 ~9.7 MB | 110M fp32 ~410 MB | 0.6B fp32 图 ~0.5 MB
 *   encoder.msw     只有 0.6B fp32 会产生（~2 GB）
 *   decoder_joint.ms  0.6B ~34 MB | 110M ~20 MB
 *   vocab.txt       9384（0.6B）| 9953（110M）
 *
 * 这个校验只用来挡「选错文件」（比如把视频当模型选进来），
 * 不该用来判断模型是否"正确"——那要靠 manifest 的 SHA-256。
 * 所以区间一律放宽。
 */
function checkSizes(found: Map<string, string>): string[] {
  const HINTS: string[] = ['encoder.ms', 'encoder.msw', 'decoder_joint.ms', 'vocab.txt'];
  const MB = 1048576;
  // [最小值, 最大值]
  const RANGE = new Map<string, number[]>([
    // 100 KB（仅图的 .ms） ~ 4 GB（fp32 大模型）
    ['encoder.ms', [100 * 1024, 4096 * MB]],
    // 外部权重：只有 0.6B fp32 会产出，约 2 GB
    ['encoder.msw', [100 * MB, 6144 * MB]],
    // 4 MB ~ 512 MB（覆盖 0.6B 的 34 MB 与各种量化/大模型版本）
    ['decoder_joint.ms', [4 * MB, 512 * MB]],
    // 词表：1 KB ~ 8 MB
    ['vocab.txt', [1024, 8 * MB]],
  ]);
  const bad: string[] = [];
  for (let i = 0; i < HINTS.length; i++) {
    const name = HINTS[i];
    const p = found.get(name);
    if (p === undefined) {
      continue;
    }
    const size = fs.statSync(p).size;
    const r = RANGE.get(name);
    if (r !== undefined && (size < r[0] || size > r[1])) {
      // 报错时把实际值和允许区间都写出来，便于判断是选错文件还是区间过窄
      bad.push(`${name} 为 ${(size / MB).toFixed(1)} MB`
        + `（允许 ${(r[0] / MB).toFixed(1)}~${(r[1] / MB).toFixed(1)} MB）`);
    }
  }
  return bad;
}

/** 从 URI 或路径里取文件名。 */
function baseName(uriOrPath: string): string {
  let s = uriOrPath;
  // 去掉 query（picker 的 URI 可能带 ?xxx）
  const q = s.indexOf('?');
  if (q >= 0) {
    s = s.substring(0, q);
  }
  const slash = s.lastIndexOf('/');
  if (slash >= 0) {
    s = s.substring(slash + 1);
  }
  try {
    return decodeURIComponent(s);
  } catch (err) {
    return s;
  }
}

/**
 * 把 zlib 的错误码翻译成可操作的中文提示。
 *
 * 这几个码都是真机上踩过的，直接抛英文 message 对用户毫无帮助。
 */
function describeZlibError(code: number | undefined): string {
  if (code === 900001) {
    return '输入的源文件无效（不是合法 zip，或文件已损坏）';
  }
  if (code === 900002) {
    return '输出路径无效（目录不可写或不存在）';
  }
  if (code === 900003) {
    return '压缩包内的文件名含非法路径（"../"），已拒绝解压';
  }
  return '文件不是有效的 zip，或已损坏';
}

/** 递归查找白名单文件（只认文件名，不认路径）。 */
function findFiles(dir: string, out: Map<string, string>, depth: number): void {
  if (depth > 8) {
    return;
  }
  let names: string[] = [];
  try {
    names = fs.listFileSync(dir);
  } catch (err) {
    return;
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const p = `${dir}/${name}`;
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch (err) {
      isDir = false;
    }
    if (isDir) {
      findFiles(p, out, depth + 1);
      continue;
    }
    // 白名单：只关心这几个名字（外加清单本身）
    if (REQUIRED.indexOf(name) >= 0 || name === 'manifest.json') {
      if (!out.has(name)) {
        out.set(name, p);
      }
    }
  }
}

/** 读清单；失败返回 null（不阻断导入）。 */
function readManifest(path: string): ImportManifest | null {
  try {
    const text = readTextFile(path);
    const m = JSON.parse(text) as ImportManifest;
    if (m.files === undefined || m.files === null) {
      return null;
    }
    return m;
  } catch (err) {
    Logger.warn(TAG, '读取 manifest.json 失败，跳过校验');
    return null;
  }
}

/**
 * 分块复制（模型可能 2 GB+，必须避免一次性读进内存）。
 *
 * 两个要点：
 *  1. 缓冲区在循环**外**分配一次并复用。若在循环内 `new ArrayBuffer`，
 *     2 GB 文件会产生 500+ 个 4 MB 临时缓冲，GC 压力很大。
 *  2. 完全依赖「文件指针随读写推进」来顺序处理，**不传 offset**。
 *     实测把 `ReadOptions.offset` 与连续 readSync 混用会重复读同一段
 *     （offset 的语义是「文件指针 + offset」，指针本身已在推进）。
 */
function copyFile(src: string, dst: string): void {
  const CHUNK = 4 * 1024 * 1024;
  const inF = fs.openSync(src, fs.OpenMode.READ_ONLY);
  const outF = fs.openSync(dst,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  const buf = new ArrayBuffer(CHUNK);
  try {
    for (;;) {
      const read = fs.readSync(inF.fd, buf);
      if (read <= 0) {
        break;
      }
      // buf 可能大于实际读到的字节数（读到文件尾时），按 read 截断
      fs.writeSync(outF.fd, read === CHUNK ? buf : buf.slice(0, read),
        { length: read });
      if (read < CHUNK) {
        break;
      }
    }
  } finally {
    fs.closeSync(inF);
    fs.closeSync(outF);
  }
}
