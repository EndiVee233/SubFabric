// 最小复现: 完全按 server.js nativePick 的方式调用(同样的 join('; '), 同样 windowsHide),
// 但对话框会真的弹出来。如果这个卡住而 step-trace 版不卡, 就是 ShowDialog 的问题。
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = join(tmpdir(), 'kass-min-test.txt');
const tmpPs = tmp.replace(/'/g, "''");

// 与 nativePick 完全一致的行序
const ps = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$form = New-Object System.Windows.Forms.Form',
  '$form.TopMost = $true',
  '$form.Opacity = 0',
  '$d = New-Object System.Windows.Forms.OpenFileDialog',
  "$d.Title = 'Select video file'",
  "$d.Filter = 'Video|*.mp4;*.m4v;*.webm;*.mkv;*.avi;*.mov|All files|*.*'",
  '$d.CheckFileExists = $true',
  '$r = $d.ShowDialog($form)',
  "$p = if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName } else { '' }",
  `[System.IO.File]::WriteAllText('${tmpPs}', $p, (New-Object System.Text.UTF8Encoding($false)))`,
].join('; ');

console.log('--- PS 脚本 ---');
console.log(ps.slice(0, 300) + '...');
console.log('--------------');
console.log('>> 请看屏幕上是否弹出文件选择框(15 秒后自动结束)');

const t0 = Date.now();
const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
let err = '';
p.stderr.on('data', d => { err += String(d); });
const timer = setTimeout(() => { console.log('>>> 15s 到, 杀掉'); try { p.kill(); } catch {} }, 15000);
p.on('close', code => {
  clearTimeout(timer);
  console.log('耗时:', Date.now() - t0, 'exit:', code);
  let raw = '';
  try { raw = readFileSync(tmp, 'utf8'); } catch {}
  console.log('结果文件:', JSON.stringify(raw.slice(0, 200)) || '(未写出)');
  try { unlinkSync(tmp); } catch {}
  if (err) console.log('stderr:', err.slice(0, 400));
  process.exit(0);
});
