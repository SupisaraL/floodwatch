$ErrorActionPreference = 'Stop'

$candidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'),
    (Join-Path $env:LOCALAPPDATA 'Docker\resources\bin'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Docker Desktop\resources\bin')
)

$dockerBin = $candidates | Where-Object {
    Test-Path -LiteralPath (Join-Path $_ 'docker.exe')
} | Select-Object -First 1

if (-not $dockerBin) {
    throw 'Docker Desktop is running, but docker.exe was not found in a standard installation folder. Reinstall Docker Desktop, then run this script again.'
}

if (($env:Path -split ';') -notcontains $dockerBin) {
    $env:Path = "$env:Path;$dockerBin"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dockerBin) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dockerBin", 'User')
}

Write-Output "Docker CLI added to PATH: $dockerBin"
& (Join-Path $dockerBin 'docker.exe') version
