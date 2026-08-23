# Claude Capability Manager — Pre-Implementation Review

**Goal of this review:** maximize the impact of the implementation against the actual problem:
*"I have many skills/agents/plugins/MCPs; at runtime I'm overwhelmed and don't know which one to pick. Prompts should have their intent boosted, not lost."*

**Basis:** System Architecture (v2), Technical Design, PRD — all marked "release candidate / final verification."
**Verdict in one line:** the engineering skeleton is right; the product scope as specified solves only ~20–30% of your stated problem.

---

## 1. Executive Verdict

The docs are roughly 80% engineering hygiene (installer, packaging, freeze gates, failure model) and 20% product. Everything they optimized for — pass-through safety, idempotent install, deterministic core, clean builds — is correct and should stay.

But against *your* problem, v1 as specified has three fatal gaps:

1. **It routes to almost nothing you own.** V1 explicitly excludes plugins, plugin skills/agents, and `.mcp.json` — and never even enumerates the concrete sources it *does* support. Your overwhelm comes precisely from those sources.
2. **It can't judge "which one to pick" semantically.** Keyword-overlap + fixed weights + alphabetical tiebreak fails on synonyms, cross-language prompts, and compound intents — the everyday reality of real prompts.
3. **It never learns.** No outcome tracking, no override memory, no feedback. A static scorer plateaus; it cannot approach high accuracy on *your* prompts.

The docs are also one verification away from **freezing** this scope. Freezing now would freeze the wrong thing: a router with almost no relevant capabilities to route to, an unmeasurable impact claim, and no learning mechanism.

---

## 2. What to KEEP (it's genuinely good)

- `UserPromptSubmit` hook integration; wrapper → installed-runtime resolution
- Pass-through as a first-class outcome; all failures degrade safely
- Deterministic core; no daemon / polling / watcher; local-first privacy
- Idempotent installer; boundary-safe cleanup; clean production payload
- Original prompt preserved verbatim

---

## 3. Gap Analysis vs. Your Problem

| Your pain point | What v1 does today | What's missing | Impact if fixed |
|---|---|---|---|
| Overwhelmed by many skills/agents/plugins/MCPs | Discovers "supported global/workspace sources" — a contract that is **never written down anywhere in the three docs**; plugins/MCPs explicitly out of scope | A concrete discovery contract covering the sources you actually own | ~35% |
| Don't know which one to pick | Weighted keyword-overlap scorer + fixed weights + alphabetical tiebreak | Semantics (synonyms, cross-language, paraphrase), confidence thresholds, ambiguity handling | ~25% |
| Overwhelm recurs every session | One-shot static routing | Outcome/usage feedback, learning, override memory | ~15% |
| Intent lost / needs boosting | Appends a metadata template; original preserved | Intent restatement, constraint extraction, capability **invocation syntax**, token budget, selection rationale | ~15% |
| Trust / control | Black box returns an `ExecutionRequest` | Explain mode, per-capability config, overrides | ~5–10% |

---

## 4. ADD — P0 (before launch; ~75% of the impact)

### P0-1. Define and implement the real discovery contract

The single biggest lever. The docs reference a "v1 discovery contract" but never define it, while the plugin boundary excludes the exact sources that overwhelm you.

Proposed contract (concrete, testable):

| Source | Location | Kind | Metadata source |
|---|---|---|---|
| Personal skills | `~/.claude/skills/**/SKILL.md` | skill | YAML frontmatter |
| Project skills | `.claude/skills/**/SKILL.md` | skill | YAML frontmatter |
| Personal agents | `~/.claude/agents/*.md` | agent | frontmatter (name/description/tools) |
| Project agents | `.claude/agents/*.md` | agent | frontmatter |
| Plugin skills/agents | `~/.claude/plugins/*/plugin-root/skills`, `/agents` | plugin-skill / plugin-agent | SKILL.md frontmatter + plugin manifest |
| MCP servers | `.mcp.json` + `~/.claude.json` → `mcpServers` | mcp-server (+ top tools) | server config + tool name/description |

**Key metadata addition: `invocation`** — the exact syntax the model must emit to trigger the capability (skill id, agent name, plugin command, MCP tool call). Without it, the model still doesn't know how to "pick" — it only knows *that* something exists.

If plugin/MCP discovery genuinely cannot make v1, ship v1 with the sources you do own — but the roadmap must lead here, and the product must not pretend otherwise.

### P0-2. Build the eval harness — "99.19%" becomes measurable

Without a golden corpus and metrics, impact is unfalsifiable.

- **Corpus:** 100–200 of *your* real prompts, labeled with the correct capability (or "pass-through")
- **Metrics:** accuracy@1, accuracy@3, pass-through precision (casual chat must NOT route), false-negative rate (routable prompts MUST route)
- **CI regression gate:** every resolver/detector change re-runs the corpus
- **Baseline first:** measure the current scorer against the corpus before changing anything — expect <50%. That number is your "before."

### P0-3. Outcome feedback loop (local, append-only, no daemon)

"Execution-result-aware retries" is correctly a non-goal (routing ≠ execution). But *outcome-aware ranking* is missing entirely:

- Log on `UserPromptSubmit`: prompt hash, selected capability, score, ambiguity flag
- Log on `ToolUse`/`SessionEnd`: which capability was actually invoked; user override if they steered elsewhere
- Feed the log into: recency + success ranking boost; detector false-negative discovery ("this routed prompt never used anything" / "this pass-through should have routed"); slow weight drift

This is the compounding mechanism that takes you from ~90% to ~99%.

