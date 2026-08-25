/**
 * Meta-isolation tests — nothing in this repo may ever reference the REAL
 * user install from test code. This exists because a hardening test once
 * hardcoded the real home ("C:\Users\<user>\.claude-cmr"), ran install +
 * uninstall against it on every suite execution, and silently destroyed
 * the live install six times before the watchdog caught it.
 *
 * Rules enforced here:
 *  1. The literal ".claude-cmr" is banned under test/ — sandboxed homes must
 *     be built from tmp paths (e.g. path.join(tmp, "cmr-home")).
 *  2. Personal usernames / real-home literals are banned under src/, test/,
 *     eval/ — with explicit allowlist for the deliberate live tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "fixtures") continue; // fixtures are inert data
      walk(full, out);
    } else if (/\.(ts|mjs|js|json|md)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const SELF = "test/meta-isolation.test.ts"; // this file documents the banned patterns

function rel(f: string) {
  return path.relative(repoRoot, f).replace(/\\/g, "/");
}

function isSelf(f: string) {
  return rel(f) === SELF;
}

test("isolation: no test file references the real CMR home literal", () => {
  const offenders = walk(path.join(repoRoot, "test"))
    .filter((f) => !isSelf(f))
    .filter((f) => readFileSync(f, "utf8").includes(".claude-cmr"));
  assert.deepEqual(offenders, [], `tests must build sandbox homes from tmp paths, offenders: ${offenders.join(", ")}`);
});

test("isolation: no personal usernames or real-home literals in shipped code", () => {
  // live tools that legitimately target the real user install
  const allow = new Set(["eval/live-e2e.mjs", "eval/promote.mjs"]);
  const offenders: string[] = [];
  for (const dir of ["src", "test", "eval"]) {
    for (const f of walk(path.join(repoRoot, dir))) {
      if (isSelf(f)) continue;
      const r = rel(f);
      if (allow.has(r)) continue;
      const txt = readFileSync(f, "utf8");
      if (/Avinash-Pro/i.test(txt)) offenders.push(`${r} (personal username)`);
      else if (/Users\\\\[^"']+\\\\\.claude-cmr/i.test(txt)) offenders.push(`${r} (real-home literal)`);
    }
  }
  assert.deepEqual(offenders, [], `remove real-user references: ${offenders.join(", ")}`);
});
