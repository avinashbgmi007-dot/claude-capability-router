#!/usr/bin/env node
/**
 * Hook wrapper — Claude Code UserPromptSubmit hook.
 * Reads hook JSON from stdin, runs the capability router, records the
 * decision locally, and emits the Claude Code hook output on stdout:
 *   - pass-through / failure → {} (Claude Code continues unchanged)
 *   - routed → { hookSpecificOutput: { hookEventName, additionalContext: block } }
 *
 * additionalContext MUST be a plain STRING. An array fails Claude Code's
 * hook-output schema validation ("Hook JSON output validation failed —
 * (root): Invalid input") and the routing block is silently discarded —
 * observed live on 2026-08-24: routed prompts errored while {} passed.
 *
 * The wrapper never throws: any error degrades to pass-through.
 * It also self-heals a stale install (rewrites the runtime ESM marker if
 * the copied runtime was installed by an older version).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

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
 *
 * Payload shapes: current Claude Code sends `tool_name` + `tool_input` as
 * TOP-LEVEL hook fields; older builds nested them under `tool_use`. Read
 * both — reading only the legacy shape meant live Skill invocations were
 * never recorded (compliance measured 0% while the model obeyed).
 */
function capabilityIdFromToolUse(hook) {
  const name = hook.tool_name || (hook.tool_use && hook.tool_use.name) || "";
  const input = hook.tool_input || (hook.tool_use && hook.tool_use.input) || {};
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    // plugin-provided servers arrive as mcp__plugin_<name>_<server>__tool;
    // strip the marketplace prefix so stats group under the real server
    let server = parts.length >= 2 && parts[1] ? parts[1] : null;
    if (server && server.startsWith("plugin_")) server = server.slice("plugin_".length);
    return server ? `mcp-server:${server}` : null;
  }
  if (name === "Skill") {
    const n = input.name;
    return typeof n === "string" && n ? `skill:${n}` : null;
  }
  if (name === "Agent" || name === "Task") {
    const t = input.subagent_type || input.agent;
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
    const id = capabilityIdFromToolUse(hook);
    if (id) {
      // argument fingerprint enables action-loop detection (identical
      // capability + identical args, repeatedly) WITHOUT storing content
      let argsHash;
      try {
        argsHash = createHash("sha1")
          .update(JSON.stringify(hook.tool_input ?? hook.tool_use?.input ?? {}))
          .digest("hex")
          .slice(0, 12);
      } catch {}
      appendUsageLog(
        {
          ts: new Date().toISOString(),
          sessionId: hook.session_id,
          capabilityId: id,
          invoked: true,
          source: "tool-use",
          ...(argsHash ? { argsHash } : {}),
        },
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
  appendDecisionLog(toDecisionEntry(req, typeof hook.session_id === "string" ? hook.session_id : undefined), path.join(SCRIPT_DIR, "logs"));
  if (process.env.CLAUDE_CMR_DEBUG === "1") {
    console.error(`CMR debug: routed=${req.routed} entries=${router.entries().length}`);
  }
  if (!req.routed) return outEmpty();

  const block = buildEnhancedPrompt(req, config);
  if (!block) return outEmpty();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block },
    }),
  );
}

main().catch(crash);
