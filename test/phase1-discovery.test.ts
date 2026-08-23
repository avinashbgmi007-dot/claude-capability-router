/**
 * Phase 1 tests: discovery (4 sources) + fingerprint determinism +
 * incremental index (ADD / MODIFY / DELETE / UNCHANGED).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAll } from "../src/discovery.js";
import { fingerprint } from "../src/fingerprint.js";
import { loadIndex, updateIndex } from "../src/index-store.js";
import { createRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

const EXPECTED_IDS = [
  // real skills mirrored from ~/.agents/skills (eval corpus targets)
  "skill:brainstorming",
  "skill:caveman",
  "skill:caveman-compress",
  "skill:executing-plans",
  "skill:find-skills",
  "skill:frontend-design",
  "skill:graphify",
  "skill:minimalist-ui",
  "skill:ponytail",
  "skill:skill-creator",
  "skill:ui-ux-pro-max",
  "skill:writing-plans",
  // demo capabilities
  "skill:pdf-summarizer",
  "skill:pdf-extractor",
  "skill:log-analyzer",
  "skill:data-viz",
  "agent:skill-creator",
  "plugin-skill:gmail-draft",
  "plugin-agent:github-pr-review",
  "mcp-server:twitter",
  "mcp-server:jira",
  // slash commands (user / workspace / plugin)
  "command:deploy",
  "command:db-migrate",
  "command:pr-status",
];

test("discovery finds capabilities from all four sources", () => {
  const found = discoverAll(fixtures).map((d) => d.id).sort();
  for (const id of EXPECTED_IDS) {
    assert.ok(found.includes(id), `missing ${id}; found=${found.join(",")}`);
  }
  assert.equal(found.length, EXPECTED_IDS.length, "no unexpected capabilities");
});

test("discovery is deterministic across runs", () => {
  const a = discoverAll(fixtures).map((d) => d.id).join(",");
  const b = discoverAll(fixtures).map((d) => d.id).join(",");
  assert.equal(a, b);
});

test("triggers frontmatter falls back into actions", async () => {
  const { extractFromMarkdown } = await import("../src/metadata-extractor.js");
  const md = extractFromMarkdown({
    name: "make-pdf",
    kind: "skill",
    sourcePath: "x/SKILL.md",
    rawText: "---\nname: make-pdf\ndescription: Make a PDF.\ntriggers:\n  - generate pdf\n  - export pdf\n---\nBody.\n",
  });
  assert.deepEqual(md.actions, ["generate pdf", "export pdf"]);
});

test("fingerprint is content-stable and change-sensitive", () => {
  const f1 = fingerprint("hello world");
  const f2 = fingerprint("hello world");
  assert.equal(f1, f2);
  assert.notEqual(f1, fingerprint("hello world!"));
});

function copyFixturesToTemp(): { homeDir: string; workspaceDir: string; cleanup: () => void } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p1-"));
  const homeDir = path.join(tmp, "home");
  const workspaceDir = path.join(tmp, "project");
  cpSync(fixtures.homeDir, homeDir, { recursive: true });
  cpSync(fixtures.workspaceDir, workspaceDir, { recursive: true });
  return { homeDir, workspaceDir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test("incremental index: ADD then UNCHANGED then MODIFY then DELETE", () => {
  const t = copyFixturesToTemp();
  const stateDir = path.join(t.workspaceDir, ".cmr-state");
  try {
    const config = DEFAULT_CONFIG;

    // first run: everything ADDED
    const d1 = discoverAll(t);
    const r1 = updateIndex(d1, loadIndex(stateDir), config, stateDir);
    assert.deepEqual([...r1.result.added].sort(), [...EXPECTED_IDS].sort());
    assert.equal(r1.result.modified.length, 0);
    assert.equal(r1.result.deleted.length, 0);

    // second run: everything UNCHANGED
    const r2 = updateIndex(discoverAll(t), r1.index, config, stateDir);
    assert.equal(r2.result.added.length, 0);
    assert.equal(r2.result.modified.length, 0);
    assert.equal(r2.result.deleted.length, 0);
    assert.equal(r2.result.unchanged.length, EXPECTED_IDS.length);

    // modify one skill: pdf-summarizer SKILL.md gets an extra line
    const skillFile = path.join(t.homeDir, ".claude", "skills", "pdf-summarizer", "SKILL.md");
    writeFileSync(skillFile, "\n# v2: also handles scanned documents\n", { flag: "a" });
    const r3 = updateIndex(discoverAll(t), r2.index, config, stateDir);
    assert.ok(r3.result.modified.includes("skill:pdf-summarizer"), `modified=${r3.result.modified}`);
    assert.ok(r3.result.unchanged.includes("skill:pdf-extractor"));

    // delete one skill: log-analyzer
    rmSync(path.join(t.homeDir, ".claude", "skills", "log-analyzer"), { recursive: true, force: true });
    const r4 = updateIndex(discoverAll(t), r3.index, config, stateDir);
    assert.ok(r4.result.deleted.includes("skill:log-analyzer"), `deleted=${r4.result.deleted}`);

    // persistence: reload from disk gives same entries
    const reloaded = loadIndex(stateDir);
    assert.equal(reloaded.entries.size, EXPECTED_IDS.length - 1);
    assert.ok(reloaded.entries.has("skill:pdf-extractor"));
  } finally {
    t.cleanup();
  }
});

test("router: persisted index short-circuits discovery when nothing changed", () => {
  const t = copyFixturesToTemp();
  const stateDir = path.join(t.workspaceDir, ".cmr-state");
  try {
    const r1 = createRouter({ config: DEFAULT_CONFIG, roots: t, stateDir });
    const ids = () => r1.entries().map((e) => e.id).sort();
    assert.equal(ids().length, EXPECTED_IDS.length);

    // unchanged roots → second router reuses the persisted index (state file untouched)
    const indexFile = path.join(stateDir, "index.json");
    const mtimeBefore = statSync(indexFile).mtimeMs;
    const r2 = createRouter({ config: DEFAULT_CONFIG, roots: t, stateDir });
    assert.deepEqual(r2.entries().map((e) => e.id).sort(), ids(), "same entries on cache hit");
    assert.equal(statSync(indexFile).mtimeMs, mtimeBefore, "no re-discovery when nothing changed");

    // new skill on disk → scan changes → re-discovery picks it up
    mkdirSync(path.join(t.homeDir, ".claude", "skills", "new-skill"), { recursive: true });
    writeFileSync(path.join(t.homeDir, ".claude", "skills", "new-skill", "SKILL.md"), "---\nname: new-skill\ndescription: brand new skill\n---\n", "utf8");
    const r3 = createRouter({ config: DEFAULT_CONFIG, roots: t, stateDir });
    assert.ok(r3.entries().map((e) => e.id).includes("skill:new-skill"), "re-discovery on change");
    assert.notEqual(statSync(indexFile).mtimeMs, mtimeBefore, "state rewritten after change");
  } finally {
    t.cleanup();
  }
});

test("index applies config exclusions", () => {
  const t = copyFixturesToTemp();
  try {
    const config = { ...DEFAULT_CONFIG, exclude: ["skill:pdf-extractor"] };
    const d = discoverAll(t);
    const idx = updateIndex(d, { entries: new Map(), lastUpdated: "", scan: "" }, config).index;
    assert.equal(idx.entries.get("skill:pdf-extractor")?.enabled, false);
    assert.equal(idx.entries.get("skill:pdf-summarizer")?.enabled, true);
  } finally {
    t.cleanup();
  }
});

void existsSync; // keep import used if tree-shaken
