param(
    [ValidateSet("cuda", "default", "rocm", "mps", "mlx")]
    [string]$Variant = "cuda",
    [string]$Python = "python",
    [string]$RuntimeDir = "python-runtime",
    [string]$TorchVersion = "2.7.1",
    [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128",
    [switch]$Minimal,
    [string]$PreinstallBackend = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtime = Join-Path $root $RuntimeDir

# ---------------------------------------------------------------------------
# PreinstallBackend mode: create minimal bootstrap + pre-installed backend env
# ---------------------------------------------------------------------------
if ($PreinstallBackend) {
    Write-Host "=== PreinstallBackend mode: base runtime + $PreinstallBackend environment ==="

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
    & $runtimePython -m ensurepip --upgrade
    & $runtimePython -m pip install --upgrade pip setuptools wheel
    & $runtimePython -m pip install --no-cache-dir pysocks requests
    & (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime
    Write-Host "Bootstrap runtime created at $runtime"

    # Step 2: Create venv for the pre-installed backend
    $envsDir = Join-Path (Split-Path $runtime -Parent) "runtime-envs"
    $envDir = Join-Path $envsDir $PreinstallBackend
    if (Test-Path -LiteralPath $envDir) {
        Remove-Item -LiteralPath $envDir -Recurse -Force
    }
    Write-Host "Creating venv at $envDir"
    & $runtimePython -m venv $envDir
    $envPython = Join-Path $envDir "Scripts\python.exe"
    if (!(Test-Path -LiteralPath $envPython)) {
        throw "venv python.exe was not created at $envPython"
    }
    & $envPython -m pip install --upgrade pip setuptools wheel

    # Step 3: Install packages for the backend
    $torchRequirement = if ([string]::IsNullOrWhiteSpace($TorchVersion)) { "torch" } else { "torch==$TorchVersion" }
    if ($PreinstallBackend -eq "rocm") {
        $rocmSdkWheels = @(
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz"
        )
        & $envPython -m pip install --no-cache-dir @rocmSdkWheels
        $rocmWheels = @(
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
            "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl"
        )
        & $envPython -m pip install --no-cache-dir --no-deps @rocmWheels
    } elseif ([string]::IsNullOrWhiteSpace($TorchIndexUrl)) {
        & $envPython -m pip install --no-cache-dir $torchRequirement
    } else {
        & $envPython -m pip install --no-cache-dir $torchRequirement --index-url $TorchIndexUrl
    }
    & $envPython -m pip install --no-cache-dir --only-binary=:all: --prefer-binary av filelock fsspec jinja2 librosa networkx numpy pysocks requests pyyaml sympy tqdm typing-extensions
    if ($PreinstallBackend -in @("mps", "mlx")) {
        & $envPython -m pip install --no-cache-dir mlx
    }
    & $envPython -m pip install --no-cache-dir --no-deps "pymss>=2.0.15" pymss-core==0.1.6
    & (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $envDir

    # Step 4: Verify the environment
    $previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
    $env:PYTHONDONTWRITEBYTECODE = "1"
    & $envPython -c "import importlib.util, pymss, torch, librosa, av, yaml, tqdm; print('pymss', getattr(pymss, '__version__', 'unknown'), pymss.__file__); print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available()); print('librosa', librosa.__version__); print('av', av.__version__); print('mlx', importlib.util.find_spec('mlx') is not None)"
    if ($null -eq $previousDontWriteBytecode) {
        Remove-Item Env:\PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
    } else {
        $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
    }

    # Step 5: Read manifest version and write state files
    $manifestPath = Join-Path $root "python\runtime-manifest.json"
    $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
    $manifestVersion = $manifest.manifestVersion

    # Probe torch info from the env
    $probeResult = & $envPython -c "import torch, json, platform; print(json.dumps({'torchVersion': torch.__version__, 'torchBackend': 'rocm' if getattr(torch.version, 'hip', None) else 'cuda' if getattr(torch.version, 'cuda', None) else 'cpu', 'acceleratorAvailable': torch.cuda.is_available(), 'pythonVersion': platform.python_version()}))"
    $probed = $probeResult | ConvertFrom-Json
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    $envState = @{
        backend = $PreinstallBackend
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
    $relativePythonPath = Join-Path $PreinstallBackend "Scripts\python.exe"
    $activeState = @{
        backend = $PreinstallBackend
        manifestVersion = $manifestVersion
        installedAt = $now
        pythonVersion = $probed.pythonVersion
        torchVersion = $probed.torchVersion
        torchBackend = $probed.torchBackend
        acceleratorAvailable = $probed.acceleratorAvailable
        pythonPath = $relativePythonPath
        activatedAt = $now
        source = "preinstalled"
    } | ConvertTo-Json -Depth 4
    $activeRuntimePath = Join-Path $envsDir "active-runtime.json"
    Set-Content -Path $activeRuntimePath -Value $activeState -Encoding UTF8
    Write-Host "Wrote active runtime to $activeRuntimePath"

    & (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $envDir
    Write-Host "=== PreinstallBackend complete: $PreinstallBackend environment ready ==="
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

& $runtimePython -m pip install --upgrade pip setuptools wheel
if ($Minimal) {
    $sitePackages = Join-Path $runtime "Lib\site-packages"
    if (Test-Path -LiteralPath $sitePackages) {
        Remove-Item -LiteralPath $sitePackages -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
    & $runtimePython -m ensurepip --upgrade
    & $runtimePython -m pip install --no-cache-dir pysocks requests
    Write-Host "Prepared minimal Python runtime without ML dependencies"
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
    & $runtimePython -m pip install --no-cache-dir @rocmSdkWheels
    $rocmWheels = @(
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl"
    )
    & $runtimePython -m pip install --no-cache-dir --no-deps @rocmWheels
} elseif ([string]::IsNullOrWhiteSpace($TorchIndexUrl)) {
    & $runtimePython -m pip install --no-cache-dir $torchRequirement
} else {
    & $runtimePython -m pip install --no-cache-dir $torchRequirement --index-url $TorchIndexUrl
}
& $runtimePython -m pip install --no-cache-dir --only-binary=:all: --prefer-binary av filelock fsspec jinja2 librosa networkx numpy pysocks requests pyyaml sympy tqdm typing-extensions
if ($Variant -in @("mps", "mlx")) {
    & $runtimePython -m pip install --no-cache-dir mlx
}
& $runtimePython -m pip install --no-cache-dir --no-deps "pymss>=2.0.15" pymss-core==0.1.6

& (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime
$previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE = "1"
& $runtimePython -c "import importlib.util, pymss, torch, librosa, av, yaml, tqdm; print('pymss', getattr(pymss, '__version__', 'unknown'), pymss.__file__); print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available()); print('librosa', librosa.__version__); print('av', av.__version__); print('mlx', importlib.util.find_spec('mlx') is not None)"
if ($null -eq $previousDontWriteBytecode) {
    Remove-Item Env:\PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
} else {
    $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
}
& (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime
