param(
    [string]$Sdk = $env:ANDROID_HOME,
    [string]$Jdk = $env:JAVA_HOME,
    [string]$KotlinStdlib = '',
    [string]$Device = '',
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (!$Sdk) { $Sdk = $env:ANDROID_SDK_ROOT }
if (!$Sdk) { $Sdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
if (!$Jdk) { throw 'Set JAVA_HOME to JDK 17+ or pass -Jdk.' }
$buildTools = Join-Path $Sdk 'build-tools/34.0.0'
$androidJar = Join-Path $Sdk 'platforms/android-34/android.jar'
foreach ($file in @($androidJar, "$Jdk/bin/javac.exe", "$buildTools/aapt.exe", "$buildTools/d8.bat")) { if (!(Test-Path -LiteralPath $file)) { throw "Missing SDK/JDK tool: $file" } }
$env:JAVA_HOME = $Jdk
function Run([string]$exe, [string[]]$arguments) { & $exe @arguments; if ($LASTEXITCODE -ne 0) { throw "Command failed: $exe ($LASTEXITCODE)" } }
function Fetch([string]$url, [string]$path, [string]$hash) {
    if (!(Test-Path -LiteralPath $path)) { Invoke-WebRequest $url -OutFile $path }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -ne $hash) { throw "Checksum mismatch: $path" }
}
$cache = Join-Path $root '.tools'; New-Item -ItemType Directory -Force $cache | Out-Null
$r8 = Join-Path $cache 'r8-8.13.25.jar'
Fetch 'https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.13.25/r8-8.13.25.jar' $r8 '0d4f2f68c4fcbc9434eff122f41feb6fb1d98efd2faa530cec1abacab1cea03d'
$aar = Join-Path $cache 'sherpa-onnx-2.0.1.aar'
Fetch 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-2.0.1.aar' $aar 'a8d09d1d32f3eb8520482c6d3d43fae674681c5b050385967c70a3c2c9bf0ee7'
$sherpa = Join-Path $cache 'sherpa-2.0.1'
if (!(Test-Path "$sherpa/classes.jar")) { New-Item -ItemType Directory -Force $sherpa | Out-Null; Push-Location $sherpa; try { Run "$Jdk/bin/jar.exe" @('xf',$aar) } finally { Pop-Location } }
$ffmpegAar = Join-Path $cache 'ffmpeg-kit-full-8.1.9.aar'
Fetch 'https://github.com/ffmpegkit-maintained/ffmpeg/releases/download/v8.1.9-lts-android/ffmpeg-kit-full-8.1.9-arm64-v8a-x86_64.aar' $ffmpegAar '40b52770a339af3bf8c02d8a9808c89b5f0e0e56eca39c10dc76c01b90f32306'
$ffmpeg = Join-Path $cache 'ffmpeg-kit-full-8.1.9'
if (!(Test-Path "$ffmpeg/classes.jar")) { New-Item -ItemType Directory -Force $ffmpeg | Out-Null; Push-Location $ffmpeg; try { Run "$Jdk/bin/jar.exe" @('xf',$ffmpegAar) } finally { Pop-Location } }
$smart = Join-Path $cache 'smart-exception-java-0.2.1.jar'
Fetch 'https://repo.maven.apache.org/maven2/com/arthenica/smart-exception-java/0.2.1/smart-exception-java-0.2.1.jar' $smart '5b96aaa5f191dedbef72fb0c38f1a2b01807920afc0d92a75a2acd6e0cc7703c'
$smartCommon = Join-Path $cache 'smart-exception-common-0.2.1.jar'
Fetch 'https://repo.maven.apache.org/maven2/com/arthenica/smart-exception-common/0.2.1/smart-exception-common-0.2.1.jar' $smartCommon '1cad0fb4dfa01755a014331b5ed199281d2c3fab5aca5c9d7abd0b41d0ec3f7b'
$downloadAar = Join-Path $cache 'yt-dlp-android-2.0.2.aar'
Fetch 'https://github.com/ffmpegkit-maintained/yt-dlp-android/releases/download/v2.0.2/yt-dlp-android-release.aar' $downloadAar '6a836fed71490fcd7ecbcf50d4ec36b0f0919eff58d51faf843db6dc497a2e61'
$downloadRuntime = Join-Path $cache 'yt-dlp-android-2.0.2'
if (!(Test-Path "$downloadRuntime/libs/chaquopy_java-17.0.0.jar")) { New-Item -ItemType Directory -Force $downloadRuntime | Out-Null; Push-Location $downloadRuntime; try { Run "$Jdk/bin/jar.exe" @('xf',$downloadAar) } finally { Pop-Location } }
$pythonBridge = Join-Path $downloadRuntime 'libs/chaquopy_java-17.0.0.jar'
Fetch 'https://files.pythonhosted.org/packages/7f/3d/16ea7d5638cf585991f2c5705e8083688dde633d32d0871f2404e0f4d827/yt_dlp-2026.10.26-py3-none-any.whl' "$cache/yt_dlp-2026.10.26-py3-none-any.whl" 'a05c5b5d8562f7e8a62f5334348b406af4930d56d3a65f8021d14af0e22339ae'
Fetch 'https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl' "$cache/yt_dlp_ejs-0.8.0-py3-none-any.whl" '79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4'
Fetch 'https://files.pythonhosted.org/packages/32/d1/a3652fe2c19134d0d15922177821d863cbd7e842d53a21bbe7e8e3a1b5ac/certifi-2026.10.23-py3-none-any.whl' "$cache/certifi-2026.10.23-py3-none-any.whl" 'e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1'
foreach ($entry in @(@('x86_64','d295c3d13f5cbd17ac8de1a4e4352ac7099617e3cfa2706977a7c2ac7092b487'),@('arm64-v8a','a0fe160a8cd76eec34132f945664856e96687d701e3b1ff28dff44ea1fad13bc'))) {
    Fetch "https://raw.githubusercontent.com/yausername/youtubedl-android/d725d5c9a18c3a99a13ee0308bf78275dc310760/library/src/main/jniLibs/$($entry[0])/libqjs.so" "$cache/quickjs-$($entry[0]).so" $entry[1]
}
if (!$KotlinStdlib) {
    $KotlinStdlib = Join-Path $cache 'kotlin-stdlib-2.2.0.jar'
    Fetch 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.jar' $KotlinStdlib '65d12d85a3b865c160db9147851712a64b10dadd68b22eea22a95bf8a8670dca'
}
# A fresh directory per build preserves prior APKs and avoids recursive cleanup.
$out = Join-Path $root ('out/build-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$classes = Join-Path $out 'classes'; $dex = Join-Path $out 'dex'; $assets = Join-Path $out 'assets'; $pack = Join-Path $out 'pack'
New-Item -ItemType Directory -Force $classes,$dex,$assets,$pack,(Join-Path $out 'res/drawable') | Out-Null
Copy-Item -Path "$root/app/src/main/assets/*" -Destination $assets -Recurse
Copy-Item -Path "$downloadRuntime/assets/*" -Destination $assets -Recurse
New-Item -ItemType Directory -Force "$assets/download" | Out-Null
foreach ($wheel in @('yt_dlp-2026.10.26-py3-none-any.whl','yt_dlp_ejs-0.8.0-py3-none-any.whl','certifi-2026.10.23-py3-none-any.whl')) { Copy-Item -LiteralPath "$cache/$wheel" -Destination "$assets/download/$wheel" }
New-Item -ItemType Directory -Force "$assets/shared" | Out-Null
New-Item -ItemType Directory -Force "$assets/lang" | Out-Null
Copy-Item -LiteralPath "$root/../editor/lang/zh-CN.json" -Destination "$assets/lang/zh-CN.json"
Copy-Item -LiteralPath "$root/../editor/js/srt.js","$root/../editor/js/util.js" -Destination "$assets/shared"
Copy-Item -LiteralPath "$root/../editor/assets/app-logo.png" -Destination "$assets/logo.png"
Copy-Item -LiteralPath "$root/THIRD_PARTY_NOTICES.txt" -Destination $assets
Copy-Item -LiteralPath "$root/licenses" -Destination $assets -Recurse
Run 'node' @("$root/stage.mjs",$assets)
Copy-Item -LiteralPath "$root/../editor/assets/app-logo.png" -Destination "$out/res/drawable/app_logo.png"
$sources = @(Get-ChildItem "$root/app/src/main/java" -Filter '*.java' -Recurse | ForEach-Object FullName)
$classpath = "$androidJar;$sherpa/classes.jar;$KotlinStdlib;$ffmpeg/classes.jar;$smart;$smartCommon;$pythonBridge"
Run "$Jdk/bin/javac.exe" (@('-encoding','UTF-8','--release','8','-classpath',$classpath,'-d',$classes) + $sources)
Run "$Jdk/bin/jar.exe" @('cf',"$out/app.jar",'-C',$classes,'.')
Run "$Jdk/bin/java.exe" @('-cp',$r8,'com.android.tools.r8.D8','--min-api','26','--lib',$androidJar,'--output',$dex,"$out/app.jar","$sherpa/classes.jar",$KotlinStdlib,"$ffmpeg/classes.jar",$smart,$smartCommon,$pythonBridge)
Run "$buildTools/aapt.exe" @('package','-f','-M',"$root/app/src/main/AndroidManifest.xml",'-S',"$out/res",'-A',$assets,'-I',$androidJar,'-F',"$out/base.apk")
Copy-Item "$dex/*.dex" $pack
foreach ($abi in @('x86_64','arm64-v8a')) {
    New-Item -ItemType Directory -Force "$pack/lib/$abi" | Out-Null
    Copy-Item "$sherpa/jni/$abi/*.so" "$pack/lib/$abi"
    # Both libraries share libc++; use the newer NDK runtime from the pinned FFmpeg build.
    Copy-Item "$ffmpeg/jni/$abi/*.so" "$pack/lib/$abi" -Force
    Copy-Item "$downloadRuntime/jni/$abi/*.so" "$pack/lib/$abi"
    Copy-Item -LiteralPath "$cache/quickjs-$abi.so" -Destination "$pack/lib/$abi/libqjs.so"
}
Copy-Item "$out/base.apk" "$out/unsigned.apk"
Run "$Jdk/bin/jar.exe" @('uf',"$out/unsigned.apk",'-C',$pack,'.')
Run "$buildTools/zipalign.exe" @('-f','4',"$out/unsigned.apk","$out/aligned.apk")
$keystore = Join-Path $cache 'prototype.jks'
if (!(Test-Path $keystore)) { Run "$Jdk/bin/keytool.exe" @('-genkeypair','-keystore',$keystore,'-storepass','android','-keypass','android','-alias','prototype','-dname','CN=SubFabric Android Prototype','-keyalg','RSA','-keysize','2048','-validity','3650') }
$apk = Join-Path $root 'out/SubFabric-Android-0.7.0.apk'
Run "$buildTools/apksigner.bat" @('sign','--ks',$keystore,'--ks-key-alias','prototype','--ks-pass','pass:android','--key-pass','pass:android','--out',$apk,"$out/aligned.apk")
Run "$buildTools/apksigner.bat" @('verify','--verbose',$apk)
Get-FileHash $apk -Algorithm SHA256
if ($Install) {
    $adb = Join-Path $Sdk 'platform-tools/adb.exe'
    $target = @(); if ($Device) { $target = @('-s',$Device) }
    Run $adb ($target + @('install','-r',$apk))
    Run $adb ($target + @('shell','am','start','-n','com.subfabric.android/.MainActivity'))
}
Write-Output "APK: $apk"
