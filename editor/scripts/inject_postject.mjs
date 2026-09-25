// 用 postject 把 SEA blob 注入 node.exe 副本(官方 SEA 流程的第 4 步)。
// postject 需要通过 npm 拉一次(带 --yes), 之后走本地缓存。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const NPX = process.execPath;              // 用当前 node 跑 npm 的 npx-cli.js
const [exe, blob] = process.argv.slice(2);
if (!exe || !blob) { console.error('用法: node inject_postject.mjs <exe> <blob>'); process.exit(1); }

// 定位 npm 的 npx-cli.js(与 node 同发行版)
const nodeDir = dirname(process.execPath);
const candidates = [
  join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
];
const npxCli = candidates.find(existsSync);
if (!npxCli) { console.error('未找到 npx-cli.js:', candidates); process.exit(1); }

function npx(args) {
  console.log('> npx', args.join(' '));
  const r = spawnSync(process.execPath, [npxCli, '--yes', ...args],
    { stdio: 'inherit', cwd: ROOT, shell: false, env: { ...process.env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

npx(['postject', exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
console.log('blob 已注入:', exe);
