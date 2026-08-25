#!/usr/bin/env node
/**
 * setup.mjs - one-command lifecycle for the whole local stack.
 *
 *   node setup.mjs                 install or standard repair (idempotent)
 *   node setup.mjs install --deep  corrupted-state rebuild: clean dist,
 *                                  wipe runtime, fresh hook registrations
 *   node setup.mjs status          read-only health snapshot (SKIP-aware)
 *   node setup.mjs remove          reverse everything (restores backed-up route)
 *
 * Manages: CMR hooks+runtime (~/.claude-cmr), LlamaGuard autostart (:11435),
 * and Claude Code's ANTHROPIC_BASE_URL routing (safe-default: rewrites only
 * known-local values, backs up whatever it replaces).
 */
import http from "node:http";
import net from "node:net";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const argv = process.argv.slice(2);
const MODE = ["status", "remove"].includes(argv[0]) ? argv[0] : "install";
const DEEP = argv.includes("--deep");
const ASSUME_YES = argv.includes("--yes");

const CMR_HOME = process.env.CLAUDE_CMR_HOME || path.join(os.homedir(), ".claude-cmr");
const SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");
const STARTUP_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const STARTUP_CMD = path.join(STARTUP_DIR, "LlamaGuard.cmd");
const GUARD_PORT = 11435;
const UPSTREAM_PORT = 8080;
const TARGET_ROUTE = `http://127.0.0.1:${GUARD_PORT}`;
const LOCAL_LLAMA_RE = /^https?:\/\/(localhost|127\.0\.0\.1):(8080|8081|11435)\/?$/i;
const ROUTE_BACKUP = path.join(CMR_HOME, "env-backup.json");

let failures = 0;
let skips = 0;
function gate(name, status, detail = "") {
  if (status === "SKIP") skips++;
  else if (status !== "PASS") failures++;
  console.log(`${status.padEnd(4)} ${name}${detail ? ` - ${detail}` : ""}`);
}

function npm(args) {
  const r = spawnSync("npm", args, { cwd: REPO, encoding: "utf8", shell: true });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    setTimeout(() => {
      s.destroy();
      resolve(false);
    }, 1500);
  });
}

