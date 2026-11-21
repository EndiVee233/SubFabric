/*
 * SubFabric HarmonyOS 跨端共享核心（HAR）公开入口。
 *
 * 这些模块全部是**纯 ArkTS**：不 import 任何 @ohos / @kit，也不依赖 ArkUI。
 * 好处有两个：
 *   1. 同一份代码在手机、平板、折叠屏上完全一致，端侧差异只在 entry 模块；
 *   2. 可以在 PC 上用 Node 直接跑单元测试（见 harmony/verify），
 *      本仓库的 log-mel 前端已与 Python 参考实现逐值对拍通过。
 *
 * 注意导入路径：HAR 的入口文件在**模块根目录**，而源码在 `src/main/ets/` 下，
 * 因此这里必须写 `./src/main/ets/...`，不能写 `./model/Cue`。
 */

// ---------------------------------------------------------------- 数据模型
export {
  Cue, WordTiming, MediaInfo, Progress, Stage, DecodeStats, Transcription
} from './src/main/ets/model/Cue';

// ---------------------------------------------------------------- 工具
export {
  formatTimestamp, formatAssTime, parseTimestamp, formatClock, formatSeconds
} from './src/main/ets/util/TimeUtil';

// ---------------------------------------------------------------- 语音识别
export {
  MelFrontend, MelFrameSet, FftWorkspace, Rfft512,
  melFilterbank, hzToMel, melToHz,
  pcm16ToFloat, resampleTo16k,
  SAMPLE_RATE, N_FFT, WIN_LENGTH, HOP_LENGTH, N_MELS, LOG_GUARD, MEL_FRAME_RATE
} from './src/main/ets/asr/MelFrontend';

export {
  ParakeetTdtDecoder, TdtState, TokenTiming, EncoderOutput, JointStepOutput,
  DecoderConfig, WordResult, SpeechSegment, SegmentOptions,
  detectSpeech, segmentsFromWords,
  BLANK_TOKEN_ID, MEL_BINS, DURATION_BINS, JOINT_OUT_DIM,
  ENCODER_WINDOW_FRAMES, ENCODER_DOWNSAMPLE, ENCODER_FRAME_RATE, WORD_BOUNDARY
} from './src/main/ets/asr/TdtDecoder';
export type { IParakeetModel } from './src/main/ets/asr/TdtDecoder';

// ---------------------------------------------------------------- 字幕读写
export {
  readSubtitles, readAsCues, writeSrt, writeSourceSrt, writeVtt, writeJson, writeAss,
  writeKaraokeAss, karaokeEvents, cuesToPlainText,
  assEscape, assSafQuote, looksChinese, stripBom, normalizeNewlines,
  AssStyle, AssExportOptions
} from './src/main/ets/subtitle/SubtitleIo';

// ---------------------------------------------------------------- 流水线
export {
  Pipeline, PipelineConfig, CancelledError
} from './src/main/ets/subtitle/Pipeline';
export type { IAudioDecoder, ITranslator, ProgressListener, CueListener }
  from './src/main/ets/subtitle/Pipeline';
