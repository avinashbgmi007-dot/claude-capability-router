/**
 * guard-proxy.mjs — anti-loop tap between an agent CLI and llama-server.
 *
 * MONITOR-FIRST MODE: pure pass-through. Forwards every request verbatim,
 * watches completions for repetition-loop signatures, and logs strikes to
 * loop-strikes.jsonl. Changes nothing about responses (retry-with-
 * escalation comes later, gated on measured strike data).
 *
 * Detects:
 *   - verbatim loops: any 16–160 char block recurring >=6 times in the
 *     final 2KB of assistant output (the classic local-model death spiral)
 *   - compaction-correlated strikes: a strike on a request whose message
 *     count collapsed vs the previous request (auto-compact signature)
 *
 * Usage:
 *   GUARD_PORT=11435 UPSTREAM=http://127.0.0.1:8080 node guard-proxy.mjs
 *   …then point your agent CLI's baseURL at http://127.0.0.1:11435/v1
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.GUARD_PORT || 11435);
const UPSTREAM = new URL(process.env.UPSTREAM || "http://127.0.0.1:8080");
const STRIKES_LOG = process.env.STRIKES_LOG || "loop-strikes.jsonl";
const DEBUG = process.env.GUARD_DEBUG === "1";

const WINDOW = 2048;
const MIN_BLOCK = 16;
const MAX_BLOCK = 160;
const BLOCK_STEP = 8;
const STRIKE_THRESHOLD = 6;

/** Loop score = max occurrences of any trailing-block within the window. */
function loopScan(text) {
  const win = text.slice(-WINDOW);
  let worst = { count: 0, blockLen: 0, snippet: "" };
  for (let b = MIN_BLOCK; b <= MAX_BLOCK; b += BLOCK_STEP) {
    if (win.length < b * STRIKE_THRESHOLD) continue;
    const block = win.slice(-b);
    let count = 0;
    let idx = 0;
    while ((idx = win.indexOf(block, idx)) !== -1) {
      count++;
      idx += 1;
    }
    if (count > worst.count) worst = { count, blockLen: b, snippet: block.slice(0, 60) };
  }
  return worst;
}

let prevMessageCount = null;
const stats = { requests: 0, strikes: 0 };

function logStrike(rec) {
  appendFileSync(STRIKES_LOG, JSON.stringify(rec) + "\n", "utf8");
  stats.strikes++;
  console.error(
    `[strike] blocks=${rec.count}x${rec.blockLen}ch msgs=${rec.messageCount}` +
      `${rec.suspectedPostCompaction ? " POST-COMPACTION" : ""} :: ${JSON.stringify(rec.snippet)}`,
  );
}

function extractText(body) {
  // OpenAI-compatible: choices[0].message.content + tool_call arguments
  try {
    const parts = [];
    for (const ch of body.choices || []) {
      const m = ch.message || ch.delta || {};
      if (typeof m.content === "string") parts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) if (p?.type === "text" && p.text) parts.push(p.text);
      }
      for (const tc of m.tool_calls || []) {
        if (tc.function?.arguments) parts.push(String(tc.function.arguments));
      }
    }
    return parts.join("");
  } catch {
    return "";
  }
}

/** Tap a completed response body (already forwarded) for loops. */
function inspectResponse(rawBody, meta) {
  stats.requests++;
  let text = "";
  let msgCount = meta?.messageCount ?? null;
  try {
    const parsed = JSON.parse(rawBody);
    text = extractText(parsed);
  } catch {
    return; // non-JSON passthrough (errors etc.)
  }
  const scan = loopScan(text);
  if (scan.count >= STRIKE_THRESHOLD) {
    const suspectedPostCompaction =
      typeof msgCount === "number" && typeof prevMessageCount === "number" && msgCount * 2 < prevMessageCount;
    logStrike({
      ts: new Date().toISOString(),
      kind: "json",
      model: meta?.model ?? "",
      messageCount: msgCount,
      suspectedPostCompaction,
      count: scan.count,
      blockLen: scan.blockLen,
      outputChars: text.length,
      snippet: scan.snippet,
    });
  }
}

/** Minimal SSE accumulator: pulls delta.content/tool args out of the stream. */
function sseTap(clientRes, meta, onEnd) {
  let buf = "";
  let text = "";
  clientRes.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        text += extractText(JSON.parse(payload));
      } catch {
        /* partial frames are reassembled by the next line boundary */
      }
    }
  });
  clientRes.on("end", () => {
    stats.requests++;
    const scan = loopScan(text);
    if (scan.count >= STRIKE_THRESHOLD) {
      const msgCount = meta?.messageCount ?? null;
      const suspectedPostCompaction =
        typeof msgCount === "number" && typeof prevMessageCount === "number" && msgCount * 2 < prevMessageCount;
      logStrike({
        ts: new Date().toISOString(),
        kind: "stream",
        model: meta?.model ?? "",
        messageCount: msgCount,
        suspectedPostCompaction,
        count: scan.count,
        blockLen: scan.blockLen,
        outputChars: text.length,
        snippet: scan.snippet,
      });
    }
    prevMessageCount = typeof msgCount === "number" ? msgCount : prevMessageCount;
    onEnd?.();
  });
}

const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];
  clientReq.on("data", (c) => chunks.push(c));
  clientReq.on("end", () => {
    const reqBody = Buffer.concat(chunks);
    let meta = {};
    try {
      const parsed = JSON.parse(reqBody.toString() || "{}");
      meta.model = parsed.model || "";
      meta.messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : null;
      if (DEBUG) console.error(`[req] ${clientReq.method} ${clientReq.url} msgs=${meta.messageCount} model=${meta.model}`);
    } catch {
      /* opaque body — still proxied fine */
    }

    const upReq = http.request(
      {
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: `${UPSTREAM.hostname}:${UPSTREAM.port}` },
      },
      (upRes) => {
        const isSSE = (upRes.headers["content-type"] || "").includes("event-stream");
        if (isSSE) {
          // tap while piping — zero behavioral change
          sseTap(upRes, meta, () => {});
          clientRes.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(clientRes);
        } else {
          const bodyChunks = [];
          upRes.on("data", (c) => bodyChunks.push(c));
          upRes.on("end", () => {
            const raw = Buffer.concat(bodyChunks);
            inspectResponse(raw.toString(), meta);
            prevMessageCount = typeof meta.messageCount === "number" ? meta.messageCount : prevMessageCount;
            clientRes.writeHead(upRes.statusCode, upRes.headers);
            clientRes.end(raw);
          });
        }
      },
    );
    upReq.on("error", (e) => {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: { message: `guard-proxy upstream error: ${e.message}` } }));
    });
    if (reqBody.length) upReq.write(reqBody);
    upReq.end();
  });
});

server.listen(PORT, () => {
  console.error(`guard-proxy (monitor mode) listening on :${PORT} -> ${UPSTREAM.href}`);
  console.error(`strikes -> ${STRIKES_LOG} | threshold: any block ${MIN_BLOCK}-${MAX_BLOCK}ch x${STRIKE_THRESHOLD}`);
});

setInterval(() => {
  console.error(`[stats] requests=${stats.requests} strikes=${stats.strikes}`);
}, 60000).unref();

process.on("SIGINT", () => {
  console.error(`\n[final] requests=${stats.requests} strikes=${stats.strikes}`);
  process.exit(0);
});
