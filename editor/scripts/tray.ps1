<#
  SubFabric 托盘图标（Windows PowerShell 5.1；由 editor/server.js 在服务就绪后启动）

  ⚠ 本文件必须存成 **UTF-8 带 BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按系统
    ANSI(GBK) 解码 —— 中文菜单乱码，个别字节还会让脚本直接解析失败。改完记得补 BOM
    （Get-Content -Raw -Encoding UTF8 → WriteAllText + UTF8Encoding($true)，见 README 技术要点）。

  为什么要有它：发行版 SubFabric.exe 是 GUI 子系统（双击没有控制台窗口），
  关掉浏览器页面后服务照旧在后台跑 —— 用户根本找不到"退出这个程序"的地方，
  只能去任务管理器杀进程；再双击一次也只会被"端口 8321 已被占用"顶回来。
  托盘图标补上这个出口：
      双击图标 = 打开界面        右键 = 打开界面 / 完全退出

  「完全退出」= POST http://127.0.0.1:<Port>/api/quit
      → 服务端广播 shutdown 给已打开的页面（页面补存一次并关掉自己的窗口）
      → 杀掉全部子进程（ffmpeg / Python 识别 / PowerShell 选择器）
      → 关服务、断长连接、退出进程（端口随之释放）
  若 3 秒内端口还没释放，这里再按 PID 强杀一次兜底 —— 只在 exe 路径与启动时一致时
  才杀，避免 PID 被系统回收后误杀别人的进程。

  自检开关（给自动化用，不弹任何窗口）：
      powershell -File scripts/tray.ps1 -Port 8321 -SelfTest   # 建好图标/菜单后立刻收摊
      powershell -File scripts/tray.ps1 -Port 8321 -QuitOnce   # 直接跑一遍「完全退出」
#>
[CmdletBinding()]
param(
  [int]$Port = 8321,
  [int]$ServerPid = 0,          # 注意: 不能叫 $Pid —— 那是 PowerShell 只读自动变量
  [string]$Exe = '',
  [string]$Icon = '',
  [string]$Version = '',
  [string]$RootDir = '',        # 数据目录(缺省从脚本位置推: scripts -> editor -> 仓库根)
  [switch]$SelfTest,
  [switch]$QuitOnce
)

$ErrorActionPreference = 'Stop'
$BaseUrl = "http://127.0.0.1:$Port/"
$LogFile = Join-Path $env:TEMP 'SubFabric-tray.log'
$HintFile = Join-Path $env:TEMP 'SubFabric-tray-hinted'      # 首次运行提示只弹一次

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:ni = $null
$script:menu = $null
$script:cleanupTimer = $null
$script:hintTimer = $null
$script:misses = 0
$script:quitting = $false

function Write-TrayLog([string]$msg) {
  try {
    Add-Content -LiteralPath $LogFile -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
  } catch {}
}

# 托盘里的异常也送进应用自己的「日志」页(前端 /api/logs/client 就是干这个的)
function Send-TrayLog([string]$msg) {
  Write-TrayLog $msg
  try {
    $req = [System.Net.HttpWebRequest]::Create("${BaseUrl}api/logs/client")
    $req.Method = 'POST'
    $req.Proxy = $null
    $req.Timeout = 1500
    $req.ContentType = 'text/plain; charset=utf-8'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('[tray] ' + $msg)
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $req.GetResponse().Close()
  } catch {}
}

# 托盘悬停提示(NOTIFYICONDATA.szTip)是定长字段 —— 超长会被截断甚至取不到,
# 所以这里显式截到 62 字符, 保证版本号再长也不会让提示整个空掉。
function Shorten([string]$s, [int]$max = 62) {
  if ($null -eq $s) { return '' }
  if ($s.Length -le $max) { return $s }
  return $s.Substring(0, $max - 1) + '…'
}

# 数据目录: server.js 会传 -RootDir; 没传(老版本/手工启动)就从脚本位置往上推两级。
$script:DataDir = ''
function Get-DataRoot {
  if ($script:DataDir) { return $script:DataDir }
  $cand = ''
  if ($RootDir) { $cand = $RootDir }
  elseif ($PSScriptRoot) { $cand = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }
  $script:DataDir = $cand
  return $cand
}

