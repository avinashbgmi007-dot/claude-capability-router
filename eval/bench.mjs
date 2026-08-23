/**
 * bench.mjs — efficiency baseline, not vibes.
 *
 *   1. in-process route() timing: replays the corpus through the real router
 *      (fixture discovery roots) and reports p50/p95 per-call latency.
 *   2. wrapper wall-clock: spawns the INSTALLED hook-wrapper.mjs end-to-end
 *      (stdin JSON → stdout hook output) the way Claude Code does, reports
 *      p50/p95 including node process startup.
 *
 * Numbers are machine-relative; compare runs against each other, not absolutes.
 * Run: npm run bench
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function report(name, samplesMs) {
  const s = [...samplesMs].sort((a, b) => a - b);
  const p50 = percentile(s, 50).toFixed(1);
  const p95 = percentile(s, 95).toFixed(1);
  const mean = (s.reduce((a, b) => a + b, 0) / s.length).toFixed(1);
  console.log(`${name.padEnd(28)} n=${String(s.length).padEnd(5)} p50=${p50}ms  p95=${p95}ms  mean=${mean}ms`);
}

// --- 1. in-process routing -------------------------------------------------
const rt = async (m) => import(pathToFileURL(path.join(repoRoot, "dist", "src", m)).href);
const { readFileSync } = await import("node:fs");
const { loadConfig } = await rt("config.js");
const { createRouter } = await rt("router.js");

const evalConfigPath = path.join(repoRoot, "eval", "config.json");
const config = loadConfig(evalConfigPath);
const router = createRouter({ config, roots: fixtures });
const corpus = JSON.parse(readFileSync(path.join(repoRoot, "eval", "corpus.json"), "utf8"));
const prompts = corpus.cases.map((c) => c.prompt);

// warmup (JIT + index build)
for (const p of prompts.slice(0, 10)) router.route(p);

const inProcSamples = [];
for (let round = 0; round < 20; round++) {
  for (const p of prompts) {
    const t0 = performance.now();
    router.route(p);
    inProcSamples.push(performance.now() - t0);
  }
}
report("route() in-process", inProcSamples);

// --- 2. wrapper end-to-end --------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-bench-"));
try {
  const home = path.join(tmp, "cmr");
  const env = {
    ...process.env,
    CLAUDE_CMR_HOME: home,
    CLAUDE_SETTINGS_PATH: path.join(tmp, "settings.json"),
    CLAUDE_CMR_HOME_DIR: fixtures.homeDir,
    CLAUDE_CMR_WORKSPACE_DIR: fixtures.workspaceDir,
  };
  spawnSync(process.execPath, [path.join(repoRoot, "dist", "src", "cli.js"), "install"], { env });

  const wrapper = path.join(home, "hook-wrapper.mjs");
  // warmup spawns (runtime import caching is per-process, so every sample pays it — that's the point)
  for (const p of prompts.slice(0, 3)) {
    spawnSync(process.execPath, [wrapper], { input: JSON.stringify({ prompt: p }), env });
  }
  const wrapperSamples = [];
  for (let i = 0; i < 30; i++) {
    const prompt = prompts[i % prompts.length];
    const t0 = performance.now();
    spawnSync(process.execPath, [wrapper], { input: JSON.stringify({ prompt }), env });
    wrapperSamples.push(performance.now() - t0);
  }
  report("hook-wrapper end-to-end", wrapperSamples);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
