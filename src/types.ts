/**
 * Capability Manager — core type definitions (v1.5 blueprint).
 * All types are plain data; routing stays 100% deterministic.
 */

export type CapabilityKind =
  | "skill"
  | "agent"
  | "plugin-skill"
  | "plugin-agent"
  | "mcp-server"
  | "mcp-tool";

/** Raw metadata extracted from a discovered capability source. */
export interface CapabilityMetadata {
  name: string;
  kind: CapabilityKind;
  purpose: string;
  description: string;
  /** SKILL.md / agent body text (after frontmatter) — trigger words often live here. */
  body: string;
  actions: string[];
  domains: string[];
  examples: string[];
  category: string;
  /** Exact syntax the model must emit to trigger this capability. */
  invocation: string;
  sourcePath: string;
}

/** Capability as discovered on disk (before indexing). */
export interface DiscoveredCapability extends CapabilityMetadata {
  id: string;
  fingerprint: string;
}

/** Normalized, indexed capability entry. */
export interface CapabilityIndexEntry extends CapabilityMetadata {
  id: string;
  fingerprint: string;
  enabled: boolean;
  weight: number;
}

/** Per-field scoring breakdown (for explain / debug). */
export interface FieldScores {
  purpose: number;
  actions: number;
  domains: number;
  examples: number;
  description: number;
  name: number;
  body: number;
}

export interface ScoredCapability {
  entry: CapabilityIndexEntry;
  confidence: number;
  fieldScores: FieldScores;
}

export interface PlanStep {
  step: number;
  intent: string;
  primary: ScoredCapability | null;
  fallbacks: ScoredCapability[];
  /** top-2 within ambiguityBand — the pick is not confident */
  ambiguous?: boolean;
}

export interface ExecutionRequest {
  originalPrompt: string;
  routed: boolean;
  plan: PlanStep[];
  enhancedPrompt?: string;
  rationale?: string;
}

export interface IndexUpdateResult {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export interface RouterConfig {
  threshold: number;
  /** top-2 confidence gap below this flags a step as ambiguous */
  ambiguityBand: number;
  weights: { purpose: number; actions: number; domains: number; examples: number; description: number; name: number; body: number };
  aliases: Record<string, string[]>;
  stopwords: string[];
  capabilities: Record<string, { enabled?: boolean; weight?: number }>;
  exclude: string[];
  verbosity: "brief" | "full";
  tokenBudget: number;
  /** leading prefix that forces routing past the threshold ("" disables) */
  forcePrefix: string;
}

export interface HookInput {
  prompt?: string;
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

/** Log record written on every routed decision (append-only JSONL). */
export interface DecisionLogEntry {
  ts: string;
  promptHash: string;
  prompt?: string;
  /** Claude Code session id — the join key for usage-log correlation (stats). */
  sessionId?: string;
  routed: boolean;
  plan: Array<{ intent: string; primary: string | null; fallbacks: string[]; confidence: number }>;
  rationale?: string;
}
