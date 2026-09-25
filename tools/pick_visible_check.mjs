// 判定"对话框在本环境到底显示没显示": 用 Win32 API 查有没有可见的顶层窗口属于 powershell
// 如果 ShowDialog 卡 15s 且期间无任何可见窗口 → 对话框不可见(用户视角=没弹出来), 与用户报告吻合
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const psList = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  '$form = New-Object System.Windows.Forms.Form',
  '$form.TopMost = $true; $form.Opacity = 0',
  '$d = New-Object System.Windows.Forms.OpenFileDialog',
  "$d.Filter = 'Video|*.mp4|All files|*.*'",
  '$r = $d.ShowDialog($form)',
].join('; ');

const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psList], { windowsHide: true });
console.log('对话框脚本已启动, 5 秒后枚举可见窗口...');

const checkScript = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$found = @()
$cb = [WinEnum+EnumWindowsProc]{ param($h, $l)
  if ([WinEnum]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match 'Select video|video file|Open') { $found += $t }
  }
  $true
}
[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($found.Count) { "VISIBLE: " + ($found -join '; ') } else { "NO-VISIBLE-DIALOG" }
`;

setTimeout(() => {
  const c = spawn('powershell.exe', ['-NoProfile', '-Command', checkScript], { windowsHide: true });
  let out = '';
  c.stdout.on('data', d => out += String(d));
  c.on('close', () => {
    console.log('窗口枚举结果:', out.trim().slice(0, 300));
    try { p.kill(); } catch {}
    process.exit(0);
  });
}, 5000);
