'use strict';
/**
 * 剪映（CapCut）云端语音识别客户端 —— 逐词时间戳，本地不装模型、不需要显卡。
 *
 * 【许可说明 · 重要】剪映云接口**没有 MIT 许可的公开实现**（能用的两个：xifan2333/jianying-subtitle
 * 是 GPL-3.0-only、K07VN/capcut-tts-api 无许可证），因此本文件**没有移植任何第三方代码**：
 * 它是按接口协议自己写的实现 —— 端点、请求头名、签名公式、请求/响应字段名属于**为互通所必需的
 * 协议事实**（与 GPL 代码的"表达"无关）。协议细节来自对剪映 PC 客户端请求的公开整理，并在本机实测校准。
 *
 * 链路（与剪映 PC 客户端"识别字幕"同一条云端路径）：
 *   ① POST {API}/lv/v1/upload_sign                 取 ByteDance VOD 临时凭证（access/secret/session）
 *   ② GET  {VOD}/?Action=ApplyUploadInner&…        AWS SigV4 签名 → StoreUri / Auth / UploadID / UploadHost
 *   ③ PUT  https://{host}/{storeUri}?partNumber=1&uploadID=…   传音频（Content-CRC32 校验）
 *   ④ POST https://{host}/{storeUri}?uploadID=…                报 CRC（`1:{crc32}`）
 *   ⑤ PUT  …&x-amz-security-token=…                            提交（best-effort，失败不影响后续）
 *   ⑥ POST {API}/lv/v1/audio_subtitle/submit       建识别任务 → data.id
 *   ⑦ POST {API}/lv/v1/audio_subtitle/query        轮询：data==null 表示还在跑, 出 utterances 即完成
 *
 * 返回（毫秒）：
 *   { "utterances": [ { "text", "start_time", "end_time",
 *                       "words": [ { "text", "start_time", "end_time" } ] } ] }
 * 注意与必剪的区别：这里的字段名是 `text`（必剪是 transcript / words[].label）。
 *
 * ⚠ 音频会上传到字节跳动服务器（剪映云端）—— 机密素材不要用。
 * ⚠ 逆向出来的非公开接口：官方改协议就失效；失败务必把 ret/errmsg 原样报出来。
 */

const API_BASE = process.env.SUBFABRIC_CAPCUT_API || 'https://lv-pc-api-sinfonlinec.ulikecam.com';
const VOD_BASE = process.env.SUBFABRIC_CAPCUT_VOD || 'https://vod.bytedanceapi.com';
const APP_VERSION = '6.6.0';           // 客户端版本号(签名里要用, 跟着剪映客户端走)
const PF = '4';                        // 平台标识
const SPACE_NAME = 'lv-mac-recognition';
const VOD_S = '5y0udbjapi';
const UA_SIGN = 'Cronet/TTNetVersion:d4572e53 2024-06-12 QuicVersion:4bf243e0 2023-04-17';
const UA_UPLOAD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 Thea/1.0.1';
const SUPPORTED_EXTS = new Set(['mp3', 'wav', 'flac', 'm4a']);

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** CRC32(IEEE) → 8 位十六进制（VOD 上传校验用） */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** 设备标识 tdid：`fr = 390 + 年份末位` + （偶数年用 MAC 派生，奇数年用固定串）—— 免登录设备指纹 */
function generateTdid() {
  const y = String(new Date().getFullYear())[3];
  const fr = 390 + Number(y);
  if (Number(y) % 2 !== 0) return `${fr}3278516897751`;
  let macNum = 0;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const d of list || []) {
      if (d.mac && d.mac !== '00:00:00:00:00:00') { macNum = parseInt(d.mac.replace(/:/g, ''), 16); break; }
    }
    if (macNum) break;
  }
  return `${fr}${String(macNum).padStart(13, '0')}`;
}

/** 剪映的请求签名：MD5("9e2c|" + 路径末 7 字符 + "|" + pf + "|" + appvr + "|" + 秒级时间 + "|" + tdid + "|11ac") */
function signParams(urlPath, tdid) {
  const deviceTime = String(Math.floor(Date.now() / 1000));
  const tail = urlPath.length >= 7 ? urlPath.slice(-7) : urlPath;
  return { deviceTime, sign: md5(`9e2c|${tail}|${PF}|${APP_VERSION}|${deviceTime}|${tdid}|11ac`) };
}
function signedHeaders(urlPath, tdid) {
  const { deviceTime, sign } = signParams(urlPath, tdid);
  return {
    'User-Agent': UA_SIGN, appvr: APP_VERSION, 'device-time': deviceTime,
    pf: PF, sign, 'sign-ver': '1', tdid,
  };
}

