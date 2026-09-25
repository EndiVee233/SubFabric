// 关键对照实验: ShowDialog 用**无窗口**参数(不建 form, 直接 $d.ShowDialog())
// 与 winform owner 版本对比 —— 判断卡点是不是"Opacity=0 的 owner form"
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2] || 'trace';   // trace | nowindow | auto-close
const tmp = join(tmpdir(), 'kass-mode-test.txt');
const tmpPs = tmp.replace(/'/g, "''");

let lines;
if (mode === 'trace') {
  // 每一步写 trace, ShowDialog 换成 $form.Show() + 立刻 Close(不弹真对话框)
  lines = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '[System.IO.File]::AppendAllText(\'' + tmpPs + '\', \'A\', (New-Object System.Text.UTF8Encoding($false)))',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.TopMost = $true; $form.Opacity = 0',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Filter = \'Video|*.mp4|All files|*.*\'',
    '$d.CheckFileExists = $true',
    // 不调 ShowDialog —— 模拟对话框打开前
    '[System.IO.File]::AppendAllText(\'' + tmpPs + '\', \'B\', (New-Object System.Text.UTF8Encoding($false)))',
  ];
} else if (mode === 'nowindow') {
  lines = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Filter = \'Video|*.mp4|All files|*.*\'',
    '$r = $d.ShowDialog()',
    '$p = if ($r -eq OK) { $d.FileName } else { \'\' }',
    '[System.IO.File]::WriteAllText(\'' + tmpPs + '\', \'done:\' + $r, (New-Object System.Text.UTF8Encoding($false)))',
  ];
} else {
  // auto-close: 用 timer 强制关闭对话框, 模拟"用户取消", 看 ShowDialog 是否能返回
  lines = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.TopMost = $true; $form.Opacity = 0',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 4000',
    '$timer.Add_Tick({ $form.Close() })',
    '$timer.Start()',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Filter = \'Video|*.mp4|All files|*.*\'',
    '$r = $d.ShowDialog($form)',
    '[System.IO.File]::WriteAllText(\'' + tmpPs + '\', \'returned:\' + $r, (New-Object System.Text.UTF8Encoding($false)))',
  ];
}
const ps = lines.join('; ');

console.log('mode:', mode);
const t0 = Date.now();
const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
let err = '';
p.stderr.on('data', d => err += String(d));
const timer = setTimeout(() => { console.log('>>> 12s 超时杀掉'); try { p.kill(); } catch {} }, 12000);
p.on('close', code => {
  clearTimeout(timer);
  console.log('耗时:', Date.now() - t0, 'exit:', code);
  let raw = '';
  try { raw = readFileSync(tmp, 'utf8'); } catch {}
  console.log('结果:', JSON.stringify(raw.slice(0, 100)) || '(未写出)');
  try { unlinkSync(tmp); } catch {}
  if (err) console.log('stderr:', err.slice(0, 400));
  process.exit(0);
});
