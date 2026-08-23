/**
 * Intent-boosting prompt enhancer — deterministic.
 * Produces a <capability-routing> context block: intent restatement,
 * per-step invocation syntax, alternatives with rationale, token-budgeted.
 * The original prompt is NEVER modified (preservation is a router invariant).
 */
import type { ExecutionRequest, RouterConfig } from "./types.js";

function estimateTokens(text: string): number {
  const latin = (text.match(/[a-zA-Z0-9]+/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin + cjk;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the routing-context block. Returns undefined for pass-through.
 * The block is injected as context (not user speech) so the model never
 * mistakes it for a user requirement.
 */
export function buildEnhancedPrompt(req: ExecutionRequest, config: RouterConfig): string | undefined {
  if (!req.routed || req.plan.length === 0) return undefined;

  const lines: string[] = ["<capability-routing>"];
  const intents = req.plan
    .filter((s) => s.primary)
    .map((s) => s.intent)
    .join("; ");
  if (intents) lines.push(`  <intent>${escapeXml(intents)}</intent>`);
  if (req.rationale && config.verbosity === "full") {
    lines.push(`  <rationale>${escapeXml(req.rationale)}</rationale>`);
  }
  for (const step of req.plan) {
    if (!step.primary) continue;
    const e = step.primary.entry;
    const alts = step.fallbacks
      .slice(0, 2)
      .map((f) => `${f.entry.id} (${(f.confidence * 100).toFixed(0)}%)`)
      .join(", ");
    lines.push(`  <step n="${step.step}">`);
    lines.push(`    <capability>${escapeXml(e.name)}</capability>`);
    lines.push(`    <kind>${e.kind}</kind>`);
    if (step.ambiguous) lines.push(`    <ambiguous>true</ambiguous>`);
    lines.push(`    <invoke>${escapeXml(e.invocation)}</invoke>`);
    if (alts) {
      lines.push(`    <alternatives>${escapeXml(alts)}</alternatives>`);
      lines.push(`    <on-failure>try each alternative in order; if all fail, continue without routing</on-failure>`);
    }
    lines.push(`  </step>`);
  }
  lines.push("</capability-routing>");
  let block = lines.join("\n");

  // token budget: drop alternatives + on-failure first, then truncate (never the primary)
  if (estimateTokens(block) > config.tokenBudget) {
    block = block.replace(/\n\s*<alternatives>[^<]*<\/alternatives>/g, "");
    block = block.replace(/\n\s*<on-failure>[^<]*<\/on-failure>/g, "");
  }
  if (estimateTokens(block) > config.tokenBudget) {
    block = block.split("\n").slice(0, 6).join("\n") + "\n  <truncated>true</truncated>\n</capability-routing>";
  }
  return block;
}
