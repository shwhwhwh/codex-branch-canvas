$ErrorActionPreference = 'Stop'
$canvasRoot = Split-Path -Parent $PSScriptRoot
$canvasRecordPath = Join-Path $canvasRoot 'data\server.json'
if (-not (Test-Path -LiteralPath $canvasRecordPath)) { Write-Output 'No background process was recorded.'; exit 0 }
$canvasRecord = Get-Content -LiteralPath $canvasRecordPath -Raw | ConvertFrom-Json
$canvasExpectedEntry = [System.IO.Path]::GetFullPath((Join-Path $canvasRoot 'dist\http.mjs'))
$canvasProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$canvasRecord.pid) -ErrorAction SilentlyContinue
if ($canvasProcess) {
  if ($canvasRecord.entry -ne $canvasExpectedEntry -or $canvasProcess.CommandLine -notlike ('*' + $canvasExpectedEntry + '*') -or [System.IO.Path]::GetFileName($canvasProcess.ExecutablePath) -ne 'node.exe') { throw 'The recorded process does not match this workspace. Nothing was stopped.' }
  Stop-Process -Id ([int]$canvasRecord.pid)
}
Remove-Item -LiteralPath $canvasRecordPath
Write-Output 'Branch Canvas stopped. Conversation history was preserved.'
