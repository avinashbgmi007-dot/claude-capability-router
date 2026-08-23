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

/** Split a prompt into intent segments (deterministic, order-preserving). */
export function splitIntents(prompt: string): string[] {
  const parts = prompt
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(LEAD_TRIM_RE, "").replace(TRAIL_TRIM_RE, "").trim())
    .filter(Boolean);
  return parts;
}
