/**
 * simulate.mjs — compress a week of usage into seconds.
 *
 * Generates a deterministic, seeded session stream from the eval corpus and
 * pipes it through the REAL installed hook wrapper into a SANDBOXED
 * CLAUDE_CMR_HOME (never touches ~/.claude-cmr), then runs stats on the
 * sandbox logs.
 *
 * What this proves: the measurement machinery (decision/usage correlation,
 * fidelity math, log rotation) works at week-scale volume.
 * What this CANNOT prove: real model obedience. Invocation events are
 * emitted by an explicit obedience MODEL (--obey / --override) — every
 * fidelity number below is conditioned on those assumptions, not reality.
 *
 * Run: npm run simulate -- --days 7 --sessions-per-day 4 --obey 0.85 --override 0.05 --seed 42
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const DAYS = flag("days", 7);
const SESSIONS_PER_DAY = flag("sessions-per-day", 4);
const OBEY = flag("obey", 0.85);
const OVERRIDE = flag("override", 0.05);
const SEED = flag("seed", 42);

// deterministic LCG — same seed → identical stream on any platform
let state = SEED >>> 0;
const rand = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};

/** Map a capability id to the ToolUse shape Claude Code would emit for it. */
function idToToolUse(id) {
  if (id.startsWith("skill:") || id.startsWith("plugin-skill:")) {
    return { name: "Skill", input: { name: id.split(":")[1] } };
  }
  if (id.startsWith("mcp-server:")) {
    const server = id.split(":")[1];
    return { name: `mcp__${server}__main` };
  }
  if (id.startsWith("agent:") || id.startsWith("plugin-agent:")) {
    return { name: "Task", input: { subagent_type: id.split(":")[1] } };
  }
  return null; // commands have no ToolUse equivalent
}

const corpus = JSON.parse(readFileSync(path.join(repoRoot, "eval", "corpus.json"), "utf8"));
const routable = corpus.cases.filter((c) => c.expect.route);
const chat = corpus.cases.filter((c) => !c.expect.route);

// --- build the event stream -------------------------------------------------
const events = [];
for (let day = 0; day < DAYS; day++) {
  for (let s = 0; s < SESSIONS_PER_DAY; s++) {
    const sessionId = `sim-d${day}-s${s}`;
    const promptCount = 1 + Math.floor(rand() * 3); // 1..3 prompts per session
    for (let p = 0; p < promptCount; p++) {
      const useRoutable = rand() < 0.7;
      const pool = useRoutable ? routable : chat;
      const c = pool[Math.floor(rand() * pool.length)];
      events.push({ day, sessionId, kind: "prompt", payload: { prompt: c.prompt, hook_event_name: "UserPromptSubmit", session_id: sessionId } });
    }
  }
}

// --- sandbox install ---------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-sim-"));
try {
  const home = path.join(tmp, "cmr");
  const fixtures = {
    homeDir: path.join(repoRoot, "test", "fixtures", "home"),
    workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
  };
  const env = {
    ...process.env,
    CLAUDE_CMR_HOME: home,
    CLAUDE_SETTINGS_PATH: path.join(tmp, "settings.json"),
    CLAUDE_CMR_HOME_DIR: fixtures.homeDir,
    CLAUDE_CMR_WORKSPACE_DIR: fixtures.workspaceDir,
  };
  spawnSync(process.execPath, [path.join(repoRoot, "dist", "src", "cli.js"), "install"], { env });
  const wrapper = path.join(home, "hook-wrapper.mjs");
  const decisionsFile = path.join(home, "logs", "decisions.jsonl");

  let obeyed = 0;
  let overrides = 0;
  let skippedNoPrimary = 0;

  // index loop + splice: each ToolUse must land immediately after its own
  // prompt, or it falls into a later decision's correlation window
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === "prompt") {
      spawnSync(process.execPath, [wrapper], { input: JSON.stringify(ev.payload), env });
      // read the decision we just caused → what did the router pick?
      let primary = null;
      if (existsSync(decisionsFile)) {
        const lines = readFileSync(decisionsFile, "utf8").trim().split("\n");
        for (let j = lines.length - 1; j >= 0; j--) {
          try {
            const d = JSON.parse(lines[j]);
            if (d.sessionId === ev.payload.session_id) {
              primary = d.plan?.[0]?.primary ?? null;
              break;
            }
          } catch {
            /* skip */
          }
        }
      }
      if (!primary) {
        skippedNoPrimary++;
        continue;
      }
      // obedience model: obey → invoke the routed primary; override → invoke something else
      const roll = rand();
      const targetId = roll < OBEY ? primary : roll < OBEY + OVERRIDE ? "skill:caveman" : null;
      if (targetId == null) continue; // model "ignored" the block
      if (targetId !== primary) overrides++;
      else obeyed++;
      const toolUse = idToToolUse(targetId);
      if (!toolUse) continue; // e.g. command primaries can't be invoked via ToolUse
      events.splice(i + 1, 0, {
        kind: "tooluse",
        payload: { hook_event_name: "PreToolUse", session_id: ev.payload.session_id, tool_use: toolUse },
      });
    } else {
      spawnSync(process.execPath, [wrapper], { input: JSON.stringify(ev.payload), env });
    }
  }

  // --- measure ---------------------------------------------------------------
  const statsOut = spawnSync(process.execPath, [path.join(repoRoot, "dist", "src", "cli.js"), "stats", "--json"], {
    env,
    encoding: "utf8",
  });
  const stats = JSON.parse(statsOut.stdout);

  console.log(`=== week simulator (seeded, sandboxed) ===`);
  console.log(
    `assumptions: days=${DAYS} sessions/day=${SESSIONS_PER_DAY} obey=${OBEY} override=${OBEY < 1 ? OVERRIDE : 0} seed=${SEED}`,
  );
  console.log(
    `stream: ${events.length} hook invocations (${events.filter((e) => e.kind === "prompt").length} prompts); model obeyed=${obeyed} overrode=${overrides} no-primary=${skippedNoPrimary}`,
  );
  console.log(
    `sandbox result: decisions=${stats.decisions} routed=${stats.routedDecisions} compliant=${stats.compliant} ignored=${stats.ignored} overridden=${stats.overridden} silentWins=${stats.silentWins.length} fidelity=${(stats.fidelity * 100).toFixed(1)}%`,
  );
  const digest = createHash("sha256").update(JSON.stringify({ ...stats, lastUpdated: undefined })).digest("hex").slice(0, 16);
  console.log(`determinism digest: ${digest}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
