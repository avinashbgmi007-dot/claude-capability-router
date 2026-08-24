<#
.SYNOPSIS
  Tuned llama-server launcher for MoE/MTP Q4_K_M models <=35B.

.DESCRIPTION
  Every flag is chosen for the local-loop problem:
    - big context with quantized KV cache (compaction is the enemy)
    - no silent context shift (fail loudly instead of amputating memory)
    - DRY sampling as the primary verbatim-loop killer
    - GENTLE repeat-penalty: aggressive values wreck MoE output quality;
      let DRY handle loops instead

.EXAMPLE
  .\tuned-launch.ps1 -ModelPath D:\models\Qwen3-30B-A3B-Q4_K_M.gguf
  .\tuned-launch.ps1 -ModelPath .\model.gguf -CtxSize 65536 -Port 8080

.NOTES
  MTP weights: mainline llama.cpp ignores multi-token-prediction draft
  layers in the main GGUF — do NOT add draft-model flags unless you are
  deliberately running a matching draft model.
#>
param(
  [Parameter(Mandatory = $true)][string]$ModelPath,
  [int]$CtxSize = 32768,
  [int]$Port = 8080,
  [int]$Parallel = 1,
  [string]$LlamaServer = "llama-server",
  [Parameter(ValueFromRemainingArguments = [string[]])]$Rest
)

$args = @(
  "-m", $ModelPath,
  "-c", $CtxSize,
  "--port", $Port,
  "-np", $Parallel,

  # ---- context longevity: the anti-compaction block ----
  "--flash-attn",
  "-ctk", "q8_0",          # KV cache quantization: ~2x context per GB of RAM
  "-ctv", "q8_0",
  "--no-context-shift",     # refuse to silently truncate history

  # ---- sampling: loop suppression without quality loss ----
  "--temp", "0.7",
  "--min-p", "0.05",        # min_p beats top_p on small-activation MoEs
  "--top-k", "20",
  "--repeat-penalty", "1.07",   # GENTLE — 1.15+ degrades MoE prose/code
  "--repeat-last-n", "512",
  "--dry-multiplier", "0.8",    # primary verbatim-loop killer
  "--dry-base", "1.75",
  "--dry-allowed-length", "2",

  # ---- chat/template correctness (tool calls depend on this) ----
  "--jinja"
)
if ($Rest) { $args += $Rest }

Write-Host "Starting llama-server (MoE/MTP-tuned): $ModelPath"
Write-Host "Context=$CtxSize port=$Port parallel=$Parallel"
Write-Host "Next: start guard-proxy, then point your agent CLI at http://127.0.0.1:<guard-port>/v1"

& $LlamaServer @args
