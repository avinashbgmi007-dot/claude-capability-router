/**
 * Phase 9 tests — domain-fallback routing (zero-config, description-derived).
 *  - canonical classifier vectors (shared with llama-guard's classifier)
 *  - derivation reads each capability's OWN description; needs >=2 distinct
 *    signal families (MIN_DERIVE_AFFINITY) — single-family blurbs stay inert
 *  - affinity ranking picks strongest; skills beat spawning-agents on ties
 *  - specialist-beats-domain precedence; kill-switch; chat never represented
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDomain, deriveDomain, DOMAIN_TEST_VECTORS, MIN_DERIVE_AFFINITY } from "../src/domains.js";
import { createRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { CapabilityIndexEntry, RouterConfig } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

test("classifier: canonical prompt vectors (sync contract with llama-guard)", () => {
  for (const v of DOMAIN_TEST_VECTORS) {
    assert.equal(classifyDomain(v.text), v.expect, `vector: ${v.text}`);
  }
});

test("derivation: multi-family descriptions qualify, single-family stay inert", () => {
  const eng = deriveDomain("Expert-level software engineering agent. Deliver production-ready, tested application code.");
  assert.equal(eng?.domain, "code");
  assert.equal(eng?.affinity, 3, "engineering + production-ready + testing = three families");

  const simplifier = deriveDomain("Refactoring specialist removes dead code.");
  assert.equal(simplifier, null, "single-family blurb stays below the suggestion bar");
  assert.ok(MIN_DERIVE_AFFINITY >= 2, "suggestion bar requires multi-family evidence");

  const planner = deriveDomain("Task planner for creating actionable implementation plans and roadmaps.");
  assert.equal(planner?.domain, "plan");
  assert.ok((planner?.affinity ?? 0) >= 2);

  const neutral = deriveDomain("Terse low-token responses with minimal words.");
  assert.equal(neutral, null, "chat-flavored text derives no domain");
});

function mkEntry(id: string, kind: CapabilityIndexEntry["kind"], description: string): CapabilityIndexEntry {
  return {
    id,
    name: id.split(":")[1] ?? id,
    kind,
    purpose: description,
    description,
    body: "",
    actions: [],
    domains: [],
    examples: [],
    category: "skill",
    invocation: id.split(":")[1] ?? id,
    sourcePath: "test",
    fingerprint: id,
    enabled: true,
    weight: 1,
  };
}

const SW_ENG = () =>
  mkEntry(
    "agent:sw-eng",
    "agent",
    "Expert-level software engineering agent. Deliver production-ready, tested application code.",
  );
const JUNIOR_DEV = () =>
  mkEntry("agent:junior-dev", "agent", "Software development assistant with debugging support for everyday issues.");

// zero lexical overlap with any synthetic entry -> specialist pass silent
const PING_PONG = "write me a ping pong game with arrow keys and bouncing ball";

function routerWith(entries: CapabilityIndexEntry[], overrides: Partial<RouterConfig> = {}) {
  const config: RouterConfig = { ...DEFAULT_CONFIG, ...overrides };
  return createRouter({ config, roots, entries });
}

test("domain: ping-pong style prompt routes to strongest same-domain candidate", () => {
  const r = routerWith([SW_ENG(), JUNIOR_DEV()]);
  const req = r.route(PING_PONG);
  assert.equal(req.routed, true);
  assert.equal(req.plan[0].primary?.entry.id, "agent:sw-eng", "strongest affinity wins");
  assert.equal(req.plan[0].domainMatch, true);
  assert.match(req.rationale ?? "", /domain-match\(code, affinity 3\)/);
});

test("domain: tiebreak prefers lighter kind (skill over agent) at equal affinity", () => {
  const desc = "Software development agent delivering production-ready application code.";
  const skillCoder = mkEntry("skill:light-coder", "skill", desc);
  const agentCoder = mkEntry("agent:heavy-coder", "agent", desc);
  const r = routerWith([agentCoder, skillCoder]);
  const req = r.route(PING_PONG);
  assert.equal(req.routed, true);
  assert.equal(req.plan[0].primary?.entry.id, "skill:light-coder", "equal affinity -> lighter kind wins");
});

test("domain: chat prompts never route via domains", () => {
  const r = routerWith([SW_ENG()]);
  assert.equal(r.route("how's the weather today?").routed, false);
});

test("routing: specialist lexical match still beats domain candidates", () => {
  const pdfSummarizer = createRouter({ config: DEFAULT_CONFIG, roots }).entries().find((e) => e.id === "skill:pdf-summarizer");
  assert.ok(pdfSummarizer, "fixture exists");
  const r = routerWith([SW_ENG(), pdfSummarizer]);
  const req = r.route("summarize this PDF into bullet points");
  assert.equal(req.routed, true);
  assert.equal(req.plan[0].primary?.entry.id, "skill:pdf-summarizer");
  assert.equal(req.plan[0].domainMatch, undefined);
});

test("domain: kill-switch disables fallback entirely", () => {
  const r = routerWith([SW_ENG()], { domainRouting: { enabled: false } });
  assert.equal(r.route(PING_PONG).routed, false);
});
