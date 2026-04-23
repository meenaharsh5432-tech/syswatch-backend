# SysWatch Agent Installer for Windows (PowerShell)
# Usage:
#   $env:SYSWATCH_URL="https://your-backend.com"; $env:AGENT_KEY="sk-agent-xxx"; iwr https://your-backend.com/install.ps1 | iex
param()

$ErrorActionPreference = 'Stop'

$SYSWATCH_URL  = if ($env:SYSWATCH_URL)  { $env:SYSWATCH_URL }  else { 'http://localhost:3001' }
$AGENT_KEY     = if ($env:AGENT_KEY)     { $env:AGENT_KEY }     else { '' }
$AGENT_NAME    = if ($env:AGENT_NAME)    { $env:AGENT_NAME }    else { $env:COMPUTERNAME }
$INTERVAL      = if ($env:INTERVAL)      { $env:INTERVAL }      else { '5000' }
$INSTALL_DIR   = "$env:USERPROFILE\.syswatch-agent"
$CONFIG_FILE   = "$env:USERPROFILE\.syswatch\config.ps1"

function log   { param($m) Write-Host "[SysWatch] $m" -ForegroundColor Green }
function warn  { param($m) Write-Host "[SysWatch] $m" -ForegroundColor Yellow }
function fatal { param($m) Write-Host "[SysWatch] ERROR: $m" -ForegroundColor Red; exit 1 }

if (-not $AGENT_KEY) {
    fatal "AGENT_KEY is required. Get it from your SysWatch dashboard when adding a server."
}

log "Installing SysWatch Agent..."
Write-Host "  Server name : $AGENT_NAME"    -ForegroundColor Cyan
Write-Host "  Backend URL : $SYSWATCH_URL"  -ForegroundColor Cyan

# ---- Node.js check ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    fatal "Node.js not found. Install Node.js >= 18 from https://nodejs.org and re-run."
}
$nodeVer = node --version
log "Node.js $nodeVer detected"

# ---- Create install dir ----
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null

# ---- Download agent.js ----
log "Downloading agent.js..."
try {
    Invoke-WebRequest -Uri "$SYSWATCH_URL/agent.js" -OutFile "$INSTALL_DIR\agent.js" -UseBasicParsing
} catch {
    fatal "Could not download agent.js from $SYSWATCH_URL/agent.js. Make sure the backend is reachable."
}

# ---- Install dependency ----
log "Installing systeminformation..."
Push-Location $INSTALL_DIR
if (-not (Test-Path "$INSTALL_DIR\package.json")) {
    '{"name":"syswatch-agent-runtime","version":"1.0.0","dependencies":{"systeminformation":"^5.22.11"}}' | Set-Content package.json
}
# Use npm.cmd explicitly — avoids execution policy blocking npm.ps1 on restricted systems
$npmCmdObj = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npmCmd = if ($npmCmdObj) { $npmCmdObj.Source } else { 'npm.cmd' }
& $npmCmd install --omit=dev --quiet
Pop-Location

# ---- Write config ----
New-Item -ItemType Directory -Force -Path (Split-Path $CONFIG_FILE) | Out-Null
@"
`$env:SYSWATCH_URL = "$SYSWATCH_URL"
`$env:AGENT_KEY    = "$AGENT_KEY"
`$env:AGENT_NAME   = "$AGENT_NAME"
`$env:INTERVAL     = "$INTERVAL"
"@ | Set-Content $CONFIG_FILE
log "Config written to $CONFIG_FILE"

# ---- Create startup wrapper ----
$runScript = "$INSTALL_DIR\run.ps1"
@"
. "$CONFIG_FILE"
node "$INSTALL_DIR\agent.js"
"@ | Set-Content $runScript

# ---- Register as Task Scheduler task (tries admin path, falls back to Startup folder) ----
$taskName   = "SysWatchAgent"
$psArgs     = "-NonInteractive -WindowStyle Hidden -File `"$runScript`""
$taskOk     = $false

try {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        warn "Replaced existing scheduled task."
    }

    $action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgs
    $trigger   = New-ScheduledTaskTrigger -AtLogOn
    $settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $taskOk = $true
} catch {
    warn "Task Scheduler registration failed ($($_.Exception.Message)). Falling back to Startup folder."
}

if (-not $taskOk) {
    # Startup folder — no admin required, runs at every login
    $startupDir = [Environment]::GetFolderPath('Startup')
    $vbsPath    = "$startupDir\SysWatchAgent.vbs"

    # VBScript wrapper runs the PS script hidden (no console window)
    @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NonInteractive -WindowStyle Hidden -File ""$runScript""", 0, False
"@ | Set-Content $vbsPath

    # Start it now too
    Start-Process "powershell.exe" -ArgumentList "-NonInteractive -WindowStyle Hidden -File `"$runScript`"" -WindowStyle Hidden
    $taskOk = $true

    log ""
    log "SysWatch Agent installed via Startup folder (no admin required)!"
    log ""
    Write-Host "  Auto-start: $vbsPath" -ForegroundColor Cyan
    Write-Host "  To remove : Delete $vbsPath" -ForegroundColor Cyan
} else {
    log ""
    log "SysWatch Agent installed and started!"
    log ""
    Write-Host "  Status : Get-ScheduledTask -TaskName SysWatchAgent"       -ForegroundColor Cyan
    Write-Host "  Stop   : Stop-ScheduledTask -TaskName SysWatchAgent"       -ForegroundColor Cyan
    Write-Host "  Remove : Unregister-ScheduledTask -TaskName SysWatchAgent" -ForegroundColor Cyan
}
