'use strict';
/**
 * 必剪（bcut）云端语音识别客户端 —— 逐词时间戳，本地不装模型、不需要显卡。
 *
 * 协议实现移植自 **MIT** 许可的 SocialSisterYi/bcut-asr（Python）：
 *   MIT License, Copyright (c) 2022 社会易姐QwQ
 *   https://github.com/SocialSisterYi/bcut-asr
 * 本项目按其协议流程用 Node 内置 fetch 重写（保持本项目零 npm 依赖），
 * 请求/响应字段与官方 CLI 完全对齐：
 *   ① POST /resource/create            申请分片上传（type=2, name, size, resource_file_type, model_id=7）
 *   ② PUT  upload_urls[i]              逐片上传，响应头 Etag 作为分片标记
 *   ③ POST /resource/create/complete   提交分片（etags 逗号拼接）→ download_url
 *   ④ POST /task                       建识别任务（resource=download_url, model_id="7"）→ task_id
 *   ⑤ GET  /task/result                轮询：state 0 未开始 / 1 识别中 / 3 错误 / 4 完成
 *
 * 完成后 data.result 是**字符串**，里面还有一层 JSON（时间单位毫秒）：
 *   { "utterances": [ { "start_time", "end_time", "transcript",
 *                       "words": [ { "label", "start_time", "end_time" } ] } ] }
 * 注意 word 的文本字段叫 **label**、句子的文本字段叫 **transcript**（不是 text）。
 *
 * ⚠ 音频会上传到 B 站（bilibili）服务器 —— 机密素材不要用。
 * ⚠ 这是逆向出来的非公开接口，官方改协议就会失效：所有失败都要带原始 code/message 报出来。
 */

