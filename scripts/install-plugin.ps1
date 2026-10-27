$ErrorActionPreference = 'Stop'
$canvasRoot = Split-Path -Parent $PSScriptRoot
Get-Command node -ErrorAction Stop | Out-Null
Get-Command codex -ErrorAction Stop | Out-Null
$canvasMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($canvasMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $canvasRoot 'dist/mcp.mjs'))) { throw 'The built plugin is missing. Download the release ZIP or run npm ci and npm run build.' }
& codex plugin marketplace add $canvasRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not register the local plugin marketplace.' }
& codex plugin add codex-branch-canvas@branch-canvas-local
if ($LASTEXITCODE -ne 0) { throw 'Could not install Branch Canvas.' }
Write-Host 'Branch Canvas installed. Reopen Codex, then open a chat and choose the right-side + menu > Conversation tree.'
