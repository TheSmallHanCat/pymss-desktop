param(
  [Parameter(Mandatory = $false)]
  [string]$Version = $env:PYMSS_VERSION
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Version)) {
  throw "PYMSS_VERSION is empty. Provide -Version or set the PYMSS_VERSION environment variable."
}

$NormalizedVersion = $Version.Trim()
if ($NormalizedVersion.StartsWith('v')) {
  $NormalizedVersion = $NormalizedVersion.Substring(1)
}

if ($NormalizedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$') {
  throw "Invalid semantic version: $Version"
}

$Root = Split-Path -Parent $PSScriptRoot
$PackageJsonPath = Join-Path $Root 'package.json'
$TauriConfigPath = Join-Path $Root 'src-tauri\tauri.conf.json'
$CargoTomlPath = Join-Path $Root 'src-tauri\Cargo.toml'

function Update-JsonVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $Content = Get-Content -Path $Path -Raw
  $Updated = [regex]::Replace($Content, '(?m)^(\s*"version"\s*:\s*)"[^"]+"', "`${1}`"$NormalizedVersion`"", 1)
  [System.IO.File]::WriteAllText($Path, $Updated, [System.Text.UTF8Encoding]::new($false))
}

Update-JsonVersion -Path $PackageJsonPath
Update-JsonVersion -Path $TauriConfigPath

$CargoToml = Get-Content -Path $CargoTomlPath -Raw
$CargoToml = [regex]::Replace($CargoToml, '(?m)^(version\s*=\s*)"[^"]+"', "`${1}`"$NormalizedVersion`"", 1)
[System.IO.File]::WriteAllText($CargoTomlPath, $CargoToml, [System.Text.UTF8Encoding]::new($false))

Write-Host "Synchronized build version to $NormalizedVersion"
Write-Host " - $PackageJsonPath"
Write-Host " - $TauriConfigPath"
Write-Host " - $CargoTomlPath"
