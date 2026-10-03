/**
 * 音频切片工具（真 ffmpeg 调用）：静音检测 + 按时间段切片。
 *
 * 单独成文件是为了让"离线验证"能跑**同一份实现**（见 tools/chunk_probe.mjs），
 * 而不是在探针里另抄一遍 —— 抄一遍就验不出真正的那个 bug。
 * 纯 spawn，无状态；ffmpeg 路径由调用方传入（server.js 里是 FFMPEG 常量）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const asrChunks = require('./asr-chunks.js');

/** ffmpeg silencedetect 找静音区间；失败/超时返回 []（退化成名义切点，不阻塞识别） */
function detectSilences(ffmpeg, wav, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try {
      p = spawn(ffmpeg, ['-hide_banner', '-nostats', '-i', wav,
        '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'], { windowsHide: true });
    } catch { return resolve([]); }
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stderr.on('data', (d) => { if (err.length < 200000) err += String(d); });
    p.on('error', () => { clearTimeout(t); resolve([]); });
    p.on('close', () => { clearTimeout(t); resolve(asrChunks.parseSilences(err)); });
  });
}

/** 从音频切出 [start,end) 到 out；asMp3=true 时直接转 16k 单声道 64kbps mp3（云端用） */
function sliceAudio(ffmpeg, src, start, end, out, asMp3) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(start), '-t', String(end - start), '-i', src, '-vn'];
    if (asMp3) args.push('-ac', '1', '-ar', '16000', '-b:a', '64k');
    args.push(out);
    let err = '';
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 30 * 60 * 1000);
    p.stderr.on('data', (d) => { if (err.length < 800) err += String(d); });
    p.on('error', (e) => { clearTimeout(t); reject(new Error('ffmpeg 不可用: ' + e.message)); });
    p.on('close', (c) => {
      clearTimeout(t);
      if (c !== 0) return reject(new Error('切片失败: ' + err.slice(-200)));
      try { if (!fs.statSync(out).size) throw new Error('空文件'); }
      catch (e) { return reject(new Error('切片结果异常: ' + e.message)); }
      resolve(out);
    });
  });
}

module.exports = { detectSilences, sliceAudio };
