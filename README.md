# Claude Capability Manager (Capability Router v2)

A deterministic, hook-based capability router for Claude Code: it listens on the
`UserPromptSubmit` hook, detects actionable intent, discovers your capabilities
(skills, agents, Claude Code plugins, MCP servers), picks the best one (or an
ordered multi-capability plan), and injects a small `<capability-routing>`
context block so the model knows exactly which capability to invoke — without
touching your original prompt. Ordinary chat passes through untouched.

- **Zero runtime dependencies** (pure Node.js, no npm packages needed at runtime)
- **Deterministic** — same prompt + same capability index + same usage log = same decision
- **Local-first** — no daemon, no polling, no telemetry, no LLM for routing
- **Safe by design** — any failure degrades to pass-through; Claude Code never breaks

---

## Requirements

- Node.js **≥ 20** (check with `node -v`)

---

## Step-by-step install & run

### 1. Unzip the package

```bash
unzip capability-manager.zip
cd capability-manager
```

The zip ships with a prebuilt `dist/`, so you can install **immediately** —
no `npm install` needed for basic use.

### 2. Install the hook (idempotent)

```bash
npm run install:cr
```

This does four things:
1. copies the runtime + hook wrapper to `~/.claude-cmr/`
2. writes `~/.claude-cmr/.install-marker`
3. writes a default `~/.claude-cmr/config.json` (first run only)
4. registers `UserPromptSubmit` + `PreToolUse` hooks in
   `~/.claude/settings.json` (idempotent — unrelated hooks are preserved;
   running it twice adds nothing)

### 3. Verify the install

```bash
npm run validate
```

Every check should print `PASS`. If you see `FAIL hook registration`, open
`~/.claude/settings.json` and confirm the entry exists.

### 4. Try it live (simulate what Claude Code sends)

**PowerShell (Windows):**

```powershell
'{"prompt":"summarize this PDF into bullet points"}' | node "$env:USERPROFILE\.claude-cmr\hook-wrapper.mjs"
```

**bash / macOS / Linux:**

```bash
echo '{"prompt":"summarize this PDF into bullet points"}' | node ~/.claude-cmr/hook-wrapper.mjs
```

> Note: PowerShell does **not** expand `~` when passing arguments to `node`, so
> use `$env:USERPROFILE` (PowerShell) or `%USERPROFILE%` (cmd.exe) instead of `~`.

You should see a `<capability-routing>` block. A chat prompt returns `{}`:

```powershell
'{"prompt":"how is the weather today?"}' | node "$env:USERPROFILE\.claude-cmr\hook-wrapper.mjs"
# → {}
```

### 5. Restart Claude Code

Fully restart any running Claude Code session so it picks up the new hook.
From then on, every prompt is routed automatically. Check the log anytime:

```bash
cat ~/.claude-cmr/logs/decisions.jsonl
```

### 6. Uninstall (when you want to remove it)

```bash
npm run uninstall:cr
```

Removes the hook registration, runtime, and marker. Your `config.json`
tuning and logs are left in place.

---

## Optional: rebuild from source / run tests

```bash
npm install        # installs typescript + @types/node (dev only)
npm test           # 70 tests across all phases
node dist/eval/harness.js --routing   # corpus metrics (accuracy@1, FPR, FNR, …)
```

---

## Daily use

### Inspect why a prompt routed (or didn't)

```bash
npm run explain "extract tables from this PDF, then draft an email"
```

Windows users: run through PowerShell the same way — `npm run` handles the quoting. If you need the raw CLI: `node dist\src\cli.js explain "…"`.

Prints the normalized tokens, per-field scores for the top 5 capabilities,
the decision, and the enhanced block.

### Tune behavior — `~/.claude-cmr/config.json`

