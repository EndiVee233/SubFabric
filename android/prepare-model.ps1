param([switch]$InstallToWsa, [string]$Adb = 'adb', [string]$Device = '127.0.0.1:58526')
$ErrorActionPreference = 'Stop'
function Run([string[]]$arguments) { & $Adb @arguments; if ($LASTEXITCODE -ne 0) { throw "adb failed ($LASTEXITCODE)" } }
$manifest = Get-Content "$PSScriptRoot/model-files.json" -Raw | ConvertFrom-Json
$cache = "$PSScriptRoot/.tools"; New-Item -ItemType Directory -Force $cache | Out-Null
$archive = "$cache/parakeet-v2.tar.bz2"
if (!(Test-Path $archive)) { Invoke-WebRequest $manifest.source -OutFile $archive }
if ((Get-FileHash $archive).Hash.ToLower() -ne $manifest.archiveSha256) { throw 'Model archive checksum mismatch' }
$folder = "$cache/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
if (!(Test-Path "$folder/encoder.int8.onnx")) { tar -xjf $archive -C $cache; if ($LASTEXITCODE -ne 0) { throw 'Model extraction failed' } }
foreach ($file in $manifest.files) {
    $path = Join-Path $folder $file.name
    if ((Get-Item $path).Length -ne $file.size -or (Get-FileHash $path).Hash.ToLower() -ne $file.sha256) { throw "Model verification failed: $($file.name)" }
}
if ($InstallToWsa) {
    # Android's run-as is available for this development prototype only.
    Run @('-s',$Device,'shell','run-as','com.subfabric.android','mkdir','-p','files/parakeet')
    foreach ($file in $manifest.files) {
        $name = $file.name
        Run @('-s',$Device,'push',(Join-Path $folder $name),"/data/local/tmp/subfabric-$name")
        Run @('-s',$Device,'shell','run-as','com.subfabric.android','cp',"/data/local/tmp/subfabric-$name","files/parakeet/$name")
        Run @('-s',$Device,'shell','run-as','com.subfabric.android','sha256sum',"files/parakeet/$name")
    }
}
Write-Output "Verified model folder: $folder"
