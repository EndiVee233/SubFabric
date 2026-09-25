// 单测 nativePick 的核心: 不带对话框, 只测 spawn powershell + STA + WinForms 加载耗时
import { spawn } from 'node:child_process';

const t0 = Date.now();
const ps = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '[System.IO.File]::WriteAllText(\'C:\\Users\\SpokeIsThere\\AppData\\Local\\Temp\\kass-ps-test.txt\', \'OK-\' + (Get-Date).ToString(\'HHmmss\'), (New-Object System.Text.UTF8Encoding($false)))',
].join('; ');

const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
let err = '', out = '';
p.stdout.on('data', d => out += d);
p.stderr.on('data', d => err += d);
const timer = setTimeout(() => { console.log('>>> 25s 超时! powershell 无响应'); console.log('stdout:', out.slice(0, 500)); console.log('stderr:', err.slice(0, 500)); p.kill(); process.exit(2); }, 25000);
p.on('error', e => { clearTimeout(timer); console.log('spawn error:', e.message); });
p.on('close', code => {
  clearTimeout(timer);
  console.log('耗时:', Date.now() - t0, 'ms  exit code:', code);
  console.log('stderr:', err.slice(0, 800) || '(空)');
});
