/**
 * Router — deterministic resolution layer between user prompt and capabilities.
 * - single intent → 1-step plan
 * - compound intent → ordered multi-step plan (each step: primary + fallbacks)
 * - confidence below τ (or < MIN_ROUTE_TOKENS) → safe pass-through
 */
import { discoverAll, indexById, scanFingerprint } from "./discovery.js";
import { updateIndex, loadIndex } from "./index-store.js";
import { fingerprintJson } from "./fingerprint.js";
import { loadUsageLog, computeUsageScores } from "./logs.js";
import { normalizeTokens, extractMainClause } from "./normalization.js";
import { rankCapabilities, type Weights } from "./scorer.js";
import { splitIntents } from "./planner.js";
import { classifyDomain } from "./domains.js";
import type { DiscoveryRoots } from "./paths.js";
import { stateDir } from "./paths.js";
import type { CapabilityIndexEntry, ExecutionRequest, PlanStep, RouterConfig, ScoredCapability } from "./types.js";

/** Minimum intent tokens required before routing (1-token queries are too weak). */
const MIN_ROUTE_TOKENS = 2;

/** Confidence recorded on domain-fallback routes. Fixed: it competes with
    nothing (the domain pass runs only after specialist silence) and exists
    so downstream tooling sees a stable, distinctly-flagged route class. */
const DOMAIN_CONFIDENCE = 0.5;

export interface RouterOptions {
  config: RouterConfig;
  roots: DiscoveryRoots;
  stateDir?: string;
  /** pre-built entries (tests may inject) */
  entries?: CapabilityIndexEntry[];
  /** usage log dir; when set, recently-invoked capabilities get a weight boost */
  usageDir?: string;
}

export interface ExplainResult {
  prompt: string;
  tokens: string[];
  ranked: ScoredCapability[];
  decision: "route" | "pass-through";
  threshold: number;
}

export interface Router {
  route(prompt: string): ExecutionRequest;
  explain(prompt: string): ExplainResult;
  entries(): CapabilityIndexEntry[];
}

/** Score a single query against all entries → ranked candidates. */
export function scoreRoute(tokens: string[], entries: CapabilityIndexEntry[], weights: Weights): ScoredCapability[] {
  return rankCapabilities(tokens, entries, weights);
}

