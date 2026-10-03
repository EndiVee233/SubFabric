/* 上传/替换 GitHub Release 资产(安装包)。
 *
 * ⚠ 本机只有 Python urllib 这条路径能成功(实测 2026-10-03):
 *   curl --data-binary / curl -F / Node fetch(裸) / Node FormData 全部失败。
 *   官方要求 application/octet-stream 裸二进制 + 显式 Content-Length。
 *   所以这里用 python 调 urllib, Node 只负责调度与打印。
 *
 * 用法: node tools/gh_upload.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const TOKEN = readFileSync(resolve(ROOT, '_t/token.txt'), 'utf8').trim();
const RELEASE_ID = readFileSync(resolve(ROOT, '_t/release_id.txt'), 'utf8').trim();
const FILE = resolve(ROOT, 'build/installer/SubFabric-2.1.3-setup.exe');
const NAME = 'SubFabric-2.1.3-setup.exe';

const size = statSync(FILE).size;
console.log(`待上传: ${NAME}  ${(size / 1048576).toFixed(2)}MB (${size} 字节)`);

/* 删掉同名旧资产(GitHub 不允许重名, 会返回 422) */
try {
  const { stdout } = await promisify(execFile)('curl', ['-s', '--max-time', '40',
    '-H', 'Authorization: Bearer ' + TOKEN,
    `https://api.github.com/repos/EndiVee233/SubFabric/releases/${RELEASE_ID}/assets`,
  ], { encoding: 'utf8', maxBuffer: 8e6 });
  const list = JSON.parse(stdout);
  for (const a of (Array.isArray(list) ? list : [])) {
    if (a.name !== NAME) continue;
    await promisify(execFile)('curl', ['-s', '--max-time', '40', '-X', 'DELETE',
      '-H', 'Authorization: Bearer ' + TOKEN,
      `https://api.github.com/repos/EndiVee233/SubFabric/releases/assets/${a.id}`,
    ], { encoding: 'utf8' });
    console.log(`  已删除旧资产 id=${a.id} (${(a.size / 1048576).toFixed(1)}MB)`);
  }
} catch (e) { console.log('  (清理旧资产时出错, 继续):', e.message.slice(0, 80)); }

const t0 = Date.now();
try {
  const { stdout } = await promisify(execFile)('python', ['-c', `
import urllib.request, json, time
t = open(r"${ROOT}\\_t\\token.txt").read().strip()
url = "https://uploads.github.com/repos/EndiVee233/SubFabric/releases/${RELEASE_ID}/assets?name=${NAME}"
data = open(r"${FILE.replace(/\\/g, '\\\\')}", "rb").read()
req = urllib.request.Request(url, data=data, method="POST")
req.add_header("Authorization", "Bearer " + t)
req.add_header("Accept", "application/vnd.github+json")
req.add_header("Content-Type", "application/octet-stream")
req.add_header("Content-Length", str(len(data)))
r = urllib.request.urlopen(req, timeout=280)
d = json.loads(r.read())
print(json.dumps({"name": d["name"], "size": d["size"], "digest": d.get("digest"),
                  "url": d["browser_download_url"]}))
`], { encoding: 'utf8', maxBuffer: 1e7 });
  const d = JSON.parse(stdout.trim().split('\n').pop());
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ 上传成功  用时 ${dt}s  ${(d.size / 1048576).toFixed(2)}MB`);
  console.log('  digest:', d.digest);
  console.log('  下载:', d.url);
  writeFileSync(resolve(ROOT, '_t/asset_ok.json'), JSON.stringify(d));
} catch (e) {
  console.error('✗ 上传失败:', (e.stderr || e.message || '').toString().slice(0, 300));
  process.exitCode = 1;
}
