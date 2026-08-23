/**
 * Compound-intent planner — deterministic segmentation of multi-capability prompts.
 *
 * Splits on connector patterns (and/then/and then/comma/semicolon + CJK
 * connectors), trims connector noise from segment edges, and lets the router
 * route each segment independently. Segments that all resolve to the same
 * primary are collapsed back into a single intent by the router.
 */
const SPLIT_RE = /\band\s+then\b|,\s*(?=\S)|;\s*|\band\b|\bthen\b|然后|并且|之后|接着/g;
const LEAD_TRIM_RE = /^(?:then|and|also|so|然后|并且|之后|接着)\s*/i;
const TRAIL_TRIM_RE = /\s*(?:first|asap|now)$/i;

/** Rough intent-worthiness: ascii words + CJK chars (dense — 发邮件 is an intent). */
function fragmentWeight(s: string): number {
  const cjkChars = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const asciiWords = s.replace(/[\u4e00-\u9fff]+/g, " ").split(/[^a-zA-Z0-9]+/).filter(Boolean).length;
  return asciiWords + cjkChars;
}

/**
 * Split a prompt into intent segments (deterministic, order-preserving).
 * Fragments with <2 word tokens (list items like "green" after a comma
 * split) are connector debris — folded back into their neighbour instead
 * of becoming fake plan steps.
 */
export function splitIntents(prompt: string): string[] {
  const parts = prompt
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(LEAD_TRIM_RE, "").replace(TRAIL_TRIM_RE, "").trim())
    .filter(Boolean);

  const kept: string[] = [];
  for (const p of parts) {
    if (kept.length && fragmentWeight(p) < 2) kept[kept.length - 1] += `, ${p}`;
    else kept.push(p);
  }
  // leading debris ("hi, summarize this pdf") folds forward instead
  if (kept.length >= 2 && fragmentWeight(kept[0]) < 2) {
    kept[1] = `${kept[0]}, ${kept[1]}`;
    kept.shift();
  }
  return kept;
}
