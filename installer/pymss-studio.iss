; Pymss Studio Windows CUDA installer.
; The source directory is prepared by GitHub Actions and passed through PYMSS_PORTABLE_DIR.

#define MyAppName "Pymss Studio"
#define MyAppVersion GetEnv("PYMSS_VERSION") == "" ? "0.0.1" : GetEnv("PYMSS_VERSION")
#define MyAppPublisher "TheSmallHanCat"
#define MyAppExeName "Pymss Studio.exe"
#define SourceDir GetEnv("PYMSS_PORTABLE_DIR")
#define OutputDir GetEnv("PYMSS_INSTALLER_OUTPUT") == "" ? "..\release" : GetEnv("PYMSS_INSTALLER_OUTPUT")
#define PackageSuffix GetEnv("PYMSS_PACKAGE_SUFFIX") == "" ? "windows-x64-cuda" : GetEnv("PYMSS_PACKAGE_SUFFIX")

#if SourceDir == ""
  #error PYMSS_PORTABLE_DIR is required. It must point to the staged portable directory.
#endif

[Setup]
; Unique AppId for Pymss Studio. Do not reuse AppIds from other projects.
AppId={{6A208087-F154-4C62-8916-E3D40B7C0F24}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir={#OutputDir}
OutputBaseFilename=Pymss-Studio-{#MyAppVersion}-{#PackageSuffix}-setup
Compression=lzma2/max
LZMAUseSeparateProcess=yes
LZMADictionarySize=1048576
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
RestartApplications=no
DirExistsWarning=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Do not install anything into system Python. The embedded python-runtime is private to this app.

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\VC_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Microsoft Visual C++ Runtime..."; Flags: waituntilterminated runhidden skipifdoesntexist; Check: not IsVCRedistX64Installed
Filename: "{cmd}"; Parameters: "/C del /F /Q ""{app}\bin\VC_redist.x64.exe"""; Flags: runhidden waituntilterminated skipifdoesntexist; Check: not IsVCRedistX64Installed
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
function IsVCRedistX64Installed(): Boolean;
var
  Installed: Cardinal;
begin
  Result :=
    RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed)
    and (Installed = 1);
end;

procedure RemoveIfExists(Path: string);
begin
  if DirExists(Path) then
  begin
    DelTree(Path, True, True, True);
  end
  else if FileExists(Path) then
  begin
    DeleteFile(Path);
  end;
end;

procedure CleanupInstallTree();
begin
  { Remove known development leftovers if they ever slip into the staged directory. }
  RemoveIfExists(ExpandConstant('{app}') + '\.git');
  RemoveIfExists(ExpandConstant('{app}') + '\.github');
  RemoveIfExists(ExpandConstant('{app}') + '\.claude');
  RemoveIfExists(ExpandConstant('{app}') + '\.omc');
  RemoveIfExists(ExpandConstant('{app}') + '\.spec-workflow');
  RemoveIfExists(ExpandConstant('{app}') + '\__pycache__');
  RemoveIfExists(ExpandConstant('{app}') + '\python-runtime\Doc');
  RemoveIfExists(ExpandConstant('{app}') + '\python-runtime\include');
  RemoveIfExists(ExpandConstant('{app}') + '\python-runtime\libs');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    RemoveIfExists(ExpandConstant('{app}') + '\python-runtime');
  end;

  if CurStep = ssPostInstall then
  begin
    CleanupInstallTree();
  end;
end;
