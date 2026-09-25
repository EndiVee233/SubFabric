// 单测完整对话框脚本(不带 ShowDialog, 带一个隐藏 Form + ShowDialog):
// 找出卡住的是 Add-Type / Form 创建 / ShowDialog 哪一步 —— 每步写进度到临时文件
import { spawn } from 'node:child_process';

const T = 'C:\\Users\\SpokeIsThere\\AppData\\Local\\Temp\\kass-ps-trace.txt';
const ps = [
  `$tf = '${T}'`,
  'function Log($m){ [System.IO.File]::AppendAllText($tf, (Get-Date).ToString(\'HH:mm:ss.fff\') + \' \' + $m + [Environment]::NewLine) }',
  '$ErrorActionPreference = "Stop"',
  'Log "step1-start"',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  'Log "step2-winforms-loaded"',
  '$form = New-Object System.Windows.Forms.Form',
  '$form.TopMost = $true; $form.Opacity = 0',
  'Log "step3-form-created"',
  '$d = New-Object System.Windows.Forms.OpenFileDialog',
  '$d.Filter = \'Video|*.mp4|All files|*.*\'',
  'Log "step4-dialog-created"',
  '$form.Show(); Log "step5-form-shown"',
  '$form.Close(); Log "step6-form-closed"',
  'Log "done"',
].join('; ');

const t0 = Date.now();
const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
let err = '';
p.stderr.on('data', d => err += d);
const timer = setTimeout(() => { console.log('>>> 25s 超时'); console.log('stderr:', err.slice(0, 600)); p.kill(); process.exit(2); }, 25000);
p.on('close', code => { clearTimeout(timer); console.log('耗时:', Date.now() - t0, 'ms exit:', code, 'stderr:', err.slice(0, 400) || '(空)'); });