function Test-PortOpen {
  # 纯 .NET 同步探活。**不要**改回 MSWinsock.Winsock —— 那是 VB6 时代的 COM 控件,
  # 在 PowerShell 里需要消息泵, 异步 Connect 常常永远到不了 State=7,
  # 结果是"服务明明活着却被判成退出", 托盘图标起来几秒后自己消失(实测踩过, 见提交说明)。
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(400, $false)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch {}
  }
}

function Get-TrayIcon {
  # ① 仓库自带的 tray.ico(多尺寸, 16x16 也清晰)
  if ($Icon -and (Test-Path -LiteralPath $Icon)) {
    try { return (New-Object System.Drawing.Icon($Icon)) } catch { Write-TrayLog ('图标加载失败: ' + $_.Exception.Message) }
  }
  # ② 退回启动器自身的图标(SubFabric.exe / node.exe)
  if ($Exe -and (Test-Path -LiteralPath $Exe)) {
    try { return ([System.Drawing.Icon]::ExtractAssociatedIcon($Exe)).Clone() } catch {}
  }
  # ③ 系统默认图标 —— 图标再丑也不能让托盘起不来
  return [System.Drawing.SystemIcons]::Application
}

function Open-Interface {
  if ($script:quitting) { return }
  $cands = @()
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
  $edge = @($cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) })[0]
  try {
    if ($edge) {
      # 与 sea-launcher.cjs 同一套参数: Edge 应用模式(独立窗口、无地址栏)
      Start-Process -FilePath $edge -ArgumentList @("--app=$BaseUrl", '--no-first-run', '--no-default-browser-check') | Out-Null
      Write-TrayLog '打开界面(Edge 应用窗口)'
      return
    }
  } catch { Write-TrayLog ('Edge 启动失败: ' + $_.Exception.Message) }
  try { Start-Process $BaseUrl | Out-Null; Write-TrayLog '打开界面(默认浏览器)' } catch { Send-TrayLog ('浏览器启动失败: ' + $_.Exception.Message) }
}

function Close-Tray {
  try { if ($script:cleanupTimer) { $script:cleanupTimer.Stop(); $script:cleanupTimer.Dispose() } } catch {}
  try { if ($script:hintTimer) { $script:hintTimer.Stop(); $script:hintTimer.Dispose() } } catch {}
  try { if ($script:ni) { $script:ni.Visible = $false; $script:ni.Dispose() } } catch {}   # 先摘图标, 别留"幽灵图标"
  try { if ($script:menu) { $script:menu.Dispose() } } catch {}
  try { [System.Windows.Forms.Application]::Exit() } catch {}
}

function Stop-ServerProcess {
  if ($ServerPid -le 0) { return }
  try {
    $proc = Get-Process -Id $ServerPid -ErrorAction Stop
    $path = $null
    try { $path = $proc.Path } catch {}
    if ($Exe -and $path -and ($path -ne $Exe)) {
      Write-TrayLog ("PID $ServerPid 现在是 $path，不是启动时的 $Exe，放弃强杀")
      return
    }
    Stop-Process -Id $ServerPid -Force -ErrorAction Stop
    Write-TrayLog "已按 PID $ServerPid 强制结束服务进程"
  } catch { Write-TrayLog ('强杀失败(PID ' + $ServerPid + '): ' + $_.Exception.Message) }
}

function Invoke-Quit {
  $script:quitting = $true
  if ($script:cleanupTimer) { try { $script:cleanupTimer.Stop() } catch {} }
  try { if ($script:ni) { $script:ni.Visible = $false } } catch {}
  Write-TrayLog '用户点了「完全退出」'

  # ① 请服务自己收摊(它会杀子进程 + 关服务 + 退出)
  try {
    $req = [System.Net.HttpWebRequest]::Create("${BaseUrl}api/quit")
    $req.Method = 'POST'
    $req.Proxy = $null
    $req.KeepAlive = $false
    $req.Timeout = 3000
    $req.ReadWriteTimeout = 3000
    $req.Headers.Add('X-SubFabric-Quit', '1')
    $req.ContentLength = 0
    $req.GetResponse().Close()
    Write-TrayLog '服务已接受退出请求'
  } catch {
    # 连不上通常意味着服务已经退了 —— 不算失败, 后面照旧等端口释放
    Write-TrayLog ('退出请求异常(服务可能已退出): ' + $_.Exception.Message)
  }

  # ② 等端口真正释放(最多 5 秒)
  $freed = $false
  for ($i = 0; $i -lt 50; $i++) {
    if (-not (Test-PortOpen)) { $freed = $true; break }
    Start-Sleep -Milliseconds 100
  }
  # ③ 还没释放 → 按 PID 强杀兜底
  if (-not $freed) { Write-TrayLog '端口仍未释放，走强杀兜底'; Stop-ServerProcess }
  Close-Tray
}

