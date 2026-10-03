/* 敏感值落盘保护单测: node tests/secret-store-test.mjs
 * 覆盖: AES 往返 / DPAPI 优先但不可用时退 AES / 密文里不出现明文 / 明文兼容 / 密文损坏报错 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const S = require_('../editor/secret-store.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const SECRET = 'ac87ca47%2C1806119310%2C8b687%2A91CjBdFFu6xh85n-qW9bEpg_kl6A8Gn4kob5cKqsWlPTtS0JhbBEvtSxwnwgtdrKL';
const CJK = '中文也要能往返 ✅ SESSDATA=' + SECRET;

/* ── AES 兜底路径（纯内置 crypto，不依赖 DPAPI） ── */
{
  const c = S.aesEncrypt(SECRET);
  ok(c.startsWith('aes:'), 'aesEncrypt 带 aes: 前缀', c.slice(0, 12));
  ok(S.aesDecrypt(c) === SECRET, 'AES 往返一致');
  ok(S.aesDecrypt(S.aesEncrypt(CJK)) === CJK, '中文/emoji 也能往返');
  ok(S.aesEncrypt(SECRET) !== c, '每次密文都不同（随机 IV）');
  ok(S.aesDecrypt(S.aesEncrypt(SECRET)) === SECRET, '不同密文解出同一明文');
  ok(S.isEncrypted(c), 'isEncrypted 认 aes:');
}

/* ── 默认入口：Windows 走 DPAPI，拿不到就退 AES —— 两条路都必须能往返 ── */
{
  const e = S.encrypt(SECRET);
  ok(S.isEncrypted(e), 'encrypt 产出密文', e.slice(0, 20));
  ok(S.decrypt(e) === SECRET, 'decrypt(encrypt(x)) === x（后端=' + S.backend() + '）');
  ok(S.decrypt(e) === SECRET, '第二次解密走缓存', S.backend());
  ok(S.decrypt(S.encrypt(CJK)) === CJK, '中文往返（默认入口）');
  ok(S.encrypt('') === '' && S.decrypt('') === '', '空值安全');
  ok(S.decrypt(SECRET) === SECRET, '传进明文（老配置）原样返回');
  ok(!S.isEncrypted(SECRET), '明文不算密文');
}

/* ── 关键：落盘内容里绝不能出现明文（否则"密文保存"就是空话） ── */
{
  const e = S.encrypt('SESSDATA=' + SECRET + '; bili_jct=abcdef0123456789');
  ok(e.indexOf('SESSDATA') < 0 && e.indexOf(SECRET.slice(0, 16)) < 0, '密文里搜不到明文片段', e.slice(0, 24));
  ok(e.indexOf('bili_jct') < 0, '密文里搜不到键名');
}

/* ── 损坏的密文要报错，不能悄悄给个空串 ── */
{
  let threw = false;
  try { S.aesDecrypt('aes:' + Buffer.from('garbage-not-valid-ciphertext').toString('base64')); } catch { threw = true; }
  ok(threw, '损坏的 AES 密文 → 抛错');

  const good = S.aesEncrypt(SECRET);
  const raw = Buffer.from(good.slice(4), 'base64');
  raw[raw.length - 1] ^= 0xff;                      // 篡改最后一个字节（GCM 会校验 tag）
  let threw2 = false;
  try { S.aesDecrypt('aes:' + raw.toString('base64')); } catch { threw2 = true; }
  ok(threw2, '被篡改的密文 → 认证失败抛错');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
