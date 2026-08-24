# run-guard.ps1 — the payload the scheduled task executes.
# Sets absolute env config, guards against duplicate instances,
# and respawns the proxy if node ever exits.

$guardDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# already someone listening on our port? another instance is alive — stand down
$listening = Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

$env:UPSTREAM    = "http://127.0.0.1:8080"
$env:GUARD_PORT  = "11435"
$env:STRIKES_LOG = Join-Path $guardDir "loop-strikes.jsonl"

while ($true) {
  node (Join-Path $guardDir "guard-proxy.mjs")
  Start-Sleep -Seconds 5   # crashed/restarted llama-server window — come back
}
