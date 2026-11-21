/*
 * FFmpeg 媒体桥：AV1 软件解码转 H.264 代理。
 *
 * 为什么需要：
 *   - 编辑器优先让系统 Video 播放原片（H.264/H.265 走硬件）。
 *   - AV1 在部分设备上没有系统解码器；这时用随包的 FFmpeg 解码 AV1，
 *     再用 libopenh264 编码成 H.264 MP4 代理，交给系统播放器。
 *   - 转码在 N-API async work 线程里跑，ArkTS 侧用 Promise + 进度轮询。
 *
 * 只暴露最小接口：
 *   probeMedia(path) -> JSON
 *   hasAv1Hardware() -> boolean
 *   transcodeToH264(input, output, maxHeight, bitrateKbps) -> Promise<JSON>
 *   getTranscodeProgress() -> number
 *   cancelTranscode() -> void
 */

#include <napi/native_api.h>
#include <hilog/log.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avcapability.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

namespace {

#undef LOG_DOMAIN
#define LOG_DOMAIN 0x5F01
constexpr const char* TAG = "SFMedia";
#define LOGI(...) OH_LOG_Print(LOG_APP, LOG_INFO, LOG_DOMAIN, TAG, __VA_ARGS__)
#define LOGW(...) OH_LOG_Print(LOG_APP, LOG_WARN, LOG_DOMAIN, TAG, __VA_ARGS__)
#define LOGE(...) OH_LOG_Print(LOG_APP, LOG_ERROR, LOG_DOMAIN, TAG, __VA_ARGS__)

std::atomic<int> g_progress{0};
std::atomic<bool> g_cancel{false};
std::atomic<int> g_videoPacketCount{0};

std::string JsString(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return "";
  }
  std::string out(length, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, out.data(), length + 1, &copied) != napi_ok) {
    return "";
  }
  out.resize(copied);
  return out;
}

napi_value MakeString(napi_env env, const std::string& text) {
  napi_value out = nullptr;
  napi_create_string_utf8(env, text.c_str(), text.size(), &out);
  return out;
}

napi_value MakeNumber(napi_env env, double value) {
  napi_value out = nullptr;
  napi_create_double(env, value, &out);
  return out;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value out = nullptr;
  napi_get_boolean(env, value, &out);
  return out;
}

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

std::string JsonEscape(const std::string& input) {
  std::string out;
  out.reserve(input.size() + 8);
  for (char c : input) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c; break;
    }
  }
  return out;
}

struct MediaProbe {
  bool ok = false;
  std::string error;
  std::string container;
  std::string videoCodec;
  std::string audioCodec;
  int width = 0;
  int height = 0;
  double duration = 0;
  double fps = 0;
  bool hasAudio = false;
};

MediaProbe Probe(const std::string& path) {
  MediaProbe info;
  AVFormatContext* fmt = nullptr;
  int ret = avformat_open_input(&fmt, path.c_str(), nullptr, nullptr);
  if (ret < 0) {
    info.error = "open input failed";
    return info;
  }
  ret = avformat_find_stream_info(fmt, nullptr);
  if (ret < 0) {
    info.error = "find stream info failed";
    avformat_close_input(&fmt);
    return info;
  }
  info.ok = true;
  if (fmt->iformat != nullptr && fmt->iformat->name != nullptr) {
    info.container = fmt->iformat->name;
  }
  if (fmt->duration != AV_NOPTS_VALUE) {
    info.duration = static_cast<double>(fmt->duration) / AV_TIME_BASE;
  }
  for (unsigned i = 0; i < fmt->nb_streams; i++) {
    AVStream* stream = fmt->streams[i];
    const AVCodecParameters* par = stream->codecpar;
    if (par->codec_type == AVMEDIA_TYPE_VIDEO && info.videoCodec.empty()) {
      const AVCodec* codec = avcodec_find_decoder(par->codec_id);
      info.videoCodec = codec != nullptr ? codec->name : avcodec_get_name(par->codec_id);
      info.width = par->width;
      info.height = par->height;
      AVRational rate = av_guess_frame_rate(fmt, stream, nullptr);
      if (rate.num > 0 && rate.den > 0) {
        info.fps = static_cast<double>(rate.num) / rate.den;
      }
    } else if (par->codec_type == AVMEDIA_TYPE_AUDIO && info.audioCodec.empty()) {
      const AVCodec* codec = avcodec_find_decoder(par->codec_id);
      info.audioCodec = codec != nullptr ? codec->name : avcodec_get_name(par->codec_id);
      info.hasAudio = true;
    }
  }
  avformat_close_input(&fmt);
  return info;
}

napi_value NapiProbe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "probeMedia expects a path");
    return nullptr;
  }
  MediaProbe probe = Probe(JsString(env, args[0]));
  if (!probe.ok) {
    return MakeString(env, "{\"ok\":false,\"error\":\"" + JsonEscape(probe.error) + "\"}");
  }
  char buffer[512];
  std::snprintf(buffer, sizeof(buffer),
                "{\"ok\":true,\"container\":\"%s\",\"videoCodec\":\"%s\","
                "\"audioCodec\":\"%s\",\"width\":%d,\"height\":%d,\"duration\":%.3f,"
                "\"fps\":%.3f,\"hasAudio\":%s}",
                JsonEscape(probe.container).c_str(), JsonEscape(probe.videoCodec).c_str(),
                JsonEscape(probe.audioCodec).c_str(), probe.width, probe.height,
                probe.duration, probe.fps, probe.hasAudio ? "true" : "false");
  return MakeString(env, buffer);
}

