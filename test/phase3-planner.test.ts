/**
 * Phase 3 tests: compound-intent planner + per-step fallbacks.
 * The full-corpus gate (ALL 10 cases) only opens here, once planning exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "../src/router.js";
import { splitIntents } from "../src/planner.js";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";
import { discoverAll, indexById } from "../src/discovery.js";
import { updateIndex } from "../src/index-store.js";
import { loadCorpus, runRoutingMetrics, defaultCorpusPath } from "../eval/harness.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function makeRouter(config = DEFAULT_CONFIG) {
  const discovered = [...indexById(discoverAll(roots)).values()];
  const entries = [...updateIndex(discovered, { entries: new Map(), lastUpdated: "", scan: "" }, config).index.entries.values()];
  return createRouter({ config, roots, entries });
}

test("splitIntents: connectors produce segments, noise trimmed", () => {
  assert.deepEqual(splitIntents("extract tables from this PDF, then draft an email to the team"), [
    "extract tables from this PDF",
    "draft an email to the team",
  ]);
  assert.deepEqual(splitIntents("check the logs first, then create a bug ticket"), ["check the logs", "create a bug ticket"]);
  assert.deepEqual(splitIntents("summarize this PDF into bullet points"), ["summarize this PDF into bullet points"]);
  assert.deepEqual(splitIntents("帮我剪辑视频然后发邮件"), ["帮我剪辑视频", "发邮件"]);
});

test("splitIntents: list debris folds back — lists are not plans", () => {
  // comma-separated list items are connector debris, not intents
  assert.deepEqual(splitIntents("make it red, green, and blue"), ["make it red, green, blue"]);
  // leading debris folds forward
  assert.deepEqual(splitIntents("hi, summarize this PDF into bullet points"), ["hi, summarize this PDF into bullet points"]);
  // real compound intents on both sides of a comma still split
  assert.deepEqual(splitIntents("review my pull request, then open issues for it"), ["review my pull request", "open issues for it"]);
});

test("router: list prompt produces at most a single-step plan", () => {
  const router = makeRouter();
  const r = router.route("make it red, green, and blue");
  assert.ok(r.plan.length <= 1, `plan length ${r.plan.length} for a list prompt`);
});

test("planner: compound prompt → ordered multi-step plan", () => {
  const router = makeRouter();
  const r = router.route("extract tables from this PDF, then draft an email summary to the team");
  assert.equal(r.routed, true);
  assert.equal(r.plan.length, 2);
  assert.deepEqual(
    r.plan.map((s) => s.primary?.entry.id),
    ["skill:pdf-extractor", "plugin-skill:gmail-draft"],
  );
  assert.equal(r.originalPrompt, "extract tables from this PDF, then draft an email summary to the team");
});

test("planner: second compound corpus case (logs → jira)", () => {
  const router = makeRouter();
  const r = router.route("check the logs first, then create a bug ticket in jira");
  assert.equal(r.routed, true);
  assert.deepEqual(
    r.plan.map((s) => s.primary?.entry.id),
    ["skill:log-analyzer", "mcp-server:jira"],
  );
});

test("planner: same-primary segments collapse to single intent", () => {
  const router = makeRouter();
  const r = router.route("review my PR and open issues for it");
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].primary?.entry.id, "plugin-agent:github-pr-review");
});

test("planner: single-intent prompts keep 1-step plans with fallbacks", () => {
  const router = makeRouter();
  const r = router.route("summarize this PDF into bullet points");
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].primary?.entry.id, "skill:pdf-summarizer");
  assert.equal(r.plan[0].fallbacks.length, 2, "pre-ranked fallback chain");
  assert.equal(r.plan[0].fallbacks[0].entry.id, "skill:pdf-extractor");
  // fallbacks are pre-ranked: no rescoring (first fallback is the #2 candidate)
  const confs = r.plan[0].fallbacks.map((f) => f.confidence);
  assert.ok(confs[0] >= confs[1]);
});

test("planner: step-level pass-through when a step cannot route", () => {
  const router = makeRouter();
  const r = router.route("summarize this pdf, then say hi, then draft an email");
  assert.equal(r.routed, true);
  assert.equal(r.plan.length, 3);
  assert.equal(r.plan[0].primary?.entry.id, "skill:pdf-summarizer");
  assert.equal(r.plan[1].primary, null, "non-routable step passes through inside the plan");
  assert.equal(r.plan[2].primary?.entry.id, "plugin-skill:gmail-draft");
});

test("planner: single routed step + null steps collapses to single intent", () => {
  const router = makeRouter();
  const r = router.route("summarize this pdf then say hi");
  assert.equal(r.routed, true);
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].primary?.entry.id, "skill:pdf-summarizer");
});

test("planner: full corpus gate — every case passes with the eval config", () => {
  const router = makeRouter(loadConfig(path.join(repoRoot, "eval", "config.json")));
  const corpus = loadCorpus(defaultCorpusPath());
  const m = runRoutingMetrics(corpus, (p) => router.route(p));
  const failures = m.detail.filter((d) => !d.ok);
  assert.deepEqual(
    failures.map((f) => `${f.id}: got=${f.got} want=${f.want}`),
    [],
    "whole corpus must pass with the planner under the eval config",
  );
  console.log(
    `[phase3] full corpus: accuracy@1=${(m.accuracyAt1 * 100).toFixed(1)}% fpr=${(m.fpr * 100).toFixed(1)}% fnr=${(m.fnr * 100).toFixed(1)}% planCorrect=${(m.planCorrect * 100).toFixed(1)}% preservation=${(m.preservation * 100).toFixed(1)}%`,
  );
});
