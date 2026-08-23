/**
 * promote.mjs — turn logged reality into labeled corpus candidates.
 *
 * Reads decisions.jsonl + usage.jsonl from the live install and emits
 * corpus-shaped candidates for human review (report-only: nothing is added
 * to eval/corpus.json automatically):
 *
 *   - silent wins  → high-value: router passed through but a capability was
 *     invoked anyway. Suggested label: route to the invoked id.
 *   - routed+compliant decisions → suggested label: keep as-is (validates
 *     current behavior under the harness).
 *   - every other logged prompt → needs a human label; the router's own
 *     decision is attached only as a hint.
 *
 * Candidates are deduped against eval/corpus.json and each other.
 * Output defaults to eval/corpus-candidates.json; --stdout prints instead.
 *
 * Run: node eval/promote.mjs [--dir <cmr-home>] [--out <file>] [--stdout]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const home = argOf("--dir") || process.env.CLAUDE_CMR_HOME || path.join(os.homedir(), ".claude-cmr");
const logsDir = path.join(home, "logs");
const outArg = argOf("--out") || "eval/corpus-candidates.json";
const toStdout = args.includes("--stdout");

const rt = async (m) => import(pathToFileURL(path.join(repoRoot, "dist", "src", m)).href);
const { computeStats } = await rt("stats.js");

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

const decisions = readJsonl(path.join(logsDir, "decisions.jsonl"));
if (decisions.length === 0) {
  console.log(`No decisions found in ${logsDir} — use the live install for a while first.`);
  process.exit(0);
}
const stats = computeStats(decisions, readJsonl(path.join(logsDir, "usage.jsonl")));

// existing corpus prompts → dedupe
const corpusPath = path.join(repoRoot, "eval", "corpus.json");
const corpus = existsSync(corpusPath) ? JSON.parse(readFileSync(corpusPath, "utf8")) : { cases: [] };
const seen = new Set(corpus.cases.map((c) => c.prompt));
const norm = (p) => p.replace(/\s+/g, " ").trim().toLowerCase();

// silent wins: strongest candidates — reality already labeled them
const silentWinCases = [];
for (const w of stats.silentWins) {
  const prompt = norm(w.prompt);
  if (!prompt || prompt.startsWith("<task-notification>") || seen.has(prompt)) continue;
  seen.add(prompt);
  silentWinCases.push({
    id: `R${String(silentWinCases.length + 1).padStart(3, "0")}`,
    prompt: w.prompt.replace(/\s+/g, " ").trim(),
    expect: { route: true, plan: w.invokedIds.map((primary) => ({ primary })) },
    _source: "silent-win",
    _ts: w.ts,
  });
}

// compliant routings: validate current behavior stays correct
const compliantCases = [];
const routedSeen = new Set();
for (const d of decisions) {
  if (!d.routed || !d.plan?.[0]?.primary) continue;
  const prompt = norm(d.prompt || "");
  if (!prompt || prompt.startsWith("<task-notification>") || seen.has(prompt) || routedSeen.has(prompt)) continue;
  routedSeen.add(prompt);
  seen.add(prompt);
  compliantCases.push({
    id: `C${String(compliantCases.length + 1).padStart(3, "0")}`,
    prompt: (d.prompt || "").replace(/\s+/g, " ").trim(),
    expect: { route: true, plan: d.plan.filter((s) => s.primary).map((s) => ({ primary: s.primary })) },
    _source: "compliant-routing",
  });
}

const candidates = { note: "Human-reviewed candidates promoted from live logs. Review labels, then move approved cases into eval/corpus.json.", generatedAt: new Date().toISOString(), cases: [...silentWinCases, ...compliantCases] };

if (toStdout) {
  console.log(JSON.stringify(candidates, null, 2));
} else {
  const outFile = path.isAbsolute(outArg) ? outArg : path.join(repoRoot, outArg);
  writeFileSync(outFile, JSON.stringify(candidates, null, 2) + "\n", "utf8");
  console.log(`Wrote ${candidates.cases.length} candidates (${silentWinCases.length} silent-win, ${compliantCases.length} compliant-routing) to ${path.relative(repoRoot, outFile)}`);
  console.log(`Stats context: ${stats.routedDecisions} routed / ${stats.decisions} decisions; compliance=${stats.compliant} ignored=${stats.ignored} override=${stats.overridden}`);
  console.log("Review the labels by hand, then move approved cases into eval/corpus.json.");
}
