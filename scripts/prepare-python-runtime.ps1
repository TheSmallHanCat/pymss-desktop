param(
    [ValidateSet("cuda", "default", "rocm", "mps", "mlx")]
    [string]$Variant = "cuda",
    [string]$Python = "python",
    [string]$RuntimeDir = "python-runtime",
    [string]$TorchVersion = "2.7.1",
    [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128",
    [switch]$Minimal,
    [string]$InitialBackend = "",
    [string]$RuntimeEnvsDir = "",
    [switch]$RewriteRuntimeEnvConfigs,
    [switch]$TemplateRuntimeEnvConfigs
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtime = Join-Path $root $RuntimeDir
$effectiveRuntimeEnvsDir = if ($RuntimeEnvsDir) { $RuntimeEnvsDir } else { Join-Path $runtime "runtime-envs" }

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [object[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

function Rewrite-WindowsRuntimeEnvConfigs {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvsDir,
        [Parameter(Mandatory = $true)]
        [string]$PythonRuntimeDir,
        [switch]$Template
    )

    $resolvedEnvsDir = Resolve-Path -LiteralPath $EnvsDir
    $resolvedRuntimeDir = if ($Template) { "__PYMSS_STUDIO_PYTHON_RUNTIME__" } else { (Resolve-Path -LiteralPath $PythonRuntimeDir).Path }
    $pythonExe = Join-Path $resolvedRuntimeDir "python.exe"
    if (!$Template -and !(Test-Path -LiteralPath $pythonExe)) {
        throw "python.exe not found at $pythonExe"
    }

    Get-ChildItem -LiteralPath $resolvedEnvsDir -Directory | ForEach-Object {
        $cfg = Join-Path $_.FullName "pyvenv.cfg"
        if (Test-Path -LiteralPath $cfg) {
            $envDir = if ($Template) { "__PYMSS_STUDIO_RUNTIME_ENV__" } else { $_.FullName }
            $content = @(
                "home = $resolvedRuntimeDir"
                "include-system-site-packages = false"
                "executable = $pythonExe"
                "command = $pythonExe -m venv $envDir"
                ""
            ) -join "`r`n"

            [System.IO.File]::WriteAllText($cfg, $content, [System.Text.UTF8Encoding]::new($false))
            if ($Template) {
                Write-Host "Templated $cfg"
            } else {
                Write-Host "Rewrote $cfg"
            }
        }
    }
}

function Remove-RocmOffloadArchLauncher {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvironmentDir
    )

    # ROCm's pip console-script wrapper embeds the build interpreter path. The SDK can use the
    # relocatable native tool shipped under _rocm_sdk_core when this wrapper is absent from Scripts.
    $launcher = Join-Path $EnvironmentDir "Scripts\offload-arch.exe"
    $sitePackages = Join-Path $EnvironmentDir "Lib\site-packages"
    $sdkPackage = Get-ChildItem -LiteralPath $sitePackages -Directory -Filter "_rocm_sdk_core*" | Select-Object -First 1
    if (!$sdkPackage) {
        throw "ROCm SDK core package was not found in $sitePackages"
    }
    $nativeTools = Join-Path $sdkPackage.FullName "lib\llvm\bin"
    $runtimeBin = Join-Path $sdkPackage.FullName "bin"
    if (!(Test-Path -LiteralPath (Join-Path $nativeTools "offload-arch.exe"))) {
        throw "ROCm native offload-arch tool was not found in $nativeTools"
    }
    if (!(Test-Path -LiteralPath $runtimeBin)) {
        throw "ROCm runtime DLL directory was not found in $runtimeBin"
    }
    if (Test-Path -LiteralPath $launcher) {
        Remove-Item -LiteralPath $launcher -Force
        Write-Host "Removed relocatability-breaking ROCm launcher $launcher"
    }
    return @($nativeTools, $runtimeBin)
}

if ($RewriteRuntimeEnvConfigs -or $TemplateRuntimeEnvConfigs) {
    Rewrite-WindowsRuntimeEnvConfigs -EnvsDir $RuntimeEnvsDir -PythonRuntimeDir $RuntimeDir -Template:$TemplateRuntimeEnvConfigs
    exit 0
}

# ---------------------------------------------------------------------------
# InitialBackend mode: create minimal bootstrap + initial backend env
# ---------------------------------------------------------------------------
if ($InitialBackend) {
    Write-Host "=== InitialBackend mode: base runtime + $InitialBackend environment ==="

    # Step 1: Create minimal bootstrap runtime
    if (Test-Path -LiteralPath $runtime) {
        Remove-Item -LiteralPath $runtime -Recurse -Force
    }
    $pythonExe = (Get-Command $Python).Source
    $pythonHome = Split-Path -Parent $pythonExe
    Write-Host "Copying bootstrap Python from $pythonHome"
    robocopy $pythonHome $runtime /E /XD __pycache__ /XF *.pyc | Out-Host
    if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }
    $global:LASTEXITCODE = 0
    $runtimePython = Join-Path $runtime "python.exe"
    if (!(Test-Path -LiteralPath $runtimePython)) {
        throw "python.exe was not copied to $runtime"
    }
    $sitePackages = Join-Path $runtime "Lib\site-packages"
    if (Test-Path -LiteralPath $sitePackages) {
        Remove-Item -LiteralPath $sitePackages -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
    Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'ensurepip', '--upgrade')
    Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel')
    Write-Host "Bootstrap runtime created at $runtime"

    # Step 2: Create venv for the initial backend
    $envsDir = if ([System.IO.Path]::IsPathRooted($effectiveRuntimeEnvsDir)) { $effectiveRuntimeEnvsDir } else { Join-Path $root $effectiveRuntimeEnvsDir }
    $envDir = Join-Path $envsDir $InitialBackend
    if (Test-Path -LiteralPath $envDir) {
        Remove-Item -LiteralPath $envDir -Recurse -Force
    }
    Write-Host "Creating venv at $envDir"
    Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'venv', $envDir)
    $envPython = Join-Path $envDir "Scripts\python.exe"
    if (!(Test-Path -LiteralPath $envPython)) {
        throw "venv python.exe was not created at $envPython"
    }
    & (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime -KeepVenv
    Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel')

    # Step 3: Install packages for the backend
    $torchRequirement = if ([string]::IsNullOrWhiteSpace($TorchVersion)) { "torch" } else { "torch==$TorchVersion" }
    if ($InitialBackend -eq "rocm") {
        $rocmSdkWheels = @(
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz"
        )
        Invoke-NativeChecked -FilePath $envPython -Arguments (@('-m', 'pip', 'install', '--no-cache-dir') + $rocmSdkWheels)
        $rocmWheels = @(
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl"
        )
        Invoke-NativeChecked -FilePath $envPython -Arguments (@('-m', 'pip', 'install', '--no-cache-dir', '--no-deps') + $rocmWheels)
    } elseif ([string]::IsNullOrWhiteSpace($TorchIndexUrl)) {
        Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', $torchRequirement)
    } else {
        Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', $torchRequirement, '--index-url', $TorchIndexUrl)
    }
    Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', '--only-binary=:all:', '--prefer-binary', 'av', 'filelock', 'fsspec', 'jinja2', 'librosa', 'networkx', 'numpy', 'pysocks', 'requests', 'pyyaml', 'sympy', 'tqdm', 'typing-extensions')
    if ($InitialBackend -in @("mps", "mlx")) {
        Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', 'mlx')
    }
    Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', '--upgrade', '--no-deps', 'pymss>=2.0.15', 'pymss-core>=0.1.6')
    $rocmToolDirs = if ($InitialBackend -eq "rocm") { Remove-RocmOffloadArchLauncher -EnvironmentDir $envDir } else { @() }
    & (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $envDir -KeepScripts
    Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', '--version')

    # Step 4: Verify the environment
    $previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
    $previousPath = $env:PATH
    try {
        $env:PYTHONDONTWRITEBYTECODE = "1"
        if ($rocmToolDirs.Count -gt 0) {
            $env:PATH = ($rocmToolDirs + $previousPath) -join ";"
        }
        Invoke-NativeChecked -FilePath $envPython -Arguments @('-c', "import importlib.util, pymss, torch, librosa, av, yaml, tqdm; print('pymss', getattr(pymss, '__version__', 'unknown'), pymss.__file__); print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available()); print('librosa', librosa.__version__); print('av', av.__version__); print('mlx', importlib.util.find_spec('mlx') is not None)")

        # Step 5: Read manifest version and write state files
        $manifestPath = Join-Path $root "python\runtime-manifest.json"
        $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
        $manifestVersion = $manifest.manifestVersion

        # Probe torch info from the env
        $probeOutput = @(Invoke-NativeChecked -FilePath $envPython -Arguments @('-c', "import torch, json, platform; print(json.dumps({'torchVersion': torch.__version__, 'torchBackend': 'rocm' if getattr(torch.version, 'hip', None) else 'cuda' if getattr(torch.version, 'cuda', None) else 'cpu', 'acceleratorAvailable': torch.cuda.is_available(), 'pythonVersion': platform.python_version()}))"))
    } finally {
        if ($null -eq $previousDontWriteBytecode) {
            Remove-Item Env:\PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
        } else {
            $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
        }
        $env:PATH = $previousPath
    }
    $probeJson = $probeOutput |
        ForEach-Object { $_.ToString().Trim() } |
        Where-Object { $_ -match '^\s*\{.*\}\s*$' } |
        Select-Object -Last 1
    if ([string]::IsNullOrWhiteSpace($probeJson)) {
        throw "Runtime probe did not produce a JSON result"
    }
    $probed = $probeJson | ConvertFrom-Json
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    $envState = @{
        backend = $InitialBackend
        manifestVersion = $manifestVersion
        installedAt = $now
        pythonVersion = $probed.pythonVersion
        torchVersion = $probed.torchVersion
        torchBackend = $probed.torchBackend
        acceleratorAvailable = $probed.acceleratorAvailable
    } | ConvertTo-Json -Depth 4
    $envStatePath = Join-Path $envDir "pymss-runtime-state.json"
    Set-Content -Path $envStatePath -Value $envState -Encoding UTF8
    Write-Host "Wrote environment state to $envStatePath"

    # Use relative pythonPath (relative to runtime-envs dir) so it works on any machine
    $relativePythonPath = Join-Path $InitialBackend "Scripts\python.exe"
    $activeState = @{
        backend = $InitialBackend
        manifestVersion = $manifestVersion
        installedAt = $now
        pythonVersion = $probed.pythonVersion
        torchVersion = $probed.torchVersion
        torchBackend = $probed.torchBackend
        acceleratorAvailable = $probed.acceleratorAvailable
        pythonPath = $relativePythonPath
        activatedAt = $now
    } | ConvertTo-Json -Depth 4
    $activeRuntimePath = Join-Path $envsDir "active-runtime.json"
    Set-Content -Path $activeRuntimePath -Value $activeState -Encoding UTF8
    Write-Host "Wrote active runtime to $activeRuntimePath"

    & (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $envDir -KeepScripts
    Invoke-NativeChecked -FilePath $envPython -Arguments @('-m', 'pip', '--version')
    Write-Host "=== InitialBackend complete: $InitialBackend environment ready ==="
    exit 0
}

# ---------------------------------------------------------------------------
# Standard mode (existing behavior)
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $runtime) {
    Remove-Item -LiteralPath $runtime -Recurse -Force
}

$pythonExe = (Get-Command $Python).Source
$pythonHome = Split-Path -Parent $pythonExe
Write-Host "Copying portable Python runtime from $pythonHome"
robocopy $pythonHome $runtime /E /XD __pycache__ /XF *.pyc | Out-Host
if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

$runtimePython = Join-Path $runtime "python.exe"
if (!(Test-Path -LiteralPath $runtimePython)) {
    throw "python.exe was not copied to $runtime"
}

Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel')
if ($Minimal) {
    $sitePackages = Join-Path $runtime "Lib\site-packages"
    if (Test-Path -LiteralPath $sitePackages) {
        Remove-Item -LiteralPath $sitePackages -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
    Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'ensurepip', '--upgrade')
    Write-Host "Prepared minimal Python runtime without inference dependencies"
    exit 0
}
$torchRequirement = if ([string]::IsNullOrWhiteSpace($TorchVersion)) { "torch" } else { "torch==$TorchVersion" }
if ($Variant -eq "rocm") {
    $rocmSdkWheels = @(
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz"
    )
    Invoke-NativeChecked -FilePath $runtimePython -Arguments (@('-m', 'pip', 'install', '--no-cache-dir') + $rocmSdkWheels)
    $rocmWheels = @(
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl"
    )
    Invoke-NativeChecked -FilePath $runtimePython -Arguments (@('-m', 'pip', 'install', '--no-cache-dir', '--no-deps') + $rocmWheels)
} elseif ([string]::IsNullOrWhiteSpace($TorchIndexUrl)) {
    Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', $torchRequirement)
} else {
    Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', $torchRequirement, '--index-url', $TorchIndexUrl)
}
Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', '--only-binary=:all:', '--prefer-binary', 'av', 'filelock', 'fsspec', 'jinja2', 'librosa', 'networkx', 'numpy', 'pysocks', 'requests', 'pyyaml', 'sympy', 'tqdm', 'typing-extensions')
if ($Variant -in @("mps", "mlx")) {
    Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', 'mlx')
}
Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', 'install', '--no-cache-dir', '--upgrade', '--no-deps', 'pymss>=2.0.15', 'pymss-core>=0.1.6')

& (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime -KeepVenv
Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', '--version')
$previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE = "1"
Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-c', "import importlib.util, pymss, torch, librosa, av, yaml, tqdm; print('pymss', getattr(pymss, '__version__', 'unknown'), pymss.__file__); print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available()); print('librosa', librosa.__version__); print('av', av.__version__); print('mlx', importlib.util.find_spec('mlx') is not None)")
if ($null -eq $previousDontWriteBytecode) {
    Remove-Item Env:\PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
} else {
    $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
}
& (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime -KeepVenv
Invoke-NativeChecked -FilePath $runtimePython -Arguments @('-m', 'pip', '--version')
