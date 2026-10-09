'use strict';
/**
 * 敏感值的落盘保护（bilibili Cookie 这类）—— 不再明文写进 asr/settings.json。
 *
 * 两级：
 *   ① Windows：**DPAPI**（CryptProtectData / CurrentUser）—— 密钥由操作系统保管，
 *      换机器、换 Windows 用户都解不开，比"自己加密自己解"实在得多。经 powershell.exe(5.1) 调用，
 *      每次约 200ms，所以结果按密文串做内存缓存（同一份配置反复读只解一次）。
 *   ② 非 Windows / 机上没有 DPAPI：AES-256-GCM，密钥 = scrypt(主机名 + 用户名 + 固定盐)。
 *      这一级属于**混淆**（本机代码可反推密钥），但配置文件里至少不再是明文。
 *
 * 落盘格式：`dpapi:<base64>` / `aes:<base64(iv|tag|ct)>`。
 * 解不开（换机器、被改坏）→ 抛错，由调用方决定怎么办（一般是"当没配"并提示重新粘贴）。
 */
const crypto = require('crypto');
const os = require('os');
const childProcess = require('child_process');

const DPAPI_PREFIX = 'dpapi:';
const AES_PREFIX = 'aes:';
const cache = new Map();          // 密文 → 明文（DPAPI 起进程贵，别重复解）

const isEncrypted = (s) => typeof s === 'string' && (s.startsWith(DPAPI_PREFIX) || s.startsWith(AES_PREFIX));

/* ── AES 兜底（纯内置 crypto，跨平台） ─────────────────────────────── */
function aesKey() {
  const material = [os.hostname(), os.userInfo().username || '', 'SubFabric', 'bili-cookie-v1'].join('|');
  return crypto.scryptSync(material, 'subfabric-secret-salt', 32);
}
function aesEncrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return AES_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function aesDecrypt(stored) {
  const buf = Buffer.from(String(stored).slice(AES_PREFIX.length), 'base64');
  if (buf.length < 29) throw new Error('密文长度不对');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/* ── DPAPI（Windows，用户级） ─────────────────────────────────────── */
const PS_PROTECT = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); "
  + "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))";
const PS_UNPROTECT = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); "
  + "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))";

let dpapiUsable = null;           // null = 还没试过；false = 这台机器上不可用（之后一律走 AES）
function psRun(script, inputB64) {
  const cands = ['powershell.exe'];
  if (process.env.SystemRoot) {
    cands.push(process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  }
  let lastErr = null;
  for (const exe of cands) {
    try {
      return String(childProcess.execFileSync(exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { input: inputB64, encoding: 'utf8', timeout: 20000, windowsHide: true }) || '').trim();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('powershell 不可用');
}
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** 加密：Windows 优先 DPAPI，不可用则 AES-GCM。空串原样返回空串。 */
function encrypt(plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return '';
  if (process.platform === 'win32' && dpapiUsable !== false) {
    try {
      const out = DPAPI_PREFIX + psRun(PS_PROTECT, b64(s));
      dpapiUsable = true;
      cache.set(out, s);
      return out;
    } catch { dpapiUsable = false; }
  }
  const out = aesEncrypt(s);
  cache.set(out, s);
  return out;
}

/** 解密。密文解不开时抛错；传进来的若是明文（老配置）原样返回。 */
function decrypt(stored) {
  const s = String(stored == null ? '' : stored);
  if (!s) return '';
  if (!isEncrypted(s)) return s;
  if (cache.has(s)) return cache.get(s);
  let out = '';
  if (s.startsWith(DPAPI_PREFIX)) {
    out = Buffer.from(psRun(PS_UNPROTECT, s.slice(DPAPI_PREFIX.length)), 'base64').toString('utf8');
  } else {
    out = aesDecrypt(s);
  }
  cache.set(s, out);
  return out;
}

/** 当前实际用的后端（给日志/自检用）：'dpapi' | 'aes' */
function backend() {
  if (dpapiUsable === true) return 'dpapi';
  if (dpapiUsable === false) return 'aes';
  return process.platform === 'win32' ? 'dpapi(未探测)' : 'aes';
}

module.exports = { encrypt, decrypt, isEncrypted, backend, aesEncrypt, aesDecrypt, DPAPI_PREFIX, AES_PREFIX };
