/* 用 Git Data API 推送 commit 并移动 tag(git push 在本机网络不稳: 直连时通时断)。
 * 本脚本只推**修复后新增的那一个 commit**, 不重建历史。
 * 用法: node tools/gh_push_fix.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = process.cwd();
const REPO = 'EndiVee233/SubFabric';
const TOKEN = readFileSync(resolve(ROOT, '_t/token.txt'), 'utf8').trim();
const API = 'https://api.github.com';

const api = async (path, opts = {}) => {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'SubFabric-release',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
};

/* 1) 远端 main 当前 commit */
const ref = await api(`/repos/${REPO}/git/ref/heads/main`);
if (!ref.ok) { console.error('读远端 ref 失败', ref.status, ref.text.slice(0, 200)); process.exit(1); }
const remoteSha = ref.json.object.sha;
console.log('远端 main =', remoteSha.slice(0, 8));

/* 2) 本地相对远端多出的 commit(只推这些) */
/* ⚠ 本机 spawnSync/execFileSync 会被沙箱拦(EBUSY) —— 必须用异步 spawn。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const sh = async (args) => (await execFileP('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })).stdout.trim();
/* ⚠ 不能用 `rev-list remoteSha..HEAD`: 经 API 重建的 commit 在本地不存在,
 *   比对会报 Invalid revision range。改为"本地 HEAD 往前数, 与远端已有的 SHA 比对"。
 *   远端历史是通过 API 重建的, 本地与之无共同祖先, 所以按"远端 commit message 已存在"来判断。*/
const remoteLog = await sh(['log', '--format=%H %s', '-20', 'HEAD']);
const remoteMsgs = new Set();
try {
  const r = await api(`/repos/${REPO}/commits?per_page=30`);
  if (r.ok) for (const c of r.json) remoteMsgs.add(c.commit.message.split('\n')[0].trim());
} catch {}
const localLog = (await sh(['log', '--format=%H%x09%s', '-20', 'HEAD'])).split('\n').filter(Boolean);
const todo = [];
for (const line of localLog) {
  const [sha, ...rest] = line.split('\t');
  const subj = rest.join('\t').split('\n')[0].trim();
  if (sha === remoteSha) break;                 // 已推到的位置
  if (!remoteMsgs.has(subj)) todo.unshift(sha); // 远端没有这条 → 待推(从旧到新)
}
console.log('待推送 commit:', todo.length);
if (!todo.length) { console.log('(无新 commit)'); process.exit(0); }

/* 3) 逐个 commit 重建: tree → commit → 移动 ref */
let parent = remoteSha;
for (const c of todo) {
  const msg = await sh(['log', '-1', '--format=%B', c]);
  const files = await sh(['ls-tree', '-r', '--name-only', c]);
  const list = files.split('\n').filter(Boolean);
  const blobs = [];
  for (const f of list) {
    const buf = readFileSync(join(ROOT, f));
    const b = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    if (!b.ok) { console.error('blob 失败', f, b.status); process.exit(1); }
    blobs.push({ path: f, mode: '100644', type: 'blob', sha: b.json.sha });
  }
  const t = await api(`/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ tree: blobs }) });
  if (!t.ok) { console.error('tree 失败', t.status, t.text.slice(0, 200)); process.exit(1); }
  const cm = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST', body: JSON.stringify({ message: msg, tree: t.json.sha, parents: [parent] }),
  });
  if (!cm.ok) { console.error('commit 失败', cm.status, cm.text.slice(0, 200)); process.exit(1); }
  const up = await api(`/repos/${REPO}/git/refs/heads/main`, {
    method: 'PATCH', body: JSON.stringify({ sha: cm.json.sha, force: false }),
  });
  if (!up.ok) { console.error('更新 main 失败', up.status, up.text.slice(0, 200)); process.exit(1); }
  console.log(`  ✓ ${c.slice(0, 8)} → 远端 ${cm.json.sha.slice(0, 8)}  (${list.length} 文件)`);
  parent = cm.json.sha;
}
const newSha = parent;

/* 4) 把 tag v2.1.3 移到新提交(先解引用再重建, 因为 tag 是 annotated)
 * ⚠ 补推后续 commit 时应跳过: 通过 API 重建出的 commit 与本地 SHA 不同,
 *   用 rev-list 比对会报 Invalid revision range; 且 tag 已指向远端对象, 不该再动。*/
if (process.argv.includes('--no-tag')) { console.log('  (--no-tag: 跳过移动 tag)'); }
else {
const tagObj = await api(`/repos/${REPO}/git/refs/tags/v2.1.3`);
let tagSha = tagObj.ok ? tagObj.json.object.sha : null;
let tagType = tagObj.ok ? tagObj.json.object.type : null;
if (tagSha) {
  const del = await api(`/repos/${REPO}/git/refs/tags/v2.1.3`, { method: 'DELETE' });
  console.log(del.ok || del.status === 422 ? '  ✓ 删除旧 tag 引用' : `  ! 删除返回 ${del.status}`);
}
// 重建 annotated tag 指向新提交
const localTagSha = await sh(['rev-parse', 'v2.1.3^{}']);
const tagMsg = await sh(['tag', '-l', '--format=%(contents:subject)', 'v2.1.3']);
const t2 = await api(`/repos/${REPO}/git/tags`, {
  method: 'POST',
  body: JSON.stringify({
    tag: 'v2.1.3', message: tagMsg || 'SubFabric v2.1.3',
    object: newSha, type: 'commit',
  }),
});
if (!t2.ok) { console.error('建 tag 对象失败', t2.status, t2.text.slice(0, 200)); process.exit(1); }
const t3 = await api(`/repos/${REPO}/git/refs`, {
  method: 'POST', body: JSON.stringify({ ref: 'refs/tags/v2.1.3', sha: t2.json.sha }),
});
console.log(t3.ok ? '✓ tag v2.1.3 已指向 ' + newSha.slice(0, 8) : '✗ tag 重建失败 ' + t3.status);
}

console.log('\n最终 main =', newSha);
