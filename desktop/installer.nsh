; Reuse an existing installation only when the caller did not explicitly provide /D=.
; Current Electron wins, then the first Electron appId, then the legacy Inno AppId.
!include LogicLib.nsh
!include nsDialogs.nsh

; ── 两条分发链路的身份 ────────────────────────────────────────────────
; Electron 版（本安装器）：appId com.endivee233.subfabric → 注册表键名由 electron-builder
;   用 ${UNINSTALL_REGISTRY_KEY} / ${INSTALL_REGISTRY_KEY} 给出。
; SEA 版（Inno Setup，build/installer/SubFabric.iss）：AppId 见下。
; 两版可以装进同一个目录、共用同一份数据（数据就在程序目录里：asr\、projects\、
; videos\、.profile\ …），所以互相接管时要把对方的卸载登记与残留程序文件一并清掉，
; 否则「应用和功能」里会留下两条指向同一目录的记录，还多出上百 MB 死文件。
!define SF_INNO_APPID "{8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C}"
!define SF_INNO_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SF_INNO_APPID}_is1"
!define SF_INNO_UNINST_WOW "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\${SF_INNO_APPID}_is1"

; 卸载页上的三个「保留」开关。默认全 1 = 保留；静默卸载时页面不出现，同样保持 1。
; 这些变量只在卸载器构建里被引用（安装器构建里声明会触发 warning 6001）。
!ifdef BUILD_UNINSTALLER
Var SfKeepAsr
Var SfKeepProjects
Var SfKeepConfig
Var SfAsrBox
Var SfProjectsBox
Var SfConfigBox
Var SfDialog
!endif

; 去掉目录末尾的反斜杠，便于比较（只有安装段用得到；卸载器构建里不定义，
; 否则 makensis 会报 warning 6010「函数未被引用」，而 electron-builder 把警告当错误）
!ifndef BUILD_UNINSTALLER
Function SfNormalizeDir
  Exch $0
  Push $1
  StrCpy $1 $0 1 -1
  ${If} $1 == "\"
    StrCpy $0 $0 -1
  ${EndIf}
  Pop $1
  Exch $0
FunctionEnd
!endif

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
        ; SEA 版（Inno Setup）装在同一目录时的接管入口：AppId 的卸载项。
        ; Inno 按用户安装写 HKCU 原生视图，按机器安装写 HKLM 的 WOW6432Node。
        ReadRegStr $R1 HKCU "${SF_INNO_UNINST}" InstallLocation
        ${If} $R1 == ""
          ReadRegStr $R1 HKLM "${SF_INNO_UNINST_WOW}" InstallLocation
        ${EndIf}
        ${If} $R1 == ""
          ReadRegStr $R1 HKLM "${SF_INNO_UNINST}" InstallLocation
        ${EndIf}
        ${If} $R1 == ""
          ReadRegStr $R1 HKCU "${SF_INNO_UNINST_WOW}" InstallLocation
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

; ── 安装完成：接管 SEA 版（Inno Setup）的安装目录 ──────────────────────
; ⚠ 只有「Inno 登记的目录 == 本次安装目录」才动手 —— 否则装到别处会把另一份
;    正常安装的卸载项删掉（2026-11-05 实测踩过）。
; 删的都是「只有 SEA 版才有」的程序文件，数据目录一律不碰。
!macro customInstall
  StrCpy $R2 ""
  ReadRegStr $R2 HKCU "${SF_INNO_UNINST}" InstallLocation
  ${If} $R2 == ""
    ReadRegStr $R2 HKLM "${SF_INNO_UNINST_WOW}" InstallLocation
  ${EndIf}
  ${If} $R2 == ""
    ReadRegStr $R2 HKLM "${SF_INNO_UNINST}" InstallLocation
  ${EndIf}
  ${If} $R2 != ""
    Push $R2
    Call SfNormalizeDir
    Pop $R2
    Push $INSTDIR
    Call SfNormalizeDir
    Pop $R3
    ${If} $R2 == $R3
      DetailPrint "接管 SEA 版安装目录：清理它的卸载登记与残留程序文件"
      DeleteRegKey HKCU "${SF_INNO_UNINST}"
      DeleteRegKey HKCU "${SF_INNO_UNINST_WOW}"
      DeleteRegKey HKLM "${SF_INNO_UNINST}"
      DeleteRegKey HKLM "${SF_INNO_UNINST_WOW}"
      Delete "$INSTDIR\main.py"
      Delete "$INSTDIR\start-editor.bat"
      Delete "$INSTDIR\start-editor.command"
      Delete "$INSTDIR\unins000.exe"
      Delete "$INSTDIR\unins000.dat"
      Delete "$INSTDIR\unins000.msg"
    ${EndIf}
  ${EndIf}
!macroend

