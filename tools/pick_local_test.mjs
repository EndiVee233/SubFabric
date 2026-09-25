// 发起 /api/pick 后, 从服务端内部直接观察 spawn 的行为(在 server 里注入诊断日志不可行,
// 这里用独立 node 进程模拟 server.js 的 nativePick 调用方式, 完整复刻):
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = join(tmpdir(), `kass-pick-${process.pid}-${Date.now().toString(36)}.txt`);
const tmpPs = tmp.replace(/'/g, "''");
const filter = 'Video|*.mp4;*.m4v;*.webm;*.mkv;*.avi;*.mov|All files|*.*';
const title = 'Select video file';

const ps = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$form = New-Object System.Windows.Forms.Form',
  '$form.TopMost = $true',
  '$form.Opacity = 0',
  '$d = New-Object System.Windows.Forms.OpenFileDialog',
  `$d.Title = '${title}'`,
  `$d.Filter = '${filter}'`,
  '$d.CheckFileExists = $true',
  '$r = $d.ShowDialog($form)',
  `$p = if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName } else { '' }`,
  `[System.IO.File]::WriteAllText('${tmpPs}', $p, (New-Object System.Text.UTF8Encoding($false)))`,
].join('; ');

console.log('tmp 文件:', tmp);
const t0 = Date.now();
const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
let err = '';
p.stdout.on('data', d => console.log('[stdout]', String(d).slice(0, 200)));
p.stderr.on('data', d => { err += String(d); console.log('[stderr]', String(d).slice(0, 300)); });
const timer = setTimeout(() => {
  console.log('>>> 15s 超时, powershell 还挂着(说明 ShowDialog 卡住=对话框其实有弹但看不见?) 杀掉');
  p.kill();
}, 15000);
p.on('error', e => console.log('spawn error:', e.message));
p.on('close', code => {
  clearTimeout(timer);
  console.log('耗时:', Date.now() - t0, 'ms  exit:', code);
  let raw = '';
  try { raw = readFileSync(tmp, 'utf8'); } catch { console.log('tmp 文件未写出'); }
  console.log('tmp 内容:', JSON.stringify(raw.slice(0, 300)));
  try { unlinkSync(tmp); } catch {}
  if (err) console.log('stderr 汇总:', err.slice(0, 600));
});
