/**
 * Deterministic capability scorer.
 *
 * Per-field match = max(queryPrecision, fieldRecall) — the strongest evidence
 * either direction. Confidence = 0.85 * weighted field sum + 0.15 * strongest
 * field, scaled by per-capability weight, capped at 1.0.
 *
 * Ranking: confidence desc, id asc (deterministic).
 */
import { tokenize } from "./normalization.js";
import type { CapabilityIndexEntry, FieldScores, RouterConfig, ScoredCapability } from "./types.js";

export type Weights = RouterConfig["weights"];

/**
 * Field-recall damping: a verbose capability description that happens to
 * contain many query words must not score as high as a genuine query match.
 * max(queryPrecision, dampedFieldRecall) keeps precision dominant.
 */
const FIELD_RECALL_DAMP = 0.75;

function tokenMatch(q: string, f: string): boolean {
  if (q === f) return true;
  if (q.length >= 4 && f.startsWith(q)) return true;
  if (f.length >= 4 && q.startsWith(f)) return true;
  return false;
}

function fieldMatch(queryTokens: string[], fieldTokens: string[]): number {
  if (queryTokens.length === 0 || fieldTokens.length === 0) return 0;
  let qMatched = 0;
  for (const q of queryTokens) if (fieldTokens.some((f) => tokenMatch(q, f))) qMatched++;
  let fMatched = 0;
  for (const f of fieldTokens) if (queryTokens.some((q) => tokenMatch(q, f))) fMatched++;
  return Math.max(qMatched / queryTokens.length, (fMatched / fieldTokens.length) * FIELD_RECALL_DAMP);
}

export function scoreCapability(
  queryTokens: string[],
  entry: CapabilityIndexEntry,
  weights: Weights,
): ScoredCapability {
  const purpose = fieldMatch(queryTokens, tokenize(entry.purpose));
  const actions = fieldMatch(queryTokens, entry.actions.flatMap((a) => tokenize(a)));
  const domains = fieldMatch(queryTokens, entry.domains.flatMap((d) => tokenize(d)));
  const examples = fieldMatch(queryTokens, entry.examples.flatMap((e) => tokenize(e)));
  const description = fieldMatch(queryTokens, tokenize(entry.description));
  const name = fieldMatch(queryTokens, tokenize(entry.name));
  const body = fieldMatch(queryTokens, tokenize(entry.body));

  const weighted =
    weights.purpose * purpose +
    weights.actions * actions +
    weights.domains * domains +
    weights.examples * examples +
    weights.description * description +
    weights.name * name +
    weights.body * body;

  const maxField = Math.max(purpose, actions, domains, examples, description, name, body);
  const confidence = Math.min(1, (0.85 * weighted + 0.15 * maxField) * entry.weight);

  const fieldScores: FieldScores = { purpose, actions, domains, examples, description, name, body };
  return { entry, confidence, fieldScores };
}

export function rankCapabilities(
  queryTokens: string[],
  entries: CapabilityIndexEntry[],
  weights: Weights,
): ScoredCapability[] {
  return entries
    .filter((e) => e.enabled)
    .map((e) => scoreCapability(queryTokens, e, weights))
    .sort((a, b) => b.confidence - a.confidence || (a.entry.id < b.entry.id ? -1 : 1));
}
