$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $venvPython)) {
    throw 'Environment is missing. Run .\setup_windows_gpu.ps1 first.'
}

& $venvPython -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable. Run .\\setup_windows_gpu.ps1'; print('Using GPU:', torch.cuda.get_device_name(0))"
Set-Location -LiteralPath $projectRoot
& $venvPython -m uvicorn backend.main:app --host 0.0.0.0 --port 8010
