/**
 * Phase 5 integration tests: end-to-end through the installed hook wrapper.
 * Real process spawn: install → invoke wrapper with hook JSON on stdin →
 * assert Claude Code hook output + decision log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendUsageLog, appendDecisionLog, toDecisionEntry, promptHash, loadUsageLog, usageScore } from "../src/logs.js";
import { createRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { CapabilityIndexEntry } from "../src/types.js";
import { discoverAll, indexById } from "../src/discovery.js";
import { updateIndex } from "../src/index-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(repoRoot, "dist", "src", "cli.js");
const fixtureRoots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function makeRouter() {
  const discovered = [...indexById(discoverAll(fixtureRoots)).values()];
  const entries = [...updateIndex(discovered, { entries: new Map(), lastUpdated: "", scan: "" }, DEFAULT_CONFIG).index.entries.values()];
  return createRouter({ config: DEFAULT_CONFIG, roots: fixtureRoots, entries });
}

interface Installed {
  home: string;
  settings: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function installToTemp(): Installed {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p5-"));
  const home = path.join(tmp, "cmr");
  const settings = path.join(tmp, "settings.json");
  const env = {
    ...process.env,
    CLAUDE_CMR_HOME: home,
    CLAUDE_SETTINGS_PATH: settings,
    CLAUDE_CMR_HOME_DIR: fixtureRoots.homeDir,
    CLAUDE_CMR_WORKSPACE_DIR: fixtureRoots.workspaceDir,
  };
  execFileSync(process.execPath, [CLI, "install"], { env });
  return { home, settings, env, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function invokeHook(inst: Installed, input: string): string {
  return execFileSync(process.execPath, [path.join(inst.home, "hook-wrapper.mjs")], {
    input,
    env: inst.env,
    encoding: "utf8",
  });
}

test("wrapper: routed prompt returns additionalContext with routing block", () => {
  const inst = installToTemp();
  try {
    const out = invokeHook(inst, JSON.stringify({ prompt: "summarize this PDF into bullet points", hook_event_name: "UserPromptSubmit" }));
    const parsed = JSON.parse(out);
    assert.ok(parsed.hookSpecificOutput, "hook output present");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    // documented Claude Code shape: additionalContext is an ARRAY
    assert.ok(Array.isArray(parsed.hookSpecificOutput.additionalContext), "array-form additionalContext");
    const ctx = parsed.hookSpecificOutput.additionalContext.join("\n");
    assert.ok(ctx.includes("<capability-routing>"));
    assert.ok(ctx.includes("pdf-summarizer"));
  } finally {
    inst.cleanup();
  }
});

test("wrapper: chat prompt passes through with {} and does not block", () => {
  const inst = installToTemp();
  try {
    const out = invokeHook(inst, JSON.stringify({ prompt: "how's the weather today?" }));
    assert.equal(out.trim(), "{}");
  } finally {
    inst.cleanup();
  }
});

test("wrapper: multi-step plan flows through the hook", () => {
  const inst = installToTemp();
  try {
    const out = invokeHook(inst, JSON.stringify({ prompt: "check the logs first, then create a bug ticket in jira" }));
    const parsed = JSON.parse(out);
    const ctx = Array.isArray(parsed.hookSpecificOutput.additionalContext)
      ? parsed.hookSpecificOutput.additionalContext.join("\n")
      : parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("log-analyzer"), ctx);
    assert.ok(ctx.includes("jira"), ctx);
  } finally {
    inst.cleanup();
  }
});

test("wrapper: malformed and empty input degrade to {} without crashing", () => {
  const inst = installToTemp();
  try {
    assert.equal(invokeHook(inst, "not json").trim(), "{}");
    assert.equal(invokeHook(inst, "").trim(), "{}");
    assert.equal(invokeHook(inst, JSON.stringify({})).trim(), "{}");
  } finally {
    inst.cleanup();
  }
});

test("wrapper: decision log written on every request (append-only JSONL)", () => {
  const inst = installToTemp();
  try {
    invokeHook(inst, JSON.stringify({ prompt: "summarize this PDF into bullet points" }));
    invokeHook(inst, JSON.stringify({ prompt: "how's the weather today?" }));
    const logFile = path.join(inst.home, "logs", "decisions.jsonl");
    assert.ok(existsSync(logFile));
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const routed = JSON.parse(lines[0]);
    assert.equal(routed.routed, true);
    assert.equal(routed.plan[0].primary, "skill:pdf-summarizer");
    const chat = JSON.parse(lines[1]);
    assert.equal(chat.routed, false);
    assert.ok(chat.promptHash.length >= 16);
  } finally {
    inst.cleanup();
  }
});

test("installer: registers UserPromptSubmit + PreToolUse hooks, never SessionEnd", () => {
  const inst = installToTemp();
  try {
    const settings = JSON.parse(readFileSync(inst.settings, "utf8"));
    for (const ev of ["UserPromptSubmit", "PreToolUse"]) {
      assert.equal(settings.hooks[ev].length, 1, `${ev} registered`);
    }
    assert.ok(!settings.hooks.SessionEnd || settings.hooks.SessionEnd.length === 0, "SessionEnd not registered");
  } finally {
    inst.cleanup();
  }
});

test("wrapper: ToolUse records invoked capability into usage.jsonl", () => {
  const inst = installToTemp();
  try {
    // skill, MCP tool, and a non-capability tool (Read must NOT be logged)
    assert.equal(invokeHook(inst, JSON.stringify({ hook_event_name: "ToolUse", tool_use: { name: "Skill", input: { name: "pdf-summarizer" } } })).trim(), "{}");
    assert.equal(invokeHook(inst, JSON.stringify({ hook_event_name: "ToolUse", tool_use: { name: "mcp__jira__create_issue" } })).trim(), "{}");
    assert.equal(invokeHook(inst, JSON.stringify({ hook_event_name: "ToolUse", tool_use: { name: "Read", input: { file_path: "/x" } } })).trim(), "{}");
    const logFile = path.join(inst.home, "logs", "usage.jsonl");
    assert.ok(existsSync(logFile), "usage.jsonl written");
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "only capability-mapped tools are logged");
    const [skill, mcp] = lines.map((l) => JSON.parse(l));
    assert.equal(skill.capabilityId, "skill:pdf-summarizer");
    assert.equal(skill.source, "tool-use");
    assert.equal(skill.invoked, true);
    assert.equal(mcp.capabilityId, "mcp-server:jira");
  } finally {
    inst.cleanup();
  }
});

test("wrapper: SessionEnd passes through and writes nothing", () => {
  const inst = installToTemp();
  try {
    assert.equal(invokeHook(inst, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s1" })).trim(), "{}");
    assert.ok(!existsSync(path.join(inst.home, "logs", "usage.jsonl")), "no usage entry from SessionEnd");
  } finally {
    inst.cleanup();
  }
});

test("ranking: usage log boosts recently-invoked capability (ties break to habits)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p5boost-"));
  try {
    const mk = (id: string): CapabilityIndexEntry => ({
      id,
      name: id,
      kind: "skill",
      purpose: "summarize the pdf into bullet points",
      description: "summarize the pdf into bullet points",
      body: "",
      actions: ["summarize"],
      domains: ["pdf"],
      examples: [],
      category: "skill",
      invocation: id,
      sourcePath: "test",
      fingerprint: id,
      enabled: true,
      weight: 1,
    });
    const entries = [mk("skill:sum-a"), mk("skill:sum-b")];
    // two fresh invocations of sum-b → recency score 2 → capped at +0.5 weight
    const ts = new Date().toISOString();
    appendUsageLog({ ts, capabilityId: "skill:sum-b", invoked: true, source: "test" }, tmp);
    appendUsageLog({ ts, capabilityId: "skill:sum-b", invoked: true, source: "test" }, tmp);
    const boosted = createRouter({ config: DEFAULT_CONFIG, roots: fixtureRoots, entries, usageDir: tmp });
    assert.equal(boosted.route("summarize this pdf into bullet points").plan[0].primary?.entry.id, "skill:sum-b");
    // without usageDir → no boost → alphabetical tie-break
    const plain = createRouter({ config: DEFAULT_CONFIG, roots: fixtureRoots, entries });
    assert.equal(plain.route("summarize this pdf into bullet points").plan[0].primary?.entry.id, "skill:sum-a");
    // helpers round-trip (score ~2: a few ms of age decay by now)
    assert.equal(loadUsageLog(tmp).length, 2);
    const score = usageScore("skill:sum-b", loadUsageLog(tmp));
    assert.ok(score > 1.99 && score <= 2, `score ${score}`);
    assert.equal(usageScore("skill:sum-a", loadUsageLog(tmp)), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("logs: usage log schema writes valid JSONL (P1 feed)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p5log-"));
  try {
    appendUsageLog({ ts: new Date().toISOString(), promptHash: "abc123", capabilityId: "skill:pdf-summarizer", invoked: true, source: "test" }, tmp);
    appendUsageLog({ ts: new Date().toISOString(), capabilityId: "mcp-server:jira", invoked: false, override: "plugin-skill:gmail-draft", source: "test" }, tmp);
    const lines = readFileSync(path.join(tmp, "usage.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).override, "plugin-skill:gmail-draft");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("logs: toDecisionEntry/appendDecisionLog round-trip", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p5log2-"));
  try {
    const router = makeRouter();
    const req = router.route("extract tables from this PDF, then draft an email summary to the team");
    const entry = toDecisionEntry(req);
    assert.equal(entry.plan.length, 2);
    assert.equal(entry.plan[0].primary, "skill:pdf-extractor");
    assert.equal(entry.promptHash, promptHash(req.originalPrompt));
    appendDecisionLog(entry, tmp);
    const lines = readFileSync(path.join(tmp, "decisions.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("wrapper: crash writes wrapper-error.log and degrades to {}", () => {
  const inst = installToTemp();
  try {
    // break the runtime: remove logs.js so the dynamic import fails
    rmSync(path.join(inst.home, "runtime", "capability-router", "logs.js"), { force: true });
    const out = invokeHook(inst, JSON.stringify({ prompt: "summarize this PDF" }));
    assert.equal(out.trim(), "{}", "crash must degrade to pass-through");
    const errLog = path.join(inst.home, "logs", "wrapper-error.log");
    assert.ok(existsSync(errLog), "wrapper-error.log written on crash");
    assert.ok(readFileSync(errLog, "utf8").includes("Cannot find module"), readFileSync(errLog, "utf8"));
  } finally {
    inst.cleanup();
  }
});

test("wrapper fix: Windows absolute paths must import via file:// URLs", async () => {
  // The exact Windows failure (user's selftest output): bare-path dynamic
  // import of a `C:\...` module throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const winModule = "C:\\Users\\Avinash-Pro\\.claude-cmr\\runtime\\capability-router\\config.js";
  await assert.rejects(
    () => import(winModule),
    (e) => (e as NodeJS.ErrnoException).code === "ERR_UNSUPPORTED_ESM_URL_SCHEME",
    "bare Windows path must throw the scheme error (documents the bug)",
  );
  // The fix: pathToFileURL produces an importable file:// URL (no backslashes).
  const url = pathToFileURL(winModule).href;
  assert.ok(!url.includes("\\"), `no backslashes in URL: ${url}`);
  assert.ok(url.startsWith("file://"), url);
  // wrapper source guard: must use pathToFileURL, never bare dynamic imports
  const wrapperSrc = readFileSync(path.join(repoRoot, "hook-wrapper.mjs"), "utf8");
  assert.ok(wrapperSrc.includes("pathToFileURL"), "wrapper imports pathToFileURL");
  assert.ok(wrapperSrc.includes("function rt("), "wrapper has the rt() helper");
  assert.ok(!wrapperSrc.includes('await import(path.join(RUNTIME'), "no bare-path dynamic imports remain");
});
