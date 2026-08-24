# llama-guard

Anti-loop tooling for local llama-server setups (MoE/MTP GGUF models ≤35B,
Q4_K_M-class quants). Zero dependencies — plain Node ≥20 + PowerShell.

## The problem it addresses

| Symptom | Guard's lever |
|---|---|
| Verbatim repetition loops | Detection now; conservative auto-retry later (data-gated) |
| Post-compaction collapse | Strike correlation with message-count collapses → tells you when compaction is the culprit |
| Genuine hallucinations | **Out of scope** — only bigger/better quantized models fix that |

## Architecture

```
agent CLI ──▶ guard-proxy (:11435) ──▶ llama-server (:8080)
                 │ taps responses (streaming included), forwards untouched
                 └─ verbatim-block recurrence ≥6× in final 2KB → STRIKE
                    + post-compaction tag when message count collapsed
```

Monitor-first by design: v1 changes nothing about responses. Auto-retry
(non-streaming only) is a future tier gated on real strike data.

## Usage

### Set-and-forget (installed)

One-time wiring (already done on the authoring machine):
- agent CLI baseURL points at `http://127.0.0.1:11435` instead of `:8080`
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LlamaGuard.cmd`
  launches `run-guard.ps1` hidden at every logon; it self-heals (respawns
  node after crashes) and refuses duplicate instances

Daily routine afterwards: start llama-server however you always do,
launch Claude — the guard is already resident between them.
Strikes land in `llama-guard\loop-strikes.jsonl`.

Remove: delete that Startup .cmd + stop the node process on :11435.

### Manual windows

```powershell
# 1. tuned server (flags chosen for MoE/MTP Q4_K_M — see file comments)
.\llama-guard\tuned-launch.ps1 -ModelPath D:\models\YourModel-Q4_K_M.gguf

# 2. the tap
$env:UPSTREAM = "http://127.0.0.1:8080"
$env:GUARD_PORT = 11435
node llama-guard\guard-proxy.mjs

# 3. point your agent CLI at the tap instead of the raw server:
#    baseURL = http://127.0.0.1:11435/v1
```

Verify detection any time:

```powershell
node llama-guard/smoke-test.mjs   # 9 assertions, mock looping upstream
```

## Reading `loop-strikes.jsonl`

Each line: `ts, kind (json|stream), model, messageCount, suspectedPostCompaction,
count, blockLen, snippet`. What to look for:

- **strikes per session** — baseline loop rate before/after flag changes
- **`suspectedPostCompaction: true`** clusters → your compaction strategy is
  the trigger; compact manually at task boundaries instead
- **model field** — compare quants/models directly under identical traffic

## Compaction hygiene checklist (the non-code half of the fix)

1. Disable auto-compact; compact manually at task boundaries only
2. After every compaction, re-anchor: system role + current goal + done/todo
3. Keep tool definitions identical across the boundary — models invent calls
   for tools that vanish
4. Split marathon jobs into fresh sessions rather than one long compacted run
5. Quant floor for agentic use: Q4_K_M minimum; Q5_K_M/Q6_K if RAM allows

## Tuning notes (why those launcher flags)

- `--repeat-penalty 1.07` is deliberately GENTLE — 1.15+ visibly degrades
  small-activation MoE output; DRY sampling handles loops instead
- `-ctk/-ctv q8_0` + `--flash-attn` ≈ doubles affordable context per GB
- `--no-context-shift` converts silent context amputation into a visible error
- MTP draft layers in mainline GGUFs are ignored by llama.cpp; don't add
  draft-model flags unless deliberately running a matched draft
