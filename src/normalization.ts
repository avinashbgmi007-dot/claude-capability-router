/**
 * Query normalization — deterministic text preparation before scoring.
 * 1. main-clause extraction (truncate at relative pronouns: that/which/who/whom/whose)
 * 2. tokenize (ascii words + CJK runs with bigrams)
 * 3. lowercase, stopword removal, single-char drop
 * 4. alias/synonym expansion (variant → canonical, incl. cross-language pairs)
 */
import type { RouterConfig } from "./types.js";

const CJK_RE = /[\u4e00-\u9fff]+/g;
const RELATIVE_CLAUSE_RE = /\b(that|which|who|whom|whose)\b/i;

/** Tokenize: ascii word chunks + CJK runs (plus bigrams of each run). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  let last = 0;
  for (const m of lower.matchAll(CJK_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(...lower.slice(last, idx).split(/[^a-z0-9]+/).filter(Boolean));
    const run = m[0];
    out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    last = idx + run.length;
  }
  if (last < lower.length) out.push(...lower.slice(last).split(/[^a-z0-9]+/).filter(Boolean));
  return out;
}

/** Main-clause extraction: drop subordinate clauses introduced by relative pronouns. */
export function extractMainClause(prompt: string): string {
  const m = prompt.match(RELATIVE_CLAUSE_RE);
  if (!m || m.index === undefined || m.index < 4) return prompt;
  return prompt.slice(0, m.index).trim();
}

/** Reverse alias lookup: variant → [canonical...]. */
export function buildAliasLookup(aliases: Record<string, string[]>): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const [canonical, variants] of Object.entries(aliases)) {
    for (const v of variants) {
      const arr = lookup.get(v) ?? [];
      arr.push(canonical);
      lookup.set(v, arr);
    }
  }
  return lookup;
}

/**
 * Full normalization → deduplicated token set.
 * Alias expansion REPLACES the raw token with its canonical form(s);
 * stopwords/single-char tokens are dropped after expansion.
 */
export function normalizeTokens(text: string, config: RouterConfig): string[] {
  const main = extractMainClause(text);
  const lookup = buildAliasLookup(config.aliases);
  const stop = new Set(config.stopwords);
  const out = new Set<string>();
  for (const t of tokenize(main)) {
    const canonicals = lookup.get(t);
    const candidates = canonicals && canonicals.length ? canonicals : [t];
    for (const c of candidates) {
      for (const tc of tokenize(c)) {
        if (stop.has(tc) || tc.length === 1) continue;
        out.add(tc);
      }
    }
  }
  return [...out];
}