napi_value NapiHasAv1Hardware(napi_env env, napi_callback_info info) {
  (void)info;
  OH_AVCapability* cap =
    OH_AVCodec_GetCapabilityByCategory(OH_AVCODEC_MIMETYPE_VIDEO_AV1, false, HARDWARE);
  if (cap == nullptr) {
    return MakeBool(env, false);
  }
  bool hardware = OH_AVCapability_IsHardware(cap);
  const char* name = OH_AVCapability_GetName(cap);
  LOGI("AV1 capability=%{public}s hardware=%{public}d", name != nullptr ? name : "?",
       hardware ? 1 : 0);
  return MakeBool(env, hardware);
}

struct EncodeSettings {
  int width = 0;
  int height = 0;
  AVRational fps{30, 1};
  int bitrateKbps = 1800;
};

bool WritePacket(AVFormatContext* outFmt, AVStream* stream, AVPacket* packet,
                 const char* kind) {
  packet->stream_index = stream->index;
  av_packet_rescale_ts(packet, stream->time_base, stream->time_base);
  if (packet->dts == AV_NOPTS_VALUE) {
    packet->dts = packet->pts;
  }
  int ret = av_interleaved_write_frame(outFmt, packet);
  if (ret < 0) {
    LOGW("write %{public}s packet failed: %{public}d", kind, ret);
    return false;
  }
  return true;
}

bool DrainEncoder(AVCodecContext* enc, AVFormatContext* outFmt, AVStream* stream,
                  const char* kind, std::string& error) {
  AVPacket* packet = av_packet_alloc();
  if (packet == nullptr) {
    error = "alloc packet failed";
    return false;
  }
  while (true) {
    int ret = avcodec_receive_packet(enc, packet);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
      break;
    }
    if (ret < 0) {
      error = std::string("receive ") + kind + " packet failed";
      av_packet_free(&packet);
      return false;
    }
    if (!WritePacket(outFmt, stream, packet, kind)) {
      error = std::string("write ") + kind + " packet failed";
      av_packet_free(&packet);
      return false;
    }
    if (std::strcmp(kind, "video") == 0) {
      g_videoPacketCount.fetch_add(1);
    }
    av_packet_unref(packet);
  }
  av_packet_free(&packet);
  return true;
}

bool SendFrame(AVCodecContext* enc, AVFrame* frame, AVFormatContext* outFmt,
               AVStream* stream, const char* kind, std::string& error) {
  int ret = avcodec_send_frame(enc, frame);
  if (ret < 0) {
    error = std::string("send ") + kind + " frame failed";
    return false;
  }
  return DrainEncoder(enc, outFmt, stream, kind, error);
}

struct TranscodeJob {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string input;
  std::string output;
  int maxHeight = 720;
  int bitrateKbps = 1800;
  bool ok = false;
  std::string error;
};

