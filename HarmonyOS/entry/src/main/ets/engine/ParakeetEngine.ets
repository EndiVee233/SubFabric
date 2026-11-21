import { fileIo as fs } from "@kit.CoreFileKit";
import { ParakeetTdtDecoder, EncoderOutput, JointStepOutput, BLANK_TOKEN_ID, JOINT_OUT_DIM, ENCODER_WINDOW_FRAMES } from "common";
import type { IParakeetModel } from "common";
import type { Transcription } from "common";
import { MsLiteModel, MsLiteRuntime, toTensorBuffer, toInt32Buffer } from "./MindSporeLite";
import type { MsLiteContext } from "./MindSporeLite";
import { Logger } from "./Logger";
import { readTextFile } from "../platform/FileUtil";
const TAG = 'Parakeet';
/**
 * 编码器常量（必须与所选模型的 ONNX 导出一致）。
 *
 * ⚠️ `ENC_HIDDEN` 随模型变：
 *   0.6b-v2 -> 1024 ； 110m -> 512
 * 当前配的是 **110M 模型**。这个值用错会让转置/取帧全部错位，
 * 而报错往往只是「输出形状不符」或结果乱码，不好查。
 *
 * 帧数 188 两者相同：1501 mel 帧 / 8 倍下采样 ≈ 188（实测 onnxruntime
 * 跑 110M encoder 的输出正是 (1, 512, 188)）。
 */
const ENC_HIDDEN: number = 512;
const DEC_HIDDEN: number = 640;
/** joint 输出：1025 词表 + 5 个时长头。 */
const JOINT_DIM: number = JOINT_OUT_DIM;
/** 固定的编码器窗宽。 */
const WIN: number = ENCODER_WINDOW_FRAMES;
/** 一个编码器窗对应的编码器帧数（1501 帧 mel / 8 倍下采样 -> 188）。 */
const ENC_FRAMES_PER_WINDOW: number = 188;
/** 模型文件集合。 */
export class ParakeetModelFiles {
    readonly encoder: string;
    readonly decoderJoint: string;
    readonly vocab: string;
    /**
     * encoder 的外部权重文件（`.msw`）。
     *
     * MindSpore Lite 的 MINDIR_LITE 在权重较大时会把它外置到同名 `.msw`，
     * `.ms` 里只留图结构（约 0.5 MB）。Parakeet 的 encoder 权重约 2 GB，
     * **必然**产生 `.msw`。缺失时模型加载失败，而报错不会指向「缺文件」，
     * 只表现为识别结果为空——很难查，所以当作必需文件。
     */
    readonly encoderWeights: string;
    constructor(encoder: string, decoderJoint: string, vocab: string, encoderWeights: string = '') {
        this.encoder = encoder;
        this.decoderJoint = decoderJoint;
        this.vocab = vocab;
        this.encoderWeights = encoderWeights;
    }
    /** 必需文件是否都存在。 */
    complete(): boolean {
        return exists(this.encoder) && exists(this.decoderJoint) && exists(this.vocab)
            && (this.encoderWeights.length === 0 || exists(this.encoderWeights));
    }
    /** 缺失的文件名列表，用于提示用户。 */
    missing(): string[] {
        const out: string[] = [];
        if (!exists(this.encoder)) {
            out.push('encoder.ms');
        }
        if (this.encoderWeights.length > 0 && !exists(this.encoderWeights)) {
            out.push('encoder.msw');
        }
        if (!exists(this.decoderJoint)) {
            out.push('decoder_joint.ms');
        }
        if (!exists(this.vocab)) {
            out.push('vocab.txt');
        }
        return out;
    }
}
function exists(path: string): boolean {
    try {
        return fs.accessSync(path);
    }
    catch (err) {
        return false;
    }
}
/**
 * 用 MindSpore Lite 实现的 Parakeet 模型后端。
 *
 * 实现 `IParakeetModel`，因此可以直接喂给 common 里的 ParakeetTdtDecoder。
 */
