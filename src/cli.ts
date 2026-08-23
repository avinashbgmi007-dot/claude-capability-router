#!/usr/bin/env node
/**
 * Capability Manager CLI — installer + explain + validate.
 *
 *   node dist/src/cli.js install      idempotent hook registration
 *   node dist/src/cli.js uninstall    remove hook + runtime (boundary-safe)
 *   node dist/src/cli.js validate     integrity check
 *   node dist/src/cli.js explain "<prompt>"   scoring breakdown
 *
 * Env overrides (tests): CLAUDE_CMR_HOME, CLAUDE_SETTINGS_PATH,
 * CLAUDE_CMR_HOME_DIR, CLAUDE_CMR_WORKSPACE_DIR.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmrHome, settingsPath, discoveryRoots, logsDir } from "./paths.js";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";
import { createRouter } from "./router.js";
import { buildEnhancedPrompt } from "./enhancer.js";
import { loadDecisionLog, loadUsageLog } from "./logs.js";
import { computeStats } from "./stats.js";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url)); // dist/src
const REPO_ROOT = path.resolve(CLI_DIR, "..", "..");
const RUNTIME_SRC = path.join(CLI_DIR);
const WRAPPER_SRC = path.join(REPO_ROOT, "hook-wrapper.mjs");

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

function copyRuntime(home: string): void {
  const runtimeDest = path.join(home, "runtime", "capability-router");
  mkdirSync(runtimeDest, { recursive: true });
  // mark the runtime as ESM — without this, Node treats the .js files as CJS
  writeFileSync(path.join(runtimeDest, "package.json"), JSON.stringify({ name: "capability-router-runtime", type: "module", private: true }, null, 2), "utf8");
  const files = readdirSync(RUNTIME_SRC).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"));
  for (const f of files) {
    copyFileSync(path.join(RUNTIME_SRC, f), path.join(runtimeDest, f));
  }
  copyFileSync(WRAPPER_SRC, path.join(home, "hook-wrapper.mjs"));
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    // strip UTF-8 BOM — some Windows editors write one and JSON.parse rejects it
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(file: string, settings: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(settings, null, 2));
}

function hookCommand(home: string): string {
  return `node "${path.join(home, "hook-wrapper.mjs")}"`;
}

/**
 * Structured registration check. Compares parsed `command` fields directly —
 * string-matching against JSON.stringify breaks on Windows because JSON
 * escapes backslashes (`C:\\Users\\...`) differently than the raw command.
 */
export function hasHookRegistration(entryList: Array<Record<string, unknown>>, cmd: string): boolean {
  for (const e of entryList) {
    const hooks = e.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const command = (h as { command?: unknown }).command;
      if (typeof command === "string" && command === cmd) return true;
    }
  }
  return false;
}

