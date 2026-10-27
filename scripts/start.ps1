$ErrorActionPreference = 'Stop'
$canvasRoot = Split-Path -Parent $PSScriptRoot
$canvasNode = (Get-Command node -ErrorAction Stop).Source
$canvasMajor = [int]((& $canvasNode --version).TrimStart('v').Split('.')[0])
if ($canvasMajor -lt 24) { throw 'Branch Canvas requires Node.js 24 or newer.' }
$canvasEntry = Join-Path $canvasRoot 'dist\http.mjs'
if (-not (Test-Path -LiteralPath $canvasEntry)) { throw 'Run npm ci and npm run build before starting from source.' }
$canvasData = Join-Path $canvasRoot 'data'
New-Item -ItemType Directory -Path $canvasData -Force | Out-Null
$canvasUrl = 'http://127.0.0.1:47832/'
$canvasAvailable = $false
try {
  $canvasResponse = Invoke-RestMethod -Uri ($canvasUrl + 'api/state') -TimeoutSec 2
  $canvasAvailable = ($canvasResponse.runtime.version -eq '0.1.2')
} catch {}
if (-not $canvasAvailable) {
  $env:BRANCH_CANVAS_DB = Join-Path $canvasData 'canvas.sqlite'
  $canvasProcess = Start-Process -FilePath $canvasNode -ArgumentList @('"' + $canvasEntry + '"') -WorkingDirectory $canvasRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $canvasData 'server.log') -RedirectStandardError (Join-Path $canvasData 'server-error.log')
  @{ pid = $canvasProcess.Id; entry = $canvasEntry } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $canvasData 'server.json') -Encoding UTF8
  for ($canvasAttempt = 0; $canvasAttempt -lt 25; $canvasAttempt++) {
    Start-Sleep -Milliseconds 200
    try { $canvasResponse = Invoke-RestMethod -Uri ($canvasUrl + 'api/state') -TimeoutSec 1; if ($canvasResponse.runtime.version -eq '0.1.2') { $canvasAvailable = $true; break } } catch {}
    if ($canvasProcess.HasExited) { break }
  }
  if (-not $canvasAvailable) { throw ('Unable to start. See ' + (Join-Path $canvasData 'server-error.log')) }
}
Start-Process $canvasUrl
