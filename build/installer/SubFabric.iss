; SubFabric 安装包脚本（Inno Setup 6）
;
; 本文件入库（build/ 其余内容是 .gitignore 的），构建步骤见 docs/PROJECT.md §6「打包与发版」：
;   1) node editor/scripts/fetch-vendor.js      ; 拉 editor/vendor（约 19MB，缺了安装包会小一截）
;   2) python build_exe.py                     ; 生成 build/SubFabric.exe（Node SEA，含图标与版本信息）
;   3) "D:\Program Files (x86)\Inno Setup 6\ISCC.exe" build/installer/SubFabric.iss
;   4) 静默自检: SubFabric-<版本>-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="" /DIR=<临时目录>
;
; 图标：logo.png 是源图，logo.ico 是 editor/scripts/gen_app_icon.py 生成的多尺寸版
;       （16/24/32/48/64/128/256）。两个都入库，SetupIconFile 直接引用 logo.ico。
;       build_exe.py 会顺带把 logo.ico 嵌进 SubFabric.exe，所以程序本体、快捷方式、
;       安装/卸载向导、控制面板「应用和功能」里显示的都是同一张图。
;
; 产品版本要和 editor/server.js 的 APP_VERSION 一起改；
; Windows PE 文件版本另用四段纯数字的 APP_FILE_VERSION / MyAppFileVersion。
; ⚠ VersionInfo* 三个字段（VersionInfoVersion / VersionInfoProductVersion / VersionInfoFileVersion）
;   只接受**纯数字**，绝不能填带 "beta" 的显示版本 —— 2026-10-14 实测：上一轮把显示版本改成
;   "beta 1.0" 时漏改这里，ISCC 直接 "Value ... is invalid" 编译中止（此前从未真正编过安装包，
;   所以一直没暴露）。显示版本走 AppVersion / AppVerName / VersionInfoProductName，数字版本走 MyAppFileVersion。
; 版本口径（显示版本 / 文件版本 / tag 三段如何推进、下一个该发多少）：见 docs/PROJECT.md §6「打包与发版」。
;   beta 期：显示 `beta <主>.<次>`、文件 `<主>.<次>.0.0`、tag `v<主>.<次>.0-beta.<序号>`；转正后去掉 beta 前缀。
;
; ── 与 Electron 版共用一份安装 ──────────────────────────────────────────
; SEA 版与 Electron 版装在同一目录、共用同一份数据（数据就在程序目录里：asr\、projects\、
; videos\、.profile\ …）。因此：
;   ① 本包按用户安装（PrivilegesRequired=lowest，向导里仍可选「为所有用户安装」），
;      否则没管理员权限时无法装进 Electron 版默认的 %LOCALAPPDATA%\Programs\SubFabric；
;   ② 检测到 Electron 版（NSIS，appId com.endivee233.subfabric）的卸载项时，预填它的目录，
;      安装后清掉它的卸载登记与残留程序文件（resources\、*.dll、*.pak …），避免「应用和功能」
;      里出现两条指向同一目录的记录、也避免留下上百 MB 死文件；
;   ③ 卸载时弹一个选项框，默认保留全部用户数据（ASR 模型与运行时 / 项目与视频 / 配置），
;      静默卸载永远按「全部保留」处理，要连数据一起清空须显式传 /DELETE-DATA。

