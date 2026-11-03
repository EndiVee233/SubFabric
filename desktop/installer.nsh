; Reuse an existing installation only when the caller did not explicitly provide /D=.
; Current Electron wins, then the first Electron appId, then the legacy Inno AppId.
!include LogicLib.nsh

!macro customInit
  !insertmacro GetDParameter $R0
  ${If} $R0 == ""
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      ${If} ${FileExists} "$0\SubFabric.exe"
        StrCpy $INSTDIR $0
      ${EndIf}
    ${Else}
      StrCpy $R1 ""
      ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.endivee233.subfabric.electron" InstallLocation
      ${If} $R1 == ""
        ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.endivee233.subfabric.electron" InstallLocation
      ${EndIf}
      ${If} $R1 != ""
        ${If} ${FileExists} "$R1\resources\backend\manifest.json"
          StrCpy $INSTDIR $R1
        ${EndIf}
      ${Else}
        ; Inno Setup is a 32-bit installer on this machine, so its uninstall key
        ; lives in the WOW6432Node view; check it before the native 64-bit view.
        ReadRegStr $R1 HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C}_is1" InstallLocation
        ${If} $R1 == ""
          ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C}_is1" InstallLocation
        ${EndIf}
        ${If} $R1 == ""
          ReadRegStr $R1 HKCU "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C}_is1" InstallLocation
        ${EndIf}
        ${If} $R1 == ""
          ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C}_is1" InstallLocation
        ${EndIf}
        ${If} $R1 != ""
          ${If} ${FileExists} "$R1\editor\server.js"
            StrCpy $INSTDIR $R1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; ── 覆盖安装：不要执行旧版本的卸载器 ────────────────────────────────
  ; 安装器的 install 段会先静默执行「已注册版本」的卸载器，而那个卸载器会对整个
  ; $INSTDIR 做 RMDir /r。本产品的用户数据就在程序目录里（asr\models、
  ; asr\runtime-python、projects\、videos\、.profile\），升级等于把它们连同
  ; 41,748 个文件一起删掉（2026-11-04 实测发生过）。
  ; uninstallOldVersion 读不到 UninstallString 就直接 Return，所以这里在安装前
  ; 抹掉卸载登记：只看得到程序文件被覆盖，数据一个都不动。装完 registryAddInstallInfo
  ; 会写回新的登记项。
  ${If} ${FileExists} "$INSTDIR\SubFabric.exe"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
      DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
  ${EndIf}
!macroend

; ── 卸载：默认保留用户数据 ─────────────────────────────────────────────
; electron-builder 默认对 $INSTDIR 整目录 RMDir /r；这里接管成「只删程序文件」，
; 模型、Python 运行时、项目、视频、浏览器偏好一律留下。真要清空，删掉安装目录即可。
!macro customRemoveFiles
  ${If} ${isUpdated}
    ; 升级路径：程序文件马上会被覆盖，这里什么都不删。
    DetailPrint "升级安装：保留现有数据目录"
  ${Else}
    DetailPrint "卸载程序文件，保留模型、运行时与项目数据"
    Delete "$INSTDIR\SubFabric.exe"
    Delete "$INSTDIR\Uninstall SubFabric.exe"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\LICENSE*"
    Delete "$INSTDIR\vk_swiftshader_icd.json"
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"
  ${EndIf}
!macroend