/** Tolerate malformed settings: each event list must be an array (else []). */
function getHookList(hooks: Record<string, unknown>, event: string): Array<Record<string, unknown>> {
  const v = hooks[event];
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/** Events this tool registers. SessionEnd is deliberately NOT registered (no-op hook). */
const REGISTER_EVENTS = ["UserPromptSubmit", "PreToolUse"] as const;
/** Events cleaned up on install/uninstall — includes stale registrations from older versions. */
const CLEANUP_EVENTS = ["UserPromptSubmit", "PreToolUse", "SessionEnd"] as const;

export function install(): void {
  const home = cmrHome();
  mkdirSync(home, { recursive: true });
  copyRuntime(home);
  const marker = { version: "0.1.5", installedAt: new Date().toISOString() };
  writeFileSync(path.join(home, ".install-marker"), JSON.stringify(marker, null, 2), "utf8");
  const cfgFile = path.join(home, "config.json");
  if (!existsSync(cfgFile)) writeFileSync(cfgFile, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");

  const settingsFile = settingsPath();
  const settings = readSettings(settingsFile);
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const cmd = hookCommand(home);
  let changed = false;
  // sweep stale own registrations first (e.g. SessionEnd from older versions)…
  for (const ev of CLEANUP_EVENTS) {
    const list = getHookList(hooks, ev);
    const filtered = list.filter((e) => !hasHookRegistration([e], cmd));
    if (filtered.length !== list.length) {
      hooks[ev] = filtered;
      changed = true;
    }
  }
  // …then register the current event set (idempotent)
  for (const ev of REGISTER_EVENTS) {
    const list = getHookList(hooks, ev);
    if (!hasHookRegistration(list, cmd)) {
      hooks[ev] = [...list, { matcher: "", hooks: [{ type: "command", command: cmd }] }];
      changed = true;
    }
  }
  if (changed) {
    settings.hooks = hooks;
    writeSettings(settingsFile, settings);
  }
  console.log(`Installed v0.1.5 to ${home}`);
  console.log(`Hooks (${REGISTER_EVENTS.join(", ")}) registered in ${settingsFile}`);
}

export function uninstall(): void {
  const home = cmrHome();
  const settingsFile = settingsPath();
  const settings = readSettings(settingsFile);
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const cmd = hookCommand(home);
  let changed = false;
  for (const ev of CLEANUP_EVENTS) {
    const list = getHookList(hooks, ev);
    const filtered = list.filter((e) => !hasHookRegistration([e], cmd));
    if (filtered.length !== list.length) {
      hooks[ev] = filtered;
      changed = true;
    }
  }
  if (changed) {
    settings.hooks = hooks;
    writeSettings(settingsFile, settings);
  }
  rmSync(path.join(home, "runtime"), { recursive: true, force: true });
  rmSync(path.join(home, "hook-wrapper.mjs"), { force: true });
  rmSync(path.join(home, ".install-marker"), { force: true });
  console.log(`Uninstalled from ${home}`);
}

export function validate(): boolean {
  const home = cmrHome();
  const checks: Array<[string, boolean]> = [
    ["install marker", existsSync(path.join(home, ".install-marker"))],
    ["hook wrapper", existsSync(path.join(home, "hook-wrapper.mjs"))],
    ["runtime dir", existsSync(path.join(home, "runtime", "capability-router", "router.js"))],
  ];
  const settingsFile = settingsPath();
  const settings = readSettings(settingsFile);
  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const expected = hookCommand(home);
  const registered = hasHookRegistration(getHookList(hooks, "UserPromptSubmit"), expected);
  checks.push(["hook registration (UserPromptSubmit)", registered]);
  checks.push(["hook registration (PreToolUse)", hasHookRegistration(getHookList(hooks, "PreToolUse"), expected)]);
  checks.push(["stale SessionEnd removed", !hasHookRegistration(getHookList(hooks, "SessionEnd"), expected)]);
  checks.push(["runtime esm marker", existsSync(path.join(home, "runtime", "capability-router", "package.json"))]);
  if (!registered) {
    const found = getHookList(hooks, "UserPromptSubmit")
      .flatMap((e) => (Array.isArray(e.hooks) ? (e.hooks as Array<{ command?: unknown }>).map((h) => String(h.command ?? "(no command field)")) : ["(no hooks array)"]));
    console.log(`  expected command: ${expected}`);
    console.log(`  found in settings: ${found.length ? found.join(" | ") : "(none)"}`);
  }
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  return ok;
}

/** Print every capability discovered from the real discovery roots. */
export function listCapabilities(): void {
  const config = loadConfig(path.join(cmrHome(), "config.json"));
  const roots = discoveryRoots();
  const router = createRouter({ config, roots });
  const entries = router.entries().sort((a, b) => a.id.localeCompare(b.id));
  if (entries.length === 0) {
    console.log("No capabilities discovered.");
    console.log("Searched: ~/.claude/skills, <workspace>/.claude/skills, ~/.claude/agents, <workspace>/.claude/agents,");
    console.log("          ~/.claude/plugins/*/plugin-root/{skills,agents}, .mcp.json, ~/.claude.json mcpServers");
    console.log("Add a skill under ~/.claude/skills/<name>/SKILL.md and re-run this command.");
    return;
  }
  for (const e of entries) {
    console.log(`${e.enabled ? "ON " : "OFF"} ${e.id.padEnd(30)} ${e.kind.padEnd(12)} invoke=${e.invocation}`);
  }
  console.log(`\n${entries.filter((e) => e.enabled).length} enabled / ${entries.length} total`);
}

/**
 * End-to-end self-test on the INSTALLED copy: spawns the actual
 * hook-wrapper.mjs with a test prompt and verifies stdout + decision log.
 * Any wrapper crash lands in logs/wrapper-error.log (visible here).
 */
export function selftest(): number {
  const home = cmrHome();
  const wrapper = path.join(home, "hook-wrapper.mjs");
  const checks: Array<[string, boolean]> = [["wrapper exists", existsSync(wrapper)]];
  let ok = checks.every(([, p]) => p);

  if (ok) {
    const res = spawnSync(process.execPath, [wrapper], {
      input: JSON.stringify({ prompt: "summarize this PDF into bullet points", hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
      timeout: 20000,
      env: process.env,
    });
    const out = (res.stdout || "").trim();
    checks.push(["wrapper executed", res.error ? false : true]);
    checks.push([
      "wrapper output valid",
      out === "{}" || out.startsWith('{"hookSpecificOutput"'),
    ]);
    if (out && out !== "{}") {
      console.log(`  wrapper output: ${out.slice(0, 120)}...`);
    } else {
      console.log(`  wrapper output: ${out || "(empty)"}`);
    }

    const logFile = path.join(home, "logs", "decisions.jsonl");
    checks.push(["decision log written", existsSync(logFile)]);
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
      checks.push(["decision log has entries", lines.length > 0]);
      const last = lines[lines.length - 1] || "";
      if (last) {
        try {
          const entry = JSON.parse(last) as { routed?: boolean; plan?: Array<{ primary: string | null }> };
          console.log(`  last log entry: routed=${entry.routed} primary=${entry.plan?.[0]?.primary ?? "none"}`);
        } catch {
          /* ignore */
        }
      }
    }
    const errLog = path.join(home, "logs", "wrapper-error.log");
    checks.push(["no wrapper errors", !existsSync(errLog)]);
    if (existsSync(errLog)) console.log(`  wrapper-error.log: ${readFileSync(errLog, "utf8").slice(0, 300)}`);
  }

  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  return ok ? 0 : 1;
}

export function explain(prompt: string): void {
  const config = loadConfig(path.join(cmrHome(), "config.json"));
  const roots = discoveryRoots();
  const router = createRouter({ config, roots });
  const ex = router.explain(prompt);
  console.log(`prompt: ${ex.prompt}`);
  console.log(`tokens: [${ex.tokens.join(", ")}]`);
  console.log(`threshold: ${ex.threshold} | decision: ${ex.decision}`);
  for (const r of ex.ranked) {
    const fs = r.fieldScores;
    console.log(
      `  ${r.entry.id.padEnd(28)} conf=${r.confidence.toFixed(3)}  purpose=${fs.purpose.toFixed(2)} actions=${fs.actions.toFixed(2)} domains=${fs.domains.toFixed(2)} examples=${fs.examples.toFixed(2)} desc=${fs.description.toFixed(2)} name=${fs.name.toFixed(2)} body=${fs.body.toFixed(2)}`,
    );
  }
  const req = router.route(prompt);
  if (req.routed) {
    console.log(`\nenhanced block:\n${buildEnhancedPrompt(req, config)}`);
  }
}

/**
 * Join decisions.jsonl × usage.jsonl per session → last-mile compliance report.
 * Report-only by design: it measures whether routed capabilities actually get
 * invoked, and surfaces silent wins (pass-through prompts that triggered a
 * capability anyway) as corpus material.
 */
export function stats(opts: { days?: number; json?: boolean } = {}): void {
  const dir = logsDir();
  let decisions = loadDecisionLog(dir);
  const usage = loadUsageLog(dir);
  if (opts.days && opts.days > 0) {
    const cutoff = Date.now() - opts.days * 24 * 3600 * 1000;
    const inWindow = (e: { ts: string }) => {
      const t = Date.parse(e.ts);
      return !Number.isNaN(t) && t >= cutoff;
    };
    decisions = decisions.filter(inWindow);
  }
  const s = computeStats(decisions, usage);
  if (opts.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`);
  console.log(`CMR stats — ${s.decisions} decisions (${s.attributedDecisions} attributed), ${s.routedDecisions} routed`);
  console.log(`compliance (routed & invoked): ${pct(s.compliant, s.routedDecisions)}`);
  console.log(`ignored    (routed, unused):  ${pct(s.ignored, s.routedDecisions)}`);
  console.log(`override   (invoked other):   ${pct(s.overridden, s.routedDecisions)}`);
  console.log(`silent wins (pass-through but invoked): ${s.silentWins.length}`);
  const unattributed = s.decisions - s.attributedDecisions;
  if (unattributed > 0) console.log(`unattributed entries (no session_id, pre-stats format): ${unattributed}`);
  if (s.perCapability.length) {
    console.log("\nper-capability:");
    for (const c of s.perCapability.slice(0, 15)) {
      console.log(`  ${c.id.padEnd(34)} routed=${String(c.routedAsPrimary).padEnd(4)} invoked=${String(c.invoked).padEnd(4)} ignored=${c.ignoredDecisions}`);
    }
  }
  if (s.silentWins.length) {
    console.log("\nsilent-win corpus candidates (label + add to eval/corpus.json):");
    for (const w of s.silentWins.slice(0, 10)) {
      console.log(`  "${w.prompt.replace(/\s+/g, " ").trim().slice(0, 90)}" -> ${w.invokedIds.join(", ")}`);
    }
  }
}

function usage(): void {
  console.log(`Usage: node dist/src/cli.js <install|uninstall|validate|list|selftest|stats|explain "<prompt>">`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "validate":
    process.exit(validate() ? 0 : 1);
    break;
  case "list":
    listCapabilities();
    break;
  case "selftest":
    process.exit(selftest());
    break;
  case "stats": {
    const daysIdx = rest.indexOf("--days");
    const days = daysIdx >= 0 ? Number(rest[daysIdx + 1]) : undefined;
    stats({ days: Number.isFinite(days) ? days : undefined, json: rest.includes("--json") });
    break;
  }
  case "explain":
    if (!rest.length) usage();
    explain(rest.filter((a) => a !== "--json").join(" "));
    break;
  default:
    usage();
}
