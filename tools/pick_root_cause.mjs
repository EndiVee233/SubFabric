// 根因判定: 完整复刻 nativePick 的 PS 脚本 + 每步写 trace + Timer 4s 自动关
// 看 ShowDialog($form) 是否在"run from node spawn"下根本没显示(返回 Cancel 是 timer 关的)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = join(tmpdir(), 'kass-root-cause.txt');
const tmpPs = tmp.replace(/'/g, "''");
try { unlinkSync(tmp); } catch {}

const ps = [
  '$ErrorActionPreference = "Stop"',
  'function Log($m){ [System.IO.File]::AppendAllText(\'' + tmpPs + '\', $m + \'|\', (New-Object System.Text.UTF8Encoding($false))) }',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null; Log "winforms"',
  '$form = New-Object System.Windows.Forms.Form; $form.TopMost = $true; $form.Opacity = 0; Log "form"',
  '$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 4000; $timer.Add_Tick({ Log "tick"; $form.Close() }); $timer.Start(); Log "timer"',
  '$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = \'Video|*.mp4|All files|*.*\'; $d.CheckFileExists = $true; Log "dialog"',
  '$r = $d.ShowDialog($form); Log ("dlg-returned:" + $r)',
  'Log "end"',
].join('; ');

console.log('>> 请看屏幕: 4 秒内有没有对话框一闪而过?');
const t0 = Date.now();
const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
let err = '';
p.stderr.on('data', d => err += String(d));
const timer = setTimeout(() => { console.log('>>> 12s 超时'); try { p.kill(); } catch {} }, 12000);
p.on('close', code => {
  clearTimeout(timer);
  console.log('耗时:', Date.now() - t0, 'exit:', code);
  let raw = '';
  try { raw = readFileSync(tmp, 'utf8'); } catch {}
  console.log('trace:', raw || '(未写出)');
  try { unlinkSync(tmp); } catch {}
  if (err) console.log('stderr:', err.slice(0, 300));
  process.exit(0);
});
