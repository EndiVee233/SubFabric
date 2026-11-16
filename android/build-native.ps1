param([string]$Sdk=$env:ANDROID_HOME,[string[]]$Abis=@('x86_64','arm64-v8a'))
$ErrorActionPreference='Stop'
$cache=Join-Path $PSScriptRoot '.tools/crisp-vulkan';New-Item -ItemType Directory -Force $cache | Out-Null
$ndk=Join-Path $Sdk 'ndk/27.0.12077973';$cmake=Join-Path $Sdk 'cmake/3.22.1/bin/cmake.exe';$ninja=Join-Path $Sdk 'cmake/3.22.1/bin/ninja.exe'
foreach($p in @($cmake,$ninja,"$ndk/build/cmake/android.toolchain.cmake")){if(!(Test-Path -LiteralPath $p)){throw "Missing native build tool: $p"}}
$env:PATH=(Split-Path $cmake)+';'+$env:PATH
function Run([string]$exe,[string[]]$arguments){& $exe @arguments;if($LASTEXITCODE -ne 0){throw "Native command failed: $exe"}}
function Source([string]$name,[string]$url,[string]$hash,[string]$dest){
 $file=Join-Path $cache $name
 if(!(Test-Path -LiteralPath $file)){Invoke-WebRequest $url -OutFile $file}
 if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() -ne $hash){throw "Native archive checksum mismatch: $name"}
 if(!(Test-Path -LiteralPath "$dest/CMakeLists.txt")){New-Item -ItemType Directory -Force $dest | Out-Null;Run 'tar' @('-xf',$file,'--strip-components','1','-C',$dest)}
}
Source 'source.tar.gz' 'https://api.github.com/repos/CrispStrobe/CrispASR/tarball/6221fbb79532be2e5a1ad6fde641ce5037971cf1' '32c8dca6526fb2b66707f0e273b67c4e30cf5726922044bcb080838f44a4c472' "$cache/source"
Source 'ggml.tar.gz' 'https://api.github.com/repos/CrispStrobe/ggml/tarball/1b972bb754aa5f83e2d872ccf37a335717f6658d' '727b6b6758e25b628af8cbabe6f6541106b5cbda42e857ecbe787d0b437be620' "$cache/source/ggml"
Source 'vulkan-headers.tar.gz' 'https://codeload.github.com/KhronosGroup/Vulkan-Headers/tar.gz/b26454f3ccd67e704117a39295fa13935fd3804c' 'af327ef162a7a049249585e189671c4cc312f0bb3cf1e26279a47711c5f0b48c' "$cache/vulkan-headers"
Source 'spirv-headers.tar.gz' 'https://codeload.github.com/KhronosGroup/SPIRV-Headers/tar.gz/5c6004e758e0c80185ef2cee93ae5c10fa342a5b' 'cc1bdb9d3ecee75c00eab4e60387909d27152ec5f13ac928ee984ae952b6f70c' "$cache/spirv-headers"
$zigzip="$cache/zig.zip"
if(!(Test-Path -LiteralPath $zigzip)){Invoke-WebRequest 'https://ziglang.org/download/0.13.0/zig-windows-x86_64-0.13.0.zip' -OutFile $zigzip}
if((Get-FileHash -LiteralPath $zigzip -Algorithm SHA256).Hash.ToLower() -ne 'd859994725ef9402381e557c60bb57497215682e355204d754ee3df75ee3c158'){throw 'Zig checksum mismatch'}
if(!(Test-Path "$cache/zig-windows-x86_64-0.13.0/zig.exe")){Expand-Archive -LiteralPath $zigzip -DestinationPath $cache}
$unix=$cache.Replace('\','/');$zig="$unix/zig-windows-x86_64-0.13.0/zig.exe"
[IO.File]::WriteAllText("$cache/zigcc.cmd",'@"'+$zig+'" cc %*'+"`r`n")
[IO.File]::WriteAllText("$cache/zigcxx.cmd",'@"'+$zig+'" c++ %*'+"`r`n")
@"
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_C_COMPILER "$unix/zigcc.cmd")
set(CMAKE_CXX_COMPILER "$unix/zigcxx.cmd")
set(CMAKE_MAKE_PROGRAM "$($ninja.Replace('\','/'))" CACHE FILEPATH "" FORCE)
"@ | Set-Content -Encoding utf8 "$cache/host.cmake"
New-Item -ItemType Directory -Force "$cache/spirv-config" | Out-Null
@"
add_library(SPIRV-Headers::SPIRV-Headers INTERFACE IMPORTED)
set_target_properties(SPIRV-Headers::SPIRV-Headers PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "$unix/spirv-headers/include")
"@ | Set-Content -Encoding utf8 "$cache/spirv-config/SPIRV-HeadersConfig.cmake"
Run 'node' @("$PSScriptRoot/native/patch-crisp.mjs","$cache/source")
foreach($abi in $Abis){
 $triple=if($abi -eq 'x86_64'){'x86_64-linux-android'}elseif($abi -eq 'arm64-v8a'){'aarch64-linux-android'}else{throw 'Unsupported ABI'}
 $build="$cache/build-$abi"
 Run $cmake @('-S',"$PSScriptRoot/native",'-B',$build,'-G','Ninja',"-DCMAKE_MAKE_PROGRAM=$ninja","-DCMAKE_TOOLCHAIN_FILE=$ndk/build/cmake/android.toolchain.cmake","-DANDROID_ABI=$abi",'-DANDROID_PLATFORM=android-26','-DANDROID_STL=c++_static','-DCMAKE_BUILD_TYPE=Release',"-DCRISP_SOURCE=$unix/source","-DVulkan_INCLUDE_DIR=$unix/vulkan-headers/include","-DVulkan_LIBRARY=$ndk/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib/$triple/26/libvulkan.so","-DVulkan_GLSLC_EXECUTABLE=$ndk/shader-tools/windows-x86_64/glslc.exe","-DSPIRV-Headers_DIR=$unix/spirv-config","-DGGML_VULKAN_SHADERS_GEN_TOOLCHAIN=$unix/host.cmake")
 Run $cmake @('--build',$build,'--parallel','4')
}
