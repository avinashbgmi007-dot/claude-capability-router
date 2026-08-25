/**
 * Stats — joins the decision log with the usage log per Claude Code session
 * to measure the last mile: did the model actually invoke what we routed?
 *
 * Correlation rule (deterministic):
 *   - entries without sessionId are unattributable (older format) → counted separately
 *   - within a session, a routed decision owns the usage events from its own
 *     timestamp until the session's next decision (or end of log)
 *   - compliant: any planned primary was invoked in the window
 *   - override : something else was invoked instead
 *   - ignored  : nothing planned was invoked (routing theater candidate)
 *   - silent win: pass-through decision followed by invocations — free labeled
 *     corpus cases (the router missed a routable prompt)
 */
import type { DecisionLogEntry } from "./types.js";
import type { UsageLogEntry } from "./logs.js";

export interface SilentWin {
  ts: string;
  prompt: string;
  invokedIds: string[];
}

export interface CapabilityStats {
  id: string;
  routedAsPrimary: number;
  invoked: number;
  ignoredDecisions: number;
}

export interface ActionCycle {
  capabilityId: string;
  argsHash: string;
  count: number;
  firstTs: string;
  lastTs: string;
}

export interface StatsResult {
  decisions: number;
  attributedDecisions: number;
  /** routed=true across ALL decisions (attributed or not) — headline count */
  routedDecisions: number;
  /** routed decisions that carry a sessionId — the correlation denominator */
  routedAttributed: number;
  compliant: number;
  overridden: number;
  ignored: number;
  passThrough: number;
  /** pass-through decisions where nothing was invoked — the correct outcome */
  correctPassThrough: number;
  /**
   * Intention fidelity: of attributable decisions, the fraction where the
   * system did the right thing overall — routed AND obeyed, or passed
   * through AND nothing was needed. The composite end-to-end bar.
   */
  fidelity: number;
  silentWins: SilentWin[];
  perCapability: CapabilityStats[];
  /** REPORT-ONLY: same capability + same argsHash repeated rapidly.
      Productive automation (browser testing) can look identical - treat as
      signal to inspect, never as automatic failure. */
  suspectedActionLoops: ActionCycle[];
}

const CYCLE_MIN_COUNT = 6;
const CYCLE_WINDOW_MS = 10 * 60 * 1000;

/** Identical capability + identical argument-hash >= CYCLE_MIN_COUNT times
    within a sliding CYCLE_WINDOW_MS. Requires argsHash (post-schema data). */
export function detectActionCycles(usage: UsageLogEntry[]): ActionCycle[] {
  const groups = new Map<string, typeof usage>();
  for (const u of usage) {
    if (!u.argsHash || !u.capabilityId) continue;
    const key = `${u.capabilityId}|${u.argsHash}`;
    const arr = groups.get(key) ?? [];
    arr.push(u);
    groups.set(key, arr);
  }
  const cycles: ActionCycle[] = [];
  for (const [key, arr] of groups) {
    const sorted = [...arr].sort((a, b) => tsOf(a) - tsOf(b));
    let left = 0;
    for (let right = 0; right < sorted.length; right++) {
      while (tsOf(sorted[right]) - tsOf(sorted[left]) > CYCLE_WINDOW_MS) left++;
      const count = right - left + 1;
      if (count >= CYCLE_MIN_COUNT) {
        cycles.push({
          capabilityId: sorted[left].capabilityId,
          argsHash: key.split("|")[1],
          count,
          firstTs: sorted[left].ts,
          lastTs: sorted[right].ts,
        });
        break; // one cycle record per group is enough signal
      }
    }
  }
  return cycles.sort((a, b) => b.count - a.count);
}

function tsOf(e: { ts: string }): number {
  const t = Date.parse(e.ts);
  return Number.isNaN(t) ? 0 : t;
}

