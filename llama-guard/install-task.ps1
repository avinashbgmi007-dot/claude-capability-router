<#
.SYNOPSIS
  One-time install: registers "LlamaGuard" scheduled task so the guard
  proxy starts hidden at every logon and self-heals if it dies.

.EXAMPLE
  .\install-task.ps1           # register (idempotent)
  .\install-task.ps1 -Remove   # unregister + kill any running instance

After installing, your daily routine is unchanged:
  start llama-server however you always do -> launch Claude -> done.
The guard is already sitting on :11435 in the background.
#>
param([switch]$Remove)

$taskName = "LlamaGuard"
$guardDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match "guard-proxy" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Host "LlamaGuard task removed; any running guard instance stopped."
  exit 0
}

$runner = Join-Path $guardDir "run-guard.ps1"
$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
            -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Anti-loop tap for local llama-server" -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "LlamaGuard installed and LISTENING on :11435"
} else {
  Write-Host "LlamaGuard installed but not listening yet - check Task Scheduler"
}
