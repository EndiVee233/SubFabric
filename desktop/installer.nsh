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
!macroend