```json
{
  "threshold": 0.38,           // confidence needed to route (lower = more routing, more false positives)
  "ambiguityBand": 0.05,       // top-2 gap below this flags the step as ambiguous (not a confident pick)
  "weights": {                 // scoring weights (sum ≈ 1.0) — harness-tuned defaults
    "purpose": 0.3, "actions": 0.08, "domains": 0.06,
    "examples": 0.08, "description": 0.28, "name": 0.15, "body": 0.05
  },
  "aliases": { "twitter": ["x"] },   // variant → canonical (incl. cross-language)
  "exclude": ["skill:some-id"],      // never route to these capabilities
  "capabilities": { "skill:pdf-summarizer": { "enabled": false } },
  "verbosity": "brief",              // "full" adds rationale line to the block
  "tokenBudget": 300                 // max tokens in the injected block
}
```

Edit the file, then restart Claude Code. No reinstall needed.

### Force-route escape hatch

When routing wrongly passes through, prefix the prompt with `@cmr` to force
the top-ranked capability regardless of confidence:

```text
@cmr how's the weather today?
```

The original prompt is still delivered byte-identical; only the routing
decision changes (the rationale in `logs/decisions.jsonl` says "forced").
Configure or disable via `"forcePrefix": "@cmr"` in `config.json` (`""` disables).

### Usage feedback loop

Every capability actually invoked is recorded by the `PreToolUse` hook into
`logs/usage.jsonl`. The router reads it and boosts recently-used capabilities
(recency-halved every 7 days, capped at +0.5 weight), so ties break toward
your habits. `SessionEnd` is intentionally unused — a stateless hook can't
attribute a session's usage to a capability.

### Expand the evaluation corpus

Your real prompts belong in `eval/corpus.json` (label each with the correct
capability or `passThrough`). Grow it to 100–200 entries, then re-run
`node dist/eval/harness.js --routing` and tune `threshold`/`weights` until the
metrics hit your target (accuracy@1 ≥ 99%, false-positive rate ≈ 0).

`eval/config.json` holds the tuned weights/threshold the harness loads
automatically (it's what makes description-heavy skills like the ones in
`~/.agents/skills` routable — they carry no `actions`/`domains`/`examples`
frontmatter, so scoring leans on `purpose`/`description`/`name`). Set
`CLAUDE_CMR_HOME` to override it with your live `~/.claude-cmr/config.json`.

### Live verification loop

After installing, verify real behavior in three steps:

1. Restart Claude Code, then type the trigger prompts printed by the check tool
2. `npm run live:check` — install integrity + last-24h decisions + 7-day fidelity report (paste it back for analysis)
3. `npm run simulate` — compress a week of usage into seconds against a sandboxed home; proves the measurement machinery (obedience numbers are model assumptions, not reality)

`npm run bench` reports routing latency p50/p95 (in-process and end-to-end through the spawned wrapper).

---

## How it works

```
Claude Code ──UserPromptSubmit──▶ hook-wrapper.mjs (stdin JSON)
                                      │
                                      ▼
                              Capability Router
   detect → normalize → score (deterministic, τ threshold)
        │                                │
        ▼                                ▼
  chat / no match              single capability OR multi-step plan
        │                          (primary + ordered fallbacks)
        ▼                                ▼
   {} (pass-through)            <capability-routing> context block
                                      │
                                      ▼
                        Claude Code continues, enhanced
```

Capabilities are discovered from: `~/.claude/skills`, `.claude/skills`
(workspace), `~/.claude/agents`, `.claude/agents` (workspace),
`~/.claude/commands`, `.claude/commands` (workspace slash commands),
`~/.claude/plugins/*/plugin-root/{skills,agents,commands}`, `.mcp.json` and
`~/.claude.json` (`mcpServers`).

---

## Environment overrides (for testing / CI)

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CMR_HOME` | `~/.claude-cmr` | install root |
| `CLAUDE_SETTINGS_PATH` | `~/.claude/settings.json` | settings file to edit |
| `CLAUDE_CMR_HOME_DIR` | `$HOME` | global discovery root |
| `CLAUDE_CMR_WORKSPACE_DIR` | `process.cwd()` | workspace discovery root |

---

## Design docs

See `docs/` in this package: implementation review + decision-locked v1.5
blueprint (includes the full implementation status and measured results).