bool Transcode(const TranscodeJob& job, std::string& error) {
  AVFormatContext* inFmt = nullptr;
  AVCodecContext* videoDec = nullptr;
  AVCodecContext* audioDec = nullptr;
  AVCodecContext* videoEnc = nullptr;
  AVCodecContext* audioEnc = nullptr;
  AVFormatContext* outFmt = nullptr;
  AVStream* videoOut = nullptr;
  AVStream* audioOut = nullptr;
  SwsContext* sws = nullptr;
  SwrContext* swr = nullptr;
  AVFrame* decoded = nullptr;
  AVFrame* scaled = nullptr;
  AVFrame* audioFrame = nullptr;
  AVPacket* packet = nullptr;
  int videoIndex = -1;
  int audioIndex = -1;
  int64_t videoStart = 0;
  int videoStreamIndex = -1;
  int audioStreamIndex = -1;
  bool headerWritten = false;

  auto cleanup = [&]() {
    if (packet != nullptr) av_packet_free(&packet);
    if (audioFrame != nullptr) av_frame_free(&audioFrame);
    if (scaled != nullptr) av_frame_free(&scaled);
    if (decoded != nullptr) av_frame_free(&decoded);
    if (swr != nullptr) swr_free(&swr);
    if (sws != nullptr) sws_freeContext(sws);
    if (videoEnc != nullptr) avcodec_free_context(&videoEnc);
    if (audioEnc != nullptr) avcodec_free_context(&audioEnc);
    if (videoDec != nullptr) avcodec_free_context(&videoDec);
    if (audioDec != nullptr) avcodec_free_context(&audioDec);
    if (outFmt != nullptr) {
      if (headerWritten) {
        av_write_trailer(outFmt);
      }
      if ((outFmt->oformat->flags & AVFMT_NOFILE) == 0 && outFmt->pb != nullptr) {
        avio_closep(&outFmt->pb);
      }
      avformat_free_context(outFmt);
    }
    if (inFmt != nullptr) avformat_close_input(&inFmt);
  };

  int ret = avformat_open_input(&inFmt, job.input.c_str(), nullptr, nullptr);
  if (ret < 0) {
    error = "open input failed";
    cleanup();
    return false;
  }
  ret = avformat_find_stream_info(inFmt, nullptr);
  if (ret < 0) {
    error = "find stream info failed";
    cleanup();
    return false;
  }

  videoStreamIndex = av_find_best_stream(inFmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
  audioStreamIndex = av_find_best_stream(inFmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (videoStreamIndex < 0) {
    error = "no video stream";
    cleanup();
    return false;
  }

  AVStream* videoIn = inFmt->streams[videoStreamIndex];
  const AVCodec* videoDecoder = avcodec_find_decoder_by_name("libdav1d");
  if (videoDecoder == nullptr) {
    videoDecoder = avcodec_find_decoder(videoIn->codecpar->codec_id);
  }
  if (videoDecoder == nullptr) {
    error = "no decoder for " + std::string(avcodec_get_name(videoIn->codecpar->codec_id));
    cleanup();
    return false;
  }
  videoDec = avcodec_alloc_context3(videoDecoder);
  if (videoDec == nullptr) {
    error = "alloc video decoder failed";
    cleanup();
    return false;
  }
  avcodec_parameters_to_context(videoDec, videoIn->codecpar);
  videoDec->thread_count = 1;
  ret = avcodec_open2(videoDec, videoDecoder, nullptr);
  if (ret < 0) {
    error = "open video decoder failed";
    cleanup();
    return false;
  }

  int srcW = videoDec->width > 0 ? videoDec->width : videoIn->codecpar->width;
  int srcH = videoDec->height > 0 ? videoDec->height : videoIn->codecpar->height;
  if (srcW <= 0 || srcH <= 0) {
    error = "invalid video size";
    cleanup();
    return false;
  }
  int dstH = job.maxHeight > 0 ? job.maxHeight : 720;
  if (srcH < dstH) {
    dstH = srcH;
  }
  int dstW = static_cast<int>(std::lround(static_cast<double>(srcW) * dstH / srcH));
  dstW &= ~1;
  dstH &= ~1;
  if (dstW <= 0 || dstH <= 0) {
    error = "invalid proxy size";
    cleanup();
    return false;
  }

  AVRational fps = av_guess_frame_rate(inFmt, videoIn, nullptr);
  if (fps.num <= 0 || fps.den <= 0) {
    fps = AVRational{30, 1};
  }
  AVRational encTb = av_inv_q(fps);
  if (encTb.num <= 0 || encTb.den <= 0) {
    encTb = AVRational{1, 30};
  }
  videoStart = videoIn->start_time == AV_NOPTS_VALUE ? 0 : videoIn->start_time;

  const AVCodec* videoEncoder = avcodec_find_encoder_by_name("libopenh264");
  if (videoEncoder == nullptr) {
    videoEncoder = avcodec_find_encoder(AV_CODEC_ID_H264);
  }
  if (videoEncoder == nullptr) {
    videoEncoder = avcodec_find_encoder(AV_CODEC_ID_MPEG4);
  }
  if (videoEncoder == nullptr) {
    error = "no H.264 encoder in FFmpeg build";
    cleanup();
    return false;
  }
  videoEnc = avcodec_alloc_context3(videoEncoder);
  if (videoEnc == nullptr) {
    error = "alloc video encoder failed";
    cleanup();
    return false;
  }
  videoEnc->width = dstW;
  videoEnc->height = dstH;
  videoEnc->codec_type = AVMEDIA_TYPE_VIDEO;
  videoEnc->pix_fmt = AV_PIX_FMT_YUV420P;
  videoEnc->time_base = encTb;
  videoEnc->framerate = fps;
  videoEnc->bit_rate = static_cast<int64_t>(job.bitrateKbps) * 1000;
  videoEnc->gop_size = 60;
  videoEnc->max_b_frames = 0;
  videoEnc->thread_count = 4;
  videoEnc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  if (videoEncoder->id == AV_CODEC_ID_H264) {
    videoEnc->profile = AV_PROFILE_H264_BASELINE;
  }
  ret = avcodec_open2(videoEnc, videoEncoder, nullptr);
  if (ret < 0) {
    error = "open H.264 encoder failed";
    cleanup();
    return false;
  }
  LOGI("proxy: src=%{public}dx%{public}d dst=%{public}dx%{public}d enc=%{public}s",
       srcW, srcH, dstW, dstH, videoEncoder->name);

  const AVCodec* audioEncoder = nullptr;
  if (audioStreamIndex >= 0) {
    AVStream* audioIn = inFmt->streams[audioStreamIndex];
    const AVCodec* audioDecoder = avcodec_find_decoder(audioIn->codecpar->codec_id);
    if (audioDecoder != nullptr) {
      audioDec = avcodec_alloc_context3(audioDecoder);
      if (audioDec != nullptr) {
        avcodec_parameters_to_context(audioDec, audioIn->codecpar);
        audioDec->thread_count = 1;
        if (avcodec_open2(audioDec, audioDecoder, nullptr) < 0) {
          avcodec_free_context(&audioDec);
        }
      }
    }
    if (audioDec != nullptr) {
      audioEncoder = avcodec_find_encoder(AV_CODEC_ID_AAC);
      if (audioEncoder != nullptr) {
        audioEnc = avcodec_alloc_context3(audioEncoder);
      }
      if (audioEnc != nullptr) {
        audioEnc->sample_rate = 48000;
        audioEnc->codec_type = AVMEDIA_TYPE_AUDIO;
        audioEnc->sample_fmt = AV_SAMPLE_FMT_FLTP;
        av_channel_layout_default(&audioEnc->ch_layout, 2);
        audioEnc->bit_rate = 128000;
        audioEnc->time_base = AVRational{1, 48000};
        audioEnc->profile = AV_PROFILE_AAC_LOW;
        if (avcodec_open2(audioEnc, audioEncoder, nullptr) < 0) {
          avcodec_free_context(&audioEnc);
        }
      }
      if (audioDec != nullptr && audioEnc != nullptr) {
        AVChannelLayout inLayout = audioDec->ch_layout;
        if (inLayout.nb_channels == 0) {
          av_channel_layout_default(&inLayout, 2);
        }
        AVChannelLayout outLayout = AV_CHANNEL_LAYOUT_STEREO;
        int swrRet = swr_alloc_set_opts2(&swr, &outLayout, AV_SAMPLE_FMT_FLTP, 48000,
                                         &inLayout, audioDec->sample_fmt,
                                         audioDec->sample_rate, 0, nullptr);
        if (swrRet < 0 || swr == nullptr || swr_init(swr) < 0) {
          if (swr != nullptr) {
            swr_free(&swr);
          }
          avcodec_free_context(&audioEnc);
        }
      }
    }
  }

  ret = avformat_alloc_output_context2(&outFmt, nullptr, "mp4", job.output.c_str());
  if (ret < 0 || outFmt == nullptr) {
    error = "alloc mp4 output failed";
    cleanup();
    return false;
  }

  videoOut = avformat_new_stream(outFmt, nullptr);
  if (videoOut == nullptr) {
    error = "create video stream failed";
    cleanup();
    return false;
  }
  videoOut->time_base = encTb;
  videoOut->avg_frame_rate = fps;
  avcodec_parameters_from_context(videoOut->codecpar, videoEnc);
  videoOut->codecpar->codec_tag = 0;
  videoOut->codecpar->codec_type = AVMEDIA_TYPE_VIDEO;
  videoOut->codecpar->width = dstW;
  videoOut->codecpar->height = dstH;

  if (audioEnc != nullptr) {
    audioOut = avformat_new_stream(outFmt, nullptr);
    if (audioOut == nullptr) {
      error = "create audio stream failed";
      cleanup();
      return false;
    }
    audioOut->time_base = audioEnc->time_base;
    avcodec_parameters_from_context(audioOut->codecpar, audioEnc);
    audioOut->codecpar->codec_tag = 0;
    audioOut->codecpar->codec_type = AVMEDIA_TYPE_AUDIO;
  }

  if ((outFmt->oformat->flags & AVFMT_NOFILE) == 0) {
    ret = avio_open(&outFmt->pb, job.output.c_str(), AVIO_FLAG_WRITE);
    if (ret < 0) {
      error = "open output file failed";
      cleanup();
      return false;
    }
  }
  ret = avformat_write_header(outFmt, nullptr);
  if (ret < 0) {
    error = "write mp4 header failed";
    cleanup();
    return false;
  }
  headerWritten = true;

  decoded = av_frame_alloc();
  scaled = av_frame_alloc();
  audioFrame = av_frame_alloc();
  packet = av_packet_alloc();
  if (decoded == nullptr || scaled == nullptr || audioFrame == nullptr || packet == nullptr) {
    error = "alloc frames failed";
    cleanup();
    return false;
  }
  scaled->format = AV_PIX_FMT_YUV420P;
  scaled->width = dstW;
  scaled->height = dstH;
  if (av_frame_get_buffer(scaled, 32) < 0) {
    error = "alloc scaled frame failed";
    cleanup();
    return false;
  }
  audioFrame->format = AV_SAMPLE_FMT_FLTP;
  audioFrame->sample_rate = 48000;
  av_channel_layout_default(&audioFrame->ch_layout, 2);

  sws = sws_getContext(srcW, srcH, videoDec->pix_fmt, dstW, dstH, AV_PIX_FMT_YUV420P,
                       SWS_BILINEAR, nullptr, nullptr, nullptr);
  if (sws == nullptr) {
    error = "create scaler failed";
    cleanup();
    return false;
  }

  double duration = inFmt->duration != AV_NOPTS_VALUE
    ? static_cast<double>(inFmt->duration) / AV_TIME_BASE : 0;
  int64_t audioNextPts = 0;
  int videoFrames = 0;
  int videoPackets = 0;
  g_progress.store(0);
  g_videoPacketCount.store(0);
  auto handleVideoFrame = [&](AVFrame* frame) -> bool {
    if (frame->format < 0) {
      error = "invalid decoded frame";
      return false;
    }
    videoFrames++;
    av_frame_make_writable(scaled);
    sws_scale(sws, frame->data, frame->linesize, 0, srcH, scaled->data, scaled->linesize);
    int64_t pts = frame->pts;
    if (pts == AV_NOPTS_VALUE) {
      pts = frame->best_effort_timestamp;
    }
    if (pts == AV_NOPTS_VALUE) {
      pts = 0;
    }
    pts -= videoStart;
    scaled->pts = av_rescale_q(pts, videoIn->time_base, encTb);
    return SendFrame(videoEnc, scaled, outFmt, videoOut, "video", error);
  };

  auto handleAudioFrame = [&](AVFrame* frame) -> bool {
    if (swr == nullptr || audioOut == nullptr || audioEnc == nullptr) {
      return true;
    }
    int maxSamples = static_cast<int>(av_rescale_rnd(
      swr_get_delay(swr, audioDec->sample_rate) + frame->nb_samples,
      48000, audioDec->sample_rate, AV_ROUND_UP));
    if (maxSamples <= 0) {
      return true;
    }
    av_frame_unref(audioFrame);
    audioFrame->format = AV_SAMPLE_FMT_FLTP;
    audioFrame->sample_rate = 48000;
    av_channel_layout_default(&audioFrame->ch_layout, 2);
    audioFrame->nb_samples = maxSamples;
    if (av_frame_get_buffer(audioFrame, 0) < 0) {
      error = "alloc audio frame failed";
      return false;
    }
    int converted = swr_convert(swr, audioFrame->data, maxSamples,
                                const_cast<const uint8_t**>(frame->extended_data),
                                frame->nb_samples);
    if (converted < 0) {
      error = "resample audio failed";
      return false;
    }
    audioFrame->nb_samples = converted;
    audioFrame->pts = audioNextPts;
    audioNextPts += converted;
    return SendFrame(audioEnc, audioFrame, outFmt, audioOut, "audio", error);
  };

  auto updateProgress = [&](AVPacket* pkt) {
    if (duration > 0 && pkt->stream_index == videoStreamIndex && pkt->pts != AV_NOPTS_VALUE) {
      double seconds = static_cast<double>(pkt->pts) * av_q2d(videoIn->time_base);
      int percent = static_cast<int>(seconds * 100.0 / duration);
      if (percent > 98) {
        percent = 98;
      }
      if (percent > g_progress.load()) {
        g_progress.store(percent);
      }
    }
  };

  while (!g_cancel.load()) {
    ret = av_read_frame(inFmt, packet);
    if (ret < 0) {
      break;
    }
    updateProgress(packet);
    if (packet->stream_index == videoStreamIndex) {
      if (avcodec_send_packet(videoDec, packet) >= 0) {
        while (avcodec_receive_frame(videoDec, decoded) == 0) {
          if (!handleVideoFrame(decoded)) {
            av_packet_unref(packet);
            cleanup();
            return false;
          }
          av_frame_unref(decoded);
        }
      }
    } else if (audioDec != nullptr && packet->stream_index == audioStreamIndex) {
      if (avcodec_send_packet(audioDec, packet) >= 0) {
        while (avcodec_receive_frame(audioDec, decoded) == 0) {
          if (!handleAudioFrame(decoded)) {
            av_packet_unref(packet);
            cleanup();
            return false;
          }
          av_frame_unref(decoded);
        }
      }
    }
    av_packet_unref(packet);
  }

  if (g_cancel.load()) {
    error = "cancelled";
    cleanup();
    return false;
  }

  avcodec_send_packet(videoDec, nullptr);
  while (avcodec_receive_frame(videoDec, decoded) == 0) {
    if (!handleVideoFrame(decoded)) {
      cleanup();
      return false;
    }
    av_frame_unref(decoded);
  }
  if (audioDec != nullptr) {
    avcodec_send_packet(audioDec, nullptr);
    while (avcodec_receive_frame(audioDec, decoded) == 0) {
      if (!handleAudioFrame(decoded)) {
        cleanup();
        return false;
      }
      av_frame_unref(decoded);
    }
  }
  if (!SendFrame(videoEnc, nullptr, outFmt, videoOut, "video", error)) {
    cleanup();
    return false;
  }
  if (swr != nullptr) {
    int pending = static_cast<int>(swr_get_delay(swr, 48000));
    while (pending > 0 && audioEnc != nullptr && audioOut != nullptr) {
      int maxSamples = pending > 4096 ? 4096 : pending;
      av_frame_unref(audioFrame);
      audioFrame->format = AV_SAMPLE_FMT_FLTP;
      audioFrame->sample_rate = 48000;
      av_channel_layout_default(&audioFrame->ch_layout, 2);
      audioFrame->nb_samples = maxSamples;
      if (av_frame_get_buffer(audioFrame, 0) < 0) {
        break;
      }
      int converted = swr_convert(swr, audioFrame->data, maxSamples, nullptr, 0);
      if (converted <= 0) {
        break;
      }
      audioFrame->nb_samples = converted;
      audioFrame->pts = audioNextPts;
      audioNextPts += converted;
      if (!SendFrame(audioEnc, audioFrame, outFmt, audioOut, "audio", error)) {
        cleanup();
        return false;
      }
      pending -= converted;
    }
  }
  if (audioEnc != nullptr && !SendFrame(audioEnc, nullptr, outFmt, audioOut, "audio", error)) {
    cleanup();
    return false;
  }

  ret = av_write_trailer(outFmt);
  if (ret < 0) {
    error = "write mp4 trailer failed";
    cleanup();
    return false;
  }
  headerWritten = false;
  g_progress.store(100);
  LOGI("proxy done: %{public}s %{public}dx%{public}d codec=%{public}s frames=%{public}d packets=%{public}d",
       job.output.c_str(), dstW, dstH, videoEncoder->name, videoFrames,
       g_videoPacketCount.load());
  cleanup();
  return true;
}

void ExecuteTranscode(napi_env env, void* data) {
  (void)env;
  TranscodeJob* job = static_cast<TranscodeJob*>(data);
  g_cancel.store(false);
  job->ok = Transcode(*job, job->error);
  if (!job->ok) {
    std::remove(job->output.c_str());
    LOGE("proxy failed: %{public}s", job->error.c_str());
  }
}

void CompleteTranscode(napi_env env, napi_status status, void* data) {
  TranscodeJob* job = static_cast<TranscodeJob*>(data);
  if (job->deferred != nullptr) {
    if (job->ok) {
      std::string result = "{\"ok\":true,\"output\":\"" + JsonEscape(job->output) + "\"}";
      napi_value value = MakeString(env, result);
      napi_resolve_deferred(env, job->deferred, value);
    } else {
      napi_value message = MakeString(env, job->error);
      napi_reject_deferred(env, job->deferred, message);
    }
  }
  if (job->work != nullptr) {
    napi_delete_async_work(env, job->work);
  }
  delete job;
}

napi_value NapiTranscode(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4] = {nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "transcodeToH264 expects input and output paths");
    return nullptr;
  }
  TranscodeJob* job = new TranscodeJob();
  job->env = env;
  job->input = JsString(env, args[0]);
  job->output = JsString(env, args[1]);
  if (argc >= 3) {
    int32_t maxHeight = 720;
    napi_get_value_int32(env, args[2], &maxHeight);
    if (maxHeight > 0) {
      job->maxHeight = maxHeight;
    }
  }
  if (argc >= 4) {
    int32_t bitrate = 1800;
    napi_get_value_int32(env, args[3], &bitrate);
    if (bitrate > 0) {
      job->bitrateKbps = bitrate;
    }
  }
  if (job->input.empty() || job->output.empty()) {
    delete job;
    Throw(env, "input/output path is empty");
    return nullptr;
  }
  napi_value promise = nullptr;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) {
    delete job;
    Throw(env, "create promise failed");
    return nullptr;
  }
  napi_value name = MakeString(env, "subfabricTranscode");
  napi_create_async_work(env, nullptr, name, ExecuteTranscode, CompleteTranscode, job,
                         &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

napi_value NapiProgress(napi_env env, napi_callback_info info) {
  (void)info;
  return MakeNumber(env, g_progress.load());
}

napi_value NapiCancel(napi_env env, napi_callback_info info) {
  (void)info;
  g_cancel.store(true);
  return nullptr;
}

// ============================================================================
// 音频转 WAV
//
// 波形与识别都不能依赖 AVTranscoder 输出 WAV：当前鸿蒙 AVTranscoder 只支持
// MP4/AAC（fileFormat 传 CFT_WAV 会直接报 "fileFormat is invalid"）。
// 这里用随包的 FFmpeg 把任意容器的音轨解成 16 kHz / 单声道 / S16LE WAV，
// 再交给 WavReader 解析。异步工作线程与视频代理共用进度/取消标志。
// ============================================================================

struct DecodeAudioJob {
  napi_env env = nullptr;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  std::string input;
  std::string output;
  bool ok = false;
  std::string error;
};

void WriteLe16(FILE* file, uint16_t value) {
  uint8_t bytes[2] = {
    static_cast<uint8_t>(value & 0xFF),
    static_cast<uint8_t>((value >> 8) & 0xFF)
  };
  fwrite(bytes, 1, sizeof(bytes), file);
}

void WriteLe32(FILE* file, uint32_t value) {
  uint8_t bytes[4] = {
    static_cast<uint8_t>(value & 0xFF),
    static_cast<uint8_t>((value >> 8) & 0xFF),
    static_cast<uint8_t>((value >> 16) & 0xFF),
    static_cast<uint8_t>((value >> 24) & 0xFF)
  };
  fwrite(bytes, 1, sizeof(bytes), file);
}

void WriteWavHeader(FILE* file, uint32_t dataBytes) {
  fseek(file, 0, SEEK_SET);
  fwrite("RIFF", 1, 4, file);
  WriteLe32(file, 36 + dataBytes);
  fwrite("WAVE", 1, 4, file);
  fwrite("fmt ", 1, 4, file);
  WriteLe32(file, 16);
  WriteLe16(file, 1);           // PCM
  WriteLe16(file, 1);           // mono
  WriteLe32(file, 16000);       // sample rate
  WriteLe32(file, 32000);       // byte rate
  WriteLe16(file, 2);           // block align
  WriteLe16(file, 16);          // bits per sample
  fwrite("data", 1, 4, file);
  WriteLe32(file, dataBytes);
}

bool DecodeAudioToWav(const std::string& input, const std::string& output,
                      std::string& error) {
  AVFormatContext* format = nullptr;
  AVCodecContext* codec = nullptr;
  SwrContext* swr = nullptr;
  AVPacket* packet = av_packet_alloc();
  AVFrame* frame = av_frame_alloc();
  FILE* file = nullptr;
  bool ok = false;
  uint64_t totalSamples = 0;

  auto cleanup = [&]() {
    if (swr != nullptr) {
      swr_free(&swr);
    }
    if (codec != nullptr) {
      avcodec_free_context(&codec);
    }
    if (format != nullptr) {
      avformat_close_input(&format);
    }
    av_frame_free(&frame);
    av_packet_free(&packet);
    if (file != nullptr) {
      fclose(file);
      file = nullptr;
    }
  };

  if (avformat_open_input(&format, input.c_str(), nullptr, nullptr) < 0) {
    error = "打开媒体文件失败";
    cleanup();
    return false;
  }
  if (avformat_find_stream_info(format, nullptr) < 0) {
    error = "读取媒体流信息失败";
    cleanup();
    return false;
  }
  int streamIndex = av_find_best_stream(format, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (streamIndex < 0) {
    error = "该文件没有音轨";
    cleanup();
    return false;
  }
  AVStream* stream = format->streams[streamIndex];
  const AVCodec* decoder = avcodec_find_decoder(stream->codecpar->codec_id);
  if (decoder == nullptr) {
    error = "没有可用的音频解码器";
    cleanup();
    return false;
  }
  codec = avcodec_alloc_context3(decoder);
  if (codec == nullptr || avcodec_parameters_to_context(codec, stream->codecpar) < 0
      || avcodec_open2(codec, decoder, nullptr) < 0) {
    error = "打开音频解码器失败";
    cleanup();
    return false;
  }

  file = fopen(output.c_str(), "wb");
  if (file == nullptr) {
    error = "无法创建 WAV 文件";
    cleanup();
    return false;
  }
  // 先占位 44 字节，解码结束后回填大小。
  uint8_t placeholder[44] = {0};
  fwrite(placeholder, 1, sizeof(placeholder), file);

  AVChannelLayout inLayout = {};
  AVChannelLayout outLayout = {};
  int outRate = 16000;
  double duration = format->duration != AV_NOPTS_VALUE
    ? static_cast<double>(format->duration) / AV_TIME_BASE : 0;

  g_progress.store(0);
  auto handleFrame = [&](AVFrame* decoded) -> bool {
    if (decoded->format < 0 || decoded->sample_rate <= 0 || decoded->nb_samples <= 0) {
      return true;
    }
    if (swr == nullptr) {
      if (decoded->ch_layout.nb_channels > 0) {
        av_channel_layout_copy(&inLayout, &decoded->ch_layout);
      } else {
        av_channel_layout_default(&inLayout, 2);
      }
      av_channel_layout_default(&outLayout, 1);
      int ret = swr_alloc_set_opts2(&swr, &outLayout, AV_SAMPLE_FMT_S16, outRate,
                                    &inLayout, static_cast<AVSampleFormat>(decoded->format),
                                    decoded->sample_rate, 0, nullptr);
      if (ret < 0 || swr == nullptr || swr_init(swr) < 0) {
        error = "初始化重采样失败";
        av_channel_layout_uninit(&inLayout);
        av_channel_layout_uninit(&outLayout);
        return false;
      }
      av_channel_layout_uninit(&inLayout);
      av_channel_layout_uninit(&outLayout);
    }
    int maxOut = static_cast<int>(av_rescale_rnd(
      swr_get_delay(swr, decoded->sample_rate) + decoded->nb_samples,
      outRate, decoded->sample_rate, AV_ROUND_UP));
    if (maxOut <= 0) {
      return true;
    }
    std::vector<uint8_t> pcm(static_cast<size_t>(maxOut) * 2);
    uint8_t* outData[1] = { pcm.data() };
    const uint8_t** inData = const_cast<const uint8_t**>(decoded->extended_data);
    int converted = swr_convert(swr, outData, maxOut, inData, decoded->nb_samples);
    if (converted < 0) {
      error = "音频重采样失败";
      return false;
    }
    if (converted > 0) {
      size_t bytes = static_cast<size_t>(converted) * 2;
      if (fwrite(pcm.data(), 1, bytes, file) != bytes) {
        error = "写入 WAV 失败";
        return false;
      }
      totalSamples += static_cast<uint64_t>(converted);
    }
    if (duration > 0) {
      double seconds = static_cast<double>(totalSamples) / outRate;
      int percent = static_cast<int>(seconds * 100.0 / duration);
      if (percent > 98) {
        percent = 98;
      }
      if (percent > g_progress.load()) {
        g_progress.store(percent);
      }
    }
    return true;
  };

  bool finished = false;
  while (!g_cancel.load()) {
    int ret = av_read_frame(format, packet);
    if (ret < 0) {
      break;
    }
    if (packet->stream_index == streamIndex) {
      if (avcodec_send_packet(codec, packet) >= 0) {
        while (avcodec_receive_frame(codec, frame) == 0) {
          if (!handleFrame(frame)) {
            av_packet_unref(packet);
            cleanup();
            return false;
          }
          av_frame_unref(frame);
        }
      }
    }
    av_packet_unref(packet);
  }
  if (g_cancel.load()) {
    error = "已取消";
    cleanup();
    return false;
  }

  avcodec_send_packet(codec, nullptr);
  while (avcodec_receive_frame(codec, frame) == 0) {
    if (!handleFrame(frame)) {
      cleanup();
      return false;
    }
    av_frame_unref(frame);
  }
  // 冲出重采样器里残留的样本。
  while (swr != nullptr) {
    int maxOut = static_cast<int>(av_rescale_rnd(swr_get_delay(swr, outRate),
                                                 outRate, outRate, AV_ROUND_UP));
    if (maxOut <= 0) {
      maxOut = 4096;
    }
    std::vector<uint8_t> pcm(static_cast<size_t>(maxOut) * 2);
    uint8_t* outData[1] = { pcm.data() };
    int converted = swr_convert(swr, outData, maxOut, nullptr, 0);
    if (converted <= 0) {
      break;
    }
    size_t bytes = static_cast<size_t>(converted) * 2;
    if (fwrite(pcm.data(), 1, bytes, file) != bytes) {
      error = "写入 WAV 失败";
      cleanup();
      return false;
    }
    totalSamples += static_cast<uint64_t>(converted);
  }

  if (fseek(file, 0, SEEK_SET) != 0) {
    error = "回写 WAV 头失败";
    cleanup();
    return false;
  }
  WriteWavHeader(file, static_cast<uint32_t>(totalSamples * 2));
  fflush(file);
  finished = true;
  g_progress.store(100);
  LOGI("audio wav done: %{public}s samples=%{public}llu", output.c_str(),
       static_cast<unsigned long long>(totalSamples));
  ok = finished;
  cleanup();
  return ok;
}

void ExecuteDecodeAudio(napi_env env, void* data) {
  (void)env;
  auto* job = static_cast<DecodeAudioJob*>(data);
  job->ok = DecodeAudioToWav(job->input, job->output, job->error);
}

void CompleteDecodeAudio(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<DecodeAudioJob*>(data);
  std::string json;
  if (job->ok) {
    json = "{\"ok\":true,\"output\":\"" + JsonEscape(job->output) + "\"}";
  } else {
    json = "{\"ok\":false,\"error\":\"" + JsonEscape(job->error) + "\"}";
  }
  napi_value result = MakeString(env, json);
  if (status == napi_ok) {
    napi_resolve_deferred(env, job->deferred, result);
  } else {
    napi_value message = MakeString(env, "audio decode failed");
    napi_reject_deferred(env, job->deferred, message);
  }
  napi_delete_async_work(env, job->work);
  delete job;
}

napi_value NapiDecodeAudioToWav(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = { nullptr, nullptr };
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "decodeAudioToWav(input, output) requires 2 arguments");
    return nullptr;
  }
  auto* job = new DecodeAudioJob();
  job->env = env;
  job->input = JsString(env, argv[0]);
  job->output = JsString(env, argv[1]);
  if (job->input.empty() || job->output.empty()) {
    delete job;
    Throw(env, "input/output path is empty");
    return nullptr;
  }
  napi_value promise = nullptr;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) {
    delete job;
    Throw(env, "create promise failed");
    return nullptr;
  }
  g_cancel.store(false);
  napi_value name = MakeString(env, "subfabricDecodeAudio");
  napi_create_async_work(env, nullptr, name, ExecuteDecodeAudio, CompleteDecodeAudio, job,
                         &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"probeMedia", nullptr, NapiProbe, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"hasAv1Hardware", nullptr, NapiHasAv1Hardware, nullptr, nullptr, nullptr, napi_default,
     nullptr},
    {"transcodeToH264", nullptr, NapiTranscode, nullptr, nullptr, nullptr, napi_default,
     nullptr},
    {"decodeAudioToWav", nullptr, NapiDecodeAudioToWav, nullptr, nullptr, nullptr,
     napi_default, nullptr},
    {"getTranscodeProgress", nullptr, NapiProgress, nullptr, nullptr, nullptr, napi_default,
     nullptr},
    {"cancelTranscode", nullptr, NapiCancel, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

napi_module g_mediaModule = {
  1,
  0,
  nullptr,
  Init,
  "ffmpeg",
  nullptr,
  {0},
};

extern "C" __attribute__((constructor)) void RegisterMediaModule() {
  napi_module_register(&g_mediaModule);
}

} // namespace