export function createRouter(opts: RouterOptions): Router {
  let entries: CapabilityIndexEntry[];
  if (opts.entries) {
    entries = opts.entries;
  } else {
    const sd = opts.stateDir ?? stateDir();
    const prev = loadIndex(sd);
    // short-circuit: same discovery roots + same config → reuse the persisted
    // index instead of re-walking and re-reading every capability source
    // (config is in the key so exclude/enable/weight changes still re-index).
    const scan = `${scanFingerprint(opts.roots)}|${fingerprintJson(opts.config)}`;
    if (prev.scan === scan) {
      entries = [...prev.entries.values()];
    } else {
      const discovered = discoverAll(opts.roots);
      const byId = indexById(discovered);
      const { index } = updateIndex([...byId.values()], prev, opts.config, sd, scan);
      entries = [...index.entries.values()];
    }
  }

  // usage feedback: boost capabilities actually invoked recently (ties break to habits)
  if (opts.usageDir) {
    const usage = loadUsageLog(opts.usageDir);
    if (usage.length) {
      const scores = computeUsageScores(usage);
      entries = entries.map((e) => {
        const score = scores.get(e.id) ?? 0;
        // 1 fresh hit ≈ +0.5 weight, capped (confidence stays ≤ 1 via scorer)
        return score > 0 ? { ...e, weight: e.weight * (1 + 0.5 * Math.min(score, 1)) } : e;
      });
    }
  }

  /** Rank candidates for one segment; primary = top if confidence ≥ τ (or forced). */
  function routeSegment(segment: string, forced = false): { scored: ScoredCapability[]; primary: ScoredCapability | null; ambiguous: boolean } {
    const tokens = normalizeTokens(segment, opts.config);
    if (!forced && tokens.length < MIN_ROUTE_TOKENS) return { scored: [], primary: null, ambiguous: false };
    const scored = scoreRoute(tokens, entries, opts.config.weights);
    if (forced) {
      // escape hatch: user explicitly asked for routing — take the top candidate
      const primary = scored.length ? scored[0] : null;
      const ambiguous =
        !!primary && scored.length >= 2 && scored[0].confidence - scored[1].confidence < opts.config.ambiguityBand;
      return { scored, primary, ambiguous };
    }
    const primary = scored.length && scored[0].confidence >= opts.config.threshold ? scored[0] : null;
    // top-2 within the band → don't treat the pick as confident
    const ambiguous =
      !!primary && scored.length >= 2 && scored[0].confidence - scored[1].confidence < opts.config.ambiguityBand;
    return { scored, primary, ambiguous };
  }

  function buildStep(step: number, intent: string, scored: ScoredCapability[], primary: ScoredCapability | null, ambiguous: boolean): PlanStep {
    const s: PlanStep = { step, intent, primary, fallbacks: primary ? scored.slice(1, 3) : [] };
    if (ambiguous) s.ambiguous = true;
    return s;
  }

  const warnedGhosts = new Set<string>();

  /** DOMAIN PASS (fallback): specialist scoring stayed silent — suggest the
      user-appointed representative for the classified task domain. Never
      fires for forced routes (@cmr means "top-ranked, whatever it is"). */
  function tryDomainRoute(prompt: string): ExecutionRequest | null {
    const dr = opts.config.domainRouting;
    if (!dr?.enabled) return null;
    const domain = classifyDomain(prompt);
    if (domain === "chat") return null; // catch-all category: never represented
    const repId = dr.representatives[domain];
    if (!repId) return null;
    const entry = entries.find((e) => e.id === repId);
    if (!entry || !entry.enabled) {
      if (!warnedGhosts.has(repId)) {
        warnedGhosts.add(repId);
        console.error(`[domain-routing] representative "${repId}" (${domain}) not found/enabled in discovery index — skipping`);
      }
      return null;
    }
    const primary: ScoredCapability = {
      entry,
      confidence: DOMAIN_CONFIDENCE,
      fieldScores: { purpose: 0, actions: 0, domains: 0, examples: 0, description: 0, name: 0, body: 0 },
    };
    const step: PlanStep = { step: 1, intent: extractMainClause(prompt), primary, fallbacks: [], domainMatch: true };
    return {
      originalPrompt: prompt,
      routed: true,
      plan: [step],
      rationale: `domain-match: ${domain} -> ${repId}`,
    };
  }

  function routeSingleIntent(prompt: string, o: { scoreText?: string; forced?: boolean } = {}): ExecutionRequest {
    const forced = o.forced ?? false;
    const { scored, primary, ambiguous } = routeSegment(o.scoreText ?? prompt, forced);
    if (!primary) {
      // specialist silence → domain fallback (never on forced routes)
      if (!forced) {
        const dm = tryDomainRoute(prompt);
        if (dm) return dm;
      }
      return { originalPrompt: prompt, routed: false, plan: [] };
    }
    return {
      originalPrompt: prompt,
      routed: true,
      plan: [buildStep(1, extractMainClause(o.scoreText ?? prompt), scored, primary, ambiguous)],
      rationale: `${forced ? "forced via prefix — " : ""}routed to ${primary.entry.id} (confidence ${primary.confidence.toFixed(3)})`,
    };
  }

  function route(prompt: string): ExecutionRequest {
    // force-route escape hatch: leading prefix bypasses τ + MIN_ROUTE_TOKENS.
    // originalPrompt stays byte-identical (invariant) — only the working copy is stripped.
    const prefix = opts.config.forcePrefix;
    let forced = false;
    let working = prompt;
    if (prefix) {
      const trimmed = prompt.trimStart();
      if (trimmed.startsWith(prefix)) {
        forced = true;
        working = trimmed.slice(prefix.length).trim();
      }
    }
    const segments = splitIntents(working);
    if (segments.length < 2) {
      return forced ? routeSingleIntent(prompt, { scoreText: working, forced: true }) : routeSingleIntent(prompt);
    }

    const steps: PlanStep[] = [];
    let anyRouted = false;
    for (let i = 0; i < segments.length; i++) {
      const { scored, primary, ambiguous } = routeSegment(segments[i], forced);
      if (primary) anyRouted = true;
      steps.push(buildStep(i + 1, segments[i], scored, primary, ambiguous));
    }

    // all routed steps → same capability? collapse to a single intent
    const routedPrimaries = steps.filter((s) => s.primary).map((s) => s.primary!.entry.id);
    if (new Set(routedPrimaries).size <= 1) {
      return forced ? routeSingleIntent(prompt, { scoreText: working, forced: true }) : routeSingleIntent(prompt);
    }
    if (!anyRouted) return { originalPrompt: prompt, routed: false, plan: [] };

    const rationale = steps
      .filter((s) => s.primary)
      .map((s) => `${s.step}. ${s.primary!.entry.id} (${s.primary!.confidence.toFixed(3)})`)
      .join(" | ");
    return { originalPrompt: prompt, routed: true, plan: steps, rationale: `${forced ? "forced via prefix — " : ""}plan: ${rationale}` };
  }

  function explain(prompt: string): ExplainResult {
    const tokens = normalizeTokens(prompt, opts.config);
    const ranked = scoreRoute(tokens, entries, opts.config.weights);
    const primary = ranked.length && ranked[0].confidence >= opts.config.threshold ? ranked[0] : null;
    return {
      prompt,
      tokens,
      ranked: ranked.slice(0, 5),
      decision: primary ? "route" : "pass-through",
      threshold: opts.config.threshold,
    };
  }

  return { route, explain, entries: () => entries };
}
