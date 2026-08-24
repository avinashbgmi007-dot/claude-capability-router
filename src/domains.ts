/**
 * Domain classification — deterministic task-type detection shared by the
 * domain-fallback routing pass. Code > plan > chat, with ambiguity biased
 * toward CODE (chat-on-code misclassification costs far more than the reverse:
 * a code rep suggested for a chat prompt is noise; chat sampling on code is
 * lost precision).
 *
 * SYNC NOTE: regex families mirror llama-guard/guard-proxy.mjs's classifier.
 * DOMAIN_TEST_VECTORS below are the canonical sync vectors — if you change
 * either implementation, both must pass this same list.
 */

export type TaskDomain = "code" | "plan" | "chat";

const CODE_FENCE_RE = /```/;
const CODE_FILE_RE =
  /\.(py|ts|tsx|js|jsx|mjs|cjs|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|ps1|psm1|sql|json|ya?ml|toml|ini|cfg|html|css)\b/i;
const DIFF_MARKER_RE = /^(\+\+\+|---) |^@@ -\d+/m;
const CODE_VERB_RE =
  /\b(refactor|implement|debug|compile|regex|unit ?tests?|write (me |us )?(a |the )?(function|script|class|hook|module)|fix (the |this |a )?(bug|error|crash|issue)|typeerror|syntaxerror|nullpointer|null reference|(write|build|make|create)[^.\n]{0,40}\b(game|program|application|app|tool|website|clone))\b/i;
const PLAN_RE =
  /\b(plan|roadmap|architect|approach|strategy|milestones?|step[- ]by[- ]step|phases? of work|blueprint)\b/i;

/** Canonical vectors — hook tests AND guard smoke must stay in agreement. */
export const DOMAIN_TEST_VECTORS: Array<{ text: string; expect: TaskDomain }> = [
  { text: "write me a ping pong game with arrow keys", expect: "code" },
  { text: "refactor utils.py please", expect: "code" },
  { text: "```js\nconsole.log(1)\n```", expect: "code" },
  { text: "getting TypeError cannot read properties of undefined", expect: "code" },
  { text: "@@ -1,2 +1,2 @@ patched", expect: "code" },
  { text: "we should plan the migration roadmap", expect: "plan" },
  { text: "what is your approach for the auth architecture", expect: "plan" },
  { text: "how's the weather today", expect: "chat" },
  { text: "my name is bob and i like tea", expect: "chat" },
];

/** Classify a raw user prompt into its task domain. */
export function classifyDomain(prompt: string): TaskDomain {
  const t = prompt || "";
  if (
    CODE_FENCE_RE.test(t) ||
    CODE_FILE_RE.test(t) ||
    DIFF_MARKER_RE.test(t) ||
    CODE_VERB_RE.test(t)
  ) {
    return "code";
  }
  if (PLAN_RE.test(t)) return "plan";
  return "chat";
}
