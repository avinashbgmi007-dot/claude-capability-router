/**
 * Phase 8 tests: slash-command discovery + operational hygiene (log pruning).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { discoverAll, indexById, scanFingerprint } from "../src/discovery.js";
import { updateIndex } from "../src/index-store.js";
import { createRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { CapabilityIndexEntry } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = {
  homeDir: path.join(repoRoot, "test", "fixtures", "home"),
  workspaceDir: path.join(repoRoot, "test", "fixtures", "project"),
};

function discoveredIds(): Set<string> {
  return new Set([...indexById(discoverAll(roots)).values()].map((e) => e.id));
}

test("commands: user, workspace, and plugin commands are discovered", () => {
  const ids = discoveredIds();
  assert.ok(ids.has("command:deploy"), "user command");
  assert.ok(ids.has("command:db-migrate"), "workspace command");
  assert.ok(ids.has("command:pr-status"), "plugin command");
});

test("commands: invocation syntax is the slash form; kind and category set", () => {
  const byId = indexById(discoverAll(roots));
  const deploy = byId.get("command:deploy")!;
  assert.equal(deploy.kind, "command");
  assert.equal(deploy.invocation, "/deploy");
  assert.equal(deploy.category, "command");
  assert.ok(deploy.description.length > 10, "frontmatter description extracted");
});

test("commands: routing picks the right command over skills/agents", () => {
  const discovered = [...indexById(discoverAll(roots)).values()];
  const entries: CapabilityIndexEntry[] = [
    ...updateIndex(discovered, { entries: new Map(), lastUpdated: "", scan: "" }, DEFAULT_CONFIG).index.entries.values(),
  ];
  const router = createRouter({ config: DEFAULT_CONFIG, roots, entries });
  const r = router.route("ship my changes and open a pull request");
  assert.equal(r.routed, true);
  assert.equal(r.plan[0].primary?.entry.id, "command:deploy");
});

test("commands: adding a command file changes the scan fingerprint", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cmr-p8cmd-"));
  try {
    const home = { homeDir: tmp, workspaceDir: path.join(tmp, "ws") };
    mkdirSync(path.join(home.workspaceDir, ".claude", "commands"), { recursive: true });
    const before = scanFingerprint(home);
    writeFileSync(path.join(home.workspaceDir, ".claude", "commands", "lint.md"), "---\ndescription: run lint checks\n---\nrun eslint\n");
    const after = scanFingerprint(home);
    assert.notEqual(before, after, "new command must invalidate the persisted index");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
