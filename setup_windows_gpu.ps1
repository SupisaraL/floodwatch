$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $venvPython)) {
    $basePython = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'
    if (-not (Test-Path -LiteralPath $basePython)) {
        throw "Python 3.11 was not found at $basePython. Install Python 3.11 and run this script again."
    }
    & $basePython -m venv (Join-Path $projectRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the virtual environment.' }
}

& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Unable to upgrade pip.' }

# Replace the installed CPU-only packages with the CUDA build tested on this RTX 4050 project.
& $venvPython -m pip install --upgrade --force-reinstall `
    --index-url https://download.pytorch.org/whl/cu128 `
    torch==2.11.0+cu128 torchvision==0.26.0+cu128
if ($LASTEXITCODE -ne 0) { throw 'Unable to install CUDA-enabled PyTorch.' }

& $venvPython -m pip install -r (Join-Path $projectRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Unable to install application dependencies.' }

& $venvPython -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable'; print('CUDA ready:', torch.__version__, '|', torch.cuda.get_device_name(0))"
if ($LASTEXITCODE -ne 0) { throw 'PyTorch did not detect CUDA after installation.' }