export function computeStats(decisions: DecisionLogEntry[], usage: UsageLogEntry[]): StatsResult {
  const result: StatsResult = {
    decisions: decisions.length,
    attributedDecisions: 0,
    routedDecisions: decisions.filter((d) => d.routed).length,
    routedAttributed: 0,
    compliant: 0,
    overridden: 0,
    ignored: 0,
    passThrough: 0,
    correctPassThrough: 0,
    fidelity: 0,
    silentWins: [],
    suspectedActionLoops: [],
    perCapability: [],
  };
  const capStats = new Map<string, CapabilityStats>();
  const cap = (id: string): CapabilityStats => {
    let s = capStats.get(id);
    if (!s) capStats.set(id, (s = { id, routedAsPrimary: 0, invoked: 0, ignoredDecisions: 0 }));
    return s;
  };

  // usage events by session, chronological
  const usageBySession = new Map<string, UsageLogEntry[]>();
  for (const u of usage) {
    if (!u.sessionId || !u.capabilityId) continue;
    const arr = usageBySession.get(u.sessionId) ?? [];
    arr.push(u);
    usageBySession.set(u.sessionId, arr);
  }
  for (const arr of usageBySession.values()) arr.sort((a, b) => tsOf(a) - tsOf(b));
  const invokedCount = new Map<string, number>();
  for (const u of usage) if (u.capabilityId) invokedCount.set(u.capabilityId, (invokedCount.get(u.capabilityId) ?? 0) + 1);

  // decisions grouped by session, chronological
  const bySession = new Map<string, DecisionLogEntry[]>();
  for (const d of decisions) {
    if (!d.sessionId) continue; // unattributed (pre-session_id format)
    const arr = bySession.get(d.sessionId) ?? [];
    arr.push(d);
    bySession.set(d.sessionId, arr);
  }

  for (const arr of bySession.values()) {
    arr.sort((a, b) => tsOf(a) - tsOf(b));
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i];
      result.attributedDecisions++;
      const windowStart = tsOf(d);
      const windowEnd = i + 1 < arr.length ? tsOf(arr[i + 1]) : Infinity;
      const invokedIds = new Set<string>();
      for (const u of usageBySession.get(d.sessionId!) ?? []) {
        const t = tsOf(u);
        if (t >= windowStart && t < windowEnd) invokedIds.add(u.capabilityId!);
      }

      const primaries = d.plan.map((s) => s.primary).filter((p): p is string => !!p);
      if (!d.routed || primaries.length === 0) {
        result.passThrough++;
        if (invokedIds.size > 0) {
          // pass-through with invocations → router missed a routable prompt
          result.silentWins.push({
            ts: d.ts,
            prompt: d.prompt ?? "",
            invokedIds: [...invokedIds],
          });
        } else {
          result.correctPassThrough++;
        }
        continue;
      }
      result.routedAttributed++;
      for (const id of new Set(primaries)) cap(id).routedAsPrimary++;
      const hit = primaries.some((p) => invokedIds.has(p));
      if (hit) {
        result.compliant++;
      } else if (invokedIds.size > 0) {
        result.overridden++;
        for (const id of new Set(primaries)) cap(id).ignoredDecisions++;
      } else {
        result.ignored++;
        for (const id of new Set(primaries)) cap(id).ignoredDecisions++;
      }
    }
  }

  for (const id of [...invokedCount.keys()]) cap(id); // ensure invoked-only capabilities appear
  result.perCapability = [...capStats.values()].map((s) => ({ ...s, invoked: invokedCount.get(s.id) ?? 0 }));
  result.perCapability.sort((a, b) => b.routedAsPrimary + b.invoked - (a.routedAsPrimary + a.invoked) || (a.id < b.id ? -1 : 1));
  result.fidelity =
    result.attributedDecisions === 0
      ? 0
      : (result.compliant + result.correctPassThrough) / result.attributedDecisions;
  result.suspectedActionLoops = detectActionCycles(usage);
  return result;
}
