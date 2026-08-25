/**
 * Feedback logs — local, append-only JSONL, no daemon.
 * decision log: written on every routed decision (UserPromptSubmit).
 * usage log:   P1 feed — records which capability was actually invoked /
 *              overridden (ToolUse/SessionEnd hooks); schema is frozen now
 *              so Phase 5 (P1) needs no architecture change.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { logsDir } from "./paths.js";
import type { DecisionLogEntry, ExecutionRequest } from "./types.js";

/**
 * Log retention: both JSONL logs grow forever without pruning, and
 * loadUsageLog is re-read on every prompt for the recency boost. 90 days
 * loses nothing (recency score at 90d ≈ 2^-12); hard line caps bound the
 * worst case. Compaction only runs when the file exceeds SIZE_TRIGGER so
 * the per-append cost stays a cheap stat call.
 */
const RETENTION_MS = 90 * 24 * 3600 * 1000;
const SIZE_TRIGGER = 256 * 1024;
const MAX_LINES: Record<string, number> = { "decisions.jsonl": 10000, "usage.jsonl": 5000 };

function compactLog(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < SIZE_TRIGGER) return;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const cutoff = Date.now() - RETENTION_MS;
    let kept = lines.filter((l) => {
      try {
        const t = Date.parse((JSON.parse(l) as { ts?: string }).ts ?? "");
        return Number.isNaN(t) ? true : t >= cutoff; // unparseable lines are preserved
      } catch {
        return true;
      }
    });
    const max = MAX_LINES[path.basename(file)];
    if (max && kept.length > max) kept = kept.slice(-max);
    if (kept.length !== lines.length) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, kept.join("\n") + "\n", "utf8");
      renameSync(tmp, file);
    }
  } catch {
    /* pruning must never break logging */
  }
}

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
      ...(s.domainMatch ? { domainMatch: true } : {}),
    })),
    rationale: req.rationale,
  };
  if (sessionId) entry.sessionId = sessionId;
  return entry;
}

export function appendDecisionLog(entry: DecisionLogEntry, dir?: string): void {
  const d = dir || logsDir();
  mkdirSync(d, { recursive: true });
  const file = path.join(d, "decisions.jsonl");
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  compactLog(file);
}

/** P1 usage record — frozen schema (populated by ToolUse hooks). */
export interface UsageLogEntry {
  ts: string;
  promptHash?: string;
  /** Claude Code session id - the join key for decision-log correlation (stats). */
  sessionId?: string;
  capabilityId: string;
  invoked: boolean;
  override?: string;
  source: "tool-use" | "session-end" | "test";
  /** sha1-prefix of tool_input - enables action-loop detection without storing content */
  argsHash?: string;
}

export function appendUsageLog(entry: UsageLogEntry, dir?: string): void {
  const d = dir || logsDir();
  mkdirSync(d, { recursive: true });
  const file = path.join(d, "usage.jsonl");
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  compactLog(file);
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

/**
 * Aggregate recency scores for ALL capabilities in one pass over the log.
 * The per-prompt router previously called usageScore once per capability —
 * O(caps × lines). One map build is O(lines).
 */
export function computeUsageScores(
  entries: UsageLogEntry[],
  now: number = Date.now(),
  halfLifeMs: number = 7 * 24 * 3600 * 1000,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const e of entries) {
    if (!e.capabilityId) continue;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    scores.set(e.capabilityId, (scores.get(e.capabilityId) ?? 0) + Math.pow(0.5, Math.max(0, now - t) / halfLifeMs));
  }
  return scores;
}
