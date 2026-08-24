/**
 * smoke-test.mjs — proves guard-proxy detection + zero-interference guarantees.
 *
 * Black-box: spins an in-process mock llama-server (looping + healthy
 * responses, streaming SSE + plain JSON), starts the real guard-proxy as a
 * child process pointed at it, then asserts:
 *   1. verbatim-loop JSON completion      → strike logged (kind=json)
 *   2. loop right after a message-count collapse → flagged post-compaction
 *   3. verbatim-loop SSE completion       → strike logged (kind=stream)
 *   4. streamed bytes reach the client BYTE-IDENTICAL (tap changes nothing)
 *   5. healthy completions                → zero strikes
 *
 * Run: node llama-guard/smoke-test.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const MOCK_PORT = 18099 + Math.floor(Math.random() * 100);
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
    const chunk = text.slice(i, i + chunkSize);
    raw += `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
  }
  raw += "data: [DONE]\n\n";
  return raw;
}

let failures = 0;
const check = (name, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

// --- mock upstream -----------------------------------------------------------
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const looping = body.model === "looper";
    const text = looping ? loopText : healthyText;
    if (req.url === "/v1/messages") {
      // Anthropic protocol — the shape Claude Code actually speaks to llama-server
      if (body.stream) {
        let raw = "";
        for (let i = 0; i < text.length; i += 48) {
          raw += `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: text.slice(i, i + 48) },
          })}\n\n`;
        }
        anthropicRawSse = raw;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(raw);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ role: "assistant", content: [{ type: "text", text }] }));
      }
      return;
    }
    // OpenAI-compatible
    if (body.stream) {
      const raw = makeSse(text);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.end(raw);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
    }
  });
});
let anthropicRawSse = "";
await new Promise((r) => mock.listen(MOCK_PORT, r));

// --- guard under test --------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "guard-smoke-"));
const strikesLog = path.join(tmp, "loop-strikes.jsonl");
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const child = spawn(process.execPath, [path.join(repoRoot, "llama-guard", "guard-proxy.mjs")], {
  env: { ...process.env, GUARD_PORT: String(GUARD_PORT), UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`, STRIKES_LOG: strikesLog },
  stdio: ["ignore", "pipe", "pipe"],
});
let childErr = "";
child.stderr.on("data", (c) => (childErr += c.toString()));
await new Promise((r) => setTimeout(r, 700)); // listen grace

async function chat(model, stream, msgCount) {
  const body = JSON.stringify({ model, stream, messages: Array.from({ length: msgCount }, () => ({ role: "user", content: "hi" })) });
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", body, headers: { "content-type": "application/json" } });
  return res;
}

const strikes = () => {
  try {
    return readFileSync(strikesLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

try {
  // 5. healthy first — baseline, no strikes, sets prevMessageCount=8
  await chat("healthy", false, 8);
  await new Promise((r) => setTimeout(r, 250));
  check("healthy json produces zero strikes", strikes().length === 0);

  // 1+2. looping json right after message-count collapse (8 -> 3)
  await chat("looper", false, 3);
  await new Promise((r) => setTimeout(r, 250));
  let s = strikes();
  check("looping json logs exactly one strike", s.length === 1, JSON.stringify(s[0]?.count));
  check("strike flags suspectedPostCompaction (msgs 8->3)", s[0]?.suspectedPostCompaction === true);
  check("strike kind=json with count>=6", s[0]?.kind === "json" && s[0]?.count >= 6);

  // 3+4. looping SSE — passthrough fidelity + stream-kind strike
  const res = await chat("looper", true, 10);
  const expectedRaw = makeSse(loopText);
  const receivedRaw = await res.text();
  check("SSE passthrough is byte-identical", receivedRaw === expectedRaw);
  check("SSE content-type preserved", (res.headers.get("content-type") || "").includes("event-stream"));
  await new Promise((r) => setTimeout(r, 400));
  s = strikes();
  check("looping sse logs second strike (kind=stream)", s.length === 2 && s[1].kind === "stream");
  check("stream strike not flagged post-compaction (msgs 3->10)", s[1]?.suspectedPostCompaction === false);

  // healthy again — still zero additional
  await chat("healthy", true, 2);
  await new Promise((r) => setTimeout(r, 300));
  check("healthy sse adds no strikes", strikes().length === 2);

  // --- Anthropic protocol (what Claude Code actually speaks to llama-server) ---
  const anthropic = async (model, stream, msgCount) => {
    const body = JSON.stringify({ model, stream, max_tokens: 1024, messages: Array.from({ length: msgCount }, () => ({ role: "user", content: "hi" })) });
    return fetch(`${BASE}/v1/messages`, { method: "POST", body, headers: { "content-type": "application/json" } });
  };
  await anthropic("looper", false, 6); // msgs 2 -> 6, no collapse expected
  await new Promise((r) => setTimeout(r, 250));
  let s2 = strikes();
  check("anthropic json loop detected", s2.length === 3 && s2[2].kind === "json");

  const aRes = await anthropic("looper", true, 4);
  const aReceived = await aRes.text();
  check("anthropic SSE passthrough byte-identical", aReceived === anthropicRawSse);
  await new Promise((r) => setTimeout(r, 400));
  s2 = strikes();
  check("anthropic SSE loop detected (kind=stream)", s2.length === 4 && s2[3].kind === "stream");

  console.log(failures === 0 ? "\nSMOKE TEST GREEN" : `\nSMOKE TEST RED (${failures})`);
  writeFileSync(path.join(tmp, "child-stderr.log"), childErr);
} finally {
  child.kill();
  mock.close();
  if (failures === 0) rmSync(tmp, { recursive: true, force: true });
  else console.log(`artifacts kept at ${tmp}`);
}
process.exit(failures === 0 ? 0 : 1);