function reqSignal(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** ① 取 VOD 临时凭证 */
async function uploadSign(tdid, signal) {
  const p = '/lv/v1/upload_sign';
  const res = await fetch(API_BASE + p, {
    method: 'POST', signal: reqSignal(signal, 30000),
    headers: { ...signedHeaders(p, tdid), 'Content-Type': 'application/json' },
    body: JSON.stringify({ biz: 'pc-recognition' }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`剪映取上传凭证失败：HTTP ${res.status} ${text.slice(0, 160)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('剪映取上传凭证返回非 JSON：' + text.slice(0, 160)); }
  if (String(j.ret) !== '0') throw new Error(`剪映取上传凭证失败（ret=${j.ret}）：${j.errmsg || '未知原因'}`);
  const d = j.data || {};
  if (!d.access_key_id || !d.secret_access_key || !d.session_token) {
    throw new Error('剪映取上传凭证响应缺少字段：' + text.slice(0, 160));
  }
  return { accessKey: d.access_key_id, secretKey: d.secret_access_key, sessionToken: d.session_token };
}

/** ② AWS SigV4 签 ApplyUploadInner（region=cn / service=vod，空 body） */
function awsSign({ accessKey, secretKey, sessionToken, requestParams }) {
  const amzDate = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const headers = { 'x-amz-date': amzDate, 'x-amz-security-token': sessionToken };
  const keys = Object.keys(headers);                       // 已按字典序: x-amz-date < x-amz-security-token
  const canonicalHeaders = keys.map((k) => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders = keys.join(';');
  const canonicalRequest = ['GET', '/', requestParams, canonicalHeaders, signedHeaders, sha256('')].join('\n');
  const scope = `${dateStamp}/cn/vod/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), 'cn'), 'vod'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** ② 申请上传位置 */
async function applyUpload(creds, fileSize, signal) {
  const requestParams = [
    'Action=ApplyUploadInner', `FileSize=${fileSize}`, 'FileType=object', 'IsInner=1',
    `SpaceName=${SPACE_NAME}`, 'Version=2020-11-19', `s=${VOD_S}`,
  ].join('&');
  const { headers, authorization } = awsSign({ ...creds, requestParams });
  const res = await fetch(`${VOD_BASE}/?${requestParams}`, {
    method: 'GET', signal: reqSignal(signal, 30000), headers: { ...headers, authorization },
  });
  const text = await res.text().catch(() => '');
  let j; try { j = JSON.parse(text); } catch { throw new Error(`剪映申请上传位置返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`); }
  const addr = j.Result && j.Result.UploadAddress;
  const info = addr && addr.StoreInfos && addr.StoreInfos[0];
  const host = addr && addr.UploadHosts && addr.UploadHosts[0];
  if (!info || !host) throw new Error('剪映申请上传位置失败：' + text.slice(0, 200));
  return { storeUri: info.StoreUri, auth: info.Auth, uploadId: info.UploadID, host };
}

/** ③④⑤ 上传 + CRC 校验 + 提交 */
async function uploadFile(buf, st, sessionToken, onProgress, signal) {
  const base = `https://${st.host}/${st.storeUri}`;
  const crc = crc32(buf);
  const put = await fetch(`${base}?partNumber=1&uploadID=${st.uploadId}`, {
    method: 'PUT', signal: reqSignal(signal, 600000),
    headers: { 'User-Agent': UA_UPLOAD, Authorization: st.auth, 'Content-CRC32': crc },
    body: buf,
  });
  const putText = await put.text().catch(() => '');
  if (!put.ok) throw new Error(`剪映音频上传失败：HTTP ${put.status} ${putText.slice(0, 160)}`);
  let ok = true; try { ok = JSON.parse(putText).success === 0; } catch { ok = false; }
  if (!ok) throw new Error('剪映音频上传响应异常：' + putText.slice(0, 160));

  onProgress(52, '校验上传 …');
  await fetch(`${base}?uploadID=${st.uploadId}`, {
    method: 'POST', signal: reqSignal(signal, 60000),
    headers: { 'User-Agent': UA_UPLOAD, Authorization: st.auth, 'Content-CRC32': crc },
    body: `1:${crc}`,
  }).catch(() => {});

  // 提交(best-effort): 官方客户端在这里再 PUT 一次同一份数据; 失败也不影响后续识别
  await fetch(`${base}?uploadID=${st.uploadId}&partNumber=1&x-amz-security-token=${sessionToken}`, {
    method: 'PUT', signal: reqSignal(signal, 600000),
    headers: { 'User-Agent': UA_UPLOAD, Authorization: st.auth, 'Content-CRC32': crc },
    body: buf,
  }).catch(() => {});
  return st.storeUri;
}

/** ⑥ 建识别任务 */
async function submitTask(storeUri, tdid, signal) {
  const p = '/lv/v1/audio_subtitle/submit';
  const body = {
    adjust_endtime: 200,
    audio: storeUri,
    caption_type: 2,
    client_request_id: crypto.randomUUID(),
    max_lines: 1,
    songs_info: [{ end_time: 6000, id: '', start_time: 0 }],
    words_per_line: 16,
  };
  const res = await fetch(API_BASE + p, {
    method: 'POST', signal: reqSignal(signal, 30000),
    headers: { ...signedHeaders(p, tdid), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let j; try { j = JSON.parse(text); } catch { throw new Error('剪映建任务返回非 JSON：' + text.slice(0, 160)); }
  if (String(j.ret) !== '0') throw new Error(`剪映建识别任务失败（ret=${j.ret}）：${j.errmsg || '未知原因'}`);
  const id = j.data && j.data.id;
  if (!id) throw new Error('剪映建识别任务响应缺少 id：' + text.slice(0, 160));
  return id;
}

/** ⑦ 查一次结果 */
async function queryTask(taskId, tdid, signal) {
  const p = '/lv/v1/audio_subtitle/query';
  const res = await fetch(API_BASE + p, {
    method: 'POST', signal: reqSignal(signal, 30000),
    headers: { ...signedHeaders(p, tdid), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: taskId, pack_options: { need_attribute: true } }),
  });
  const text = await res.text().catch(() => '');
  let j; try { j = JSON.parse(text); } catch { throw new Error('剪映查询结果返回非 JSON：' + text.slice(0, 160)); }
  if (String(j.ret) !== '0') throw new Error(`剪映查询结果失败（ret=${j.ret}）：${j.errmsg || '未知原因'}`);
  return j;
}

/** 剪映结果 → 本项目 asr.json 的 segments（秒）。
 *  剪映：utterances[].text / words[].text，毫秒；这里统一成 {start,end,text,words:[{word,start,end}]}。 */
function toSegments(resp) {
  const utts = (resp && resp.data && resp.data.utterances) || [];
  const segs = [];
  for (const u of utts) {
    const text = String(u.text || '').trim();
    if (!text) continue;
    const start = Number(u.start_time) / 1000;
    const end = Number(u.end_time) / 1000;
    if (!(end > start)) continue;
    const words = (Array.isArray(u.words) ? u.words : [])
      .map((w) => ({
        word: String(w.text != null ? w.text : '').trim(),
        start: Number(w.start_time) / 1000,
        end: Number(w.end_time) / 1000,
      }))
      .filter((w) => w.word && w.end > w.start);
    segs.push({ start, end, text, words });
  }
  return segs;
}

/**
 * 跑完整条剪映识别链路。
 * @param {object} o  { audioPath, log?, onProgress?, signal?, timeoutMs? }
 * @returns {Promise<{segments: Array}>}
 */
async function transcribe(o) {
  const log = o.log || (() => {});
  const onProgress = o.onProgress || (() => {});
  const signal = o.signal;
  const timeoutMs = o.timeoutMs || 30 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  const ext = path.extname(o.audioPath).slice(1).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`剪映只支持 ${[...SUPPORTED_EXTS].join(' / ')} 音频，当前是 .${ext}`);
  }
  const buf = fs.readFileSync(o.audioPath);
  if (!buf.length) throw new Error('待识别音频为空');
  const tdid = generateTdid();

  onProgress(32, '取上传凭证 …');
  log(`音频 ${path.basename(o.audioPath)}（${(buf.length / 1048576).toFixed(1)} MB）→ 剪映云端（tdid=${tdid}）`);
  const creds = await uploadSign(tdid, signal);
  log('已取到上传凭证');

  onProgress(40, '申请上传位置 …');
  const st = await applyUpload(creds, buf.length, signal);
  onProgress(46, '上传音频 …');
  log(`开始上传（${st.host}）`);
  const storeUri = await uploadFile(buf, st, creds.sessionToken, onProgress, signal);
  log('音频已上传完成');

  onProgress(58, '创建识别任务 …');
  const taskId = await submitTask(storeUri, tdid, signal);
  log(`识别任务已创建：${taskId}`);

  const t0 = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw new Error('已取消');
    if (Date.now() > deadline) throw new Error(`剪映识别超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`);
    const r = await queryTask(taskId, tdid, signal);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (r.data == null) {                       // 还在排队/识别中
      onProgress(Math.min(85, 60 + Math.round(elapsed / 6)), `识别中 … ${elapsed}s`);
      if (elapsed % 15 < 3) log(`识别中（已用 ${elapsed} 秒）`);
      await sleep(elapsed < 30 ? 2000 : 5000);
      continue;
    }
    if (!Array.isArray(r.data.utterances)) {
      throw new Error('剪映查询响应缺少 utterances：' + JSON.stringify(r).slice(0, 200));
    }
    onProgress(86, '解析识别结果 …');
    const segments = toSegments(r);
    log(`识别完成：${segments.length} 句（用时 ${elapsed} 秒）`);
    return { segments };
  }
}

module.exports = { transcribe, toSegments, crc32, generateTdid, SUPPORTED_EXTS, API_BASE };