function Open-DataDir {
  $dir = Get-DataRoot
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) {
    Send-TrayLog '数据目录不存在，无法打开'
    return
  }
  try { Start-Process explorer.exe -ArgumentList ('"' + $dir + '"') }
  catch { Send-TrayLog ('打开数据目录失败: ' + $_.Exception.Message) }
}

function Initialize-Tray {
  $script:ni = New-Object System.Windows.Forms.NotifyIcon
  $script:ni.Icon = Get-TrayIcon
  $script:ni.Text = 'SubFabric 字幕工作台'
  $script:ni.Visible = $true

  $script:menu = New-Object System.Windows.Forms.ContextMenuStrip
  $headText = 'SubFabric 字幕工作台'
  if ($Version) { $headText = $headText + " v$Version" }
  # 标题本身当状态用(托盘最容易被看到的一行): 服务一旦没响应这里立刻看得出来
  $script:headText = $headText
  $title = $script:menu.Items.Add($headText)
  $title.Enabled = $false
  # 只读的状态行: 端口与 PID —— 排查"到底有没有在跑/是哪个进程"时不用去翻任务管理器
  $script:statusItem = $script:menu.Items.Add('状态读取中 …')
  $script:statusItem.Enabled = $false
  $script:menu.Items.Add('-') | Out-Null                       # 分隔线
  $openItem = $script:menu.Items.Add('打开界面')
  $openItem.add_Click({ Open-Interface })
  $dirItem = $script:menu.Items.Add('打开数据目录')
  $dirItem.add_Click({ Open-DataDir })
  $script:menu.Items.Add('-') | Out-Null
  $quitItem = $script:menu.Items.Add('完全退出')
  $quitItem.Font = New-Object System.Drawing.Font($quitItem.Font, [System.Drawing.FontStyle]::Bold)
  $quitItem.add_Click({ Invoke-Quit })
  $script:ni.ContextMenuStrip = $script:menu
  # 初始状态先填上 —— 否则图标刚出现的 1.5 秒里提示是光秃秃的版本号
  $initLive = '运行中 · 端口 ' + $Port
  if ($ServerPid -gt 0) { $initLive = $initLive + ' · PID ' + $ServerPid }
  $script:ni.Text = Shorten ($headText + ' · ' + $initLive)
  $script:statusItem.Text = $initLive
  $script:ni.add_MouseDoubleClick({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Interface }
  })

  # 服务没了(崩溃 / 被任务管理器杀掉 / 从页面里发出的退出) → 图标自己消失, 不留孤儿图标。
  # 服务端退出时会**跳过**托盘进程(强杀会留下 Windows 幽灵图标), 所以这条路也是正常收尾路径。
  $script:cleanupTimer = New-Object System.Windows.Forms.Timer
  $script:cleanupTimer.Interval = 1500
  $script:cleanupTimer.add_Tick({
    if ($script:quitting) { return }
    if (Test-PortOpen) {
      $script:misses = 0
      # 服务活着 —— 顺手把状态刷到提示与菜单上(不额外起定时器)
      try {
        $live = '运行中 · 端口 ' + $Port
        if ($ServerPid -gt 0) { $live = $live + ' · PID ' + $ServerPid }
        $script:ni.Text = Shorten ($script:headText + ' · ' + $live)
        if ($script:statusItem) { $script:statusItem.Text = $live }
      } catch {}
      return
    }
    # 连不上: 图标自身由下面的 misses 计数负责收掉, 这里只把状态改成"无响应"
    try { $script:ni.Text = Shorten ($script:headText + ' · 无响应') } catch {}
    $script:misses = $script:misses + 1
    if ($script:misses -ge 2) {           # 连续 3 秒连不上 = 服务确实没了
      Write-TrayLog '服务已退出，托盘图标关闭'
      Close-Tray
    }
  })
  $script:cleanupTimer.Start()

  # 首次运行提示一次(托盘的发现性问题: Windows 11 会把新图标收进"隐藏的图标"里)
  if (-not (Test-Path -LiteralPath $HintFile)) {
    try { New-Item -ItemType File -Path $HintFile -Force | Out-Null } catch {}
    $script:hintTimer = New-Object System.Windows.Forms.Timer
    $script:hintTimer.Interval = 1500
    $script:hintTimer.add_Tick({
      $script:hintTimer.Stop(); $script:hintTimer.Dispose()
      try {
        $script:ni.BalloonTipTitle = 'SubFabric 已在后台运行'
        $script:ni.BalloonTipText = '右键这个图标 → 完全退出（关掉浏览器窗口不会退出程序；图标在 ∧ 隐藏区里可以拖出来）'
        $script:ni.ShowBalloonTip(8000)
      } catch {}
    })
    $script:hintTimer.Start()
  }
  Promote-TrayIcon
  Write-TrayLog ("托盘图标已就绪 (port=$Port, pid=$ServerPid, version=$Version)")
}