### P0-4. Ambiguity handling (flip one non-goal)

The "no progressive clarification" non-goal blocks the exact UX that kills overwhelm. A hook can't block for an interactive question — but it can return `{ ambiguous: true, candidates: [A, B] }` and let the enhanced prompt present a one-line choice. When the top-2 scores fall within a confidence band, don't silently pick.

---

## 5. ADD — P1 (high value; ~20% impact)

### P1-5. Resolver upgrade

- **Normalization:** lowercase, stemming, synonym expansion, cross-language pairs (your prompts won't always match English metadata)
- **Pluggable scorer interface;** weights configurable; scores normalized to a confidence value
- **Confidence bands:** high → route; mid → enhance with rationale; low → ambiguity or pass-through (never alphabetical tiebreak)
- **Optional LLM-assisted rerank** only when confidence is low *and* the user opts in — deterministic remains the default, preserving the invariants as defaults rather than absolutes

### P1-6. Intent-boosting prompt enhancement

Current design = metadata dump. The goal = "intent boosted, not lost." The enhanced block should contain:

1. One-line intent restatement (proves the system understood)
2. Extracted constraints / implicit requirements made explicit
3. The selected capability's **invocation syntax**
4. Top-3 alternatives + one-line rationale each (transparency kills overwhelm)
5. A token budget (~200–400 max); inject only the fields that matched
6. Frame the block as routing context (e.g. `<capability-routing>…</capability-routing>`), not user speech — so the model never mistakes injected text for user requirements

### P1-7. Config, control, and explainability

- `~/.claude-cmr/config.json`: per-capability enable/disable, exclusions, weight overrides, confidence threshold, rationale verbosity
- Force-route escape hatch (`@cmr` prefix or `/cmr` slash command)
- `cmr explain <prompt>` — scoring breakdown for any prompt (also the debug tool for the eval corpus)

### P1-8. Multi-intent detection

Compound prompts ("extract from this PDF, then write it to Notion") — detect and return an ordered plan of capabilities instead of a single winner. Cheap once P0-1 exists.

### P1-9. Detector v2 — catalog-driven, not rule-stack

The "review code" pass-through regression is a symptom: rules accumulated by improvisation. Replace with a catalog (verb + domain phrase lists) + sensitivity config + metrics from P0-3. **False negatives are the worst failure mode** — the product becomes invisible and users uninstall it.

---

## 6. UPDATE (modify existing design)

| Item | From | To |
|---|---|---|
| Resolver | fixed weights, alphabetical tiebreak | configurable weights, confidence bands, pluggable scorers; no-match → pass-through / ambiguity |
| Prompt enhancer | metadata append | intent-boosting block (P1-6), token-budgeted, includes invocation syntax |
| ExecutionRequest | prompt + capability + enhancedPrompt | + selection rationale, ambiguity flag, candidate list, invocation plan |
| Non-goals | "no progressive clarification", "no plugin discovery", "no LLM/embeddings" | ambiguity surfaced in the request (not blocking); plugin/MCP discovery as v1.5 with contract defined now; no-LLM as default-with-opt-in |
| Freeze gate | freeze whole v1 | freeze the skeleton only; discovery/resolver/enhancer stay open until eval gates pass |

---

## 7. DELETE / de-emphasize

- **Installer/packaging/freeze ceremony as the definition of done** — ~30% of doc weight, ~5% of impact. Keep it minimal; it's hygiene, not product.
- **Fixed-weight scorer as the only scoring mechanism** — one scorer in a chain, not the whole story.
- **"No LLM/embeddings" as an absolute invariant** — make it the default with an opt-in extension; an invariants list shouldn't forbid the future.
- **Rule-stack detector patches** — replaced by catalog + metrics.
- **Unused metadata fields** — carry only the fields the resolver/enhancer consume (context budget matters).

---

## 8. Where the 99.19% comes from (draft allocation)

| Lever | Share | Rationale |
|---|---|---|
| Discovery of real sources (plugins/MCP/agents) | ~35% | no capabilities → no routing |
| Resolver semantics + ambiguity handling | ~25% | the actual "which one" decision |
| Outcome feedback loop | ~15% | compounds toward the tail |
| Prompt enhancement (invocation + intent) | ~15% | turns selection into action |
| Detector precision/recall | ~5% | gate quality |
| Config / transparency / override | ~5% | trust and control |

**Honest caveat:** "99.19%" must be defined before it can be reached. Proposed definition: accuracy@1 ≥ 90% on the golden corpus, pass-through precision ≥ 99%, zero false negatives on routable prompts, override rate < 10%. The last few percent cost exponentially — land 90–95% measurable first, then let the feedback loop close the tail.

---

## 9. Recommended Implementation Order

1. **Phase 0 (design, 1–2 days):** write the discovery contract; collect 100–200 real prompts into the golden corpus
2. **Phase 1:** implement discovery + eval harness; measure the baseline
3. **Phase 2:** resolver normalization + confidence + ambiguity; re-measure
4. **Phase 3:** feedback loop; re-measure; tune the detector
5. **Phase 4:** enhancement upgrade + config / explain / override UX
6. Freeze only after the eval gates pass — freeze the skeleton, not the scope

---

## 10. Questions Only You Can Answer

1. Which sources do you actually own in volume — plugins, MCP servers, agents, or skills? (Sets P0-1 priority.)
2. Is opt-in LLM disambiguation acceptable for low-confidence cases, or must routing stay 100% deterministic?
3. What does "99.19%" mean for you — accuracy@1, zero false negatives, override rate?
4. Is one primary capability enough, or do you need multi-capability plans?
