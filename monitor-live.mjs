/**
 * monitor-live.mjs — background watcher for the live Capability Router.
 *
 * Polls ~/.claude-cmr/logs/decisions.jsonl from EOF, prints every new decision
 * as a one-liner, and flags anomalies:
 *   - routed but no plan/primary, or confidence below the configured threshold
 *   - primary id not in the live discovery index
 *   - intent matches a known trigger phrase but routed to an unexpected skill
 *   - hook wrapper file missing (broken install)
 *
 * Output: stdout + appends to ~/.claude-cmr/logs/watch.log
 */
import { readFileSync, statSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const LOG = path.join(os.homedir(), ".claude-cmr", "logs", "decisions.jsonl");
const WATCH_LOG = path.join(os.homedir(), ".claude-cmr", "logs", "watch.log");
const WRAPPER = path.join(os.homedir(), ".claude-cmr", "hook-wrapper.mjs");
const POLL_MS = 5000;

// trigger phrase -> expected primary id (soft check; primary must contain the skill name)
const EXPECTED = {
  ponytail: "ponytail", yagni: "ponytail", laziest: "ponytail", boilerplate: "ponytail",
  caveman: "caveman",
  graphify: "graphify", knowledge: "graphify",
  brainstorm: "brainstorming",
  "skill for": "find-skills", "find a skill": "find-skills",
  minimalist: "minimalist-ui", bento: "minimalist-ui", monochrome: "minimalist-ui",
  "visual design": "frontend-design", typography: "frontend-design", templated: "frontend-design",
  "ux": "ui-ux-pro-max", accessibility: "ui-ux-pro-max", palette: "ui-ux-pro-max",
  "write the plan": "writing-plans", "before touching code": "writing-plans",
  "execute": "executing-plans", checkpoint: "executing-plans",
  "run evals": "skill-creator", benchmark: "skill-creator",
  compress: "caveman-compress",
};

let known = new Set();
try {
  known = new Set(
    execFileSync(process.execPath, ["dist/src/cli.js", "list"], { cwd: process.cwd(), encoding: "utf8" })
      .split(/\r?\n/).map((l) => l.match(/^\S+\s+(\S+)\s+(\S+)/)?.[1]).filter(Boolean),
  );
} catch {
  /* discovery index unavailable; known-id check disabled */
}

function flag(msg) {
  const line = `[FLAG ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(WATCH_LOG, line + "\n");
}

function softFlag(msg) {
  const line = `[warn ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(WATCH_LOG, line + "\n");
}

function tailNewLines(file, fromByte) {
  if (!existsSync(file)) return { lines: [], size: 0 };
  const size = statSync(file).size;
  if (size <= fromByte) return { lines: [], size };
  const chunk = readFileSync(file, "utf8").slice(fromByte);
  return { lines: chunk.split(/\r?\n/).filter(Boolean), size };
}

let pos = existsSync(LOG) ? statSync(LOG).size : 0;
console.log(`[monitor] watching ${LOG} (${known.size} known capabilities, starting at byte ${pos})`);
appendFileSync(WATCH_LOG, `[monitor start ${new Date().toISOString()}] ${known.size} known capabilities\n`);

setInterval(() => {
  if (!existsSync(WRAPPER)) flag("hook wrapper missing: " + WRAPPER + " — hook is silently passing everything through");
  const { lines, size } = tailNewLines(LOG, pos);
  pos = size;
  for (const line of lines) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      softFlag("unparseable decision line: " + line);
      continue;
    }
    const routed = d.routed === true;
    const step = d.plan?.[0];
    const primary = step?.primary || null;
    const conf = step?.confidence;
    const intent = step?.intent || "";
    const snippet = (d.prompt || "").replace(/\s+/g, " ").trim().slice(0, 90);
    const one = `${d.ts} ${routed ? `route -> ${primary} (${(conf * 100).toFixed(0)}%)` : "pass-through"} | ${snippet}`;
    console.log(one);
    appendFileSync(WATCH_LOG, one + "\n");
    if (routed) {
      if (!primary || !conf) flag("routed=true but missing primary/confidence: " + line);
      else if (conf < 0.38) flag(`confidence ${conf.toFixed(3)} below threshold 0.38 for ${primary}: ${intent}`);
      if (known.size && !known.has(primary)) flag(`primary ${primary} not in discovery index: ${intent}`);
      for (const [trigger, expected] of Object.entries(EXPECTED)) {
        if (intent.toLowerCase().includes(trigger) && !String(primary).includes(expected)) {
          softFlag(`'${trigger}' in intent '${intent}' but routed to ${primary} (expected ~${expected})`);
        }
      }
    }
  }
}, POLL_MS);