<#
  让图标默认显示在任务栏上。
  Windows 11 对**新出现**的通知区域图标默认 IsPromoted=0 —— 也就是先塞进 ^ 隐藏区，
  用户第一反应就是"没有托盘图标"(实测本机注册表里确实如此)。这里主动把它改成 1。
  项名是 Win11 内部算出来的(exePath 与 tooltip 的 crc32 组合)，不可推导，所以
  按 exePath 逐项比对，命中才改；没命中只记一行日志，绝不硬造项名去污染注册表。
  这个函数任何一步失败都只记日志，绝不能因为它让托盘起不来。
#>
function Promote-TrayIcon {
  try {
    $exe = $Exe
    if (-not $exe) { $exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
    $key = 'HKCU:\Control Panel\NotifyIconSettings'
    if (-not (Test-Path $key)) { Write-TrayLog '注册表无 NotifyIconSettings，跳过图标显示设置'; return }
    $hit = 0
    foreach ($sub in Get-ChildItem $key -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty -Path $sub.PSPath -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      if ($p.ExecutablePath -and ($p.ExecutablePath -ieq $exe)) {
        if ($p.IsPromoted -ne 1) {
          try {
            Set-ItemProperty -Path $sub.PSPath -Name IsPromoted -Value 1 -Type DWord -ErrorAction Stop
            Write-TrayLog ("已设为在任务栏常驻显示: " + $sub.PSChildName)
          } catch { Write-TrayLog ('设置 IsPromoted 失败: ' + $_.Exception.Message) }
        }
        $hit = $hit + 1
      }
    }
    if ($hit -eq 0) {
      # 首次运行时这一项通常还不存在（图标刚创建，Windows 还没登记），属正常
      Write-TrayLog ("通知区域里还没有本图标的注册项(首次运行时正常), exe=" + $exe)
    }
  } catch {
    Write-TrayLog ('Promote-TrayIcon 异常(忽略): ' + $_.Exception.Message)
  }
}

Initialize-Tray

if ($SelfTest) {
  # 自检: 图标/菜单都建好了就立刻收摊, 把结果打到 stdout(自动化验证用)。
  # 菜单文字一并回显 —— 方便确认 BOM 没丢(丢了这里就是乱码)。
  $items = ($script:menu.Items | ForEach-Object { $_.Text }) -join '|'
  Write-Output ('SELFTEST OK icon=' + [bool]$script:ni.Icon + ' menu=' + $script:menu.Items.Count + ' portOpen=' + (Test-PortOpen) + ' items=' + $items)
  Close-Tray
  exit 0
}

if ($QuitOnce) {
  Invoke-Quit
  Write-Output ('QUITONCE done portOpen=' + (Test-PortOpen))
  exit 0
}

[System.Windows.Forms.Application]::Run()      # 托盘只有图标没有窗体, 靠消息循环活着
Close-Tray
Write-TrayLog '托盘图标退出'
