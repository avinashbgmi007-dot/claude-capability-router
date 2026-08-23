#!/usr/bin/env node
/**
 * Hook wrapper — Claude Code UserPromptSubmit hook.
 * Reads hook JSON from stdin, runs the capability router, records the
 * decision locally, and emits the Claude Code hook output on stdout:
 *   - pass-through / failure → {} (Claude Code continues unchanged)
 *   - routed → { hookSpecificOutput: { hookEventName, additionalContext: [block] } }
 *
 * additionalContext is emitted in ARRAY form (the documented Claude Code
 * shape) — a bare string can be silently ignored by Claude Code.
 *
 * The wrapper never throws: any error degrades to pass-through.
 * It also self-heals a stale install (rewrites the runtime ESM marker if
 * the copied runtime was installed by an older version).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(SCRIPT_DIR, "runtime", "capability-router");

// install root == this script's directory (config + logs live beside it)
process.env.CLAUDE_CMR_HOME = SCRIPT_DIR;

/**
 * Dynamic imports MUST use file:// URLs — on Windows a bare absolute path
 * like `C:\Users\...\config.js` makes the ESM loader throw
 * ERR_UNSUPPORTED_ESM_URL_SCHEME (it parses `C:` as a URL scheme).
 */
function rt(moduleName) {
  return import(pathToFileURL(path.join(RUNTIME, moduleName)).href);
}

// self-heal: the copied runtime must be treated as ESM by Node
try {
  const pkg = path.join(RUNTIME, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: "capability-router-runtime", type: "module", private: true }, null, 2));
  }
} catch {
  /* pass-through fallback */
}

function outEmpty() {
  process.stdout.write("{}");
}

/**
 * Map a ToolUse tool to a capability id. Best-effort: unknown tools → null
 * (never logged). Covers skills (Skill tool), MCP (mcp__server__tool), and
 * agents/subagents (Agent/Task tools).
 */
function capabilityIdFromToolUse(toolUse) {
  const name = (toolUse && toolUse.name) || "";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.length >= 2 && parts[1] ? `mcp-server:${parts[1]}` : null;
  }
  if (name === "Skill") {
    const n = toolUse.input && toolUse.input.name;
    return typeof n === "string" && n ? `skill:${n}` : null;
  }
  if (name === "Agent" || name === "Task") {
    const t = toolUse.input && (toolUse.input.subagent_type || toolUse.input.agent);
    return typeof t === "string" && t ? `agent:${t}` : null;
  }
  return null;
}

/** Any failure: record it to logs/wrapper-error.log, then pass through safely. */
function crash(e) {
  try {
    const dir = path.join(SCRIPT_DIR, "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "wrapper-error.log"),
      `${new Date().toISOString()} ${(e && e.stack) || String(e)}\n`,
      { flag: "a" },
    );
  } catch {
    /* never throw */
  }
  if (process.env.CLAUDE_CMR_DEBUG === "1") console.error("CMR wrapper error:", e);
  outEmpty();
}

async function main() {
  const raw = readFileSync(0, "utf8").trim();
  if (!raw) return outEmpty();
  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    return outEmpty();
  }

  const event = hook.hook_event_name || "UserPromptSubmit";
  if (event === "PreToolUse" || event === "ToolUse") {
    // side-effect only: record the invoked capability, never shape output
    const { appendUsageLog } = await rt("logs.js");
    const id = capabilityIdFromToolUse(hook.tool_use);
    if (id) {
      appendUsageLog(
        { ts: new Date().toISOString(), capabilityId: id, invoked: true, source: "tool-use" },
        path.join(SCRIPT_DIR, "logs"),
      );
    }
    return outEmpty();
  }
  if (event === "SessionEnd") {
    // ponytail: stateless hook can't attribute session usage to a capability;
    // parse transcript_path into per-session usage if that ever matters
    return outEmpty();
  }

  const prompt = typeof hook.prompt === "string" ? hook.prompt : "";
  if (!prompt) return outEmpty();
  // system task-notifications (subagent stopped/paused) are not user prompts — never route them
  if (prompt.trimStart().startsWith("<task-notification>")) return outEmpty();

  const { loadConfig } = await rt("config.js");
  const { discoveryRoots } = await rt("paths.js");
  const { createRouter } = await rt("router.js");
  const { buildEnhancedPrompt } = await rt("enhancer.js");
  const { toDecisionEntry, appendDecisionLog } = await rt("logs.js");

  const config = loadConfig(path.join(SCRIPT_DIR, "config.json"));
  const router = createRouter({ config, roots: discoveryRoots(), usageDir: path.join(SCRIPT_DIR, "logs") });
  const req = router.route(prompt);
  appendDecisionLog(toDecisionEntry(req), path.join(SCRIPT_DIR, "logs"));
  if (process.env.CLAUDE_CMR_DEBUG === "1") {
    console.error(`CMR debug: routed=${req.routed} entries=${router.entries().length}`);
  }
  if (!req.routed) return outEmpty();

  const block = buildEnhancedPrompt(req, config);
  if (!block) return outEmpty();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: [block] },
    }),
  );
}

main().catch(crash);
