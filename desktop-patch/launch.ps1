param([switch]$CheckOnly, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$canvasOriginalApp = '__ORIGINAL_APP__'
$canvasCopyApp = Join-Path $PSScriptRoot 'app'
$canvasOriginalExe = Join-Path $canvasOriginalApp 'ChatGPT.exe'
$canvasCopyExe = Join-Path $canvasCopyApp 'ChatGPT.exe'
$canvasProfile = Join-Path $PSScriptRoot 'desktop-profile'
$canvasLog = Join-Path $PSScriptRoot 'launch-status.json'
$canvasRuntimeStatus = Join-Path $canvasCopyApp 'resources\branch-canvas-native-status.json'
$canvasRunning = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $canvasCopyExe })
$canvasStatus = [ordered]@{
  checkedAt = [DateTime]::UtcNow.ToString('o')
  expectedExecutable = $canvasCopyExe
  profile = $canvasProfile
  copyProcessIds = @($canvasRunning | ForEach-Object { $_.Id })
  originalRunning = @((Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $canvasOriginalExe })).Count -gt 0
  isolatedProfile = $true
}
if ($CheckOnly) {
  if (Test-Path -LiteralPath $canvasRuntimeStatus) { $canvasStatus.runtime = Get-Content -LiteralPath $canvasRuntimeStatus -Raw | ConvertFrom-Json }
  $canvasStatus | ConvertTo-Json -Depth 6
  exit 0
}
if (-not (Test-Path -LiteralPath (Join-Path $canvasCopyApp 'resources\app.asar'))) { throw '实验副本不完整，请重新准备。' }
if ($canvasRunning.Count -gt 0) {
  if ($SelfTest) { throw '实验窗口正在运行。请关闭实验版后再执行无窗口诊断，原版可以保持打开。' }
  $canvasExisting = Get-Content -LiteralPath $canvasRuntimeStatus -Raw | ConvertFrom-Json
  if ($canvasExisting.executablePath -ne $canvasCopyExe -or $canvasExisting.userDataPath -ne $canvasProfile -or -not $canvasExisting.ipcRegistered) { throw '已有实验进程的配置无法验证，请先关闭该实验窗口。' }
  $canvasPreviousProfile = [Environment]::GetEnvironmentVariable('CODEX_ELECTRON_USER_DATA_PATH', 'Process')
  try {
    $env:CODEX_ELECTRON_USER_DATA_PATH = $canvasProfile
    Start-Process -FilePath $canvasCopyExe -ArgumentList @('--user-data-dir="' + $canvasProfile + '"') -WorkingDirectory $canvasCopyApp
  } finally { [Environment]::SetEnvironmentVariable('CODEX_ELECTRON_USER_DATA_PATH', $canvasPreviousProfile, 'Process') }
  Write-Host 'Branch Canvas 实验版已经运行。请切换到标题含有“Branch Canvas 实验版”的窗口。'
  exit 0
}
$canvasLaunchId = [Guid]::NewGuid().ToString()
$canvasArguments = @(('--user-data-dir="' + $canvasProfile + '"'), ('--branch-canvas-launch-id=' + $canvasLaunchId))
if ($SelfTest) { $canvasArguments += @('--no-startup-window', '--branch-canvas-native-self-test') }
$canvasPreviousProfile = [Environment]::GetEnvironmentVariable('CODEX_ELECTRON_USER_DATA_PATH', 'Process')
try {
  # Isolate both Chromium and desktop single-instance state before startup.
  $env:CODEX_ELECTRON_USER_DATA_PATH = $canvasProfile
  $canvasStartOptions = @{ FilePath = $canvasCopyExe; ArgumentList = $canvasArguments; WorkingDirectory = $canvasCopyApp; PassThru = $true; RedirectStandardOutput = (Join-Path $PSScriptRoot 'desktop-stdout.log'); RedirectStandardError = (Join-Path $PSScriptRoot 'desktop-stderr.log') }
  if ($SelfTest) { $canvasStartOptions.WindowStyle = 'Hidden' }
  $canvasProcess = Start-Process @canvasStartOptions
  $canvasProcess.Handle | Out-Null
} finally {
  [Environment]::SetEnvironmentVariable('CODEX_ELECTRON_USER_DATA_PATH', $canvasPreviousProfile, 'Process')
}
$canvasStatus.launchId = $canvasLaunchId
$canvasStatus.startedPid = $canvasProcess.Id
$canvasDeadline = [DateTime]::UtcNow.AddSeconds(25)
$canvasLoaded = $false
do {
  if (Test-Path -LiteralPath $canvasRuntimeStatus) {
    try {
      $canvasRuntime = Get-Content -LiteralPath $canvasRuntimeStatus -Raw | ConvertFrom-Json
      if ($canvasRuntime.launchId -eq $canvasLaunchId -and $canvasRuntime.executablePath -eq $canvasCopyExe -and $canvasRuntime.ipcRegistered) {
        $canvasStatus.runtime = $canvasRuntime
        $canvasLoaded = $true
        break
      }
    } catch { }
  }
  $canvasProcess.Refresh()
  if ($canvasProcess.HasExited) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $canvasDeadline)
$canvasProcess.Refresh()
$canvasStatus.nativePatchLoaded = $canvasLoaded
$canvasStatus.processExited = $canvasProcess.HasExited
if ($canvasProcess.HasExited) { $canvasStatus.exitCode = $canvasProcess.ExitCode }
$canvasStatus | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $canvasLog -Encoding UTF8
if (-not $canvasLoaded) { throw '未检测到实验补丁加载。请查看同目录的 launch-status.json 和 desktop-stderr.log；启动器没有把原版窗口当成成功。' }
if ($SelfTest) {
  if (-not $canvasProcess.WaitForExit(30000)) { throw '无窗口诊断未在时限内结束，请查看诊断记录。' }
  $canvasSelfTest = Get-Content -LiteralPath (Join-Path $canvasCopyApp 'resources\branch-canvas-native-self-test.json') -Raw | ConvertFrom-Json
  $canvasStatus.processExited = $true
  $canvasStatus.exitCode = $canvasProcess.ExitCode
  $canvasStatus.selfTest = $canvasSelfTest
  $canvasStatus | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $canvasLog -Encoding UTF8
  if (($null -ne $canvasProcess.ExitCode -and $canvasProcess.ExitCode -ne 0) -or $canvasSelfTest.launchId -ne $canvasLaunchId -or -not $canvasSelfTest.installedPluginConnected) { throw '实验运行时已加载，但后台诊断失败。请查看 app/resources/branch-canvas-native-self-test.json。' }
  Write-Host '实验版无窗口启动与插件连接诊断通过。此检查不代表界面验收完成。'
  exit 0
}
if (-not $SelfTest -and $canvasProcess.HasExited) { throw '实验版已提前退出，请查看同目录的诊断记录。' }
Write-Host '已确认启动 Branch Canvas 实验版。窗口标题含“Branch Canvas 实验版”。打开本机聊天的摘要即可选择对话树。'