export class MsLiteParakeetModel implements IParakeetModel {
    private readonly files: ParakeetModelFiles;
    private readonly preferNpu: boolean;
    private readonly cpuThreads: number;
    private encoder: MsLiteModel | null = null;
    private joint: MsLiteModel | null = null;
    private loaded: boolean = false;
    private backend: string = '未加载';
    /** 编码器上一次推理的输出 [frames, 1024]，供 joint 按帧取用。 */
    private lastEncOut: Float32Array | null = null;
    constructor(files: ParakeetModelFiles, preferNpu: boolean = true, cpuThreads: number = 4) {
        this.files = files;
        this.preferNpu = preferNpu;
        this.cpuThreads = cpuThreads;
    }
    // ------------------------------------------------------- IParakeetModel
    encoderHidden(): number {
        return ENC_HIDDEN;
    }
    decoderHidden(): number {
        return DEC_HIDDEN;
    }
    jointOutDim(): number {
        return JOINT_DIM;
    }
    isLoaded(): boolean {
        return this.loaded;
    }
    backendName(): string {
        return this.backend;
    }
    /**
     * 加载两个 `.ms` 模型。
     *
     * 编码器按用户偏好选择 NNRt/CPU；joint **强制 CPU**，并在日志里说明原因，
     * 避免用户误以为识别整体没走 NPU。
     */
    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        // ================== 强制 NPU（用户要求，不允许 CPU 推理）==================
        //
        // 这里的策略是「**失败就报错，绝不降级**」：
        // 任何一环拿不到 NPU 后端，直接抛错终止识别，并在日志里写明原因。
        // 这样能保证「跑出来的结果一定是 NPU 算的」，不会出现
        // 「以为在用 NPU、其实在跑 CPU」这种误导。
        const encCtx: MsLiteContext = MsLiteRuntime.buildContext(true, this.cpuThreads);
        const jointCtx: MsLiteContext = MsLiteRuntime.buildContext(true, this.cpuThreads);
        if (!encCtx.isNpu) {
            throw new Error('当前设备/环境不可用 NPU（NNRt）。'
                + '按设置已禁用 CPU 推理，识别终止。'
                + '请在设置里确认「优先使用 NPU」已开启，且设备支持 NNRt。');
        }
        Logger.info(TAG, `强制 NPU：编码器与 joint 均使用 NNRt（${encCtx.label}）`);
        // ---- 编码器（NPU，失败即终止）
        const enc = new MsLiteModel(this.files.encoder, encCtx);
        await enc.load();
        if (!enc.canInfer) {
            // NNRt 下 `model.getInputs()` 返回 undefined 是实测过的行为。
            // 不允许回退 CPU，所以这里直接失败并把原因讲清楚。
            throw new Error(`编码器在 NPU 上加载成功，但拿不到输入张量对象`
                + `（model.getInputs() 返回空），无法构造推理入参。`
                + `按设置已禁用 CPU 兜底，识别终止。`
                + `这是 ArkTS 侧 MindSpore Lite 绑定在 NNRt 后端的行为，`
                + `需要在 NAPI 层直接调 C++ API 才能绕开。`);
        }
        this.encoder = enc;
        // ---- 预测网络 + joint（同样强制 NPU）
        const joint = new MsLiteModel(this.files.decoderJoint, jointCtx);
        await joint.load();
        if (!joint.canInfer) {
            throw new Error(`预测/joint 在 NPU 上拿不到输入张量对象，无法推理。`
                + `按设置已禁用 CPU 兜底，识别终止。`);
        }
        this.joint = joint;
        this.backend = this.encoder.backendLabel;
        Logger.info(TAG, `模型就绪（全部 NPU）：编码器=${this.encoder.backendLabel}，`
            + `预测/joint=${joint.backendLabel}`);
        this.loaded = true;
    }
    async release(): Promise<void> {
        this.loaded = false;
        this.lastEncOut = null;
        const e = this.encoder;
        const j = this.joint;
        this.encoder = null;
        this.joint = null;
        if (e !== null) {
            await e.release();
        }
        if (j !== null) {
            await j.release();
        }
    }
    /**
     * 运行编码器。
     *
     * 输入布局与 `.ms` 转换约定一致：
     *   audio_signal: float32 [1, 128, 1501]（行主序 mel）
     *   length:       int32   [1]            有效 mel 帧数
     * 输出：
     *   outputs:         float32 [1, 1024, 188]
     *   encoded_lengths: int32   [1]
     */
    async runEncoder(mel: Float32Array, validFrames: number): Promise<EncoderOutput> {
        const enc = this.encoder;
        if (enc === null) {
            throw new Error('编码器未加载');
        }
        const inputs = new Map<string, ArrayBuffer>();
        inputs.set('audio_signal', toTensorBuffer(mel));
        inputs.set('length', toInt32Buffer([validFrames]));
        const outs = await enc.predict(inputs);
        if (outs.length === 0) {
            throw new Error('编码器没有返回任何输出张量');
        }
        // 按名字取，不按下标 —— 转换器对输出顺序不作保证。
        const raw = enc.outputByName(outs, 'outputs');
        if (raw === null) {
            throw new Error(`编码器输出里找不到 'outputs'（实际有 [${enc.lastOutputNames.join(', ')}]）`);
        }
        // [1, 1024, 188] -> 转置成 [188, 1024]，方便解码器按帧访问。
        const frames = raw.length >= ENC_HIDDEN * ENC_FRAMES_PER_WINDOW
            ? ENC_FRAMES_PER_WINDOW
            : Math.floor(raw.length / ENC_HIDDEN);
        const acts = new Float32Array(frames * ENC_HIDDEN);
        for (let t = 0; t < frames; t++) {
            for (let h = 0; h < ENC_HIDDEN; h++) {
                acts[t * ENC_HIDDEN + h] = raw[h * frames + t];
            }
        }
        let encLen = frames;
        const lenTensor = enc.outputByName(outs, 'encoded_lengths');
        if (lenTensor !== null && lenTensor.length > 0) {
            // encoded_lengths 在 ONNX 里是 int64；int8 转换后可能是 int32。
            // 这里只取首元素，两种精度下数值都远小于 2^24，安全。
            encLen = Math.round(lenTensor[0]);
        }
        this.lastEncOut = acts;
        return new EncoderOutput(acts, frames, ENC_HIDDEN, Math.min(encLen, frames));
    }
    /**
     * 运行预测网络 + joint 的单步。
     *
     * 与 PC 端 OpenVINO 实现的差异：`.ms` 里 `encoder_outputs` 是**单帧**
     * `[1,1024,1]`（而不是整窗）。这样切的原因见文件头注释：
     * TDT 解码留在 ArkTS 侧，模型只保留最小的联合图算子集，
     * 既更容易被 MindSpore Lite 接受，也避免在 NPU 上触发不支持的算子。
     */
    async runJoint(token: number, hidden: Float32Array, cell: Float32Array, frameIndex: number): Promise<JointStepOutput> {
        const joint = this.joint;
        const encOut = this.lastEncOut;
        if (joint === null) {
            throw new Error('预测/joint 模型未加载');
        }
        if (encOut === null) {
            throw new Error('尚未运行编码器');
        }
        const frame = new Float32Array(ENC_HIDDEN);
        const base = frameIndex * ENC_HIDDEN;
        for (let i = 0; i < ENC_HIDDEN; i++) {
            frame[i] = encOut[base + i];
        }
        const inputs = new Map<string, ArrayBuffer>();
        inputs.set('encoder_outputs', toTensorBuffer(frame));
        inputs.set('targets', toInt32Buffer([token]));
        inputs.set('target_length', toInt32Buffer([1]));
        inputs.set('input_states_1', toTensorBuffer(hidden));
        inputs.set('input_states_2', toTensorBuffer(cell));
        const outs = await joint.predict(inputs);
        const logits = new Float32Array(JOINT_DIM);
        const rawLogits = joint.outputByName(outs, 'outputs');
        if (rawLogits !== null) {
            const n = Math.min(rawLogits.length, JOINT_DIM);
            for (let i = 0; i < n; i++) {
                logits[i] = rawLogits[i];
            }
        }
        // ⚠️ decoder_joint 实际有 4 个输出：
        //     outputs, prednet_lengths, output_states_1, output_states_2
        // 早期版本按「下标 1/2」取值，会把 prednet_lengths 当成 LSTM 隐状态、
        // 把 output_states_1 当成细胞状态 —— 状态错位，识别结果必然是垃圾。
        // 因此改为**按名字取**；取不到时退回传入的状态，至少不会污染。
        const h = joint.outputByName(outs, 'output_states_1');
        const c = joint.outputByName(outs, 'output_states_2');
        return new JointStepOutput(logits, h ?? hidden, c ?? cell);
    }
}
/** 识别引擎：模型 + 词表 + 解码器。 */
export class ParakeetEngine {
    private readonly model: MsLiteParakeetModel;
    private readonly files: ParakeetModelFiles;
    private decoder: ParakeetTdtDecoder | null = null;
    private vocab: string[] = [];
    constructor(files: ParakeetModelFiles, preferNpu: boolean = true, cpuThreads: number = 4) {
        this.files = files;
        this.model = new MsLiteParakeetModel(files, preferNpu, cpuThreads);
    }
    get backend(): string {
        return this.model.backendName();
    }
    isReady(): boolean {
        return this.decoder !== null;
    }
    /**
     * 供 Pipeline 使用的模型句柄。
     *
     * 必须在本引擎 `init()` 之后再交给 Pipeline，
     * 否则 Pipeline 会去加载一个尚未配置好后端的模型。
     */
    modelHandle(): MsLiteParakeetModel {
        return this.model;
    }
    /** 已加载的词表（`init()` 之后有效）。 */
    get vocabulary(): string[] {
        return this.vocab;
    }
    /** 加载模型与词表。 */
    async init(): Promise<void> {
        if (this.decoder !== null) {
            return;
        }
        if (!this.model.isLoaded()) {
            await this.model.load();
        }
        this.vocab = loadVocab(this.files.vocab);
        if (this.vocab.length === 0) {
            throw new Error('词表为空或无法读取');
        }
        const problem = validateVocab(this.vocab);
        if (problem.length > 0) {
            // 只告警不阻断：词表多/少几项仍可能工作，让用户看到真实原因。
            Logger.warn(TAG, `词表校验异常：${problem}`);
        }
        this.decoder = new ParakeetTdtDecoder(this.model, this.vocab, undefined, (m: string): void => Logger.info(TAG, m));
        Logger.info(TAG, `引擎就绪：词表 ${this.vocab.length} 项，后端 ${this.model.backendName()}`);
    }
    /** 识别 16 kHz 单声道音频。 */
    async transcribe(samples: Float64Array): Promise<Transcription> {
        await this.init();
        const dec = this.decoder;
        if (dec === null) {
            throw new Error('解码器未初始化');
        }
        return dec.transcribe(samples);
    }
    async release(): Promise<void> {
        this.decoder = null;
        await this.model.release();
    }
}
/** 读取 SentencePiece 词表：每行 "piece id"，去掉行尾 id。 */
export function loadVocab(path: string): string[] {
    let text = '';
    try {
        text = readTextFile(path);
    }
    catch (err) {
        const e = err as Error;
        Logger.error(TAG, `读取词表失败：${e.message}`);
        return [];
    }
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (line.trim().length === 0) {
            continue;
        }
        // 最后一段是序号时剥掉；否则整行都是片段（含空格的特殊 token）。
        const sp = line.lastIndexOf(' ');
        if (sp > 0) {
            const tail = line.substring(sp + 1);
            if (/^\d+$/.test(tail)) {
                out.push(line.substring(0, sp));
                continue;
            }
        }
        out.push(line);
    }
    return out;
}
/** 检查 blank id 是否与词表一致（不一致说明词表或模型版本不匹配）。 */
export function validateVocab(vocab: string[]): string {
    if (vocab.length === 0) {
        return '词表为空';
    }
    if (vocab.length !== BLANK_TOKEN_ID + 1) {
        return `词表有 ${vocab.length} 项，期望 ${BLANK_TOKEN_ID + 1}`;
    }
    return '';
}
