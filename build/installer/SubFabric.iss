; SubFabric 安装包脚本（Inno Setup 6）
;
; 本文件入库（build/ 其余内容是 .gitignore 的），构建步骤见 editor/README.md「发版流程」：
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
; 版本号要和 editor/server.js 的 APP_VERSION、editor/README.md 标题一起改。
; 口径：**只看远端最新 tag，补丁位 +1**（远端 https://github.com/EndiVee233/SubFabric/tags ）。
;       功能再多也走补丁位（2.1.8 加微光特效、2.1.9 加词生长都是这么发的），不要自己跳小版本。
;       嫌麻烦可以先 `git ls-remote --tags` 或直接看 Releases 页确认最新号再 +1。

#define MyAppName "SubFabric"
#define MyAppVersion "2.1.14"
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
VersionInfoVersion={#MyAppVersion}.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=.
OutputBaseFilename=SubFabric-{#MyAppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
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

; ── Python 侧（asr.py / diarize.py / multitalker.py / fetch\*）──
; 用户数据一律不进安装包，也绝不被安装/卸载碰到：asr\.venv、asr\models、asr\settings.json、
; asr\whisper.cpp、asr\runtime-python、asr\ytdlp、asr\logs、projects\
Source: "{#Root}\asr\*"; DestDir: "{app}\asr"; \
    Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: ".venv\*,\models\*,\settings.json,\whisper.cpp\*,\runtime-python\*,\ytdlp\*,\logs\*,\__pycache__\*,*\__pycache__\*"

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

var
  DetectedDir: string;

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
