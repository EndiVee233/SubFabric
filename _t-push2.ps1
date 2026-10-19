$ErrorActionPreference = 'Stop'
$c = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$tok = (($c -split "`n" | Where-Object { $_ -match '^password=' }) -join '') -replace '^password=',''
$H = @{ Authorization = "token $tok"; 'User-Agent' = 'SubFabric'; Accept = 'application/vnd.github+json' }
$api = 'https://api.github.com/repos/EndiVee233/SubFabric'

$headSha = (Invoke-RestMethod -Uri "$api/git/ref/heads/main" -Headers $H).object.sha
$baseTree = (Invoke-RestMethod -Uri "$api/git/commits/$headSha" -Headers $H).tree.sha
if ($headSha -ne '9a738c36eec69b397ea923da9cb38a30c556909a') { throw "远端 HEAD 已变化: $headSha" }
Write-Host "base: $headSha  tree: $baseTree"

# core.quotepath=false: 让 git 输出真实 UTF-8 路径，而不是 \345\217\214 这种八进制转义
$status = git -c core.quotepath=false status --porcelain
$adds = @(); $dels = @()
foreach ($line in $status) {
  $code = $line.Substring(0,2)
  $path = $line.Substring(3).Trim()
  if ($path.StartsWith('"')) { $path = $path.Trim('"') }
  if ($code -match '^ D|^D ') { $dels += $path } else { $adds += $path }
}
Write-Host "adds=$($adds.Count) dels=$($dels.Count)"

$tree = @()
foreach ($p in $adds) {
  $full = Join-Path (Get-Location) $p
  if (-not (Test-Path -LiteralPath $full)) { throw "missing file: $p" }
  $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($full))
  $body = @{ content = $b64; encoding = 'base64' } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $r = Invoke-RestMethod -Uri "$api/git/blobs" -Method Post -Headers $H -Body $bytes -ContentType 'application/json; charset=utf-8'
  $tree += @{ path = $p; mode = '100644'; type = 'blob'; sha = $r.sha }
}
foreach ($p in $dels) { $tree += @{ path = $p; mode = '100644'; type = 'blob'; sha = $null } }
Write-Host "tree entries: $($tree.Count)（含删除 $($dels.Count)）"

$msg = @"
feat(导出): 新增视频导出（硬字幕/生肉/字幕），GPU 优先压制，并内置 ffmpeg 获取

- 编辑器「设置 → 导出 → 导出视频…」：选目录后可多选导出双语硬字幕视频 / 生肉原片 / ASS 字幕
- 压制逻辑内嵌自 hardsub-py（垫背事件、硬件链路试跑回退、滤镜路径转义、成片自检）
- 加速方案 GPU 优先（NVIDIA → AMD → Intel → CPU），按「厂商 × 编码格式」逐项判断
- 新增 editor/ffmpeg-tool.js：环境变量 → 自带副本 → 常见路径 → PATH；缺失时可自动下载到 tools/ffmpeg/（GitHub 优先、PowerShell 兜底）
- 「前置」新增 ffmpeg 状态卡与下载入口；未安装时给出明确指引而非误报「将用 CPU」
- 字幕正文由前端带上（含微光/淡入特效），保证压制效果与编辑器预览一致
- 文档收敛为 README.md / docs/PROJECT.md / AGENTS.md 三份
- 版本推进到 beta 1.4（文件版本 1.4.0.0）
- 测试：新增 export-video-test（9 组）与 hardsub-accel-test（30 项）；全量 96 通过 / 0 失败
"@

$treeJson = @{ base_tree = $baseTree; tree = $tree } | ConvertTo-Json -Depth 8 -Compress
$newTree = Invoke-RestMethod -Uri "$api/git/trees" -Method Post -Headers $H -Body ([System.Text.Encoding]::UTF8.GetBytes($treeJson)) -ContentType 'application/json; charset=utf-8'
Write-Host "new tree: $($newTree.sha)"

$commitJson = @{ message = $msg; tree = $newTree.sha; parents = @($headSha) } | ConvertTo-Json -Compress
$commit = Invoke-RestMethod -Uri "$api/git/commits" -Method Post -Headers $H -Body ([System.Text.Encoding]::UTF8.GetBytes($commitJson)) -ContentType 'application/json; charset=utf-8'
Write-Host "commit: $($commit.sha)"

$refJson = @{ sha = $commit.sha; force = $false } | ConvertTo-Json -Compress
$upd = Invoke-RestMethod -Uri "$api/git/refs/heads/main" -Method Patch -Headers $H -Body ([System.Text.Encoding]::UTF8.GetBytes($refJson)) -ContentType 'application/json; charset=utf-8'
Write-Host "ref updated -> $($upd.object.sha)"