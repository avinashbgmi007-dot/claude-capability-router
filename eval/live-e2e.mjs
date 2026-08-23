/**
 * live-e2e.mjs — live end-to-end test against the installed CMR.
 *
 *   1. install       — node dist/src/cli.js install   (idempotent)
 *   2. selftest      — node dist/src/cli.js selftest  (spawns the real wrapper)
 *   3. real prompts  — pipes real prompts through the installed hook-wrapper.mjs
 *                      and verifies decisions.jsonl gains matching entries
 *                      (routed prompts: intent + primary must match; chat: routed:false)
 *
 * Uses the live install (~/.claude-cmr by default, or CLAUDE_CMR_HOME).
 * Run: npm run live:e2e
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.CLAUDE_CMR_HOME || path.join(os.homedir(), ".claude-cmr");
const wrapper = path.join(home, "hook-wrapper.mjs");
const logFile = path.join(home, "logs", "decisions.jsonl");
const env = { ...process.env, CLAUDE_CMR_HOME: home };

const node = process.execPath;
let failures = 0;
const check = (name, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

function runCli(args) {
  return spawnSync(node, [path.join(repoRoot, "dist", "src", "cli.js"), ...args], { encoding: "utf8", env });
}

// --- 1. install -----------------------------------------------------------
console.log("== step 1: install ==");
const inst = runCli(["install"]);
check("install exits 0", inst.status === 0, (inst.stdout || "").split("\n")[1]?.trim() || "");
check("wrapper installed", existsSync(wrapper));

// --- 2. selftest ----------------------------------------------------------
console.log("\n== step 2: selftest ==");
const self = runCli(["selftest"]);
check("selftest exits 0", self.status === 0);
for (const line of (self.stdout || "").split("\n")) {
  if (/^(PASS|FAIL) /.test(line)) console.log(`  ${line}`);
}

// --- 3. real prompts land in decisions.jsonl -----------------------------
console.log("\n== step 3: decisions.jsonl records real prompts ==");
const CASES = [
  { prompt: "ponytail this refactor laziest simplest solution yagni no boilerplate", expect: { routed: true, primary: "skill:ponytail" } },
  { prompt: "talk like caveman be brief use less tokens", expect: { routed: true, primary: "skill:caveman" } },
  { prompt: "graphify this repo map the codebase architecture and file relationships", expect: { routed: true, primary: "skill:graphify" } },
  { prompt: "here's the spec write the plan before touching code", expect: { routed: true, primary: "skill:writing-plans" } },
  { prompt: "how's the weather today?", expect: { routed: false } },
];

const start = existsSync(logFile) ? statSync(logFile).size : 0;
const before = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).length : 0;

for (const c of CASES) {
  const res = spawnSync(node, [wrapper], {
    input: JSON.stringify({ prompt: c.prompt, hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
    timeout: 20000,
    env,
  });
  const out = (res.stdout || "").trim();
  const hasBlock = out.startsWith('{"hookSpecificOutput"') && out.includes("<capability-routing>");
  check(
    `wrapper answers for "${c.prompt.slice(0, 30)}..."`,
    !res.error && (c.expect.routed ? hasBlock : out === "{}"),
    res.error ? `wrapper crashed: ${res.error.message}` : "",
  );
}

// read only the lines appended by this run
const after = readFileSync(logFile, "utf8");
const newLines = after.split("\n").filter(Boolean).slice(before);
check("decision log grew by " + CASES.length, newLines.length >= CASES.length, `+${newLines.length} entries`);

for (const c of CASES) {
  const entry = newLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => {
    if (!e) return false;
    if (c.expect.routed) return e.routed === true && (e.plan?.[0]?.intent || "").includes(c.prompt.slice(0, 20));
    return e.routed === false && !e.plan?.length;
  });
  if (c.expect.routed) {
    check(
      `log routes "${c.prompt.slice(0, 24)}..." to ${c.expect.primary}`,
      !!entry && entry.plan?.[0]?.primary === c.expect.primary,
      entry ? `got ${entry.plan?.[0]?.primary} (${(entry.plan?.[0]?.confidence || 0).toFixed(2)})` : "no matching entry",
    );
  } else {
    check(`log passes through "${c.prompt}"`, !!entry, entry ? "" : "no pass-through entry found");
  }
}

// sanity: hook wrapper must not have error log after live traffic
const errLog = path.join(home, "logs", "wrapper-error.log");
if (existsSync(errLog) && statSync(errLog).size > 0) {
  check("no wrapper errors", false, readdirSync(path.join(home, "logs")).includes("wrapper-error.log"));
} else {
  check("no wrapper errors", true);
}

console.log(failures === 0 ? "\nLIVE E2E: ALL PASS" : `\nLIVE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
