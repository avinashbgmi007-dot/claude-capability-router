# run-guard.ps1 - payload for the Startup autostart entry.
# Sets absolute env config, waits out any lingering previous instance,
# then keeps the proxy alive (respawns node if it ever exits).

$guardDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$env:UPSTREAM    = "http://127.0.0.1:8080"
$env:GUARD_PORT  = "11435"
$env:STRIKES_LOG = Join-Path $guardDir "loop-strikes.jsonl"
$env:GUARD_SAMPLING_LOG = Join-Path $guardDir "sampling-observed.jsonl"

# grace-wait: a previous instance may take a moment to release :11435
# (e.g. mid-upgrade kill). Only stand down if it stays busy for 30s.
$deadline = (Get-Date).AddSeconds(30)
while (Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue) {
  if ((Get-Date) -gt $deadline) { exit 0 }
  Start-Sleep -Seconds 2
}

$respawnLog = Join-Path $env:TEMP "llamaguard-respawn.log"
while ($true) {
  Add-Content $respawnLog "$(Get-Date -Format o) guard starting"
  node (Join-Path $guardDir "guard-proxy.mjs")
  Add-Content $respawnLog "$(Get-Date -Format o) guard exited (code=$LASTEXITCODE) -- respawning"
  Start-Sleep -Seconds 5
}
