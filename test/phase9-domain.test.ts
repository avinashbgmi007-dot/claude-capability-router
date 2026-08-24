/**
 * Phase 9 tests — domain-fallback routing.
 *  - canonical classifier vectors (shared with llama-guard's classifier)
 *  - specialist-beats-domain precedence
 *  - fallback fires only when specialist silent AND rep exists/enabled
 *  - chat reps rejected; ghosts warned + skipped; kill-switch honored
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDomain, DOMAIN_TEST_VECTORS } from "../src/domains.js";
import { createRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { CapabilityIndexEntry, RouterConfig } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

test("classifier: canonical vectors (sync contract with llama-guard)", () => {
  for (const v of DOMAIN_TEST_VECTORS) {
    assert.equal(classifyDomain(v.text), v.expect, `vector: ${v.text}`);
  }
});

function mkEntry(id: string): CapabilityIndexEntry {
  return {
    id,
    name: id.split(":")[1] ?? id,
    kind: "skill",
    purpose: `${id} capability`,
    description: `${id} does specialized things for the arsenal`,
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

function routerWith(reps: RouterConfig["domainRouting"]["representatives"], entries: CapabilityIndexEntry[], overrides: Partial<RouterConfig["domainRouting"]> = {}) {
  const config: RouterConfig = {
    ...DEFAULT_CONFIG,
    domainRouting: { enabled: true, representatives: reps, ...overrides },
  };
  return createRouter({ config, roots, entries });
}

// a prompt with zero lexical overlap with any synthetic entry -> specialist silent
const AMBIGUOUS_PROMPT = "write me a ping pong game with arrow keys and bouncing ball";

test("domain: fallback fires when specialists silent and rep exists", () => {
  const r = routerWith({ code: "skill:code-rep" }, [mkEntry("skill:code-rep"), mkEntry("skill:unrelated")]);
  const req = r.route(AMBIGUOUS_PROMPT);
  assert.equal(req.routed, true);
  assert.equal(req.plan[0].primary?.entry.id, "skill:code-rep");
  assert.equal(req.plan[0].domainMatch, true);
  assert.match(req.rationale ?? "", /domain-match: code/);
});

test("domain: specialist beats domain rep on lexically-matching prompt", () => {
  // 'summarize this PDF into bullet points' lexically hits fixture pdf-summarizer
  const r = routerWith({ code: "skill:code-rep" }, [
    mkEntry("skill:code-rep"),
    ...[...createRouter({ config: DEFAULT_CONFIG, roots }).entries()],
  ]);
  const req = r.route("summarize this PDF into bullet points");
  assert.equal(req.routed, true);
  assert.equal(req.plan[0].primary?.entry.id, "skill:pdf-summarizer");
  assert.equal(req.plan[0].domainMatch, undefined);
});

test("domain: ghost representative skipped (with warning) -> pass-through", () => {
  const warnings: string[] = [];
  const orig = console.error;
  console.error = (m: string) => warnings.push(m);
  try {
    const r = routerWith({ code: "skill:ghost" }, [mkEntry("skill:unrelated")]);
    const req = r.route(AMBIGUOUS_PROMPT);
    assert.equal(req.routed, false);
    assert.ok(warnings.some((w) => w.includes("skill:ghost")), "ghost warned once");
  } finally {
    console.error = orig;
  }
});

test("domain: disabled via config -> passthrough even with rep", () => {
  const r = routerWith({ code: "skill:code-rep" }, [mkEntry("skill:code-rep")], { enabled: false });
  assert.equal(r.route(AMBIGUOUS_PROMPT).routed, false);
});

test("domain: chat representatives rejected at config merge", async () => {
  const { loadConfig } = await import("../src/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-p9cfg-"));
  try {
    const cfgFile = path.join(tmp, "config.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ domainRouting: { enabled: true, representatives: { chat: "skill:chatty" } } }));
    const cfg = loadConfig(cfgFile);
    assert.equal(cfg.domainRouting.representatives.chat, undefined, "chat rep stripped at load");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
