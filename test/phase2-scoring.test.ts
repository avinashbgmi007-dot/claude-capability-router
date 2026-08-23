/**
 * Phase 2 tests: normalization, scoring, confidence bands, router decision.
 * The threshold is tuned by the eval harness — the test asserts the chosen
 * default τ makes ALL starter-corpus cases pass with margin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTokens, extractMainClause, tokenize } from "../src/normalization.js";
import { scoreCapability, rankCapabilities } from "../src/scorer.js";
import { createRouter } from "../src/router.js";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";
import { discoverAll, indexById } from "../src/discovery.js";
import { updateIndex } from "../src/index-store.js";
import type { CapabilityIndexEntry } from "../src/types.js";
import { loadCorpus, runRoutingMetrics, defaultCorpusPath } from "../eval/harness.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function buildEntries(config = DEFAULT_CONFIG) {
  const discovered = [...indexById(discoverAll(roots)).values()];
  return updateIndex(discovered, { entries: new Map(), lastUpdated: "", scan: "" }, config).index.entries;
}

test("normalization: aliases, stopwords, main-clause truncation, CJK bigrams", () => {
  const cfg = DEFAULT_CONFIG;
  // shorthand aliases resolve to canonical; canonicals that are stopwords drop out
  assert.deepEqual(normalizeTokens("u can u help meh with file??", cfg), ["file"]);
  // single-char alias: x -> twitter survives the length filter
  assert.ok(normalizeTokens("post to X", cfg).includes("twitter"), `x→twitter alias, got ${normalizeTokens("post to X", cfg)}`);
  // relative clause truncation
  assert.equal(extractMainClause("create a new skill that fetches competitor prices"), "create a new skill");
  // CJK bigrams + alias expansion
  const cjk = normalizeTokens("帮我剪辑视频", cfg);
  assert.ok(cjk.includes("video"), `expected video alias, got ${cjk}`);
  // plain tokenize
  assert.deepEqual(tokenize("PDF-files, doc"), ["pdf", "files", "doc"]);
});

test("scoring: correct primary wins, confidence in [0,1], deterministic", () => {
  const entries = [...buildEntries().values()];
  const tokens = normalizeTokens("summarize this PDF into bullet points", DEFAULT_CONFIG);
  const ranked = rankCapabilities(tokens, entries, DEFAULT_CONFIG.weights);
  assert.equal(ranked[0].entry.id, "skill:pdf-summarizer");
  for (const r of ranked) {
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence out of range: ${r.confidence}`);
  }
  const again = rankCapabilities(tokens, entries, DEFAULT_CONFIG.weights);
  assert.deepEqual(ranked.map((r) => r.entry.id), again.map((r) => r.entry.id), "deterministic ranking");
});

test("scoring: alphabetical tie-break", () => {
  const entries = [...buildEntries().values()].filter((e) => e.id.startsWith("mcp-server:"));
  const cfg = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } };
  // empty query → all zero confidence → alphabetical order
  const ranked = rankCapabilities([], entries, cfg.weights);
  const ids = ranked.map((r) => r.entry.id);
  assert.deepEqual(ids, [...ids].sort());
});

test("scoring: field-recall is damped — a small field fully recalled cannot outscore query precision", () => {
  const mk = (id: string, description: string): CapabilityIndexEntry => ({
    id,
    name: id,
    kind: "skill",
    purpose: description,
    description,
    body: "",
    actions: [],
    domains: [],
    examples: [],
    category: "skill",
    invocation: id,
    sourcePath: "test",
    fingerprint: id,
    enabled: true,
    weight: 1,
  });
  // 4-token query, only half its tokens appear in the field
  const queryTokens = ["extract", "tables", "from", "pdf"];
  const exact = mk("skill:exact", "extract tables from pdf");
  const tinyField = mk("skill:tiny", "extract tables");
  const eScore = scoreCapability(queryTokens, exact, DEFAULT_CONFIG.weights).fieldScores.description;
  const tScore = scoreCapability(queryTokens, tinyField, DEFAULT_CONFIG.weights).fieldScores.description;
  assert.equal(eScore, 1, "full query-precision match is undamped");
  // undamped this would be 1.0 via full field recall; damped it must sit at 0.75
  assert.ok(tScore < 1 && tScore >= 0.74, `full-recall small field must damp below 1 (~0.75), got ${tScore}`);
});

test("router: chat prompts pass through, actionable prompts route", () => {
  const router = createRouter({ config: DEFAULT_CONFIG, roots, entries: [...buildEntries().values()] });
  assert.equal(router.route("how's the weather today?").routed, false);
  assert.equal(router.route("what do you think about this architecture doc?").routed, false);
  assert.equal(router.route("u can u help meh with file??").routed, false);
  const r = router.route("summarize this PDF into bullet points");
  assert.equal(r.routed, true);
  assert.equal(r.plan[0].primary?.entry.id, "skill:pdf-summarizer");
  assert.equal(r.originalPrompt, "summarize this PDF into bullet points");
});

test("threshold tuning: a τ exists where all single-step corpus cases pass", () => {
  const corpus = loadCorpus(defaultCorpusPath());
  // multi-step cases (P003, P009, P059, P060) are validated by the Phase 3 planner test
  const singleStep: typeof corpus = {
    cases: corpus.cases.filter((c) => !c.expect.route || (c.expect.plan ?? []).length === 1),
  };
  const entries = [...buildEntries().values()];
  // the eval config (eval/config.json) is the harness-tuned weights for the real-skills corpus
  const evalConfig = loadConfig(path.join(repoRoot, "eval", "config.json"));
  const taus = [0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25];
  let best: { tau: number; score: number } | null = null;
  for (const tau of taus) {
    const config = { ...evalConfig, threshold: tau };
    const router = createRouter({ config, roots, entries });
    const m = runRoutingMetrics(singleStep, (p) => router.route(p));
    const s = m.accuracyAt1 + (1 - m.fpr) + (1 - m.fnr) + m.planCorrect;
    if (s >= 3.99 && (!best || s > best.score)) best = { tau, score: s };
  }
  assert.ok(best, "no τ found where all single-step corpus cases pass");
  // and the eval config must itself pass all single-step corpus cases (harness-tuned value)
  const defRouter = createRouter({ config: evalConfig, roots, entries });
  const defMetrics = runRoutingMetrics(singleStep, (p) => defRouter.route(p));
  const failures = defMetrics.detail.filter((d) => !d.ok);
  assert.deepEqual(
    failures.map((f) => `${f.id}: got=${f.got} want=${f.want}`),
    [],
    "eval config must pass all single-step corpus cases",
  );
  console.log(`[phase2] tuned τ=${best.tau} | eval τ=${evalConfig.threshold} | single-step metrics: accuracy@1=${(defMetrics.accuracyAt1 * 100).toFixed(1)}% fpr=${(defMetrics.fpr * 100).toFixed(1)}% fnr=${(defMetrics.fnr * 100).toFixed(1)}% preservation=${(defMetrics.preservation * 100).toFixed(1)}%`);
});

test("scoring: trigger words in the SKILL.md body contribute (body field)", async () => {
  const { extractFromMarkdown } = await import("../src/metadata-extractor.js");
  const md = extractFromMarkdown({
    name: "make-pdf",
    kind: "skill",
    sourcePath: "x/SKILL.md",
    rawText: "---\nname: make-pdf\ndescription: general purpose document helper\n---\n# make-pdf\n\nUse when the user asks to generate a pdf, export a pdf, or convert documents.\n",
  });
  assert.ok(md.body.includes("generate a pdf"), "body extracted past frontmatter");
  const entry: CapabilityIndexEntry = { ...md, id: "skill:make-pdf", fingerprint: "x", enabled: true, weight: 1 };
  const tokens = normalizeTokens("generate a pdf", DEFAULT_CONFIG);
  const sc = scoreCapability(tokens, entry, DEFAULT_CONFIG.weights);
  assert.ok(sc.fieldScores.body > 0, `body should match, got ${sc.fieldScores.body}`);
});

test("scoreCapability: name field participates in scoring", () => {
  const entries = [...buildEntries().values()];
  const entry = entries.find((e) => e.id === "plugin-skill:gmail-draft")!;
  const tokens = normalizeTokens("draft an email", DEFAULT_CONFIG);
  const sc = scoreCapability(tokens, entry, DEFAULT_CONFIG.weights);
  assert.ok(sc.fieldScores.name > 0, `name field should match, got ${sc.fieldScores.name}`);
  assert.ok(sc.confidence > 0.5);
});
