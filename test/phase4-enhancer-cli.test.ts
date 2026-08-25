/**
 * Phase 4 tests: enhancer (intent-boosting block) + installer CLI lifecycle.
 * All CLI operations run against temp dirs via env overrides.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "../src/router.js";
import { buildEnhancedPrompt } from "../src/enhancer.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { CapabilityIndexEntry } from "../src/types.js";
import { discoverAll, indexById } from "../src/discovery.js";
import { updateIndex } from "../src/index-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(repoRoot, "dist", "src", "cli.js");
const roots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function makeRouter(config = DEFAULT_CONFIG) {
  const discovered = [...indexById(discoverAll(roots)).values()];
  const entries = [...updateIndex(discovered, { entries: new Map(), lastUpdated: "", scan: "" }, config).index.entries.values()];
  return createRouter({ config, roots, entries });
}

test("enhancer: routed request produces capability-routing block with invocation", () => {
  const router = makeRouter();
  const req = router.route("summarize this PDF into bullet points");
  assert.equal(req.routed, true);
  const block = buildEnhancedPrompt(req, DEFAULT_CONFIG)!;
  assert.ok(block, "enhanced block exists");
  assert.ok(block.includes("<capability-routing>"), "wrapped as routing context");
  assert.ok(block.includes("pdf-summarizer"), "contains capability name");
  assert.ok(block.includes("<invoke>Skill tool with { &quot;name&quot;: &quot;pdf-summarizer&quot; }</invoke>"), "executable Skill tool-call syntax");
  assert.ok(block.includes("<intent>"), "intent restatement present");
  assert.ok(block.includes("<on-failure>"), "explicit retry instruction present");
});

test("enhancer: imperative action closer present when budget allows, dropped first under pressure", () => {
  const router = makeRouter();
  const req = router.route("summarize this PDF into bullet points");
  const roomy = buildEnhancedPrompt(req, { ...DEFAULT_CONFIG, tokenBudget: 300 })!;
  assert.ok(roomy.includes("<action>"), "directive closer present at normal budget");
  assert.ok(roomy.trimEnd().endsWith("</capability-routing>"), "block still well-formed");

  const tight = buildEnhancedPrompt(req, { ...DEFAULT_CONFIG, tokenBudget: 60 })!;
  assert.ok(!tight.includes("<action>"), "action line dropped first under tight budget");
  assert.ok(tight.includes("pdf-summarizer"), "primary capability never dropped");
});

// ---- outcome templates: the delivery bar travels with the task class ----

test("outcome: code/generative spec demands run + fix + verified delivery", () => {
  const router = makeRouter();
  const req = router.route("write me a racing program with nitro and 10 cars");
  const block = buildEnhancedPrompt(req, DEFAULT_CONFIG)!;
  assert.ok(block.includes("<outcome>"), "outcome present");
  assert.ok(block.includes("verified working version"), "generative wording");
  // primacy: outcome sits between intent and first step
  assert.ok(block.indexOf("<outcome>") < block.indexOf("<step "), "outcome before steps");
});

test("outcome: diagnostic spec demands reproduction-first and root-cause discipline", () => {
  const router = makeRouter();
  const req = router.route("getting TypeError in my game engine, help me debug");
  const block = buildEnhancedPrompt(req, DEFAULT_CONFIG)!;
  assert.ok(block.includes("root cause before editing"), block);
  assert.ok(block.includes("cannot be reproduced in this environment"), "non-repro escape hatch present");
});

test("outcome: plan class asks for verifiable numbered steps", () => {
  const router = makeRouter();
  const req = router.route("rough plan and layout for the migration");
  assert.equal(req.routed, true);
  const block = buildEnhancedPrompt(req, DEFAULT_CONFIG)!;
  assert.ok(block.includes("independently verifiable"), block);
});

test("outcome: kill-switch removes tag; drop order protects it over alternatives", () => {
  const router = makeRouter();
  const req = router.route("write me a racing program with nitro");
  const cfgOff = { ...DEFAULT_CONFIG, outcomes: { enabled: false } };
  assert.ok(!buildEnhancedPrompt(req, cfgOff)!.includes("<outcome>"), "kill-switch works");

  // moderate pressure (200): alternatives/on-failure sacrificed, OUTCOME retained
  const pressured = buildEnhancedPrompt(req, { ...DEFAULT_CONFIG, tokenBudget: 200 })!;
  assert.ok(pressured.includes("<outcome>"), "outcome survives moderate pressure");
  assert.ok(!pressured.includes("<alternatives>"), "alternatives die first");

  // extreme pressure (120): everything auxiliary gone, primary + intent remain
  const extreme = buildEnhancedPrompt(req, { ...DEFAULT_CONFIG, tokenBudget: 120 })!;
  assert.ok(extreme.includes("pdf-summarizer") || extreme.includes("<intent>"), extreme);
});

test("enhancer: pass-through produces no block; original prompt untouched", () => {
  const router = makeRouter();
  const req = router.route("how's the weather today?");
  assert.equal(req.routed, false);
  assert.equal(buildEnhancedPrompt(req, DEFAULT_CONFIG), undefined);
  assert.equal(req.originalPrompt, "how's the weather today?");
});

test("enhancer: multi-step plan yields one step element per capability", () => {
  const router = makeRouter();
  const req = router.route("extract tables from this PDF, then draft an email summary to the team");
  const block = buildEnhancedPrompt(req, DEFAULT_CONFIG)!;
  assert.equal((block.match(/<step n=/g) || []).length, 2);
  assert.ok(block.includes("pdf-extractor"), block);
  assert.ok(block.includes("gmail-draft"), block);
  // directive sits at primacy position — right after the intent
  assert.ok(block.indexOf("<action>") > -1 && block.indexOf("<action>") < block.indexOf("<step"), "action precedes steps");
});

test("ambiguity: top-2 within band flags the step and the block", () => {
  const cfg = DEFAULT_CONFIG;
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
  // two identical capabilities → equal scores → gap 0 < band → ambiguous
  const close = createRouter({ config: cfg, roots, entries: [mk("skill:sum-a"), mk("skill:sum-b")] });
  const req = close.route("summarize this pdf into bullet points");
  assert.equal(req.routed, true);
  assert.equal(req.plan[0].ambiguous, true);
  const block = buildEnhancedPrompt(req, cfg)!;
  assert.ok(block.includes("<ambiguous>true</ambiguous>"), block);
  assert.ok(block.includes("skill:sum-b"), "runner-up listed as alternative");

  // single candidate → no ambiguity
  const clear = createRouter({ config: cfg, roots, entries: [mk("skill:sum-only")] });
  const r2 = clear.route("summarize this pdf into bullet points");
  assert.equal(r2.plan[0].ambiguous, undefined);
  assert.ok(!buildEnhancedPrompt(r2, cfg)!.includes("<ambiguous>"), "no marker on clear pick");
});

test("enhancer: token budget enforced (tiny budget truncates)", () => {
  const router = makeRouter();
  const req = router.route("extract tables from this PDF, then draft an email summary to the team");
  const block = buildEnhancedPrompt(req, { ...DEFAULT_CONFIG, tokenBudget: 60 })!;
  const tokens = (block.match(/[a-zA-Z0-9]+/g) || []).length;
  assert.ok(tokens <= 60, `block tokens ${tokens} exceed budget`);
});

function cliEnv(home: string, settings: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CMR_HOME: home,
    CLAUDE_SETTINGS_PATH: settings,
    CLAUDE_CMR_HOME_DIR: roots.homeDir,
    CLAUDE_CMR_WORKSPACE_DIR: roots.workspaceDir,
  };
}

test("installer: install writes runtime + marker + idempotent hook registration", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p4-"));
  try {
    const home = path.join(tmp, "cmr");
    const settingsFile = path.join(tmp, "settings.json");
    // pre-existing unrelated hook must survive
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "node other.mjs" }] }] } }), "utf8");

    execFileSync(process.execPath, [CLI, "install"], { env: cliEnv(home, settingsFile) });
    assert.ok(existsSync(path.join(home, ".install-marker")));
    assert.ok(existsSync(path.join(home, "hook-wrapper.mjs")));
    assert.ok(existsSync(path.join(home, "runtime", "capability-router", "router.js")));
    assert.ok(existsSync(path.join(home, "config.json")));
    let settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.ok(
      settings.hooks.PreToolUse.some((e: { hooks?: Array<{ command?: string }> }) => e.hooks?.[0]?.command === "node other.mjs"),
      "unrelated hook preserved",
    );
    const cmd1 = settings.hooks.UserPromptSubmit[0].hooks[0].command;

    // idempotent: second install does not duplicate
    execFileSync(process.execPath, [CLI, "install"], { env: cliEnv(home, settingsFile) });
    settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1, "no duplicate registration");
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, cmd1);

    // validate passes
    execFileSync(process.execPath, [CLI, "validate"], { env: cliEnv(home, settingsFile) });

    // uninstall removes runtime + registration, keeps unrelated hook
    execFileSync(process.execPath, [CLI, "uninstall"], { env: cliEnv(home, settingsFile) });
    assert.ok(!existsSync(path.join(home, ".install-marker")));
    assert.ok(!existsSync(path.join(home, "hook-wrapper.mjs")));
    settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit.length, 0);
    assert.equal(settings.hooks.PreToolUse.length, 1, "unrelated hook survives uninstall");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("installer: Windows-style backslash paths install/validate/uninstall cleanly", () => {
  // literal backslashes in the install root reproduce the Windows JSON-escaping
  // failure: the old check compared JSON.stringify(hooks) against the raw command.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p4win-"));
  try {
    const home = path.join(tmp, "cmr", "win-home\\user");
    const settingsFile = path.join(tmp, "settings.json");
    execFileSync(process.execPath, [CLI, "install"], { env: cliEnv(home, settingsFile) });
    execFileSync(process.execPath, [CLI, "validate"], { env: cliEnv(home, settingsFile) });
    // idempotent: second install must not duplicate the entry
    execFileSync(process.execPath, [CLI, "install"], { env: cliEnv(home, settingsFile) });
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1, "no duplicate registration on Windows-style paths");
    // uninstall removes the registration
    execFileSync(process.execPath, [CLI, "uninstall"], { env: cliEnv(home, settingsFile) });
    const after = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(after.hooks.UserPromptSubmit.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("list: prints discovered capabilities with enabled state", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p4list-"));
  try {
    const out = execFileSync(process.execPath, [CLI, "list"], {
      env: cliEnv(path.join(tmp, "cmr"), path.join(tmp, "settings.json")),
      encoding: "utf8",
    });
    assert.ok(out.includes("skill:pdf-summarizer"), out);
    assert.ok(out.includes("plugin-skill:gmail-draft"), out);
    assert.ok(out.includes("mcp-server:twitter"), out);
    assert.ok(out.includes("command:deploy"), out);
    assert.ok(out.includes("invoke=pdf-summarizer"), out);
    assert.ok(/24 enabled \/ 24 total/.test(out), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("explain: prints scoring breakdown with winner", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p4-"));
  try {
    const home = path.join(tmp, "cmr");
    const out = execFileSync(process.execPath, [CLI, "explain", "summarize this PDF into bullet points"], {
      env: cliEnv(home, path.join(tmp, "settings.json")),
      encoding: "utf8",
    });
    assert.ok(out.includes("decision: route"));
    assert.ok(out.includes("skill:pdf-summarizer"), out);
    assert.ok(out.includes("conf="));
    assert.ok(out.includes("enhanced block"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("selftest: runs installed wrapper end-to-end and verifies logs", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p4st-"));
  try {
    const home = path.join(tmp, "cmr");
    const settings = path.join(tmp, "settings.json");
    execFileSync(process.execPath, [CLI, "install"], { env: cliEnv(home, settings) });
    const out = execFileSync(process.execPath, [CLI, "selftest"], { env: cliEnv(home, settings), encoding: "utf8" });
    assert.ok(out.includes("PASS wrapper executed"), out);
    assert.ok(out.includes("PASS wrapper output valid"), out);
    assert.ok(out.includes("PASS decision log written"), out);
    assert.ok(out.includes("PASS decision log has entries"), out);
    assert.ok(out.includes("PASS no wrapper errors"), out);
    assert.ok(existsSync(path.join(home, "logs", "decisions.jsonl")), "decision log file exists");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
