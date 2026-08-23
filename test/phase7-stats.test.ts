/**
 * Phase 7 tests: last-mile compliance stats.
 * Unit coverage of the decision×usage join, plus an end-to-end proof that a
 * routed prompt followed by a real PreToolUse invocation reports as compliant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeStats } from "../src/stats.js";
import { appendDecisionLog, appendUsageLog, loadDecisionLog, loadUsageLog, promptHash, toDecisionEntry } from "../src/logs.js";
import { createRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { DecisionLogEntry, ExecutionRequest } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(repoRoot, "dist", "src", "cli.js");
const fixtureRoots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function fakeRequest(prompt: string, primaryId: string | null): ExecutionRequest {
  const router = createRouter({ config: DEFAULT_CONFIG, roots: fixtureRoots });
  if (!primaryId) return { originalPrompt: prompt, routed: false, plan: [] };
  const entry = router.entries().find((e) => e.id === primaryId);
  assert.ok(entry, `fixture entry ${primaryId} must exist`);
  return {
    originalPrompt: prompt,
    routed: true,
    plan: [{ step: 1, intent: prompt, primary: { entry, confidence: 0.9, fieldScores: { purpose: 0, actions: 0, domains: 0, examples: 0, description: 0, name: 0, body: 0 } }, fallbacks: [] }],
    rationale: `routed to ${primaryId}`,
  };
}

const T = (iso: string) => iso;

test("stats: compliance, override, ignored, silent-win, unattributed", () => {
  const decisions: DecisionLogEntry[] = [
    // s1 #1 routed → later invoked in-window → compliant
    { ...toDecisionEntry(fakeRequest("summarize this PDF into bullet points", "skill:pdf-summarizer"), "s1"), ts: T("2026-08-24T10:00:00.000Z") },
    // s1 #2 routed jira → nothing after it → ignored
    { ...toDecisionEntry(fakeRequest("create a bug ticket", "mcp-server:jira"), "s1"), ts: T("2026-08-24T10:05:00.000Z") },
    // s2 #1 routed x → y invoked instead → override
    { ...toDecisionEntry(fakeRequest("post the chart", "mcp-server:twitter"), "s2"), ts: T("2026-08-24T11:00:00.000Z") },
    // s2 #2 pass-through → but x invoked → silent win
    { ...toDecisionEntry(fakeRequest("tweet this now", null), "s2"), ts: T("2026-08-24T11:01:00.000Z") },
    // no session → unattributed
    { ...toDecisionEntry(fakeRequest("summarize this PDF into bullet points", "skill:pdf-summarizer")), ts: T("2026-08-24T12:00:00.000Z") },
  ];
  const usage = [
    { ts: T("2026-08-24T10:01:00.000Z"), sessionId: "s1", capabilityId: "skill:pdf-summarizer", invoked: true, source: "tool-use" as const },
    { ts: T("2026-08-24T11:00:30.000Z"), sessionId: "s2", capabilityId: "skill:minimalist-ui", invoked: true, source: "tool-use" as const },
    { ts: T("2026-08-24T11:02:00.000Z"), sessionId: "s2", capabilityId: "mcp-server:twitter", invoked: true, source: "tool-use" as const },
  ];

  const s = computeStats(decisions, usage);
  assert.equal(s.decisions, 5);
  assert.equal(s.attributedDecisions, 4);
  assert.equal(s.routedDecisions, 4);
  assert.equal(s.routedAttributed, 3);
  assert.equal(s.compliant, 1);
  assert.equal(s.overridden, 1);
  assert.equal(s.ignored, 1);
  assert.equal(s.silentWins.length, 1);
  assert.equal(s.silentWins[0].prompt, "tweet this now");
  assert.deepEqual(s.silentWins[0].invokedIds, ["mcp-server:twitter"]);

  const byId = new Map(s.perCapability.map((c) => [c.id, c]));
  assert.equal(byId.get("skill:pdf-summarizer")?.routedAsPrimary, 1);
  assert.equal(byId.get("mcp-server:jira")?.ignoredDecisions, 1);
  assert.equal(byId.get("skill:minimalist-ui")?.invoked, 1);
  assert.equal(byId.get("skill:minimalist-ui")?.routedAsPrimary, 0);
});

test("stats: empty inputs produce a zeroed report without throwing", () => {
  const s = computeStats([], []);
  assert.equal(s.decisions, 0);
  assert.equal(s.routedDecisions, 0);
  assert.deepEqual(s.silentWins, []);
});

test("logs: decision log round-trips sessionId and loads back tolerantly", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p7log-"));
  try {
    const entry = toDecisionEntry(fakeRequest("summarize this PDF", "skill:pdf-summarizer"), "sess-42");
    assert.equal(entry.sessionId, "sess-42");
    assert.equal(entry.promptHash, promptHash("summarize this PDF"));
    appendDecisionLog(entry, tmp);
    appendUsageLog({ ts: entry.ts, sessionId: "sess-42", capabilityId: "skill:pdf-summarizer", invoked: true, source: "tool-use" }, tmp);
    const d = loadDecisionLog(tmp);
    const u = loadUsageLog(tmp);
    assert.equal(d.length, 1);
    assert.equal(d[0].sessionId, "sess-42");
    assert.equal(u.length, 1);
    assert.equal(u[0].sessionId, "sess-42");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: routed prompt + real ToolUse invocation reports compliant via wrapper logs", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p7e2e-"));
  try {
    const home = path.join(tmp, "cmr");
    const env = {
      ...process.env,
      CLAUDE_CMR_HOME: home,
      CLAUDE_SETTINGS_PATH: path.join(tmp, "settings.json"),
      CLAUDE_CMR_HOME_DIR: fixtureRoots.homeDir,
      CLAUDE_CMR_WORKSPACE_DIR: fixtureRoots.workspaceDir,
    };
    execFileSync(process.execPath, [CLI, "install"], { env });
    const hook = (input: unknown) =>
      execFileSync(process.execPath, [path.join(home, "hook-wrapper.mjs")], { input: JSON.stringify(input), env, encoding: "utf8" });

    hook({ prompt: "summarize this PDF into bullet points", hook_event_name: "UserPromptSubmit", session_id: "live-sess" });
    hook({ hook_event_name: "PreToolUse", session_id: "live-sess", tool_use: { name: "Skill", input: { name: "pdf-summarizer" } } });

    const s = computeStats(loadDecisionLog(path.join(home, "logs")), loadUsageLog(path.join(home, "logs")));
    assert.equal(s.routedDecisions, 1);
    assert.equal(s.compliant, 1);
    assert.equal(s.ignored, 0);
    assert.equal(s.perCapability.find((c) => c.id === "skill:pdf-summarizer")?.invoked, 1);

    // CLI prints the report end-to-end
    const out = execFileSync(process.execPath, [CLI, "stats"], { env, encoding: "utf8" });
    assert.ok(out.includes("compliance"), out);
    assert.ok(out.includes("100%"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
