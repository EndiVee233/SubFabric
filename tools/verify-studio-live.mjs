// 当前安装版只读资源验收；显式 --toggle-config 时临时检查新旧入口并恢复原配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '../..');
const origin = 'http://127.0.0.1:8321';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(fs.readFileSync(process.argv[2]));
assert.equal(manifest.installed, root);
assert.equal(manifest.status, 'installed');
const laterDataChanges = [];
for (const [rel, expected] of Object.entries({ ...manifest.before, ...manifest.expected })) {
  const changed = hash(fs.readFileSync(path.join(root, rel))) !== expected;
  // 安装事务已断言用户数据不变；服务恢复使用后，用户编辑不能当作资源安装损坏或覆盖回去。
  if (rel.startsWith('projects/') || rel === 'asr/settings.json') {
    if (changed) laterDataChanges.push(rel);
  } else assert.equal(changed, false, rel);
}
const entry = async () => {
  const r = await fetch(origin + '/', { redirect: 'manual' });
  assert.equal(r.status, 302); assert.equal(r.headers.get('cache-control'), 'no-store'); return r.headers.get('location');
};
assert.equal(await entry(), '/editor/studio.html');
const strip = text => text.replace(/\?v=\d+/g, '').replace(/<meta name="build-stamp" content="\d+"><script>window\.__BUILD_STAMP="\d+";<\/script>/g, '');
const seen = new Set(), queue = ['/editor/studio.html', '/editor/index.html'];
while (queue.length) {
  const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
  const r = await fetch(origin + url); assert.equal(r.status, 200, url);
  const text = await r.text();
  if (/\.(html|css|js)$/.test(url)) assert.equal(strip(text), fs.readFileSync(path.join(root, url.slice(1)), 'utf8'), 'HTTP/disk mismatch: ' + url);
  const refs = url.endsWith('.html') ? [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]) : [...text.matchAll(/(?:from\s*|import\s*\()?['"]((?:\.{1,2}\/|\/)[^'"\n]+\.js(?:\?[^'"\n]*)?)['"]/g)].map(m => m[1]);
  for (const ref of refs) if (!ref.startsWith('#') && !/^[a-z]+:/i.test(ref)) queue.push(new URL(ref, origin + url).pathname);
}
assert.equal((await fetch(origin + '/ui-config.json')).status, 403);
if (process.argv.includes('--toggle-config')) {
  const file = path.join(root, 'ui-config.json'), before = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, '{"ui":"legacy"}\n'); assert.equal(await entry(), '/editor/index.html');
    fs.writeFileSync(file, '{"ui":"new"}\n'); assert.equal(await entry(), '/editor/studio.html');
  } finally { fs.writeFileSync(file, before); }
  assert.equal(hash(fs.readFileSync(file)), hash(before));
}
const version = await (await fetch(origin + '/api/version')).json();
const projects = await (await fetch(origin + '/api/projects')).json();
console.log(JSON.stringify({ version: version.version, vendorOk: version.vendorOk, projects: projects.projects.length, resources: seen.size, entry: await entry(), installedHashes: 'passed', configPrivacy: 'passed', laterDataChanges, legacyToggle: process.argv.includes('--toggle-config') ? 'passed and restored' : 'not tested' }));
