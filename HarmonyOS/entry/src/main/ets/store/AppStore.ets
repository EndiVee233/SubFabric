import { common } from "@kit.AbilityKit";
import { resourceManager } from "@kit.LocalizationKit";
import { fileIo as fs } from "@kit.CoreFileKit";
import { Cue, Progress, Stage, MediaInfo, WordTiming } from "common";
import { Pipeline } from "common";
import type { IAudioDecoder, ITranslator } from "common";
import { readAsCues, writeSrt, writeVtt, writeAss, writeJson, AssExportOptions } from "common";
import { HarmonyAudioDecoder } from "../platform/MediaDecoder";
import { ParakeetEngine, ParakeetModelFiles } from "../engine/ParakeetEngine";
import { MsLiteRuntime } from "../engine/MindSporeLite";
import { Logger } from "../engine/Logger";
import { ensureDir, fileExists, filesDir, readTextFile, writeTextFile, writeTextFileAtomic, deleteTree } from "../platform/FileUtil";
import { TranslationService, TranslateOptions } from "../engine/TranslationService";
import { GlossaryEntry, GlossaryGroup, TranslationScheme, cloneGlossary, parseTranslationScheme } from "../engine/TranslationScheme";
import type { GlossaryJson, GlossaryEntryJson } from "../engine/TranslationScheme";
import { readManifest, ensureUnpacked } from "../engine/ModelStore";
import type { EmbeddedManifest, UnpackResult } from "../engine/ModelStore";
import { ModelDownloader, DownloadStage } from "../engine/ModelDownloader";
import type { DownloadProgress, DownloadResult } from "../engine/ModelDownloader";
import { pickAndImportModel, pickAndImportFiles, ImportStage } from "../engine/ModelImporter";
import type { ImportResult, ImportProgress, ImportProgressListener } from "../engine/ModelImporter";
import { npuSelfTest } from "../engine/NpuSelfTest";
import type { SelfTestResult } from "../engine/NpuSelfTest";
const TAG = 'AppStore';
/** 一个项目（一次字幕工程的元数据）。 */
@Observed
export class ProjectMeta {
    id: string = '';
    name: string = '';
    mediaPath: string = '';
    mediaName: string = '';
    durationSec: number = 0;
    cueCount: number = 0;
    updatedAt: number = 0;
    /** 原文语言。 */
    sourceLang: string = 'en';
    /** 译文语言。 */
    targetLang: string = 'zh';
    constructor(id: string = '', name: string = '') {
        this.id = id;
        this.name = name;
    }
}
/** 项目内人物登记；颜色跟着人物走，允许暂时 0 条字幕。 */
export class SpeakerRecord {
    name: string = '';
    color: string = '';
    constructor(name: string = '', color: string = '') {
        this.name = name;
        this.color = color;
    }
}
/** 运行状态。 */
export class RunState {
    static readonly IDLE: string = 'idle';
    static readonly BUSY: string = 'busy';
    static readonly CANCELLING: string = 'cancelling';
    static readonly DONE: string = 'done';
    static readonly FAILED: string = 'failed';
}
/** 全局应用状态。 */
@Observed
export class AppStore {
    // ------------------------------------------------------------ 布局
    /** 当前断点：xs/sm/md/lg/xl。 */
    breakpoint: string = 'sm';
    /** 形态：phone/foldable/tablet/desktop。 */
    form: string = 'phone';
    // ------------------------------------------------------------ 项目
    projects: ProjectMeta[] = [];
    current: ProjectMeta | null = null;
    cues: Cue[] = [];
    media: MediaInfo = new MediaInfo();
    // ------------------------------------------------------------ 运行状态
    runState: string = RunState.IDLE;
    progress: Progress = new Progress();
    statusText: string = '就绪';
    /** 当前识别后端描述，例如 "NPU" / "未加载"。 */
    backendLabel: string = '未加载';
    /** 硬件是否具备 NPU。 */
    npuAvailable: boolean = false;
    /** 内置模型解包进度 0..1；-1 表示不需要解包。 */
    modelPrepRatio: number = -1;
    /** 内置模型解包提示文案。 */
    modelPrepText: string = '';
    /** 模型下载状态：'' | checking | downloading | verifying | done | cancelled | failed */
    downloadStage: string = '';
    /** 下载进度 0..1。 */
    downloadRatio: number = 0;
    /** 下载速度（字节/秒）。 */
    downloadSpeed: number = 0;
    /** 下载提示文案。 */
    downloadText: string = '';
    /** 导入阶段（空串表示未在导入）。 */
    importStage: string = '';
    /** 导入进度 0..1；-1 表示未知。 */
    importRatio: number = -1;
    /** 导入提示文案。 */
    importText: string = '';
    // ------------------------------------------------------------ 设置
    preferNpu: boolean = true;
    /** CPU 线程仅作为 MindSpore Lite 上下文参数保留；CPU 不再作为可选识别硬件。 */
    cpuThreads: number = 4;
    autoTranslate: boolean = true;
    useVad: boolean = true;
    /** 宽屏项目页侧边栏常驻展开（仅 lg 生效）。 */
    projectsDrawerPinned: boolean = false;
    targetLang: string = 'zh';
    /** 翻译服务地址（留空表示使用服务商默认地址）。 */
    translateEndpoint: string = '';
    translateApiKey: string = '';
    /** 留空表示使用服务商默认模型。 */
    translateModel: string = '';
    /** 翻译方案与服务商。 */
    translateProvider: string = 'deepseek';
    translateSchemeName: string = '默认方案';
    translateTemperature: number = 0.2;
    translateBatchSize: number = 20;
    translateContextLines: number = 1;
    translatePrompt: string = '';
    translateGlossary: GlossaryGroup[] = [];
    /** 本地保存的翻译方案（可切换/导入导出）。 */
    translateSchemes: TranslationScheme[] = [];
    /**
     * 模型下载清单地址。留空表示不提供应用内下载。
     *
     * 指向一个 JSON，格式见 docs/MODEL_DOWNLOAD.md：
     * { version, model, engine, melBins, baseUrl, files:[{name,size,sha256}] }
     *
     * ⚠️ 默认值是一个**占位地址**，指向 SubFabric 仓库下预留的
     * `harmonyos-ms/` 子目录。之所以还不能开箱即用：
     * HuggingFace 上的 parakeet 仓库只有 ONNX
     * （`istupakov/parakeet-tdt-0.6b-v2-onnx`）或高通 Hexagon 的 QNN 产物
     * （`runanywhere/*_HNPU`），**都不是 MindSpore Lite 能加载的 `.ms`**。
     *
     * 用法：在 PC 的 Linux 上用 converter_lite 转出 `.ms`，
     * 跑 `tools/gen_download_manifest.py` 生成 manifest.json，
     * 把 `.ms` 与 manifest.json 一起传到该目录，这里就能直接下载了
     * —— 或者把这个字段改成你自己服务器的地址。
     *
     * HuggingFace 支持 Range 请求，所以断点续传可用（直链会 302 到 CDN，
     * 若 CDN 忽略 Range，下载器会自动从头重写，不会产生坏文件）。
     */
    modelDownloadUrl: string = 'https://huggingface.co/EndiVee233/SubFabric/resolve/main/harmonyos-ms/manifest.json';
    // ------------------------------------------------------------ 依赖
    private pipeline: Pipeline | null = null;
    private engine: ParakeetEngine | null = null;
    private readonly decoder: HarmonyAudioDecoder = new HarmonyAudioDecoder();
    private translator: TranslationService | null = null;
    private downloader: ModelDownloader | null = null;
    context: common.UIAbilityContext | null = null;
    /** 数据根目录。 */
    rootDir(): string {
        const ctx = this.context;
        return ctx === null ? '' : `${filesDir(ctx)}/subfabric`;
    }
    /** 模型目录。 */
    modelDir(): string {
        return `${this.rootDir()}/models/parakeet`;
    }
    /** 项目目录。 */
    projectsDir(): string {
        return `${this.rootDir()}/projects`;
    }
    /** 模型文件集合。 */
    modelFiles(): ParakeetModelFiles {
        const dir = this.modelDir();
        // 量化后的 encoder.ms 是自包含模型，不需要外置权重。只有转换器生成
        // 外置权重版本时，导入器才会把 encoder.msw 复制到此目录并传入路径。
        return new ParakeetModelFiles(`${dir}/encoder.ms`, `${dir}/decoder_joint.ms`, `${dir}/vocab.txt`);
    }
    /** 初始化：准备目录、探测 NPU、加载设置与项目列表。 */
    async init(context: common.UIAbilityContext): Promise<void> {
        this.context = context;
        ensureDir(this.rootDir());
        ensureDir(this.modelDir());
        ensureDir(this.projectsDir());
        ensureDir(`${this.rootDir()}/exports`);
        // 给解码器指定转码中间产物目录。
        //
        // ⚠️ 必须在这里设！视频/MP3 等非 WAV 媒体要走 AVTranscoder 转成 WAV，
        // 而 AVTranscoder 需要一个可写的落地目录。漏掉这步的后果是：
        // 识别视频时报「未设置转码工作目录」，而 WAV 却能正常识别——
        // 表现为「音频能用、视频不能用」，很容易误判成解码器不支持的格式问题。
        const transcodeDir = `${context.cacheDir}/transcode`;
        ensureDir(transcodeDir);
        this.decoder.setWorkDir(transcodeDir);
        this.loadSettings();
        this.translateSchemes = this.loadTranslationSchemes();
        this.npuAvailable = MsLiteRuntime.hasNpu();
        if (!this.npuAvailable) {
            const why = MsLiteRuntime.nnrtFailure();
            Logger.warn(TAG, `未检测到 NPU，识别将走 CPU${why.length > 0 ? `（${why}）` : ''}`);
        }
        this.loadProjects();
        // 内置模型：首次启动会把 rawfile 里的模型解包到 files 目录（可能 600 MB+）。
        await this.prepareModels(context);
        // 诊断用的小模型（33 KB），解包到模型目录供 NPU 对照实验使用。
        await this.unpackTinyProbe(context);
        this.statusText = this.npuAvailable ? 'NPU 可用' : '识别硬件待接入';
        Logger.info(TAG, `初始化完成：NPU=${this.npuAvailable}，`
            + `项目 ${this.projects.length} 个，模型目录 ${this.modelDir()}`);
    }
    // ------------------------------------------------------------ 模型准备
    // ------------------------------------------------------------ 应用内下载
    /** 是否配置了下载地址。 */
    canDownloadModel(): boolean {
        return this.modelDownloadUrl.trim().length > 0;
    }
    /** 当前是否正在下载。 */
    isDownloading(): boolean {
        return this.downloadStage === DownloadStage.CHECKING
            || this.downloadStage === DownloadStage.DOWNLOADING
            || this.downloadStage === DownloadStage.VERIFYING;
    }
    /**
     * 从远端下载模型并部署到沙箱。
     *
     * 与内置模型的关系：内置模型是「随包分发」，这里是「按需拉取」。
     * 两者都写入同一个目录，所以谁先完成都行；`prepareModels()` 只在
     * 本地没有模型时才会去解包内置资源，不会与下载冲突。
     *
     * 断点续传：中断后再次调用即可从 `.part` 继续，不会从头再来。
     */
    async downloadModel(): Promise<void> {
        if (this.isDownloading()) {
            return;
        }
        if (!this.canDownloadModel()) {
            this.downloadText = '未配置模型下载地址';
            this.downloadStage = DownloadStage.FAILED;
            return;
        }
        this.downloadStage = DownloadStage.CHECKING;
        this.downloadRatio = 0;
        this.downloadSpeed = 0;
        this.downloadText = '正在获取模型信息…';
        this.statusText = this.downloadText;
        const dl = new ModelDownloader();
        this.downloader = dl;
        try {
            const result: DownloadResult = await dl.run(this.modelDownloadUrl.trim(), this.modelDir(), (p: DownloadProgress): void => {
                this.downloadStage = p.stage;
                this.downloadRatio = p.ratio;
                this.downloadSpeed = p.speedBps;
                this.downloadText = p.message;
                this.statusText = p.message;
            });
            this.downloadStage = result.ok
                ? DownloadStage.DONE
                : (result.cancelled ? DownloadStage.CANCELLED : DownloadStage.FAILED);
            this.downloadText = result.message;
            this.statusText = result.message;
            if (result.ok) {
                // 模型换了，之前加载的引擎作废
                await this.releaseEngine();
                this.backendLabel = '未加载';
            }
            Logger.info(TAG, `下载结束：${result.message}`);
        }
        catch (err) {
            const e = err as Error;
            this.downloadStage = DownloadStage.FAILED;
            this.downloadText = `下载异常：${e.message}`;
            this.statusText = this.downloadText;
            Logger.error(TAG, this.downloadText);
        }
        finally {
            this.downloader = null;
        }
    }
    /** 取消下载（已下载部分保留，下次可续传）。 */
    cancelModelDownload(): void {
        const dl = this.downloader;
        if (dl !== null) {
            dl.cancel();
            this.downloadText = '正在取消…';
        }
    }
    /**
     * 清理已下载/导入的模型文件。
     *
     * 用途：模型损坏、需要释放空间或切换到另一套权重时，先卸载已加载引擎，
     * 再删除整个模型目录；下次下载会从头开始，不会复用旧文件。
     */
    async clearModelFiles(): Promise<void> {
        if (this.isDownloading()) {
            return;
        }
        await this.releaseEngine();
        const dir = this.modelDir();
        deleteTree(dir);
        ensureDir(dir);
        this.backendLabel = '未加载';
        this.downloadStage = '';
        this.downloadText = '模型文件已清理';
        this.statusText = this.downloadText;
        Logger.info(TAG, '已清理模型文件');
    }
    /**
     * 从本地压缩包导入模型（离线路径）。
     *
     * 适合「PC 转换 -> hdc 推送 -> 手机导入」的流程，不依赖网络。
     * 需要 UI 层把 picker 用的 context 传进来。
     */
    async importModelFromZip(context: common.UIAbilityContext): Promise<void> {
        await this.runImport(context, true);
    }
    /**
     * 多选文件导入（**不经过解压**）。
     *
     * 真机上 `zlib.decompressFile` 会以 `900003 压缩包内文件名含非法路径`
     * 拒绝结构合法的 zip，这条路绕开了解压，更稳。
     */
    async importModelFromFiles(context: common.UIAbilityContext): Promise<void> {
        await this.runImport(context, false);
    }
    /** 导入的公共外壳：状态、进度、异常处理、引擎失效。 */
    private async runImport(context: common.UIAbilityContext, useZip: boolean): Promise<void> {
        if (this.isImporting()) {
            this.statusText = '已有导入在进行中';
            return;
        }
        this.importStage = ImportStage.PICKING;
        this.importRatio = -1;
        this.importText = '请选择文件…';
        this.statusText = this.importText;
        try {
            const onProgress: ImportProgressListener = (p: ImportProgress): void => {
                this.importStage = p.stage;
                this.importRatio = p.ratio;
                this.importText = p.message;
                this.statusText = p.message;
            };
            const result: ImportResult = useZip
                ? await pickAndImportModel(context, this.modelDir(), onProgress)
                : await pickAndImportFiles(context, this.modelDir(), onProgress);
            if (result.ok) {
                // 模型换了，旧引擎作废
                await this.releaseEngine();
                this.backendLabel = '未加载';
                this.statusText = result.message;
                Logger.info(TAG, `导入成功：${result.installed.join('、')}`);
            }
            else if (result.cancelled) {
                this.statusText = '已取消导入';
            }
            else {
                this.statusText = `导入失败：${result.message}`;
                Logger.error(TAG, this.statusText);
            }
        }
        catch (err) {
            const e = err as Error;
            this.statusText = `导入异常：${e.message}`;
            Logger.error(TAG, this.statusText);
        }
        finally {
            this.importStage = '';
            this.importRatio = -1;
        }
    }
    /** 是否正在导入。 */
    isImporting(): boolean {
        return this.importStage.length > 0 && this.importStage !== ImportStage.DONE;
    }
    /**
     * NPU 原生通路自检。
     *
     * 用 NAPI 层（`libmslite.so`）在 **NNRt** 上加载 encoder 并读取输入张量。
     *
     * 为什么需要这个自检：ArkTS 绑定在 NNRt 后端下 `model.getInputs()`
     * 返回 undefined（拿不到张量就没法 predict）。整个 NPU 路线都建立在
     * 「官方 C API 没有这个限制」这个假设上——先用最小代价验证它，
     * 再决定是否把推理引擎整体迁到原生层。
     */
    async runNpuSelfTest(): Promise<void> {
        const files = this.modelFiles();
        const missing = files.missing();
        if (missing.length > 0) {
            this.statusText = `模型未就绪（缺 ${missing.join('、')}），无法自检`;
            return;
        }
        this.statusText = '正在做 NPU 原生自检…';
        await this.releaseEngine();
        try {
            const res: SelfTestResult = npuSelfTest(files.encoder, 'encoder(110M fp32)');
            this.statusText = res.detail;
        }
        catch (err) {
            const e = err as Error;
            this.statusText = `自检异常：${e.message}`;
            Logger.errorWithCause(TAG, 'runNpuSelfTest', err as Object);
        }
    }
    /**
     * 用**最小模型**做 NPU 对照实验。
     *
     * 目的：区分两种失败原因
     *   a) 设备/NNRt 配置问题 —— 连 MatMul+Add+Relu 都构建不了
     *   b) 模型算子问题     —— 最小模型能构建，只有 encoder 不行
     *
     * 最小模型放在 rawextra 目录，由 UI 层负责确保它存在。
     */
    async runNpuTinyTest(): Promise<void> {
        const tiny = `${this.modelDir()}/tiny.ms`;
        this.statusText = '正在用最小模型做 NPU 对照自检…';
        await this.releaseEngine();
        try {
            const res: SelfTestResult = npuSelfTest(tiny, 'tiny(MatMul+Add+Relu)');
            this.statusText = res.detail;
        }
        catch (err) {
            const e = err as Error;
            this.statusText = `最小模型自检异常：${e.message}`;
            Logger.errorWithCause(TAG, 'runNpuTinyTest', err as Object);
        }
    }
    /**
     * 把诊断用的小模型（rawfile/tiny.ms，33 KB）解包到模型目录。
     *
     * 用途：NPU 对照实验。
     * 只用 MatMul + Add + Relu 三个算子，如果连它在 NPU 上都构建不了，
     * 说明是设备/NNRt 配置问题；如果它能构建而 encoder 不行，
     * 说明是 encoder 的算子兼容性问题。这个区分很关键。
     *
     * 失败不影响正常使用（只是少一个诊断手段），所以只 warn。
     */
    private async unpackTinyProbe(context: common.UIAbilityContext): Promise<void> {
        const dest = `${this.modelDir()}/tiny.ms`;
        if (fileExists(dest)) {
            return;
        }
        let desc: resourceManager.RawFileDescriptor | null = null;
        let outF: fs.File | null = null;
        try {
            desc = await context.resourceManager.getRawFd('tiny.ms');
            outF = fs.openSync(dest, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
            // 与 ModelStore.copyRawFile 同一套做法：
            // getRawFd 返回的 fd 指向**整个 HAP**，但文件指针已定位到该 rawfile
            // 的起点，所以顺序读 `desc.length` 字节即可，**不能**用 copyFileSync。
            const CHUNK = 64 * 1024;
            let remaining = desc.length;
            let copied = 0;
            while (remaining > 0) {
                const want = remaining < CHUNK ? remaining : CHUNK;
                const buf = new ArrayBuffer(want);
                const read = fs.readSync(desc.fd, buf);
                if (read <= 0) {
                    Logger.warn(TAG, `读取 tiny.ms 提前结束（已读 ${copied}/${desc.length}）`);
                    break;
                }
                fs.writeSync(outF.fd, buf, { length: read });
                copied += read;
                remaining -= read;
            }
            Logger.info(TAG, `已解包诊断小模型 tiny.ms（${copied} 字节）`);
        }
        catch (err) {
            const e = err as BusinessError;
            Logger.warn(TAG, `解包 tiny.ms 失败（不影响正常使用）：${e.message}`);
        }
        finally {
            if (outF !== null) {
                fs.closeSync(outF);
            }
            if (desc !== null) {
                try {
                    await context.resourceManager.closeRawFd('tiny.ms');
                }
                catch (err) {
                    Logger.warn(TAG, '关闭 tiny.ms 的 rawfile fd 失败');
                }
            }
        }
    }
    /** 删除已下载/解包的模型，回到「未就绪」状态。 */
    async removeModels(): Promise<void> {
        await this.releaseEngine();
        const dir = this.modelDir();
        const names: string[] = ['encoder.ms', 'encoder.msw', 'decoder_joint.ms', 'vocab.txt',
            'encoder.ms.part', 'encoder.msw.part', 'decoder_joint.ms.part', 'vocab.txt.part'];
        for (let i = 0; i < names.length; i++) {
            const p = `${dir}/${names[i]}`;
            try {
                if (fileExists(p)) {
                    fs.unlinkSync(p);
                }
            }
            catch (err) {
                Logger.warn(TAG, `删除 ${names[i]} 失败（忽略）`);
            }
        }
        this.backendLabel = '未加载';
        this.statusText = '模型已删除';
    }
    /**
     * 准备识别模型。
     *
     * 三种情形：
     *   1. 模型已在 files 目录（上次解包过，或用户手工导入）-> 直接用；
     *   2. HAP 内置了模型（rawfile/parakeet/manifest.json 存在）-> 解包后使用；
     *   3. 都没有 -> 保持「未就绪」，由「模型」页面提示用户准备。
     *
     * 解包是幂等的：已存在且 SHA-256 一致的文件会跳过，所以第二次启动很快。
     */
    private async prepareModels(context: common.UIAbilityContext): Promise<void> {
        // 情形 1：本地已有
        if (this.hasModels()) {
            Logger.info(TAG, '模型已存在于本地，跳过解包');
            return;
        }
        // 情形 2：内置
        let manifest: EmbeddedManifest | null = null;
        try {
            manifest = await readManifest(context.resourceManager);
        }
        catch (err) {
            Logger.warn(TAG, '读取内置模型清单失败（按未内置处理）');
        }
        if (manifest === null) {
            this.modelPrepText = '未内置模型，请在「模型」页面准备';
            Logger.info(TAG, this.modelPrepText);
            return;
        }
        const totalMb = (manifest.totalBytes / 1048576).toFixed(0);
        this.modelPrepRatio = 0;
        this.modelPrepText = `正在准备内置模型（${totalMb} MB）…`;
        this.statusText = this.modelPrepText;
        Logger.info(TAG, `开始解包内置模型：${manifest.model}，共 ${totalMb} MB`);
        try {
            const result: UnpackResult = await ensureUnpacked(context.resourceManager, manifest, this.modelDir(), (done: number, total: number, current: string): void => {
                this.modelPrepRatio = total > 0 ? done / total : 0;
                this.modelPrepText = `正在解包 ${current}（`
                    + `${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB）`;
                this.statusText = this.modelPrepText;
            });
            this.modelPrepRatio = -1;
            if (result.ok) {
                this.modelPrepText = result.message;
                Logger.info(TAG, `内置模型就绪：${result.message}`);
            }
            else {
                this.modelPrepText = `内置模型解包失败：${result.message}`;
                Logger.error(TAG, this.modelPrepText);
            }
            this.statusText = this.modelPrepText;
        }
        catch (err) {
            const e = err as Error;
            this.modelPrepRatio = -1;
            this.modelPrepText = `内置模型解包异常：${e.message}`;
            this.statusText = this.modelPrepText;
            Logger.error(TAG, this.modelPrepText);
        }
    }
    // ------------------------------------------------------------ 设置持久化
    private settingsPath(): string {
        return `${this.rootDir()}/settings.json`;
    }
    loadSettings(): void {
        try {
            if (!fileExists(this.settingsPath())) {
                return;
            }
            const obj = JSON.parse(readTextFile(this.settingsPath())) as Record<string, Object>;
            this.preferNpu = asBool(obj, 'preferNpu', this.preferNpu);
            this.cpuThreads = asNumber(obj, 'cpuThreads', this.cpuThreads);
            this.autoTranslate = asBool(obj, 'autoTranslate', this.autoTranslate);
            this.useVad = asBool(obj, 'useVad', this.useVad);
            this.projectsDrawerPinned = asBool(obj, 'projectsDrawerPinned', this.projectsDrawerPinned);
            this.targetLang = asString(obj, 'targetLang', this.targetLang);
            this.translateEndpoint = asString(obj, 'translateEndpoint', this.translateEndpoint);
            this.translateApiKey = asString(obj, 'translateApiKey', this.translateApiKey);
            this.translateModel = asString(obj, 'translateModel', this.translateModel);
            this.translateProvider = asString(obj, 'translateProvider', this.translateProvider);
            this.translateSchemeName = asString(obj, 'translateSchemeName', this.translateSchemeName);
            this.translateTemperature = asNumber(obj, 'translateTemperature', this.translateTemperature);
            this.translateBatchSize = asNumber(obj, 'translateBatchSize', this.translateBatchSize);
            this.translateContextLines = asNumber(obj, 'translateContextLines', this.translateContextLines);
            this.translatePrompt = asString(obj, 'translatePrompt', this.translatePrompt);
            this.translateGlossary = asGlossary(obj['translateGlossary']);
            this.modelDownloadUrl = asString(obj, 'modelDownloadUrl', this.modelDownloadUrl);
            // 旧版本默认写死 gpt-4o-mini，但默认服务商是 DeepSeek 且没有接口地址。
            // 这种“从未生效过”的旧值迁移成服务商默认模型，避免界面上出现错配。
            if (this.translateEndpoint.trim().length === 0
                && this.translateModel.trim() === 'gpt-4o-mini') {
                this.translateModel = '';
            }
        }
        catch (err) {
            Logger.warn(TAG, '读取设置失败，使用默认值');
        }
    }
    saveSettings(): void {
        try {
            const obj: Record<string, Object> = {
                'preferNpu': this.preferNpu,
                'cpuThreads': this.cpuThreads,
                'autoTranslate': this.autoTranslate,
                'useVad': this.useVad,
                'projectsDrawerPinned': this.projectsDrawerPinned,
                'targetLang': this.targetLang,
                'translateEndpoint': this.translateEndpoint,
                'translateApiKey': this.translateApiKey,
                'translateModel': this.translateModel,
                'translateProvider': this.translateProvider,
                'translateSchemeName': this.translateSchemeName,
                'translateTemperature': this.translateTemperature,
                'translateBatchSize': this.translateBatchSize,
                'translateContextLines': this.translateContextLines,
                'translatePrompt': this.translatePrompt,
                'translateGlossary': this.translateGlossary,
                'modelDownloadUrl': this.modelDownloadUrl
            };
            writeTextFileAtomic(this.settingsPath(), JSON.stringify(obj, null, 2));
        }
        catch (err) {
            Logger.warn(TAG, '保存设置失败');
        }
    }
    // ------------------------------------------------------------ 翻译方案
    private translationSchemesPath(): string {
        return `${this.rootDir()}/translation-schemes.json`;
    }
    loadTranslationSchemes(): TranslationScheme[] {
        const out: TranslationScheme[] = [];
        try {
            if (!fileExists(this.translationSchemesPath())) {
                return out;
            }
            const raw = JSON.parse(readTextFile(this.translationSchemesPath())) as Object[];
            if (!Array.isArray(raw)) {
                return out;
            }
            for (let i = 0; i < raw.length; i++) {
                try {
                    // 本地方案保留 Key；导入导出时由设置页去掉。
                    out.push(parseTranslationScheme(JSON.stringify(raw[i]), true));
                }
                catch (err) {
                    Logger.warn(TAG, '跳过损坏的翻译方案');
                }
            }
        }
        catch (err) {
            Logger.warn(TAG, '读取翻译方案失败');
        }
        return out;
    }
    saveTranslationSchemes(list: TranslationScheme[]): void {
        try {
            this.translateSchemes = list;
            writeTextFileAtomic(this.translationSchemesPath(), JSON.stringify(list, null, 2));
        }
        catch (err) {
            Logger.warn(TAG, '保存翻译方案失败');
        }
    }
    currentTranslationScheme(): TranslationScheme {
        const s = new TranslationScheme();
        s.id = `scheme_${Date.now()}`;
        s.name = this.translateSchemeName;
        s.provider = this.translateProvider;
        s.endpoint = this.translateEndpoint;
        s.apiKey = this.translateApiKey;
        s.model = this.translateModel;
        s.temperature = this.translateTemperature;
        s.batchSize = this.translateBatchSize;
        s.contextLines = this.translateContextLines;
        s.prompt = this.translatePrompt;
        s.autoTranslate = this.autoTranslate;
        s.glossary = cloneGlossary(this.translateGlossary);
        return s;
    }
    upsertTranslationScheme(scheme: TranslationScheme): void {
        const list = this.translateSchemes.slice();
        let replaced = false;
        for (let i = 0; i < list.length; i++) {
            if (list[i].id === scheme.id || list[i].name === scheme.name) {
                list[i] = scheme;
                replaced = true;
            }
        }
        if (!replaced) {
            list.push(scheme);
        }
        this.saveTranslationSchemes(list);
    }
    applyTranslationScheme(scheme: TranslationScheme): void {
        this.translateSchemeName = scheme.name;
        this.translateProvider = scheme.provider;
        this.translateEndpoint = scheme.endpoint;
        this.translateApiKey = scheme.apiKey;
        this.translateModel = scheme.model;
        this.translateTemperature = scheme.temperature;
        this.translateBatchSize = scheme.batchSize;
        this.translateContextLines = scheme.contextLines;
        this.translatePrompt = scheme.prompt;
        this.autoTranslate = scheme.autoTranslate;
        this.translateGlossary = cloneGlossary(scheme.glossary);
        this.saveSettings();
        // 下一次识别/翻译使用新方案；释放旧流水线，避免继续用旧 translator。
        this.releaseEngine().catch((err: Error): void => {
            Logger.warn(TAG, `释放旧翻译流水线失败：${err.message}`);
        });
    }
    // ------------------------------------------------------------ 项目
    private projectIndexPath(): string {
        return `${this.projectsDir()}/index.json`;
    }
    loadProjects(): void {
        this.projects = [];
        try {
            if (!fileExists(this.projectIndexPath())) {
                return;
            }
            const arr = JSON.parse(readTextFile(this.projectIndexPath())) as ProjectMetaJson[];
            for (let i = 0; i < arr.length; i++) {
                const j = arr[i];
                const p = new ProjectMeta(j.id, j.name);
                p.mediaPath = j.mediaPath ?? '';
                p.mediaName = j.mediaName ?? '';
                p.durationSec = j.durationSec ?? 0;
                p.cueCount = j.cueCount ?? 0;
                p.updatedAt = j.updatedAt ?? 0;
                p.sourceLang = j.sourceLang ?? 'en';
                p.targetLang = j.targetLang ?? 'zh';
                this.projects.push(p);
            }
        }
        catch (err) {
            Logger.warn(TAG, '读取项目索引失败');
        }
    }
    saveProjects(): void {
        try {
            const arr: ProjectMetaJson[] = this.projects.map((p: ProjectMeta): ProjectMetaJson => {
                const j: ProjectMetaJson = {
                    id: p.id, name: p.name, mediaPath: p.mediaPath, mediaName: p.mediaName,
                    durationSec: p.durationSec, cueCount: p.cueCount, updatedAt: p.updatedAt,
                    sourceLang: p.sourceLang, targetLang: p.targetLang
                };
                return j;
            });
            writeTextFileAtomic(this.projectIndexPath(), JSON.stringify(arr, null, 2));
        }
        catch (err) {
            Logger.warn(TAG, '保存项目索引失败');
        }
    }
    private projectCuesPath(id: string): string {
        return `${this.projectsDir()}/${id}/cues.json`;
    }
    private projectSpeakersPath(id: string): string {
        return `${this.projectsDir()}/${id}/speakers.json`;
    }
    /** 读取项目人物登记；旧项目没有 speakers.json 时返回空数组。 */
    loadSpeakers(p: ProjectMeta): SpeakerRecord[] {
        const out: SpeakerRecord[] = [];
        const path = this.projectSpeakersPath(p.id);
        if (!fileExists(path)) {
            return out;
        }
        try {
            const arr = JSON.parse(readTextFile(path)) as SpeakerJson[];
            for (let i = 0; i < arr.length; i++) {
                const name = (arr[i].name ?? '').trim();
                if (name.length === 0) {
                    continue;
                }
                out.push(new SpeakerRecord(name, arr[i].color ?? ''));
            }
        }
        catch (err) {
            Logger.warn(TAG, '读取人物登记失败');
        }
        return out;
    }
    /** 写回人物登记；只保存名字和颜色，不复制字幕。 */
    saveSpeakers(p: ProjectMeta, speakers: SpeakerRecord[]): void {
        try {
            ensureDir(`${this.projectsDir()}/${p.id}`);
            const arr: SpeakerJson[] = speakers.map((s: SpeakerRecord): SpeakerJson => {
                const j: SpeakerJson = { name: s.name, color: s.color };
                return j;
            });
            writeTextFileAtomic(this.projectSpeakersPath(p.id), JSON.stringify(arr, null, 2));
        }
        catch (err) {
            Logger.warn(TAG, '保存人物登记失败');
        }
    }
    /** 新建项目。 */
    async createProject(name: string, mediaPath: string, mediaName: string): Promise<ProjectMeta> {
        const id = `p${Date.now()}`;
        const p = new ProjectMeta(id, name.length > 0 ? name : mediaName);
        p.mediaPath = mediaPath;
        p.mediaName = mediaName;
        p.updatedAt = Date.now();
        p.targetLang = this.targetLang;
        ensureDir(`${this.projectsDir()}/${id}`);
        this.projects.unshift(p);
        this.saveProjects();
        this.current = p;
        this.cues = [];
        Logger.info(TAG, `新建项目 ${p.name}（${id}）`);
        return p;
    }
    /** 打开项目：读回字幕。 */
    async openProject(p: ProjectMeta): Promise<void> {
        this.current = p;
        this.cues = [];
        try {
            const path = this.projectCuesPath(p.id);
            if (fileExists(path)) {
                const arr = JSON.parse(readTextFile(path)) as CueJson[];
                for (let i = 0; i < arr.length; i++) {
                    const j = arr[i];
                    const c = new Cue(j.index, j.start, j.end, j.source_text ?? '', j.target_text ?? '');
                    c.confidence = j.confidence ?? 0;
                    c.edited = j.edited ?? false;
                    c.wordChecked = j.word_checked ?? (j.words !== undefined && j.words.length > 0);
                    c.speaker = j.speaker ?? '';
                    c.speakerColor = j.speaker_color ?? '';
                    c.targetColor = j.target_color ?? '';
                    c.sourceColor = j.source_color ?? '';
                    c.wordColor = j.word_color ?? '';
                    if (j.words !== undefined) {
                        for (let k = 0; k < j.words.length; k++) {
                            const w = j.words[k];
                            c.words.push(new WordTiming(w.text, w.start, w.end));
                        }
                    }
                    this.cues.push(c);
                }
            }
        }
        catch (err) {
            Logger.warn(TAG, '读取项目字幕失败');
        }
        this.statusText = `已打开 ${p.name}（${this.cues.length} 条字幕）`;
    }
    /** 保存当前项目的字幕。 */
    async saveCurrent(): Promise<void> {
        const p = this.current;
        if (p === null) {
            return;
        }
        try {
            ensureDir(`${this.projectsDir()}/${p.id}`);
            const arr: CueJson[] = this.cues.map((c: Cue): CueJson => {
                const words: CueWordJson[] = c.words.map((w: WordTiming): CueWordJson => {
                    const j: CueWordJson = { text: w.text, start: w.start, end: w.end };
                    return j;
                });
                const j: CueJson = {
                    index: c.index, start: c.start, end: c.end,
                    source_text: c.sourceText, target_text: c.targetText,
                    confidence: c.confidence, edited: c.edited, words: words,
                    word_checked: c.wordChecked,
                    speaker: c.speaker, speaker_color: c.speakerColor,
                    target_color: c.targetColor, source_color: c.sourceColor, word_color: c.wordColor
                };
                return j;
            });
            writeTextFileAtomic(this.projectCuesPath(p.id), JSON.stringify(arr));
            p.cueCount = this.cues.length;
            p.updatedAt = Date.now();
            this.saveProjects();
        }
        catch (err) {
            Logger.warn(TAG, '保存字幕失败');
        }
    }
    async deleteProject(p: ProjectMeta): Promise<void> {
        const idx = this.projects.indexOf(p);
        if (idx >= 0) {
            this.projects.splice(idx, 1);
        }
        if (this.current === p) {
            this.current = null;
            this.cues = [];
        }
        deleteTree(`${this.projectsDir()}/${p.id}`);
        this.projects = this.projects.slice();
        this.saveProjects();
    }
    /** 只改工程显示名，不动 media / 字幕 / 目录。 */
    renameProject(p: ProjectMeta, name: string): void {
        const next: string = name.trim();
        if (next.length === 0 || next === p.name) {
            return;
        }
        p.name = next;
        p.updatedAt = Date.now();
        this.projects = this.projects.slice();
        this.saveProjects();
    }
    // ------------------------------------------------------------ 识别
    /** 按需构建流水线（引擎 + 解码器 + 翻译器）。 */
    private async ensurePipeline(): Promise<Pipeline> {
        if (this.pipeline !== null) {
            return this.pipeline;
        }
        const files = this.modelFiles();
        const missing = files.missing();
        if (missing.length > 0) {
            throw new Error(`缺少模型文件：${missing.join('、')}。请到「模型」页面准备。`);
        }
        // 引擎先自行加载（它知道该选 NPU 还是 CPU，并处理降级），
        // 再把已就绪的模型句柄交给流水线，避免重复加载 622 MB 的编码器。
        const engine = new ParakeetEngine(files, this.preferNpu, this.cpuThreads);
        await engine.init();
        this.engine = engine;
        this.backendLabel = engine.backend;
        const translateOptions = new TranslateOptions();
        translateOptions.provider = this.translateProvider;
        translateOptions.temperature = this.translateTemperature;
        translateOptions.batchSize = this.translateBatchSize;
        translateOptions.prompt = this.translatePrompt;
        translateOptions.glossary = cloneGlossary(this.translateGlossary);
        this.translator = new TranslationService(this.translateEndpoint, this.translateApiKey, this.translateModel, translateOptions);
        // Key 为空时不挂翻译器；地址留空由 TranslationService 按服务商取默认地址。
        const translator: ITranslator | null = this.translateApiKey.trim().length > 0 ? this.translator : null;
        const pipeline = new Pipeline(engine.modelHandle(), engine.vocabulary, this.decoder, translator, undefined, (m: string): void => Logger.info('Pipeline', m));
        pipeline.config.autoTranslate = this.autoTranslate;
        pipeline.config.useVad = this.useVad;
        pipeline.config.targetLang = this.targetLang;
        pipeline.config.contextCues = this.translateContextLines;
        this.pipeline = pipeline;
        return pipeline;
    }
    /** 释放引擎（切换 NPU/CPU 设置后需要重建）。 */
    async releaseEngine(): Promise<void> {
        if (this.engine !== null) {
            await this.engine.release();
            this.engine = null;
        }
        this.pipeline = null;
    }
    /** 供页面探测媒体时长用的解码器。 */
    decoderForProbe(): IAudioDecoder {
        return this.decoder;
    }
    /** 直接识别一段内存里的样本（麦克风听写用）。 */
    async transcribeSamples(samples: Float64Array): Promise<string> {
        const pipeline = await this.ensurePipeline();
        return pipeline.transcribeSamples(samples);
    }
    /** 对当前项目跑完整识别。 */
    async runRecognition(): Promise<void> {
        const p = this.current;
        if (p === null || p.mediaPath.length === 0) {
            this.statusText = '请先导入媒体文件';
            return;
        }
        this.runState = RunState.BUSY;
        this.cues = [];
        this.progress = new Progress(Stage.DECODE, '准备中…');
        try {
            const pipeline = await this.ensurePipeline();
            const generatedAudio = `${this.projectsDir()}/${p.id}/editor-audio.wav`;
            const cues = await pipeline.run(fileExists(generatedAudio) ? generatedAudio : p.mediaPath, (pr: Progress): void => {
                this.progress = pr;
                this.statusText = pr.message;
            }, (cue: Cue): void => {
                // 数组 push 不会触发 UI 刷新，重新赋值一次。
                this.cues = this.cues.concat([cue]);
            });
            this.cues = cues;
            p.cueCount = cues.length;
            const decoded = pipeline.decodedAudio;
            if (decoded !== null) {
                p.durationSec = decoded.length / 16000;
            }
            await this.saveCurrent();
            this.runState = RunState.DONE;
            this.statusText = `识别完成：${cues.length} 条字幕`;
        }
        catch (err) {
            const e = err as Error;
            this.runState = RunState.FAILED;
            this.statusText = `识别失败：${e.message}`;
            // 带堆栈记录：像 "Cannot read property 'length' of undefined"
            // 这类 TypeError 只看 message 无法定位到具体行。
            Logger.errorWithCause(TAG, '识别', err as Object);
        }
    }
    cancelRecognition(): void {
        if (this.pipeline !== null) {
            this.pipeline.cancel();
            this.runState = RunState.CANCELLING;
            this.statusText = '正在取消…';
        }
    }
    /** 重新识别一条。 */
    async retranscribe(index: number): Promise<void> {
        const pipeline = this.pipeline;
        if (pipeline === null || index < 0 || index >= this.cues.length) {
            return;
        }
        this.statusText = `正在重新识别第 ${index + 1} 条…`;
        await pipeline.retranscribeCue(this.cues[index]);
        this.cues = this.cues.slice();
        await this.saveCurrent();
        this.statusText = '已重新识别';
    }
    /** 重新翻译一条。 */
    async retranslate(index: number): Promise<void> {
        const pipeline = this.pipeline;
        if (pipeline === null || index < 0 || index >= this.cues.length) {
            return;
        }
        this.statusText = `正在重新翻译第 ${index + 1} 条…`;
        await pipeline.retranslateCue(this.cues[index]);
        this.cues = this.cues.slice();
        await this.saveCurrent();
        this.statusText = '已重新翻译';
    }
    /** 批量重做（跳过手工编辑过的行）。 */
    async redoAll(which: string): Promise<void> {
        const pipeline = this.pipeline;
        if (pipeline === null) {
            this.statusText = '请先执行一次识别以加载模型';
            return;
        }
        this.runState = RunState.BUSY;
        await pipeline.redoCues(this.cues, which, (pr: Progress): void => {
            this.progress = pr;
            this.statusText = pr.message;
        });
        this.cues = this.cues.slice();
        await this.saveCurrent();
        this.runState = RunState.DONE;
        this.statusText = '批量重做完成';
    }
    // ------------------------------------------------------------ 导入导出
    /** 导入已有字幕（只翻译或校对）。 */
    async importSubtitle(uri: string, asTranslated: boolean): Promise<void> {
        try {
            const imported = readAsCues(readTextFile(uri), asTranslated);
            if (imported.length === 0) {
                this.statusText = '没有解析出任何字幕行';
                return;
            }
            this.cues = imported;
            await this.saveCurrent();
            this.statusText = `已导入 ${imported.length} 条字幕`;
        }
        catch (err) {
            const e = err as Error;
            this.statusText = `导入失败：${e.message}`;
        }
    }
    /**
     * 导出字幕。
     * @param kind 'source' | 'target' | 'bilingual' | 'vtt' | 'ass' | 'ass-karaoke' | 'json'
     * @returns 导出文件路径
     */
    exportAs(kind: string): string {
        const dir = `${this.rootDir()}/exports`;
        ensureDir(dir);
        const base = this.current === null ? 'subtitle'
            : (this.current.name.length > 0 ? this.current.name : 'subtitle');
        const stamp = Date.now();
        let path = '';
        let content = '';
        if (kind === 'source') {
            path = `${dir}/${base}_source_${stamp}.srt`;
            content = writeSrt(this.cues, false, true);
        }
        else if (kind === 'target') {
            path = `${dir}/${base}_target_${stamp}.srt`;
            content = writeSrt(this.cues, false, false);
        }
        else if (kind === 'bilingual') {
            path = `${dir}/${base}_bilingual_${stamp}.srt`;
            content = writeSrt(this.cues, true);
        }
        else if (kind === 'vtt') {
            path = `${dir}/${base}_${stamp}.vtt`;
            content = writeVtt(this.cues);
        }
        else if (kind === 'ass') {
            path = `${dir}/${base}_${stamp}.ass`;
            content = writeAss(this.cues);
        }
        else if (kind === 'ass-karaoke') {
            const opts = new AssExportOptions();
            opts.karaoke = true;
            path = `${dir}/${base}_karaoke_${stamp}.ass`;
            content = writeAss(this.cues, opts);
        }
        else {
            path = `${dir}/${base}_${stamp}.json`;
            content = writeJson(this.cues);
        }
        writeTextFile(path, content);
        Logger.info(TAG, `已导出 ${path}`);
        return path;
    }
    /** 模型状态摘要，供「模型」页面展示。 */
    modelStatus(): string {
        const missing = this.modelFiles().missing();
        if (missing.length === 0) {
            return '模型已就绪';
        }
        return `缺少 ${missing.join('、')}`;
    }
    hasModels(): boolean {
        return this.modelFiles().missing().length === 0;
    }
}
function asBool(o: Record<string, Object>, k: string, d: boolean): boolean {
    const v = o[k];
    return typeof v === 'boolean' ? v as boolean : d;
}
function asNumber(o: Record<string, Object>, k: string, d: number): number {
    const v = o[k];
    return typeof v === 'number' ? v as number : d;
}
function asString(o: Record<string, Object>, k: string, d: string): string {
    const v = o[k];
    return typeof v === 'string' ? v as string : d;
}
function asGlossary(value: Object): GlossaryGroup[] {
    const out: GlossaryGroup[] = [];
    if (!Array.isArray(value)) {
        return out;
    }
    const groups = value as Object[];
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i] as GlossaryJson;
        if (group === null || group === undefined) {
            continue;
        }
        const lang = group.lang === 'zh-Hant' || group.lang === 'en' ? group.lang : 'zh';
        const entries: GlossaryEntry[] = [];
        if (Array.isArray(group.entries)) {
            const rawEntries = group.entries as GlossaryEntryJson[];
            for (let k = 0; k < rawEntries.length; k++) {
                const e = rawEntries[k];
                if (e === null || e === undefined) {
                    continue;
                }
                const term = (e.term ?? '').trim();
                const translation = (e.translation ?? '').trim();
                if (term.length > 0 && translation.length > 0) {
                    entries.push(new GlossaryEntry(term, translation));
                }
            }
        }
        out.push(new GlossaryGroup(lang, entries));
    }
    return out;
}
interface ProjectMetaJson {
    id: string;
    name: string;
    mediaPath?: string;
    mediaName?: string;
    durationSec?: number;
    cueCount?: number;
    updatedAt?: number;
    sourceLang?: string;
    targetLang?: string;
}
interface CueJson {
    index: number;
    start: number;
    end: number;
    source_text?: string;
    target_text?: string;
    confidence?: number;
    edited?: boolean;
    word_checked?: boolean;
    words?: CueWordJson[];
    speaker?: string;
    speaker_color?: string;
    target_color?: string;
    source_color?: string;
    word_color?: string;
}
interface SpeakerJson {
    name: string;
    color: string;
}
interface CueWordJson {
    text: string;
    start: number;
    end: number;
}
