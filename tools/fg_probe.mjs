// 验证 nativePick 的 PS 抢前台脚本能否通过 spawn 正常执行:
// 1) Add-Type 内嵌双引号经 node spawn 参数转义后 PowerShell 能否解析
// 2) SetForegroundWindow 调用是否报错(结果文件写出 = 整链路 OK)
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';

const tmp = join(tmpdir(), `fg-test-${Date.now().toString(36)}.txt`);
const tmpPs = tmp.replace(/'/g, "''");
const ps = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  "Add-Type -Namespace Kass -Name FG -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);' | Out-Null",
  '$form = New-Object System.Windows.Forms.Form',
  '$form.TopMost = $true',
  '$form.Opacity = 0',
  '$form.ShowInTaskbar = $false',
  '$null = $form.CreateControl()',
  '$ok = [Kass.FG]::SetForegroundWindow($form.Handle)',
  '$null = $form.Activate()',
  '[System.IO.File]::WriteAllText(\'' + tmpPs + '\', "FG=' + '$ok' + '", (New-Object System.Text.UTF8Encoding($false)))',
].join('; ');

const t0 = Date.now();
const timer = setTimeout(() => { console.log('TIMEOUT 10s'); p.kill(); process.exit(1); }, 10000);
const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
p.stderr.on('data', d => console.log('[stderr]', String(d).slice(0, 300)));
p.on('close', (code) => {
  clearTimeout(timer);
  let raw = '';
  try { raw = readFileSync(tmp, 'utf8'); } catch {}
  try { unlinkSync(tmp); } catch {}
  console.log('exit code:', code, '| result file:', JSON.stringify(raw), '| took', Date.now() - t0, 'ms');
  process.exit(raw.includes('FG=') ? 0 : 1);
});