#define MyAppName "SubFabric"
#define MyAppVersion "beta 1.5.7"
#define MyAppFileVersion "1.5.7.0"
#define MyAppPublisher "EndiVee233"
#define MyAppURL "https://github.com/EndiVee233/SubFabric"
#define MyAppExeName "SubFabric.exe"
; AppId 必须与 2.0.0 一致，否则老版本认不出、会装成两份（[Setup] 里两个左花括号是转义，注册表键名只有一层）
#define MyAppId "{{8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C}"
#define Root "..\.."

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
VersionInfoVersion={#MyAppFileVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppFileVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=.
; 包名带 -sea 后缀：同一个 Release 里同时发 Electron 版 SubFabric-<版本>-setup.exe，
; 两者文件名不能相同（否则下载后分不清是哪条链路、也容易装错）。
OutputBaseFilename=SubFabric-{#MyAppFileVersion}-sea-setup
; 压缩方式：**不要**用 lzma2 + SolidCompression —— 实测（2026-10-25）`lzma2/max` + `solid`
; 会被荣耀电脑管家（奇安信引擎）判成木马并实时隔离安装包；换成 `lzma/normal` + 非 solid
; 后同一份代码可正常留存，体积只从 36.5MB 涨到 38.2MB。改这里之前先读 docs/PROJECT.md §6。
Compression=lzma/normal
SolidCompression=no
WizardStyle=modern
; 默认按用户安装（不需要管理员、可装进 Electron 版默认的用户目录）；向导首屏仍提供
; 「为所有用户安装 / 仅为我安装」的选择。静默安装（/VERYSILENT）一律按用户模式。
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
; 安装/卸载向导自身的图标（.iss 同目录，相对路径即可）
SetupIconFile=logo.ico
; 控制面板「应用和功能」里显示的图标：直接用程序本体的图标（build_exe.py 已嵌入 logo.ico）
UninstallDisplayIcon={app}\{#MyAppExeName}
; 关掉 Inno 自带的「关闭正在运行的程序」以外的额外提问（保持默认的 Restart Manager 行为即可）

[Languages]
; 2026-10-09 起安装向导改用**简体中文**(用户要求)。语言文件是 Inno Setup 自带的
; compiler:Languages\ChineseSimplified.isl(6.5.0+ 版, LanguageID $0804), 不入库。
; 注意: 这一改会让快捷方式与「应用和功能」里的卸载项文案从英文
; ("Uninstall SubFabric") 变成中文("卸载 SubFabric"), 与 2.0.x 的英文默认文案不同。
; 只声明一种语言 → 不会弹语言选择框。
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; 从 Electron 版（NSIS）接管同一个目录时，先把只属于它的程序文件清掉：
; 它把前端与后端放在 resources\backend\ 下（约 150 MB），而 SEA 版直接用 editor\。
; 只删程序文件，数据目录（asr\models、projects\、videos\、.profile\ …）一个都不碰。
Type: files;          Name: "{app}\*.dll"
Type: files;          Name: "{app}\*.pak"
Type: files;          Name: "{app}\*.bin"
Type: files;          Name: "{app}\icudtl.dat"
Type: files;          Name: "{app}\LICENSE*"
Type: files;          Name: "{app}\vk_swiftshader_icd.json"
Type: files;          Name: "{app}\Uninstall SubFabric.exe"
Type: filesandordirs; Name: "{app}\locales"
Type: filesandordirs; Name: "{app}\resources"

[Files]
; ── 根目录 ──
Source: "{#Root}\build\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\main.py";               DestDir: "{app}"; Flags: ignoreversion
Source: "start-editor.bat";              DestDir: "{app}"; Flags: ignoreversion
Source: "start-editor.command";          DestDir: "{app}"; Flags: ignoreversion

; ── 编辑器（含 vendor：libass worker + CJK 字体，约 19MB）──
Source: "{#Root}\editor\*"; DestDir: "{app}\editor"; \
    Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: "\.*,\node_modules\*,\__pycache__\*,*\__pycache__\*"

; ── Python 侧（asr.py / diarize.py / fetch\*）──
; 用户数据与运行时一律不进安装包，也绝不被安装/卸载碰到：asr\.venv、asr\models、asr\settings.json、
; asr\whisper.cpp、asr\crispasr、asr\faster-whisper-xxl、asr\runtime-python、asr\runtime-vibevoice、
; asr\ytdlp、asr\logs、projects\
; （whisper.cpp / crispasr / Faster-Whisper-XXL 运行时由服务端首次使用时自动下载，所以本机存在时也不能被顺带打包）
; 2026-10-21 起 VibeVoice / NeMo / 双引擎模型已停用，对应脚本与 runtime-vibevoice 也不再打包。
Source: "{#Root}\asr\*"; DestDir: "{app}\asr"; \
    Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: ".venv\*,\models\*,\settings.json,\whisper.cpp\*,\crispasr\*,\faster-whisper-xxl\*,\runtime-python\*,\runtime-vibevoice\*,\multitalker.py,\vibevoice.py,\asr_dual.py,\asr_perf.py,\ytdlp\*,\logs\*,\__pycache__\*,*\__pycache__\*,.qwen-runtime-ok.json"

[Icons]
; 显式写 IconFilename 指向程序本体（而不是 .iss 里的 SetupIconFile），
; 这样开始菜单/桌面的快捷方式用的是 exe 内嵌的 logo.ico
Name: "{group}\{#MyAppName}";           Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}";     Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\{#MyAppExeName}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  AppGuid   = '{8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C}';
  UninstKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall';
  { Electron 版（electron-builder / NSIS）的卸载键名：由 appId com.endivee233.subfabric
    派生的 GUID，与 desktop/installer.nsh 里的 UNINSTALL_REGISTRY_KEY 对应。 }
  ElectronGuid = 'fc565a39-9129-58ff-87bf-4d6959f76571';

var
  DetectedDir: string;
  { 卸载选项：True = 保留。默认全部保留；静默卸载永远走默认值。 }
  KeepAsr, KeepProj, KeepCfg: Boolean;

function NormDir(const Dir: string): string;
begin
  Result := RemoveBackslashUnlessRoot(Dir);
end;

{ 目录里有 SubFabric.exe 或 editor\server.js 才算是一个 SubFabric 安装 }
function HasMarkers(const Dir: string): Boolean;
var
  Base: string;
begin
  Result := False;
  if (Dir = '') or (Length(Dir) < 3) then Exit;
  Base := AddBackslash(Dir);
  Result := FileExists(Base + 'SubFabric.exe') or FileExists(Base + 'editor\server.js');
end;

{ ② 扫注册表自己的 AppId（老的卸载项里有 InstallLocation） }
function RegInstallDir(RootKey: Integer): string;
var
  Names: TArrayOfString;
  I: Integer;
  Full, Loc: string;
begin
  Result := '';
  if not RegGetSubkeyNames(RootKey, UninstKey, Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do
  begin
    { 键名形如 GUID 加 _is1 后缀，只比前 38 个字符 }
    if CompareText(Copy(Names[I], 1, Length(AppGuid)), AppGuid) <> 0 then Continue;
    Full := UninstKey + '\' + Names[I];
    if RegQueryStringValue(RootKey, Full, 'InstallLocation', Loc) then
    begin
      Loc := NormDir(Loc);
      if HasMarkers(Loc) then begin Result := Loc; Exit; end;
    end;
    { 老安装可能只写了 UninstallString：从 "…\unins000.exe" 反推目录 }
    if RegQueryStringValue(RootKey, Full, 'UninstallString', Loc) then
    begin
      Loc := NormDir(ExtractFileDir(RemoveQuotes(Loc)));
      if HasMarkers(Loc) then begin Result := Loc; Exit; end;
    end;
  end;
end;

{ 从 UninstallString 里取出 exe 路径。NSIS 写的是
  `"D:\X\Uninstall SubFabric.exe" /currentuser` —— 先剥引号再截掉后面的参数，
  直接 RemoveQuotes 会因为尾部的 /currentuser 失效（2026-11-05 实测：
  解析失败 → 退化到扫盘 → 命中别的安装目录）。 }
function ExePathFrom(const S: string): string;
var
  T: string;
  P: Integer;
begin
  T := S;
  if (Length(T) > 0) and (T[1] = '"') then
  begin
    T := Copy(T, 2, Length(T) - 1);
    P := Pos('"', T);
    if P > 0 then T := Copy(T, 1, P - 1);
  end
  else
  begin
    P := Pos(' ', T);
    if P > 0 then T := Copy(T, 1, P - 1);
  end;
  Result := T;
end;

{ ③ Electron 版（NSIS）的卸载项：键名是 appId 派生的 GUID。
    优先读 HKCU\Software\<guid> 的 InstallLocation（electron-builder 写的就是这个，
    卸载项里的 InstallLocation 往往是空的），再退回卸载项的 InstallLocation /
    UninstallString（"<目录>\Uninstall SubFabric.exe" /currentuser）。 }
function RegElectronDir(RootKey: Integer): string;
var
  Full, Loc: string;
begin
  Result := '';
  if RegQueryStringValue(RootKey, 'Software\' + ElectronGuid, 'InstallLocation', Loc) then
  begin
    Loc := NormDir(Loc);
    if HasMarkers(Loc) then begin Result := Loc; Exit; end;
  end;
  Full := UninstKey + '\' + ElectronGuid;
  if RegQueryStringValue(RootKey, Full, 'InstallLocation', Loc) then
  begin
    Loc := NormDir(Loc);
    if HasMarkers(Loc) then begin Result := Loc; Exit; end;
  end;
  if RegQueryStringValue(RootKey, Full, 'UninstallString', Loc) then
  begin
    Loc := NormDir(ExtractFileDir(ExePathFrom(Loc)));
    if HasMarkers(Loc) then Result := Loc;
  end;
end;

{ ③ 扫盘：安装前缀下的 SubFabric、用户目录下的 Programs\SubFabric，再遍历所有盘符的常见位置（Program Files、
    Program Files (x86)、盘根）。这一路是为「便携版」准备的 —— 手动解压出来的目录没有任何注册记录。 }
function ScanCommonDirs: string;
var
  Dir: string;
begin
  Result := '';
  Dir := NormDir(ExpandConstant('{autopf}\SubFabric'));
  if HasMarkers(Dir) then begin Result := Dir; Exit; end;
  Dir := NormDir(ExpandConstant('{localappdata}\Programs\SubFabric'));
  if HasMarkers(Dir) then begin Result := Dir; Exit; end;
end;

function ScanDrives: string;
var
  I: Integer;
  Base, Dir: string;
begin
  Result := '';
  { 逐盘扫：'C'..'Z'。用 Ord/Chr 而不是 Char 的 for —— Char + String 在 Pascal Script 里是类型错配 }
  for I := Ord('C') to Ord('Z') do
  begin
    Base := Chr(I) + ':\';
    if not DirExists(Base) then Continue;
    Dir := Base + 'Program Files\SubFabric';
    if HasMarkers(Dir) then begin Result := Dir; Exit; end;
    Dir := Base + 'Program Files (x86)\SubFabric';
    if HasMarkers(Dir) then begin Result := Dir; Exit; end;
    Dir := Base + 'SubFabric';
    if HasMarkers(Dir) then begin Result := Dir; Exit; end;
  end;
end;

function DetectDir: string;
begin
  Result := '';
  Result := RegInstallDir(HKLM);
  if Result = '' then Result := RegInstallDir(HKLM64);
  if Result = '' then Result := RegInstallDir(HKLM32);
  if Result = '' then Result := RegInstallDir(HKCU);
  { Electron 版（NSIS）装在同一目录时，它的卸载项里也有 InstallLocation }
  if Result = '' then Result := RegElectronDir(HKLM);
  if Result = '' then Result := RegElectronDir(HKLM64);
  if Result = '' then Result := RegElectronDir(HKLM32);
  if Result = '' then Result := RegElectronDir(HKCU);
  if Result = '' then Result := ScanCommonDirs;
  if Result = '' then Result := ScanDrives;
end;

procedure InitializeWizard;
begin
  DetectedDir := DetectDir;
end;

{ 检测结果**静默预填**到目录页（页面上不写任何说明文字）。
  只在当前值仍是那个平铺默认值时覆盖：命令行 /DIR 与 ① UsePreviousAppDir 都不会被顶掉。 }
procedure CurPageChanged(CurPageID: Integer);
var
  Flat: string;
begin
  if (CurPageID <> wpSelectDir) or (DetectedDir = '') then Exit;
  Flat := NormDir(ExpandConstant('{autopf}\SubFabric'));
  if (NormDir(WizardForm.DirEdit.Text) = Flat) or (WizardForm.DirEdit.Text = '') then
    WizardForm.DirEdit.Text := DetectedDir;
end;

{ ── 安装完成后：清掉另一条链路（Electron / NSIS）的卸载登记 ──────────── }
{ 两版装同一目录、共用一份数据，只能有一条「应用和功能」记录；Electron 版的
  resources\、*.dll 等程序文件由 [InstallDelete] 清掉。
  ⚠ 只有「Electron 版登记的目录 == 本次安装目录」才算接管 —— 否则装到别处会把
  另一份正常安装的卸载项删掉（2026-11-05 实测踩过）。 }
function OtherFlavorDir: string;
begin
  Result := RegElectronDir(HKCU);
  if Result = '' then Result := RegElectronDir(HKLM);
  if Result = '' then Result := RegElectronDir(HKLM32);
  if Result = '' then Result := RegElectronDir(HKLM64);
end;

procedure RemoveOtherFlavorTraces;
var
  App, Loc: string;
begin
  App := ExpandConstant('{app}');
  Loc := OtherFlavorDir;
  if (Loc <> '') and (CompareText(NormDir(Loc), NormDir(App)) = 0) then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, UninstKey + '\' + ElectronGuid);
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\' + ElectronGuid);
    RegDeleteKeyIncludingSubkeys(HKLM, UninstKey + '\' + ElectronGuid);
    RegDeleteKeyIncludingSubkeys(HKLM32, UninstKey + '\' + ElectronGuid);
    Log('已接管 Electron 版的安装目录：' + App);
  end;
  { 只清理指向已不存在目录的旧 Inno 项（1.5.1.1 曾误装到 <目录>\SubFabric\），
    别动别人那份正常安装。 }
  if RegQueryStringValue(HKLM32, UninstKey + '\' + AppGuid + '_is1', 'InstallLocation', Loc) then
    if (NormDir(Loc) <> '') and (not DirExists(NormDir(Loc))) then
      RegDeleteKeyIncludingSubkeys(HKLM32, UninstKey + '\' + AppGuid + '_is1');
  if RegQueryStringValue(HKLM, UninstKey + '\' + AppGuid + '_is1', 'InstallLocation', Loc) then
    if (NormDir(Loc) <> '') and (not DirExists(NormDir(Loc))) then
      RegDeleteKeyIncludingSubkeys(HKLM, UninstKey + '\' + AppGuid + '_is1');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RemoveOtherFlavorTraces;
end;

{ ── 卸载：先问要保留什么，默认全保留 ────────────────────────────────── }
{ Inno 的卸载向导不支持追加页面，这里用一个模态窗体（CreateCustomForm 在卸载器里同样
  可用）在卸载开始前问一次。静默卸载不弹窗，永远按「全部保留」处理；要连数据一起清空
  必须显式传 /DELETE-DATA。窗体万一建不起来，也退回「全部保留」，不让卸载失败。 }
function InitializeUninstall(): Boolean;
var
  Form: TSetupForm;
  Hint, Tip: TNewStaticText;
  ChkAsr, ChkProj, ChkCfg: TNewCheckBox;
  OkBtn, CancelBtn: TNewButton;
  I: Integer;
begin
  KeepAsr  := True;
  KeepProj := True;
  KeepCfg  := True;

  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/DELETE-DATA') = 0 then
    begin
      KeepAsr := False; KeepProj := False; KeepCfg := False;
    end;

  Result := True;
  if UninstallSilent then Exit;

  try
    Form := CreateCustomForm(ScaleX(450), ScaleY(252), False, True);
    try
      Form.Caption := '卸载 ' + ExpandConstant('{#MyAppName}');
      Log('数据选项对话框已创建');

      Hint := TNewStaticText.Create(Form);
      Hint.Parent     := Form;
      Hint.Left       := ScaleX(16);
      Hint.Top        := ScaleY(14);
      Hint.Width      := ScaleX(418);
      Hint.Height     := ScaleY(50);
      Hint.AutoSize   := False;
      Hint.WordWrap   := True;
      Hint.Caption    := '卸载只会删除程序文件。下面勾选的内容会原样保留在：' + #13#10 +
                         ExpandConstant('{app}') + #13#10 +
                         '取消勾选的项目会被一并删除，且无法恢复。';

      ChkAsr := TNewCheckBox.Create(Form);
      ChkAsr.Parent  := Form;
      ChkAsr.Left    := ScaleX(16);
      ChkAsr.Top     := ScaleY(76);
      ChkAsr.Width   := ScaleX(418);
      ChkAsr.Height  := ScaleY(18);
      ChkAsr.Caption := '保留 ASR 模型与 Python 运行时（asr、tools，通常数 GB 到 20 GB）';
      ChkAsr.Checked := True;

      ChkProj := TNewCheckBox.Create(Form);
      ChkProj.Parent  := Form;
      ChkProj.Left    := ScaleX(16);
      ChkProj.Top     := ScaleY(102);
      ChkProj.Width   := ScaleX(418);
      ChkProj.Height  := ScaleY(18);
      ChkProj.Caption := '保留项目与视频（projects、videos）';
      ChkProj.Checked := True;

      ChkCfg := TNewCheckBox.Create(Form);
      ChkCfg.Parent  := Form;
      ChkCfg.Left    := ScaleX(16);
      ChkCfg.Top     := ScaleY(128);
      ChkCfg.Width   := ScaleX(418);
      ChkCfg.Height  := ScaleY(18);
      ChkCfg.Caption := '保留配置（翻译方案、热词/术语表、浏览器数据、缓存）';
      ChkCfg.Checked := True;

      Tip := TNewStaticText.Create(Form);
      Tip.Parent   := Form;
      Tip.Left     := ScaleX(16);
      Tip.Top      := ScaleY(156);
      Tip.Width    := ScaleX(418);
      Tip.Height   := ScaleY(34);
      Tip.AutoSize := False;
      Tip.WordWrap := True;
      Tip.Caption  := '保留的内容重新安装任一版本（Electron / SEA）后会自动继续使用。';

      OkBtn := TNewButton.Create(Form);
      OkBtn.Parent      := Form;
      OkBtn.Caption     := '确定卸载';
      OkBtn.Width       := ScaleX(110);
      OkBtn.Height      := ScaleY(27);
      OkBtn.Left        := Form.ClientWidth - ScaleX(110) - ScaleX(16);
      OkBtn.Top         := Form.ClientHeight - ScaleY(27) - ScaleY(16);
      OkBtn.Default     := True;
      OkBtn.ModalResult := mrOk;

      CancelBtn := TNewButton.Create(Form);
      CancelBtn.Parent      := Form;
      CancelBtn.Caption     := '取消';
      CancelBtn.Width       := ScaleX(110);
      CancelBtn.Height      := ScaleY(27);
      CancelBtn.Left        := OkBtn.Left - ScaleX(110) - ScaleX(10);
      CancelBtn.Top         := OkBtn.Top;
      CancelBtn.Cancel      := True;
      CancelBtn.ModalResult := mrCancel;

      if Form.ShowModal() <> mrOk then
        Result := False
      else
      begin
        KeepAsr  := ChkAsr.Checked;
        KeepProj := ChkProj.Checked;
        KeepCfg  := ChkCfg.Checked;
      end;
    finally
      Form.Free;
    end;
  except
    Log('数据选项对话框不可用，按「全部保留」处理：' + GetExceptionMessage);
    KeepAsr := True; KeepProj := True; KeepCfg := True;
    Result := True;
  end;
  Log('卸载数据选项：ASR / 项目 / 配置 = 保留');
  if not KeepAsr then Log('  用户选择删除 ASR 模型与运行时');
  if not KeepProj then Log('  用户选择删除项目与视频');
  if not KeepCfg then Log('  用户选择删除配置');
end;

{ 只删用户勾选「不保留」的部分；程序文件由 Inno 按自己的安装清单删除。
  数据路径与 desktop/installer.nsh 的 customRemoveFiles 保持一致。 }
procedure DeleteUserData;
var
  App: string;
begin
  App := ExpandConstant('{app}');
  if not KeepAsr then
  begin
    DelTree(App + '\asr\models', True, True, True);
    DelTree(App + '\asr\runtime-python', True, True, True);
    DelTree(App + '\asr\runtime-vibevoice', True, True, True);
    DelTree(App + '\asr\whisper.cpp', True, True, True);
    DelTree(App + '\asr\crispasr', True, True, True);
    DelTree(App + '\asr\faster-whisper-xxl', True, True, True);
    DelTree(App + '\asr\ytdlp', True, True, True);
    DelTree(App + '\asr\.venv', True, True, True);
    DelTree(App + '\asr\logs', True, True, True);
    DelTree(App + '\tools', True, True, True);
  end;
  if not KeepProj then
  begin
    DelTree(App + '\projects', True, True, True);
    DelTree(App + '\videos', True, True, True);
  end;
  if not KeepCfg then
  begin
    DeleteFile(App + '\asr\settings.json');
    DelTree(App + '\logs', True, True, True);
    DelTree(App + '\cache', True, True, True);
    DelTree(App + '\.profile', True, True, True);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { usPostUninstall：程序文件已经删完，这时再按选项清理数据 }
  if CurUninstallStep = usPostUninstall then
    DeleteUserData;
end;