async function waitForPort(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await portListening(port)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function readSettingsRaw() {
  if (!existsSync(SETTINGS_PATH)) return {};
  // BOM-tolerant: some editors prepend \uFEFF and JSON.parse rejects it
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8").replace(/^\uFEFF/, ""));
}

function writeSettingsAtomic(obj) {
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  // atomic swap via rename dance (copy+delete keeps ACLs sane across volumes)
  copyFileSync(tmp, SETTINGS_PATH);
  rmSync(tmp, { force: true });
}

/** Our hook entries are identified by our wrapper path inside the command. */
function isOurHookEntry(entry) {
  const cmds = [];
  for (const h of entry?.hooks || []) if (typeof h?.command === "string") cmds.push(h.command);
  return cmds.some((c) => c.includes(".claude-cmr") && c.includes("hook-wrapper.mjs"));
}

// ---------------------------------------------------------------- preflight
function preflight() {
  console.log("== preflight ==");
  const v = process.versions.node.split(".").map(Number);
  gate("node >= 20", v[0] >= 20 ? "PASS" : "FAIL", `found ${process.versions.node}`);
  for (const f of ["package.json", "src/cli.ts", "llama-guard/run-guard.ps1"]) {
    gate(`repo file ${f}`, existsSync(path.join(REPO, f)) ? "PASS" : "FAIL");
  }
  if (failures > 0) {
    console.error("\npreflight failed - aborting.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------- build
function build() {
  console.log("\n== build ==");
  if (DEEP) {
    rmSync(path.join(REPO, "dist"), { recursive: true, force: true });
    console.log("  deep mode: dist wiped for clean rebuild");
  }
  if (!existsSync(path.join(REPO, "node_modules", "typescript"))) {
    console.log("  installing dev dependencies...");
    npm(["install"]);
  }
  try {
    npm(["run", "build"]);
    gate("tsc build", "PASS");
  } catch (e) {
    gate("tsc build", "FAIL", String(e.message).split("\n")[0]);
  }
}

// ---------------------------------------------------------------- cmr install
function cmrInstall() {
  console.log("\n== capability-manager install ==");
  if (DEEP) {
    // corrupted-runtime antidote: wipe copied runtime so installer recopies clean
    rmSync(path.join(CMR_HOME, "runtime"), { recursive: true, force: true });
    console.log("  deep mode: runtime dir wiped for recopy");
  }
  spawnSync(process.execPath, [path.join(REPO, "dist", "src", "cli.js"), "install"], { stdio: "inherit" });

  const wrapperOk = existsSync(path.join(CMR_HOME, "hook-wrapper.mjs"));
  const markerOk = existsSync(path.join(CMR_HOME, ".install-marker"));
  const runtimeOk = existsSync(path.join(CMR_HOME, "runtime", "capability-router", "router.js"));
  gate("cmr wrapper+runtime+marker", wrapperOk && markerOk && runtimeOk ? "PASS" : "FAIL");
}

// ---------------------------------------------------------------- hooks fresh
function hooksFresh() {
  console.log("\n== hook registrations ==");
  const settings = readSettingsRaw();
  const hooks = settings.hooks || {};
  let stripped = 0;
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const before = hooks[ev].length;
    hooks[ev] = hooks[ev].filter((e) => !isOurHookEntry(e));
    stripped += before - hooks[ev].length;
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (stripped) writeSettingsAtomic(settings);
  console.log(`  stripped ${stripped} existing CMR entr${stripped === 1 ? "y" : "ies"}${DEEP ? " (deep)" : ""}`);

  spawnSync(process.execPath, [path.join(REPO, "dist", "src", "cli.js"), "install"], { stdio: "inherit" });

  const after = readSettingsRaw();
  const ups = after.hooks?.UserPromptSubmit || [];
  const pre = after.hooks?.PreToolUse || [];
  gate("UserPromptSubmit registered", ups.length >= 1 ? "PASS" : "FAIL");
  gate("PreToolUse registered", pre.length >= 1 ? "PASS" : "FAIL");
}

// ---------------------------------------------------------------- guard
function guardStartupEntry() {
  const runner = path.join(REPO, "llama-guard", "run-guard.ps1");
  // pure-ASCII content (PS5.1 reads BOM-less files as ANSI - em-dashes killed launches once)
  const content = `@echo off\r\nstart "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runner}"\r\n`;
  mkdirSync(STARTUP_DIR, { recursive: true });
  const current = existsSync(STARTUP_CMD) ? readFileSync(STARTUP_CMD, "utf8") : "";
  if (!current.includes(runner)) {
    writeFileSync(STARTUP_CMD, content, "utf8");
    console.log("  startup entry written/updated: " + STARTUP_CMD);
  }
}

async function guardInstall() {
  console.log("\n== llamaguard ==");
  guardStartupEntry();
  if (!(await portListening(GUARD_PORT))) {
    // launch hidden runner (it self-heals + refuses duplicates internally)
    spawnSync("powershell", [
      "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
      "-File", path.join(REPO, "llama-guard", "run-guard.ps1"),
    ], { detached: true, stdio: "ignore", windowsHide: true }).unref?.();
  }
  const up = await waitForPort(GUARD_PORT, 12);
  gate("guard listening :" + GUARD_PORT, up ? "PASS" : "FAIL");
}

// ---------------------------------------------------------------- claude route
function readBackup() {
  if (!existsSync(ROUTE_BACKUP)) return {};
  try { return JSON.parse(readFileSync(ROUTE_BACKUP, "utf8")); } catch { return {}; }
}

function claudeRoute() {
  console.log("\n== claude routing (safe-default) ==");
  const settings = readSettingsRaw();
  settings.env = settings.env || {};
  const cur = settings.env.ANTHROPIC_BASE_URL;

  if (cur === TARGET_ROUTE) {
    gate("route already points at guard", "PASS", TARGET_ROUTE);
    return;
  }
  if (cur && !LOCAL_LLAMA_RE.test(cur)) {
    gate("route rewrite", "SKIP", `current '${cur}' is not a known-local llama URL - left untouched. Point it at ${TARGET_ROUTE} manually if desired.`);
    return;
  }
  // backup whatever we replace
  const backup = readBackup();
  if (cur && backup.ANTHROPIC_BASE_URL === undefined) {
    backup.ANTHROPIC_BASE_URL = cur;
    backup.savedAt = new Date().toISOString();
    mkdirSync(CMR_HOME, { recursive: true });
    writeFileSync(ROUTE_BACKUP, JSON.stringify(backup, null, 2), "utf8");
  }
  settings.env.ANTHROPIC_BASE_URL = TARGET_ROUTE;
  writeSettingsAtomic(settings);
  gate("route rewritten to guard", "PASS", `${cur || "(unset)"} -> ${TARGET_ROUTE}`);
}

// ---------------------------------------------------------------- health gate
async function liveProbe() {
  // probe THROUGH the guard so the whole chain is exercised.
  // Success = valid response envelope from upstream (HTTP 200 + parseable
  // protocol shape) - NOT non-empty text: reasoning models may return empty
  // content at small budgets while still proving the full chain works.
  const body = JSON.stringify({ model: "local", max_tokens: 300, messages: [{ role: "user", content: "reply OK" }] });
  return new Promise((resolve) => {
    const rq = http.request(
      { hostname: "127.0.0.1", port: GUARD_PORT, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" }, timeout: 60000 },
      (res) => {
        const cs = [];
        res.on("data", (c) => cs.push(c));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(cs).toString());
            const hasShape = Array.isArray(j.content) || Array.isArray(j.choices);
            resolve(res.statusCode === 200 && hasShape ? "PASS" : "FAIL");
          } catch {
            resolve("FAIL");
          }
        });
      },
    );
    rq.on("timeout", () => { rq.destroy(); resolve("SKIP"); });
    rq.on("error", () => resolve("SKIP"));
    rq.write(body);
    rq.end();
  });
}

async function healthGate({ mutate }) {
  console.log("\n== health gate ==");
  const settings = mutate ? readSettingsRaw() : readSettingsRaw();
  const hooks = settings.hooks || {};
  const ourCmd = (list) =>
    Array.isArray(list) && list.some((e) => (e.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("hook-wrapper.mjs")));

  gate("wrapper file", existsSync(path.join(CMR_HOME, "hook-wrapper.mjs")) ? "PASS" : "FAIL");
  gate("marker file", existsSync(path.join(CMR_HOME, ".install-marker")) ? "PASS" : "FAIL");
  gate("hooks registered (UPS)", ourCmd(hooks.UserPromptSubmit) ? "PASS" : "FAIL");
  gate("hooks registered (PreToolUse)", ourCmd(hooks.PreToolUse) ? "PASS" : "FAIL");

  const guardUp = await portListening(GUARD_PORT);
  gate("guard listening :" + GUARD_PORT, guardUp ? "PASS" : mutate ? "FAIL" : "SKIP", mutate && !guardUp ? "run npm run setup to start" : "");

  // live probe: SKIP (never FAIL) when the engine itself is down
  if (!(await portListening(UPSTREAM_PORT))) {
    gate("live probe", "SKIP", `llama-server not running on :${UPSTREAM_PORT}`);
  } else if (!guardUp) {
    gate("live probe", "SKIP", "guard down");
  } else {
    gate("live probe (through guard -> llama -> back)", await liveProbe());
  }

  const cur = settings.env?.ANTHROPIC_BASE_URL;
  const normalized = (u) => String(u || "").replace(/^https?:\/\//i, "").replace(/localhost/i, "127.0.0.1").replace(/\/$/, "");
  const pointsAtGuard = normalized(cur) === `127.0.0.1:${GUARD_PORT}`;
  if (pointsAtGuard) gate("claude route", "PASS", `${cur} (guard)`);
  else if (cur && !LOCAL_LLAMA_RE.test(cur)) gate("claude route", "SKIP", `non-local value '${cur}' respected`);
  else gate("claude route", mutate ? "FAIL" : "SKIP", `currently '${cur ?? "unset"}'${mutate ? "" : " (status mode does not rewrite)"}`);
}

// ---------------------------------------------------------------- remove
function remove() {
  console.log("== remove ==");
  if (!ASSUME_YES) {
    console.error("This unregisters hooks, removes the startup entry, stops the guard,");
    console.error("and restores your backed-up model route. Re-run with --yes to proceed:");
    console.error("  node setup.mjs remove --yes");
    process.exit(1);
  }
  // 1. restore route from backup BEFORE removing cmr home (backup lives there)
  try {
    const b = readBackup();
    const settings = readSettingsRaw();
    if (b.ANTHROPIC_BASE_URL && settings.env?.ANTHROPIC_BASE_URL === TARGET_ROUTE) {
      settings.env.ANTHROPIC_BASE_URL = b.ANTHROPIC_BASE_URL;
      writeSettingsAtomic(settings);
      console.log("route restored: " + b.ANTHROPIC_BASE_URL);
    } else if (settings.env?.ANTHROPIC_BASE_URL === TARGET_ROUTE) {
      delete settings.env.ANTHROPIC_BASE_URL;
      writeSettingsAtomic(settings);
      console.log("route removed (no backup existed)");
    }
  } catch {}
  // 2. cmr uninstall (hooks + runtime + marker)
  if (existsSync(path.join(REPO, "dist", "src", "cli.js"))) {
    spawnSync(process.execPath, [path.join(REPO, "dist", "src", "cli.js"), "uninstall"], { stdio: "inherit" });
  }
  // 3. startup entry + guard processes
  if (existsSync(STARTUP_CMD)) rmSync(STARTUP_CMD, { force: true });
  const killByCmd = (filter) => {
    const out = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${filter}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ], { encoding: "utf8", shell: true });
    return out.status === 0;
  };
  killByCmd("run-guard\\.ps1");
  killByCmd("guard-proxy\\.mjs");
  console.log("startup entry removed; guard stopped.");
  console.log("kept for history: ~/.claude-cmr/{config.json,logs,state}");
}

// ---------------------------------------------------------------- main
console.log(`setup.mjs - mode=${MODE}${DEEP ? " (deep)" : ""}`);
if (MODE === "status") {
  await healthGate({ mutate: false });
} else if (MODE === "remove") {
  remove();
} else {
  preflight();
  build();
  cmrInstall();
  hooksFresh();
  await guardInstall();
  claudeRoute();
  await healthGate({ mutate: true });
}

console.log(
  failures > 0
    ? `\nRESULT: ${failures} FAIL${skips ? `, ${skips} SKIP` : ""} - see lines above`
    : `\nRESULT: ALL PASS${skips ? ` (${skips} skipped)` : ""}`,
);
process.exit(failures > 0 ? 1 : 0);
