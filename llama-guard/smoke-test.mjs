/**
 * smoke-test.mjs — proves guard-proxy behavior end-to-end against a mock
 * looping upstream. Two phases, two guard instances:
 *
 *   Phase 1 — MONITOR MODE (GUARD_AUTO_RETRY=0)
 *     detection fires on JSON + SSE (OpenAI & Anthropic shapes),
 *     passthrough is byte-identical, compaction tag correct,
 *     healthy traffic produces zero strikes
 *
 *   Phase 2 — TIER 2 AUTO-RETRY (GUARD_AUTO_RETRY=1, MAX_RETRIES=1)
 *     looped non-streaming generation is retried with escalated sampling:
 *       - resolvable loop  → client receives CLEAN text, strike marked
 *                            resolvedByRetry
 *       - unresolvable     → bounded give-up, last attempt forwarded
 *                            verbatim, chain flagged
 *
 * Run: node llama-guard/smoke-test.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const MOCK_PORT = 18200 + Math.floor(Math.random() * 100);
const GUARD_PORT = MOCK_PORT + 200;
const BASE = `http://127.0.0.1:${GUARD_PORT}`;

const LOOP_UNIT = "All systems operational. ";
const loopText = LOOP_UNIT.repeat(120); // ~2.9KB of pure verbatim repetition
const healthyText =
  "Guardians of the galaxy tuned their radios toward distant pulsars yesterday. " +
  "Nobody expected the violin solo that followed across three octaves. " +
  "Meanwhile, a quiet refactor settled into the repository like fresh snow.";

function makeSse(text, chunkSize = 48) {
  let raw = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    raw += `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + chunkSize) } }] })}\n\n`;
  }
  raw += "data: [DONE]\n\n";
  return raw;
}

function makeAnthropicSse(text, chunkSize = 48) {
  let raw = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    raw += `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(i, i + chunkSize) },
    })}\n\n`;
  }
  return raw;
}

let failures = 0;
const check = (name, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

// --- mock upstream -----------------------------------------------------------
const callCounts = {};
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    let looping;
    if (body.model === "looper" || body.model === "looper-always") looping = true;
    else if (body.model === "looper-once") {
      callCounts[body.model] = (callCounts[body.model] || 0) + 1;
      looping = callCounts[body.model] === 1;
    } else looping = false;
    const text = looping ? loopText : healthyText;
    if (req.url === "/v1/messages") {
      // Anthropic protocol
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(makeAnthropicSse(text));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ role: "assistant", content: [{ type: "text", text }] }));
      }
      return;
    }
    // OpenAI-compatible
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.end(makeSse(text));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
    }
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

// --- harness ------------------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "guard-smoke-"));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
let childErrAll = "";

function startGuard(extraEnv) {
  const strikesLog = path.join(tmp, `strikes-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);
  const child = spawn(process.execPath, [path.join(repoRoot, "llama-guard", "guard-proxy.mjs")], {
    env: {
      ...process.env,
      GUARD_PORT: String(GUARD_PORT),
      UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
      STRIKES_LOG: strikesLog,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (c) => (childErrAll += c.toString()));
  return { child, strikesLog };
}

const stopGuard = (child) =>
  new Promise((r) => {
    child.kill();
    setTimeout(r, 300);
  });

async function chat(model, stream, msgCount) {
  const body = JSON.stringify({ model, stream, messages: Array.from({ length: msgCount }, () => ({ role: "user", content: "hi" })) });
  return fetch(`${BASE}/v1/chat/completions`, { method: "POST", body, headers: { "content-type": "application/json" } });
}
async function anthropic(model, stream, msgCount) {
  const body = JSON.stringify({
    model,
    stream,
    max_tokens: 1024,
    messages: Array.from({ length: msgCount }, () => ({ role: "user", content: "hi" })),
  });
  return fetch(`${BASE}/v1/messages`, { method: "POST", body, headers: { "content-type": "application/json" } });
}
const readStrikes = (file) => {
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

try {
  // ================= PHASE 1: monitor mode =================
  let g = startGuard({ GUARD_AUTO_RETRY: "0" });
  await new Promise((r) => setTimeout(r, 700));
  const s1 = () => readStrikes(g.strikesLog);

  await chat("healthy", false, 8);
  await new Promise((r) => setTimeout(r, 250));
  check("P1: healthy json produces zero strikes", s1().length === 0);

  await chat("looper", false, 3); // msgs collapse 8 -> 3
  await new Promise((r) => setTimeout(r, 250));
  let s = s1();
  check("P1: looping json logs exactly one strike", s.length === 1, `count=${s[0]?.count}`);
  check("P1: strike flags suspectedPostCompaction (msgs 8->3)", s[0]?.suspectedPostCompaction === true);
  check("P1: strike kind=json with count>=6", s[0]?.kind === "json" && s[0]?.count >= 6);

  const res = await chat("looper", true, 10);
  const receivedRaw = await res.text();
  check("P1: SSE passthrough byte-identical", receivedRaw === makeSse(loopText));
  check("P1: SSE content-type preserved", (res.headers.get("content-type") || "").includes("event-stream"));
  await new Promise((r) => setTimeout(r, 400));
  s = s1();
  check("P1: looping sse logs second strike (kind=stream)", s.length === 2 && s[1].kind === "stream");
  check("P1: stream strike not flagged post-compaction (msgs 3->10)", s[1]?.suspectedPostCompaction === false);

  await chat("healthy", true, 2);
  await new Promise((r) => setTimeout(r, 300));
  check("P1: healthy sse adds no strikes", s1().length === 2);

  await anthropic("looper", false, 6);
  await new Promise((r) => setTimeout(r, 250));
  s = s1();
  check("P1: anthropic json loop detected", s.length === 3 && s[2].kind === "json");

  const aRes = await anthropic("looper", true, 4);
  const aReceived = await aRes.text();
  check("P1: anthropic SSE passthrough byte-identical", aReceived === makeAnthropicSse(loopText));
  await new Promise((r) => setTimeout(r, 400));
  s = s1();
  check("P1: anthropic SSE loop detected (kind=stream)", s.length === 4 && s[3].kind === "stream");

  await stopGuard(g.child);

  // ================= PHASE 2: tier 2 auto-retry =================
  g = startGuard({ GUARD_AUTO_RETRY: "1", GUARD_MAX_RETRIES: "1" });
  await new Promise((r) => setTimeout(r, 700));
  const s2 = () => readStrikes(g.strikesLog);

  await chat("healthy", false, 5);
  await new Promise((r) => setTimeout(r, 250));
  check("P2: healthy baseline zero strikes", s2().length === 0);

  // resolve-on-retry: first generation loops, escalated retry comes back clean
  const r1 = await chat("looper-once", false, 4);
  const r1Body = await r1.json();
  await new Promise((rr) => setTimeout(rr, 300));
  check(
    "P2: client receives CLEAN retried text",
    r1Body.choices?.[0]?.message?.content?.includes("fresh snow") === true,
  );
  let recs = s2();
  check("P2: one strike for the looped attempt", recs.length === 1 && recs[0].attempt === 1);
  check("P2: strike marked resolvedByRetry", recs[0]?.resolvedByRetry === true && recs[0]?.gaveUp === false);

  // give-up-after-cap: always loops -> last attempt forwarded verbatim
  const r2 = await chat("looper-always", false, 2);
  const r2Body = await r2.json();
  await new Promise((rr) => setTimeout(rr, 300));
  check(
    "P2: capped give-up forwards last attempt verbatim",
    r2Body.choices?.[0]?.message?.content?.includes(LOOP_UNIT.trim()) === true,
  );
  recs = s2();
  check("P2: two strikes for two looped attempts", recs.length === 3 && recs[1].attempt === 1 && recs[2].attempt === 2);
  check("P2: gave-up chain flagged", recs[1].resolvedByRetry === false && recs[2].gaveUpAfterAttempts === 2);

  console.log(failures === 0 ? "\nSMOKE TEST GREEN" : `\nSMOKE TEST RED (${failures})`);
  writeFileSync(path.join(tmp, "guard-stderr.log"), childErrAll);
} finally {
  mock.close();
  if (failures === 0) rmSync(tmp, { recursive: true, force: true });
  else console.log(`artifacts kept at ${tmp}`);
}
process.exit(failures === 0 ? 0 : 1);
