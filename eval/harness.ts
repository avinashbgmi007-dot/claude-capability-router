/**
 * Eval harness — the measuring stick for the 99% target.
 *
 * CLI:
 *   node dist/eval/harness.js --discovery   # discovery coverage vs corpus ids
 *   node dist/eval/harness.js --routing     # routing metrics (needs router, Phase 2+)
 *   node dist/eval/harness.js --all
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverAll } from "../src/discovery.js";
import { loadConfig } from "../src/config.js";
import type { DiscoveredCapability, ExecutionRequest } from "../src/types.js";

export interface CorpusCaseExpect {
  route: boolean;
  plan?: Array<{ primary: string }>;
  passThrough?: boolean;
}
export interface CorpusCase {
  id: string;
  prompt: string;
  expect: CorpusCaseExpect;
}
export interface Corpus {
  cases: CorpusCase[];
}

export function loadCorpus(file: string): Corpus {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { cases: CorpusCase[] };
  return { cases: raw.cases };
}

/** All capability ids referenced by routable corpus cases. */
export function collectExpectedIds(corpus: Corpus): Set<string> {
  const ids = new Set<string>();
  for (const c of corpus.cases) {
    if (!c.expect.route) continue;
    for (const step of c.expect.plan || []) ids.add(step.primary);
  }
  return ids;
}

export interface Coverage {
  missing: string[];
  coverage: number; // 0..1 of expected ids found
}

export function discoveryCoverage(discovered: DiscoveredCapability[], corpus: Corpus): Coverage {
  const found = new Set(discovered.map((d) => d.id));
  const missing = [...collectExpectedIds(corpus)].filter((id) => !found.has(id));
  const expected = collectExpectedIds(corpus).size;
  return { missing, coverage: expected === 0 ? 1 : (expected - missing.length) / expected };
}

export interface RoutingMetrics {
  total: number;
  routed: number;
  passThrough: number;
  accuracyAt1: number; // correct primary on routable cases
  fpr: number; // chat cases that routed
  fnr: number; // routable cases that passed through
  planCorrect: number; // multi-step plan correctness
  preservation: number; // original prompt byte-identical
  detail: Array<{ id: string; ok: boolean; got: string; want: string }>;
}

export function runRoutingMetrics(corpus: Corpus, route: (prompt: string) => ExecutionRequest): RoutingMetrics {
  const detail: RoutingMetrics["detail"] = [];
  let routed = 0;
  let passThrough = 0;
  let accuracyOk = 0;
  let routableTotal = 0;
  let chatTotal = 0;
  let chatRouted = 0;
  let routablePassed = 0;
  let planOk = 0;
  let planTotal = 0;
  let preserved = 0;

  for (const c of corpus.cases) {
    const req = route(c.prompt);
    const preservedOk = req.originalPrompt === c.prompt;
    if (preservedOk) preserved++;
    const gotPlan = req.routed ? (req.plan || []).map((s) => s.primary?.entry.id || "pass-through") : [];
    const wantPlan = c.expect.plan?.map((s) => s.primary) || [];
    let ok = false;

    if (c.expect.route) {
      routableTotal++;
      if (!req.routed) {
        routablePassed++;
        ok = false;
      } else {
        routed++;
        const gotPrimary = gotPlan[0] || "";
        ok = gotPrimary === wantPlan[0];
        if (ok) accuracyOk++;
        // multi-step plan correctness: same length + same order of primaries
        if (gotPlan.length > 1) {
          planTotal++;
          if (gotPlan.length === wantPlan.length && gotPlan.every((g, i) => g === wantPlan[i])) planOk++;
        }
      }
    } else {
      chatTotal++;
      if (req.routed) chatRouted++;
      else passThrough++;
      ok = !req.routed;
    }
    detail.push({
      id: c.id,
      ok,
      got: req.routed ? `route:${gotPlan.join(" -> ")}` : "pass-through",
      want: c.expect.route ? `route:${wantPlan.join(" -> ")}` : "pass-through",
    });
  }

  return {
    total: corpus.cases.length,
    routed,
    passThrough,
    accuracyAt1: routableTotal === 0 ? 0 : accuracyOk / routableTotal,
    fpr: chatTotal === 0 ? 0 : chatRouted / chatTotal,
    fnr: routableTotal === 0 ? 0 : routablePassed / routableTotal,
    planCorrect: planTotal === 0 ? 1 : planOk / planTotal,
    preservation: preserved / corpus.cases.length,
    detail,
  };
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function defaultFixtureRoots() {
  return {
    homeDir: path.join(repoRoot(), "test", "fixtures", "home"),
    workspaceDir: path.join(repoRoot(), "test", "fixtures", "project"),
  };
}

export function defaultCorpusPath(): string {
  return path.join(repoRoot(), "eval", "corpus.json");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.includes("--routing") ? "routing" : args.includes("--all") ? "all" : "discovery";
  const roots = defaultFixtureRoots();
  const corpus = loadCorpus(defaultCorpusPath());
  // repo-local eval config (tuned for the real-skills corpus) wins unless an env override is set
  const evalConfigPath = path.join(repoRoot(), "eval", "config.json");
  const config = process.env.CLAUDE_CMR_HOME ? loadConfig() : existsSync(evalConfigPath) ? loadConfig(evalConfigPath) : loadConfig();
  const discovered = discoverAll(roots);
  const cov = discoveryCoverage(discovered, corpus);

  console.log(`=== Capability Manager eval harness ===`);
  console.log(`Discovery sources: home=${roots.homeDir} workspace=${roots.workspaceDir}`);
  console.log(`Discovered ${discovered.length} capabilities:`);
  for (const d of discovered) console.log(`  ${d.id} (${d.kind})`);
  console.log(`Corpus: ${corpus.cases.length} cases | expected ids: ${collectExpectedIds(corpus).size}`);
  console.log(`Discovery coverage: ${(cov.coverage * 100).toFixed(1)}% ${cov.missing.length ? "missing: " + cov.missing.join(", ") : ""}`);

  if (mode === "routing" || mode === "all") {
    console.log(`\nRouting metrics: not available until Phase 2 scorer is wired (router import).`);
    const routerPath = path.join(repoRoot(), "dist", "src", "router.js");
    if (existsSync(routerPath)) {
      // dynamic import via href: TS cannot statically resolve a Phase-2 module
      const routerMod = (await import(pathToFileURL(routerPath).href)) as {
        createRouter: (opts: unknown) => { route: (p: string) => ExecutionRequest };
      };
      const router = routerMod.createRouter({ config, roots });
      const m = runRoutingMetrics(corpus, (p) => router.route(p));
      console.log(`accuracy@1=${(m.accuracyAt1 * 100).toFixed(1)}% fpr=${(m.fpr * 100).toFixed(1)}% fnr=${(m.fnr * 100).toFixed(1)}% planCorrect=${(m.planCorrect * 100).toFixed(1)}% preservation=${(m.preservation * 100).toFixed(1)}%`);
      for (const d of m.detail) console.log(`  ${d.ok ? "PASS" : "FAIL"} ${d.id}: got=${d.got} want=${d.want}`);
    }
  }
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith("harness")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
