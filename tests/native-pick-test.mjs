import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8');
const start = source.indexOf('function nativePick(');
const end = source.indexOf('\n/* 路由段: 波形', start);
assert(start >= 0 && end > start);

function script(kind, purpose, raw = '') {
  let command, result;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const context = {
    path, os: {tmpdir: () => 'temp'}, process: {pid: 123},
    fs: {readFileSync: () => raw, unlinkSync() {}},
    normalizePickedPath: (value, folder) => { assert.equal(folder, kind === 'folder'); return value; },
    MEDIA_ALLOW: new Set(), mediaKey: value => value,
    setTimeout: () => 1, clearTimeout() {},
    spawn(executable, args, options) {
      assert.equal(executable, 'powershell.exe');
      assert.equal(options.windowsHide, true);
      assert.deepEqual(Array.from(args.slice(0, 3)), ['-NoProfile', '-STA', '-Command']);
      command = args[3]; return child;
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.nativePick(kind, value => {result = value;}, purpose);
  child.emit('close', 0);
  return {command, result};
}

const exported = script('folder', 'video-export', 'D:\\字幕\\成片');
assert.match(exported.command, /\$d.Description = '选择导出视频保存目录'/);
assert(!exported.command.includes('必须为空目录'));
assert.equal(exported.result.path, 'D:\\字幕\\成片');
assert.match(exported.command, /FindDialog\(\[uint32\]\$PID, \$form.Handle\)/);
assert.match(exported.command, /id != processId.*GetWindow\(h, 4\) != owner/);
assert.match(exported.command, /name.ToString\(\) != "#32770"/);
assert.match(exported.command, /SetWindowText\(\$dlg, '选择导出视频保存目录'\)/);
assert.match(exported.command, /SetForegroundWindow\(\$dlg\)/);
assert(!exported.command.includes('::FindWindow('), 'localized folder captions must not prevent activation');
assert.match(exported.command, /\$form.TopMost = \$false/);
assert(!exported.command.includes('$form.TopMost = $true'), 'do not pin above unrelated apps');
assert.equal(script('folder', '').result.cancelled, true);
assert.match(script('folder', "'; injected").command, /\$d.Description = '选择文件夹'/);
assert(!script('folder', "'; injected").command.includes('injected'));
for (const kind of ['video', 'sub', 'python', 'audio']) {
  const result = script(kind, 'video-export');
  assert.match(result.command, /New-Object System.Windows.Forms.OpenFileDialog/);
  assert.equal(result.result.cancelled, true);
}
const client = fs.readFileSync(path.join(root, 'editor/js/export-video.js'), 'utf8');
assert.match(client, /JSON.stringify\(\{ kind: 'folder', purpose: 'video-export' \}\)/);
assert.match(source, /purpose = options.purpose === 'video-export' \? 'video-export' : ''/);
assert.match(source, /nativePick\(kind, r => sendJson\(res, 200, r\), purpose\)/);
// 执行真实前端选择回调，核对用途、成功回填及取消时保留当前目录。
const browseStart = client.indexOf('async function browseFolder()');
const browseEnd = client.indexOf('\nasync function ', browseStart + 1);
assert(browseStart >= 0 && browseEnd > browseStart);
const controls = {'sf-ev-browse': {textContent: '浏览…', disabled: false}, 'sf-ev-dir': {value: 'old'}};
let reply = {path: 'D:\\字幕\\成片'}, request, updates = 0;
const browser = vm.createContext({
  $: id => controls[id], AbortController, setTimeout: () => 1, clearTimeout() {},
  toast() {}, updateStartState() {updates++;},
  async fetch(url, options) {request = {url, ...JSON.parse(options.body)}; return {json: async () => reply};},
});
vm.runInContext(client.slice(browseStart, browseEnd), browser);
await browser.browseFolder();
assert.deepEqual(request, {url: '/api/pick', kind: 'folder', purpose: 'video-export'});
assert.equal(controls['sf-ev-dir'].value, reply.path);
assert.equal(controls['sf-ev-browse'].disabled, false);
reply = {cancelled: true}; await browser.browseFolder();
assert.equal(controls['sf-ev-dir'].value, 'D:\\字幕\\成片');
assert.equal(updates, 1);
console.log('Native picker: export description, owned localized dialog activation, cancellation, Unicode paths and purpose allowlist passed');
