param([int]$Port = 8771)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskDocker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $taskDocker) {
  foreach ($taskBin in @('C:\Program Files\Docker\Docker\resources\bin', "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin")) {
    if (Test-Path -LiteralPath (Join-Path $taskBin 'docker.exe')) { $env:PATH = "$taskBin;$env:PATH"; break }
  }
}
if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw '请先安装并启动 Docker Desktop。' }
& docker info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker引擎尚未启动。请打开Docker Desktop并等待Linux引擎就绪。' }
$env:HEAD_PORT = [string]$Port
if (-not $env:HEAD_CONFIG -and (Test-Path -LiteralPath './config.local.yaml')) { $env:HEAD_CONFIG = './config.local.yaml' }
& docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw '构建或启动失败，请查看上方错误。' }
Write-Host "浏览器打开：http://127.0.0.1:$Port"
