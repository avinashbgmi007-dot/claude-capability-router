/**
 * Intent-boosting prompt enhancer — deterministic.
 * Produces a <capability-routing> context block: intent restatement,
 * per-step invocation syntax, alternatives with rationale, token-budgeted.
 * The original prompt is NEVER modified (preservation is a router invariant).
 */
import { outcomeFor } from "./outcomes.js";
import { classifyDomain, classifySubtype } from "./domains.js";
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
 * Executable tool-call syntax per capability kind. A bare name ("ship")
 * forces the model to guess the mapping — live runs show it guesses wrong
 * and improvises instead. Spell out the exact call.
 */
function invocationFor(kind: string, invocation: string): string {
  switch (kind) {
    case "skill":
    case "plugin-skill":
      return `Skill tool with { "name": "${invocation}" }`;
    case "agent":
    case "plugin-agent":
      return `Task tool with { "subagent_type": "${invocation}" }`;
    case "mcp-server":
      return `MCP server "${invocation}" tools (mcp__${invocation}__*)`;
    case "command":
      return `workflow "/${invocation}" — follow its documented steps yourself`;
    default:
      return invocation;
  }
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
  // OUTCOME (delivery bar) at primacy: states what "done excellently" means
  // for this task class, independent of which capability assists. Survives
  // budget drops longer than alternatives/on-failure.
  if (config.outcomes?.enabled !== false) {
    const tmpl = outcomeFor(classifyDomain(req.originalPrompt), classifySubtype(req.originalPrompt));
    if (tmpl) lines.push(`  <outcome>${escapeXml(tmpl)}</outcome>`);
  }
  // imperative directive at PRIMACY position — directives at block-end were
  // ignored in live runs; beginnings carry weight
  lines.push(`  <action>Invoke the capabilities below with the exact tool calls given, before doing anything else; skip any that fail and continue.</action>`);
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
    lines.push(`    <invoke>${escapeXml(invocationFor(e.kind, e.invocation))}</invoke>`);
    if (alts) {
      lines.push(`    <alternatives>${escapeXml(alts)}</alternatives>`);
      lines.push(`    <on-failure>try each alternative in order; if all fail, continue without routing</on-failure>`);
    }
    lines.push(`  </step>`);
  }
  lines.push("</capability-routing>");
  let block = lines.join("\n");

  // token budget: drop the imperative closer + alternatives + on-failure first, then truncate (never the primary)
  if (estimateTokens(block) > config.tokenBudget) {
    block = block.replace(/\n\s*<action>[^<]*<\/action>/g, "");
    block = block.replace(/\n\s*<alternatives>[^<]*<\/alternatives>/g, "");
    block = block.replace(/\n\s*<on-failure>[^<]*<\/on-failure>/g, "");
  }
  if (estimateTokens(block) > config.tokenBudget) {
    block = block.split("\n").slice(0, 6).join("\n") + "\n  <truncated>true</truncated>\n</capability-routing>";
  }
  return block;
}
