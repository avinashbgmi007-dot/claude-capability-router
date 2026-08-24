/**
 * live-check.mjs — one command, shareable snapshot of real-world behavior.
 *
 * Run this AFTER typing a few trigger prompts into Claude Code (see header
 * it prints), then paste the whole output back for analysis.
 *
 * Run: npm run live:check
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.CLAUDE_CMR_HOME || path.join(os.homedir(), ".claude-cmr");
const node = process.execPath;
const cli = (args) => execFileSync(node, [path.join(repoRoot, "dist", "src", "cli.js"), ...args], { encoding: "utf8" });

console.log("=================================================================");
console.log(" CMR LIVE CHECK — how to produce data first:");
console.log("----------------------------------------------------------------");
console.log(" 1. Fully restart Claude Code (so hooks reload).");
console.log(" 2. Type these prompts, one at a time:");
console.log("      a) summarize this PDF into bullet points   (should route)");
console.log("      b) ship my changes and open a pull request (command route)");
console.log("      c) how's the weather today?                (must NOT route)");
console.log("      d) @cmr what do you think about this architecture doc?");
console.log("         (forced route past threshold)");
console.log(" 3. In prompt (a)/(b): when Claude answers, check whether it");
console.log("    ACTUALLY used the named skill/command. That obedience is");
console.log("    exactly what the compliance numbers measure.");
console.log("=================================================================");
console.log("");

// --- install integrity -------------------------------------------------------
let failures = 0;
if (!existsSync(path.join(home, "hook-wrapper.mjs"))) {
  console.log("=================================================================");
  console.log(" INSTALL IS BROKEN: hook-wrapper.mjs missing from " + home);
  console.log(" Every hook invocation is erroring right now. Run: npm run install:cr");
  console.log(" (agents asked to 'fix settings' have been known to uninstall things)");
  console.log("=================================================================");
  failures++;
}
try {
  const v = cli(["validate"]);
  for (const line of v.split("\n")) if (/^(PASS|FAIL) /.test(line)) console.log(line);
  if (v.includes("FAIL")) failures++;
} catch {
  console.log("FAIL validate crashed — is the runtime built? (npm run build)");
  failures++;
}

// --- recent decisions ---------------------------------------------------------
const decisionsFile = path.join(home, "logs", "decisions.jsonl");
if (!existsSync(decisionsFile)) {
  console.log(`\nno decisions log at ${decisionsFile} — type the trigger prompts in Claude Code first.`);
} else {
  const lines = readFileSync(decisionsFile, "utf8").trim().split("\n").filter(Boolean);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((d) => d && Date.parse(d.ts) >= cutoff);
  console.log(`\ndecisions (last 24h): ${recent.length} of ${lines.length} total`);
  for (const d of recent.slice(-8)) {
    const p = d.plan?.[0];
    const label = d.routed ? `route -> ${p?.primary} (${((p?.confidence ?? 0) * 100).toFixed(0)}%)` : "pass-through";
    const snippet = (d.prompt || "(text not recorded — pre-prompt-format entry)").replace(/\s+/g, " ").slice(0, 70);
    console.log(`  [${d.ts.slice(11, 19)}] ${label.padEnd(46)} | ${snippet}`);
  }
}

// --- fidelity / compliance ----------------------------------------------------
try {
  console.log("\n" + cli(["stats", "--days", "7"]));
} catch (e) {
  console.log("stats failed:", e.message);
  failures++;
}

console.log(failures === 0 ? "\nALL CHECKS RAN — paste this entire output back." : `\n${failures} check(s) failed — paste everything back anyway.`);
