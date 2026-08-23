/**
 * Feedback logs — local, append-only JSONL, no daemon.
 * decision log: written on every routed decision (UserPromptSubmit).
 * usage log:   P1 feed — records which capability was actually invoked /
 *              overridden (ToolUse/SessionEnd hooks); schema is frozen now
 *              so Phase 5 (P1) needs no architecture change.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { logsDir } from "./paths.js";
import type { DecisionLogEntry, ExecutionRequest } from "./types.js";

export function promptHash(prompt: string): string {
  return createHash("sha1").update(prompt, "utf8").digest("hex").slice(0, 16);
}

export function toDecisionEntry(req: ExecutionRequest, sessionId?: string): DecisionLogEntry {
  const entry: DecisionLogEntry = {
    ts: new Date().toISOString(),
    promptHash: promptHash(req.originalPrompt),
    prompt: req.originalPrompt.slice(0, 240),
    routed: req.routed,
    plan: req.plan.map((s) => ({
      intent: s.intent,
      primary: s.primary ? s.primary.entry.id : null,
      fallbacks: s.fallbacks.map((f) => f.entry.id),
      confidence: s.primary ? s.primary.confidence : 0,
    })),
    rationale: req.rationale,
  };
  if (sessionId) entry.sessionId = sessionId;
  return entry;
}

export function appendDecisionLog(entry: DecisionLogEntry, dir?: string): void {
  const d = dir || logsDir();
  mkdirSync(d, { recursive: true });
  appendFileSync(path.join(d, "decisions.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

/** P1 usage record — frozen schema (populated by ToolUse hooks). */
export interface UsageLogEntry {
  ts: string;
  promptHash?: string;
  /** Claude Code session id — the join key for decision-log correlation (stats). */
  sessionId?: string;
  capabilityId: string;
  invoked: boolean;
  override?: string;
  source: "tool-use" | "session-end" | "test";
}

export function appendUsageLog(entry: UsageLogEntry, dir?: string): void {
  const d = dir || logsDir();
  mkdirSync(d, { recursive: true });
  appendFileSync(path.join(d, "usage.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

/** Read back the append-only usage log (corrupt lines skipped). */
export function loadUsageLog(dir?: string): UsageLogEntry[] {
  const d = dir || logsDir();
  return readJsonl<UsageLogEntry>(path.join(d, "usage.jsonl"));
}

/** Read back the decision log (corrupt lines skipped). */
export function loadDecisionLog(dir?: string): DecisionLogEntry[] {
  const d = dir || logsDir();
  return readJsonl<DecisionLogEntry>(path.join(d, "decisions.jsonl"));
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Recency-weighted invocation score: fresh hit = 1, halves every halfLifeMs. */
export function usageScore(
  capabilityId: string,
  entries: UsageLogEntry[],
  now: number = Date.now(),
  halfLifeMs: number = 7 * 24 * 3600 * 1000,
): number {
  let score = 0;
  for (const e of entries) {
    if (e.capabilityId !== capabilityId) continue;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    score += Math.pow(0.5, Math.max(0, now - t) / halfLifeMs);
  }
  return score;
}
