$ErrorActionPreference = 'Stop'
$canvasRoot = Split-Path -Parent $PSScriptRoot
Get-Command node -ErrorAction Stop | Out-Null
Get-Command codex -ErrorAction Stop | Out-Null
$canvasMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($canvasMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
$canvasRequiredFiles = @(
  'plugin.json', 'mcp.json', '.agents/plugins/marketplace.json',
  'dist/mcp.mjs', 'dist/worker.mjs', 'dist/mcp-app.html'
)
$canvasMissingFiles = @($canvasRequiredFiles | Where-Object {
  -not (Test-Path -LiteralPath (Join-Path $canvasRoot $_) -PathType Leaf)
})
if ($canvasMissingFiles.Count) {
  throw "Incomplete Branch Canvas package. Missing: $($canvasMissingFiles -join ', '). Download the Windows ZIP under GitHub Releases, or build the source with npm ci and npm run build."
}
& node -e "require('node:sqlite')"
if ($LASTEXITCODE -ne 0) { throw 'This Node.js build cannot load node:sqlite. Install the regular Windows Node.js 24+ distribution.' }
& codex plugin marketplace add $canvasRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not register the local plugin marketplace.' }
& codex plugin add codex-branch-canvas@branch-canvas-local
if ($LASTEXITCODE -ne 0) { throw 'Could not install Branch Canvas.' }
Write-Host 'Branch Canvas installed. Reopen Codex, then open a chat and choose the right-side + menu > Conversation tree.'