const API_BASE = 'https://member.bilibili.com/x/bcut/rubick-interface';
const MODEL_ID = 7;
/** 必剪只收这几种音频（视频要先抽音频） */
const SUPPORTED_EXTS = new Set(['flac', 'aac', 'm4a', 'mp3', 'wav']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单次请求的超时(必剪接口偶发卡住; 整体超时由 deadline 管) */
function reqSignal(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function readJson(res, label) {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`必剪${label}失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(text); } catch {
    throw new Error(`必剪${label}返回非 JSON：${text.slice(0, 200)}`);
  }
  if (j && j.code) throw new Error(`必剪${label}返回错误（code=${j.code}）：${j.message || j.msg || '未知原因'}`);
  if (!j || !j.data) throw new Error(`必剪${label}响应缺少 data：${text.slice(0, 200)}`);
  return j.data;
}

/** ① 申请分片上传 */
async function resourceCreate(name, size, ext, signal) {
  const body = new URLSearchParams({
    type: '2', name, size: String(size), resource_file_type: ext, model_id: String(MODEL_ID),
  });
  const res = await fetch(`${API_BASE}/resource/create`, {
    method: 'POST', signal: reqSignal(signal, 30000),
    headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const d = await readJson(res, '申请上传');
  if (!Array.isArray(d.upload_urls) || !d.upload_urls.length) throw new Error('必剪申请上传未返回分片地址');
  return d;
}

/** ②③ 逐片上传 + 提交（返回 download_url） */
async function uploadParts(buf, d, onProgress, signal) {
  const per = Number(d.per_size) || buf.length;
  const etags = [];
  for (let i = 0; i < d.upload_urls.length; i++) {
    if (signal && signal.aborted) throw new Error('已取消');
    const start = i * per;
    const chunk = buf.subarray(start, Math.min(start + per, buf.length));
    const res = await fetch(d.upload_urls[i], {
      method: 'PUT', signal: reqSignal(signal, 300000),
      headers: { 'User-Agent': UA, 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    if (!res.ok) throw new Error(`必剪分片上传失败：HTTP ${res.status}（第 ${i + 1}/${d.upload_urls.length} 片）`);
    const etag = res.headers.get('etag');
    if (!etag) throw new Error(`必剪分片上传未返回 Etag（第 ${i + 1} 片）`);
    etags.push(etag);
    onProgress(40 + Math.round(((i + 1) / d.upload_urls.length) * 12), `上传音频 ${i + 1}/${d.upload_urls.length} 片`);
  }
  const body = new URLSearchParams({
    in_boss_key: d.in_boss_key, resource_id: d.resource_id,
    etags: etags.join(','), upload_id: d.upload_id, model_id: String(MODEL_ID),
  });
  const res = await fetch(`${API_BASE}/resource/create/complete`, {
    method: 'POST', signal: reqSignal(signal, 60000),
    headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const done = await readJson(res, '提交上传');
  if (!done.download_url) throw new Error('必剪提交上传未返回 download_url');
  return done.download_url;
}

/** ④ 建识别任务 */
async function createTask(downloadUrl, signal) {
  const res = await fetch(`${API_BASE}/task`, {
    method: 'POST', signal: reqSignal(signal, 30000),
    headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource: downloadUrl, model_id: String(MODEL_ID) }),
  });
  const d = await readJson(res, '创建任务');
  if (!d.task_id) throw new Error('必剪创建任务未返回 task_id');
  return d.task_id;
}

/** ⑤ 查询一次任务状态 */
async function queryTask(taskId, signal) {
  const qs = new URLSearchParams({ model_id: String(MODEL_ID), task_id: taskId });
  const res = await fetch(`${API_BASE}/task/result?${qs}`, {
    method: 'GET', signal: reqSignal(signal, 30000),
    headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
  });
  return readJson(res, '查询结果');
}

/** 识别结果 JSON → 本项目 asr.json 的 segments（秒）。
 *  必剪给的是毫秒 + `transcript`/`words[].label`；这里统一成 {start,end,text,words:[{word,start,end}]}。 */
function toSegments(resultJson) {
  const raw = String(resultJson || '').trim();
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('必剪结果 JSON 解析失败：' + raw.slice(0, 200)); }
  const utts = (data && data.utterances) || [];
  const segs = [];
  for (const u of utts) {
    const text = String(u.transcript || '').trim();
    if (!text) continue;
    const start = Number(u.start_time) / 1000;
    const end = Number(u.end_time) / 1000;
    if (!(end > start)) continue;
    const words = (Array.isArray(u.words) ? u.words : [])
      .map((w) => ({
        word: String(w.label != null ? w.label : (w.text || '')).trim(),
        start: Number(w.start_time) / 1000,
        end: Number(w.end_time) / 1000,
      }))
      .filter((w) => w.word && w.end > w.start);
    segs.push({ start, end, text, words });
  }
  return segs;
}

/**
 * 跑完整条必剪识别链路。
 *
 * @param {object} o
 * @param {string} o.audioPath  音频文件（flac/aac/m4a/mp3/wav）
 * @param {function} [o.log]    进度文本回调（进初稿日志）
 * @param {function} [o.onProgress] (pct, msg) → 初稿进度条
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs] 整体超时，默认 30 分钟
 * @returns {Promise<{segments: Array}>}
 */
async function transcribe(o) {
  const fs = require('fs');
  const path = require('path');
  const log = o.log || (() => {});
  const onProgress = o.onProgress || (() => {});
  const signal = o.signal;
  const timeoutMs = o.timeoutMs || 30 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  const ext = path.extname(o.audioPath).slice(1).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`必剪只支持 ${[...SUPPORTED_EXTS].join(' / ')} 音频，当前是 .${ext}`);
  }
  const buf = fs.readFileSync(o.audioPath);
  if (!buf.length) throw new Error('待识别音频为空');
  const name = path.basename(o.audioPath);

  onProgress(32, '申请上传 …');
  log(`音频 ${name}（${(buf.length / 1048576).toFixed(1)} MB）→ 必剪云端`);
  const d = await resourceCreate(name, buf.length, ext, signal);
  log(`申请上传成功：${d.upload_urls.length} 片，每片 ${Math.round((Number(d.per_size) || 0) / 1024)} KB`);

  onProgress(40, '上传音频 …');
  const downloadUrl = await uploadParts(buf, d, onProgress, signal);
  log('音频已上传并提交');

  onProgress(58, '创建识别任务 …');
  const taskId = await createTask(downloadUrl, signal);
  log(`识别任务已创建：${taskId}`);

  // 轮询：前 30 秒 2 秒一次（短音频能很快出结果），之后 5 秒一次，别频繁打接口
  const t0 = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw new Error('已取消');
    if (Date.now() > deadline) throw new Error(`必剪识别超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`);
    const r = await queryTask(taskId, signal);
    const state = Number(r.state);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (state === 4) {                                  // 完成
      if (!r.result) throw new Error('必剪识别完成但没有返回结果数据');
      onProgress(86, '解析识别结果 …');
      const segments = toSegments(r.result);
      log(`识别完成：${segments.length} 句（用时 ${elapsed} 秒）`);
      return { segments };
    }
    if (state === 3) throw new Error('必剪识别失败：' + (r.remark || '接口未给出原因'));
    const pct = Math.min(85, 60 + Math.round(elapsed / 6));
    onProgress(pct, (state === 0 ? '排队等待识别 …' : '识别中 …') + ` ${elapsed}s` + (r.remark ? `（${r.remark}）` : ''));
    if (elapsed % 15 < 3) log(`识别中（${state === 0 ? '排队' : '进行中'}，已用 ${elapsed} 秒）`);
    await sleep(elapsed < 30 ? 2000 : 5000);
  }
}

module.exports = { transcribe, toSegments, SUPPORTED_EXTS, API_BASE, MODEL_ID };
