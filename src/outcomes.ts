/**
 * Outcome templates — the delivery bar for each task class, stated in the
 * enhanced prompt so quality expectations travel WITH the request instead of
 * being hoped for. Keyed by task-class (domain/subtype), independent of which
 * internal capability assists — the user's goal travels, whatever helps.
 *
 * Evaluated subjectively: wording iterates from real-task ratings, not telemetry.
 */

export const OUTCOME_TEMPLATES: Record<string, string> = {
  "code/generative":
    "Deliver a complete working implementation: write it, run it yourself or add " +
    "and execute a quick self-test, fix any bugs found until clean, then deliver " +
    "the final verified working version.",
  "code/diagnostic":
    "Reproduce the issue first - or state plainly why it cannot be reproduced in " +
    "this environment - identify the root cause before editing, apply the minimal " +
    "correct fix, re-run to prove it is resolved, then summarize cause -> fix.",
  plan: "Produce a concrete actionable plan: numbered steps, each independently verifiable, with key risks called out.",
};

/** Select the outcome spec for a task class. Chat / unknown -> null. */
export function outcomeFor(domain: string, subtype: string): string | null {
  if (domain === "code") {
    return OUTCOME_TEMPLATES[subtype === "diagnostic" ? "code/diagnostic" : "code/generative"] ?? null;
  }
  if (domain === "plan") return OUTCOME_TEMPLATES.plan;
  return null;
}
