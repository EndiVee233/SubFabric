/* 上传/替换 GitHub Release 资产(安装包)。
 *
 * ⚠ 本机只有 Python urllib 这条路径能成功(实测 2026-10-03):
 *   curl --data-binary / curl -F / Node fetch(裸) / Node FormData 全部失败。
 *   官方要求 application/octet-stream 裸二进制 + 显式 Content-Length。
 *   所以这里用 python 调 urllib, Node 只负责调度与打印。
 *
 * 用法: node tools/gh_upload.mjs [releaseId]
 *   releaseId 省略时读 _t/release_id.txt；版本号从 editor/server.js 的 APP_VERSION 读。
 *   token 优先读 _t/token.txt，没有就问 Windows 凭据管理器（绕开会弹 GUI 的 helper-selector）。
 *   传完自动核对远端 digest 与本地 sha256。
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const run = promisify(execFile);

function getToken() {
  const f = resolve(ROOT, '_t/token.txt');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const helper = 'C:/Users/SpokeIsThere/.workbuddy-ai/binaries/PortableGit/versions/1.2.0/mingw64/bin/git-credential-wincred.exe';
  const out = execFileSync(helper, ['get'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  });
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('拿不到 GitHub token（凭据管理器里没有 github.com）');
  return m[1].trim();
}

const VERSION = /APP_VERSION\s*=\s*'([^']+)'/.exec(
  readFileSync(resolve(ROOT, 'editor/server.js'), 'utf8'))[1];
const NAME = `SubFabric-${VERSION}-setup.exe`;
const FILE = resolve(ROOT, 'build/installer', NAME);
const RELEASE_ID = String(process.argv[2]
  || (existsSync(resolve(ROOT, '_t/release_id.txt'))
    ? readFileSync(resolve(ROOT, '_t/release_id.txt'), 'utf8') : '')).trim();
if (!RELEASE_ID) { console.error('缺少 releaseId（argv[2] 或 _t/release_id.txt）'); process.exit(1); }

const TOKEN = getToken();
const size = statSync(FILE).size;
console.log(`版本 ${VERSION}  待上传: ${NAME}  ${(size / 1048576).toFixed(2)}MB (${size} 字节)`);

/* 删掉同名旧资产(GitHub 不允许重名, 会返回 422) */
try {
  const { stdout } = await run('curl', ['-s', '--max-time', '40',
    '-H', 'Authorization: Bearer ' + TOKEN,
    `https://api.github.com/repos/EndiVee233/SubFabric/releases/${RELEASE_ID}/assets`,
  ], { encoding: 'utf8', maxBuffer: 8e6 });
  const list = JSON.parse(stdout);
  for (const a of (Array.isArray(list) ? list : [])) {
    if (a.name !== NAME) continue;
    await run('curl', ['-s', '--max-time', '40', '-X', 'DELETE',
      '-H', 'Authorization: Bearer ' + TOKEN,
      `https://api.github.com/repos/EndiVee233/SubFabric/releases/assets/${a.id}`,
    ], { encoding: 'utf8' });
    console.log(`  已删除旧资产 id=${a.id} (${(a.size / 1048576).toFixed(1)}MB)`);
  }
} catch (e) { console.log('  (清理旧资产时出错, 继续):', e.message.slice(0, 80)); }

const t0 = Date.now();
try {
  const { stdout } = await run('python', ['-c', `
import urllib.request, json, hashlib
t = ${JSON.stringify(TOKEN)}
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
                  "state": d.get("state"), "url": d["browser_download_url"],
                  "local_sha256": hashlib.sha256(data).hexdigest()}))
`], { encoding: 'utf8', maxBuffer: 1e7 });
  const d = JSON.parse(stdout.trim().split('\n').pop());
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ 上传成功  用时 ${dt}s  ${(d.size / 1048576).toFixed(2)}MB  state=${d.state}`);
  console.log('  远端 digest:', d.digest);
  console.log('  本地 sha256:', d.local_sha256);
  const same = String(d.digest || '').replace(/^sha256:/, '') === d.local_sha256;
  console.log(same ? '✓ 摘要一致' : '✗ 摘要不一致！');
  if (!same) process.exitCode = 1;
  console.log('  下载:', d.url);
  writeFileSync(resolve(ROOT, '_t/asset_ok.json'), JSON.stringify(d));
} catch (e) {
  console.error('✗ 上传失败:', (e.stderr || e.message || '').toString().slice(0, 400));
  process.exitCode = 1;
}
