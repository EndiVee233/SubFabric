/* 上传 Release 资产(裸二进制)。
 *
 * ⚠ 踩坑记录(三次才搞对):
 *  1. curl --data-binary 发裸二进制 + 无 Content-Length → 长时间无响应(被 --max-time 砍掉)
 *     → 误判成"网络慢/超时"。实测网络没问题: 1MB 约 2s。
 *  2. 改 multipart/form-data → 400 "Multipart form data required" —— 但这**是错的**,
 *     官方文档明确: Release 资产要的是**裸二进制**(application/octet-stream)。
 *  3. multipart 改对格式后 → 422 "Bad Size"。
 *  结论: 回到裸二进制, 但必须显式带 Content-Length(Node fetch 用 Buffer body 时
 *  会自动算, 但经代理时可能丢), 且不要设 Content-Length 之外的多余头。
 *
 * 用法: node tools/gh_upload.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const TOKEN = readFileSync(resolve(ROOT, '_t/token.txt'), 'utf8').trim();
const url = readFileSync(resolve(ROOT, '_t/asset_url.txt'), 'utf8').trim().split('?')[0];
const FILE = resolve(ROOT, 'build/installer/SubFabric-2.1.3-setup.exe');
const NAME = 'SubFabric-2.1.3-setup.exe';

const buf = readFileSync(FILE);
const size = statSync(FILE).size;
console.log(`待上传: ${NAME}  ${(size / 1048576).toFixed(2)}MB (${size} 字节)`);

const t0 = Date.now();
try {
  const res = await fetch(url + '?name=' + encodeURIComponent(NAME), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'User-Agent': 'SubFabric-release',
    },
    body: buf,
  });
  const text = await res.text();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`HTTP=${res.status}  用时=${dt}s  平均=${(size / 1024 / 1024 / (dt || 1)).toFixed(2)}MB/s`);
  if (res.ok) {
    const d = JSON.parse(text);
    console.log('✓ 上传成功');
    console.log('  名称:', d.name, '| 大小:', d.size, '字节');
    console.log('  digest:', d.digest || '(无)');
    console.log('  下载:', d.browser_download_url);
    writeFileSync(resolve(ROOT, '_t/asset_ok.json'), text);
  } else {
    console.log('✗ 失败:', text.slice(0, 400));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('上传异常:', e.message, '| 用时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  process.exitCode = 1;
}