; ── 卸载页：选择要保留的内容 ──────────────────────────────────────────
; electron-builder 的卸载向导默认只有「欢迎 → 进度」，这里把欢迎页换掉，
; 在欢迎页之后插一个自定义页（NSIS 页面顺序由声明顺序决定）。
; 静默卸载不显示页面，开关保持 customUnInit 里的默认值（全保留）。
!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.SfDataPageCreate un.SfDataPageLeave
!macroend

!macro customUnInit
  StrCpy $SfKeepAsr "1"
  StrCpy $SfKeepProjects "1"
  StrCpy $SfKeepConfig "1"
  ; 自动化场景要连数据一起清空时显式传 /DELETE-DATA（默认永远保留）
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/DELETE-DATA" $R1
  ${IfNot} ${Errors}
    StrCpy $SfKeepAsr "0"
    StrCpy $SfKeepProjects "0"
    StrCpy $SfKeepConfig "0"
  ${EndIf}
!macroend

; 卸载页的两个回调只在卸载器构建里被 UninstPage 引用；安装器构建里定义会触发
; warning 6010（未引用函数），而 electron-builder 把 makensis 的警告当错误。
!ifdef BUILD_UNINSTALLER

Function un.SfDataPageCreate
  nsDialogs::Create 1018
  Pop $SfDialog
  ${If} $SfDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 30u "卸载只会删除程序文件。下面勾选的内容会原样留在安装目录里（默认全保留）。$\r$\n取消勾选的项目将在卸载完成后一并删除，且无法恢复。"
  Pop $0

  ${NSD_CreateCheckbox} 0 40u 100% 12u "保留 ASR 模型与 Python 运行时（asr、tools，通常数 GB 到 20 GB）"
  Pop $SfAsrBox
  ${NSD_Check} $SfAsrBox

  ${NSD_CreateCheckbox} 0 58u 100% 12u "保留项目与视频（projects、videos）"
  Pop $SfProjectsBox
  ${NSD_Check} $SfProjectsBox

  ${NSD_CreateCheckbox} 0 76u 100% 12u "保留配置（翻译方案、热词/术语表、浏览器数据、缓存）"
  Pop $SfConfigBox
  ${NSD_Check} $SfConfigBox

  ${NSD_CreateLabel} 0 100u 100% 24u "保留的内容会留在 $INSTDIR，重新安装任一版本（Electron / SEA）时会自动继续使用。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function un.SfDataPageLeave
  ${NSD_GetState} $SfAsrBox $0
  StrCpy $SfKeepAsr $0
  ${NSD_GetState} $SfProjectsBox $0
  StrCpy $SfKeepProjects $0
  ${NSD_GetState} $SfConfigBox $0
  StrCpy $SfKeepConfig $0
FunctionEnd

!endif

; ── 卸载：默认保留用户数据 ─────────────────────────────────────────────
; electron-builder 默认对 $INSTDIR 整目录 RMDir /r；这里接管成「只删程序文件」，
; 模型、Python 运行时、项目、视频、浏览器偏好按上面的勾选处理。
!macro customRemoveFiles
  ${If} ${isUpdated}
    ; 升级路径：程序文件马上会被覆盖，这里什么都不删。
    DetailPrint "升级安装：保留现有数据目录"
  ${Else}
    DetailPrint "卸载程序文件"
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

    ${If} $SfKeepAsr == "1"
      DetailPrint "保留 ASR 模型与运行时"
    ${Else}
      DetailPrint "删除 ASR 模型与运行时"
      RMDir /r "$INSTDIR\asr\models"
      RMDir /r "$INSTDIR\asr\runtime-python"
      RMDir /r "$INSTDIR\asr\runtime-vibevoice"
      RMDir /r "$INSTDIR\asr\runtime-whisperx"
      RMDir /r "$INSTDIR\asr\whisper.cpp"
      RMDir /r "$INSTDIR\asr\crispasr"
      RMDir /r "$INSTDIR\asr\faster-whisper-xxl"
      RMDir /r "$INSTDIR\asr\ytdlp"
      RMDir /r "$INSTDIR\asr\.venv"
      RMDir /r "$INSTDIR\asr\logs"
      RMDir /r "$INSTDIR\tools"
    ${EndIf}

    ${If} $SfKeepProjects == "1"
      DetailPrint "保留项目与视频"
    ${Else}
      DetailPrint "删除项目与视频"
      RMDir /r "$INSTDIR\projects"
      RMDir /r "$INSTDIR\videos"
    ${EndIf}

    ${If} $SfKeepConfig == "1"
      DetailPrint "保留配置"
    ${Else}
      DetailPrint "删除配置"
      Delete "$INSTDIR\asr\settings.json"
      RMDir /r "$INSTDIR\.profile"
      RMDir /r "$INSTDIR\logs"
      RMDir /r "$INSTDIR\cache"
    ${EndIf}
  ${EndIf}
!macroend
