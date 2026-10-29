import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sourcePath, digest, safePath } = require('./security.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'build/electron-stage');
fs.mkdirSync(output, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
const server = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8');
const appVersion = /const APP_VERSION = '([^']+)'/.exec(server)?.[1];
const fileVersion = /const APP_FILE_VERSION = '([^']+)'/.exec(server)?.[1];
if (pkg.version !== '1.5.1-beta.1' || appVersion !== 'beta 1.5.1.1' || fileVersion !== '1.5.1.1') throw Error('Desktop/server version mismatch');
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', 'editor', 'asr'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const paths = tracked.filter(p => !p.startsWith('editor/scripts/') || p === 'editor/scripts/7z.exe' || p === 'editor/scripts/7z-README.txt');
const vendor = ['editor/vendor/subtitles-octopus.js', 'editor/vendor/subtitles-octopus-worker.js', 'editor/vendor/subtitles-octopus-worker.wasm', 'editor/vendor/fonts/NotoSansCJKsc-Regular.otf'];
paths.push(...vendor);
const minima = [50000, 300000, 2000000, 10000000];
for (let i = 0; i < vendor.length; i++) if (!fs.existsSync(path.join(root, vendor[i])) || fs.statSync(path.join(root, vendor[i])).size < minima[i]) throw Error('Missing renderer dependency: ' + vendor[i] + '; run node editor/scripts/fetch-vendor.js');
const payload = path.join(output, 'payload');
// Do not delete previous staging files. builder.cjs packages only manifest-listed paths.
fs.mkdirSync(payload, { recursive: true });
const files = [];
for (const relative of paths.sort()) {
  sourcePath(relative);
  const src = safePath(root, relative), dst = safePath(payload, relative);
  fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
  files.push({ path: relative, sha256: digest(dst) });
}
const node = process.env.SUBFABRIC_NODE || process.execPath;
const nodeVersion = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
if (!/^v22\./.test(nodeVersion) || Number(nodeVersion.split('.')[1]) < 12) throw Error('Build with Node 22.12+ or set SUBFABRIC_NODE');
const targetNode = path.join(output, process.platform === 'win32' ? 'node.exe' : 'node');
fs.copyFileSync(node, targetNode);
const manifest = { format: 1, appVersion, fileVersion, nodeVersion, nodeSha256: digest(targetNode), files };
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ stagedFiles: files.length, nodeVersion, appVersion, output }));
