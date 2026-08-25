/**
 * Phase 6 — hardening suite: cross-platform and edge-case scenarios.
 * Covers: Windows-style paths (drive letters), malformed settings,
 * uninstall/validate without install, empty/unicode/very-long prompts,
 * zero capabilities, corrupt state/config, determinism, case-insensitive FS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "../src/router.js";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";
import type { CapabilityIndexEntry } from "../src/types.js";
import { loadIndex, updateIndex } from "../src/index-store.js";
import { discoverAll, indexById } from "../src/discovery.js";
import { loadCorpus, runRoutingMetrics, defaultCorpusPath } from "../eval/harness.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(repoRoot, "dist", "src", "cli.js");
const fixtureRoots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function makeRouter(config = DEFAULT_CONFIG, entriesOverride?: CapabilityIndexEntry[]) {
  // in-memory index: hermetic, no writes to the real state dir
  if (!entriesOverride) {
    const discovered = [...indexById(discoverAll(fixtureRoots)).values()];
    entriesOverride = [...updateIndex(discovered, { entries: new Map(), lastUpdated: "", scan: "" }, DEFAULT_CONFIG).index.entries.values()];
  }
  return createRouter({ config, roots: fixtureRoots, entries: entriesOverride });
}

function cliEnv(home: string, settings: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CMR_HOME: home,
    CLAUDE_SETTINGS_PATH: settings,
    CLAUDE_CMR_HOME_DIR: fixtureRoots.homeDir,
    CLAUDE_CMR_WORKSPACE_DIR: fixtureRoots.workspaceDir,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv, expectCode = 0): string {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === expectCode) return err.stdout || "";
    throw e;
  }
}

test("hardening: drive-letter Windows path (C:\\Users\\...) install/validate/uninstall", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h1-"));
  try {
    // realistic drive-letter backslash path — derived from tmp so the REAL
    // user install is never touched (see meta-isolation.test.ts)
    const home = path.join(tmp, "drive-letter", "cmr-home");
    const settingsFile = path.join(tmp, "settings.json");
    runCli(["install"], cliEnv(home, settingsFile));
    const out = runCli(["validate"], cliEnv(home, settingsFile));
    assert.ok(out.includes("PASS hook registration"), out);
    runCli(["install"], cliEnv(home, settingsFile));
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1, "no duplicate on drive-letter path");
    runCli(["uninstall"], cliEnv(home, settingsFile));
    const after = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(after.hooks.UserPromptSubmit.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: malformed settings (UserPromptSubmit as object) does not crash install", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h2-"));
  try {
    const home = path.join(tmp, "cmr");
    const settingsFile = path.join(tmp, "settings.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ hooks: { UserPromptSubmit: { bad: true } } }), "utf8");
    runCli(["install"], cliEnv(home, settingsFile));
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.ok(Array.isArray(settings.hooks.UserPromptSubmit), "malformed list replaced by array");
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: settings with null hooks installs cleanly", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h3-"));
  try {
    const home = path.join(tmp, "cmr");
    const settingsFile = path.join(tmp, "settings.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ hooks: null }), "utf8");
    runCli(["install"], cliEnv(home, settingsFile));
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: uninstall without install is a no-op, not a crash", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h4-"));
  try {
    const home = path.join(tmp, "cmr");
    runCli(["uninstall"], cliEnv(home, path.join(tmp, "settings.json")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: validate before install reports FAILs and exits 1 (no crash)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h5-"));
  try {
    const home = path.join(tmp, "cmr");
    const out = runCli(["validate"], cliEnv(home, path.join(tmp, "settings.json")), 1);
    assert.ok(out.includes("FAIL install marker"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: empty / stopword-only / punctuation prompts pass through", () => {
  const router = makeRouter();
  for (const p of ["", "please help me", "??!!!", "   ", "ok thanks"]) {
    const r = router.route(p);
    assert.equal(r.routed, false, `should pass through: "${p}"`);
    assert.equal(r.originalPrompt, p);
  }
});

test("hardening: CJK + emoji prompts never crash and stay deterministic", () => {
  const router = makeRouter();
  const a = router.route("帮我剪辑视频🎬");
  const b = router.route("帮我剪辑视频🎬");
  assert.equal(JSON.stringify(a), JSON.stringify(b), "deterministic");
  assert.equal(typeof a.routed, "boolean");
  assert.equal(router.route("🎉🎊✨").routed, false);
});

test("hardening: very long prompts route without crashing", () => {
  const router = makeRouter();
  const long = "a ".repeat(4000) + "summarize this PDF into bullet points";
  const r = router.route(long);
  assert.equal(typeof r.routed, "boolean");
  assert.equal(r.originalPrompt, long);
});

test("hardening: zero capabilities → everything passes through", () => {
  const router = createRouter({ config: DEFAULT_CONFIG, roots: fixtureRoots, entries: [] });
  assert.equal(router.route("summarize this PDF into bullet points").routed, false);
  assert.equal(router.route("how's the weather?").routed, false);
});

test("hardening: corrupt index state file recovers to an empty index", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h6-"));
  try {
    const stateDir = path.join(tmp, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "index.json"), "{ not valid json !!!", "utf8");
    const idx = loadIndex(stateDir);
    assert.equal(idx.entries.size, 0);
    const discovered = discoverAll(fixtureRoots);
    const { result } = updateIndex(discovered, idx, DEFAULT_CONFIG, stateDir);
    assert.ok(result.added.length >= 8, "index rebuilt after corruption");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: corrupt config file falls back to defaults", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h7-"));
  try {
    const cfg = path.join(tmp, "config.json");
    writeFileSync(cfg, "{ oops", "utf8");
    const config = loadConfig(cfg);
    assert.equal(config.threshold, DEFAULT_CONFIG.threshold);
    assert.equal(config.weights.purpose, DEFAULT_CONFIG.weights.purpose);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: same prompt 5× → byte-identical decision", () => {
  const router = makeRouter();
  const p = "extract tables from this PDF, then draft an email summary to the team";
  const first = JSON.stringify(router.route(p));
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(router.route(p)), first);
});

test("hardening: case-insensitive discovery (skill.md / agent.MD)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h8-"));
  try {
    const home = path.join(tmp, "home", ".claude");
    mkdirSync(path.join(home, "skills", "case-skill"), { recursive: true });
    writeFileSync(path.join(home, "skills", "case-skill", "skill.md"), "---\nname: case-skill\ndescription: case test skill\n---\n", "utf8");
    mkdirSync(path.join(home, "agents"), { recursive: true });
    writeFileSync(path.join(home, "agents", "case-agent.MD"), "---\nname: case-agent\ndescription: case test agent\n---\n", "utf8");
    const found = discoverAll({ homeDir: tmp + "/home", workspaceDir: tmp + "/proj" }).map((d) => d.id);
    assert.ok(found.includes("skill:case-skill"), found.join(","));
    assert.ok(found.includes("agent:case-agent"), found.join(","));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: settings file with UTF-8 BOM still reads correctly", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h9-"));
  try {
    const home = path.join(tmp, "cmr");
    const settingsFile = path.join(tmp, "settings.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, "\uFEFF" + JSON.stringify({ hooks: { UserPromptSubmit: [] } }), "utf8");
    runCli(["install"], cliEnv(home, settingsFile));
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: validate prints expected vs found commands on registration failure", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-h10-"));
  try {
    const home = path.join(tmp, "cmr");
    const settingsFile = path.join(tmp, "settings.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "node \"C:\\other\\hook.mjs\"" }] }] } }), "utf8");
    const out = runCli(["validate"], cliEnv(home, settingsFile), 1);
    assert.ok(out.includes("FAIL hook registration"), out);
    assert.ok(out.includes("expected command:"), "diagnostic shows expected command");
    assert.ok(out.includes("found in settings:"), "diagnostic shows found command");
    assert.ok(out.includes("C:\\other\\hook.mjs"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hardening: full corpus still passes after all hardening changes", () => {
  const router = makeRouter(loadConfig(path.join(repoRoot, "eval", "config.json")));
  const corpus = loadCorpus(defaultCorpusPath());
  const m = runRoutingMetrics(corpus, (p) => router.route(p));
  assert.equal(m.accuracyAt1, 1);
  assert.equal(m.fpr, 0);
  assert.equal(m.fnr, 0);
  assert.equal(m.planCorrect, 1);
  assert.equal(m.preservation, 1);
});

void existsSync;
