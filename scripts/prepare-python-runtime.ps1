param(
    [ValidateSet("cuda", "default", "mps", "mlx")]
    [string]$Variant = "cuda",
    [string]$Python = "python",
    [string]$RuntimeDir = "python-runtime",
    [string]$TorchVersion = "2.7.1",
    [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtime = Join-Path $root $RuntimeDir

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
$torchRequirement = if ([string]::IsNullOrWhiteSpace($TorchVersion)) { "torch" } else { "torch==$TorchVersion" }
if ([string]::IsNullOrWhiteSpace($TorchIndexUrl)) {
    & $runtimePython -m pip install --no-cache-dir $torchRequirement
} else {
    & $runtimePython -m pip install --no-cache-dir $torchRequirement --index-url $TorchIndexUrl
}
& $runtimePython -m pip install --no-cache-dir av librosa numpy pyyaml tqdm
if ($Variant -in @("mps", "mlx")) {
    & $runtimePython -m pip install --no-cache-dir mlx
}

& (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime
$previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE = "1"
& $runtimePython -c "import importlib.util, torch, librosa, av, yaml, tqdm; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available()); print('librosa', librosa.__version__); print('av', av.__version__); print('mlx', importlib.util.find_spec('mlx') is not None)"
if ($null -eq $previousDontWriteBytecode) {
    Remove-Item Env:\PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
} else {
    $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
}
& (Join-Path $PSScriptRoot "prune-python-runtime.ps1") -RuntimeDir $runtime
