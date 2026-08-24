/**
 * guard-proxy.mjs — anti-loop tap between an agent CLI and llama-server.
 *
 * TIER 1 (monitor): forwards every request verbatim, watches completions
 * for repetition-loop signatures, logs strikes to loop-strikes.jsonl.
 *
 * TIER 2 (conservative auto-retry, GUARD_AUTO_RETRY!=0): NON-STREAMING
 * completions that are detected as verbatim loops are discarded and the
 * SAME request is resent with escalated anti-loop sampling (DRY/repeat-
 * penalty up, small temp nudge). Bounded by GUARD_MAX_RETRIES. Streaming
 * responses stay tap-only (delivered tokens cannot be unsent). Claude Code
 * sees at most one response, as always.
 *
 * Protocols handled: OpenAI-compatible (/v1/chat/completions) AND
 * Anthropic (/v1/messages) — request/response shapes of both.
 *
 * Usage:
 *   GUARD_PORT=11435 UPSTREAM=http://127.0.0.1:8080 node guard-proxy.mjs
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.GUARD_PORT || 11435);
const UPSTREAM = new URL(process.env.UPSTREAM || "http://127.0.0.1:8080");
const STRIKES_LOG = process.env.STRIKES_LOG || "loop-strikes.jsonl";
const DEBUG = process.env.GUARD_DEBUG === "1";
const AUTO_RETRY = process.env.GUARD_AUTO_RETRY !== "0";
const MAX_RETRIES = Number(process.env.GUARD_MAX_RETRIES || 1);

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
const stats = { requests: 0, strikes: 0, retriedRequests: 0, resolvedByRetry: 0 };

// ---- D0 instrumentation: what sampler fields do clients ACTUALLY send? ----
// GUARD_SAMPLING_LOG=path enables one JSONL line per request capturing only
// the sampling keys explicitly present in the body. Feeds the profile-
// precedence decision (does Claude Code pin temperature, or omit it?).
const SAMPLING_LOG = process.env.GUARD_SAMPLING_LOG || "";
const SAMPLING_KEYS = [
  "temperature", "top_p", "top_k", "min_p",
  "repeat_penalty", "presence_penalty", "frequency_penalty",
  "dry_multiplier", "dry_base", "dry_allowed_length", "max_tokens",
];
function observeSampling(body, meta) {
  if (!SAMPLING_LOG) return;
  try {
    const explicit = {};
    for (const k of SAMPLING_KEYS) {
      if (typeof body[k] !== "undefined") explicit[k] = body[k];
    }
    appendFileSync(
      SAMPLING_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: meta?.url || "",
        model: meta?.model ?? "",
        stream: !!meta?.stream,
        messageCount: meta?.messageCount ?? null,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        explicit,
      }) + "\n",
      "utf8",
    );
  } catch {
    /* observability must never break forwarding */
  }
}

/** Sampling escalation ladder — rung index = retry attempt number - 1. */
const ESCALATIONS = [
  null,
  { dry_multiplier: 1.2, repeat_penalty: 1.15 },
  { dry_multiplier: 1.6, repeat_penalty: 1.25 },
];

function logStrike(rec) {
  appendFileSync(STRIKES_LOG, JSON.stringify(rec) + "\n", "utf8");
  stats.strikes++;
  console.error(
    `[strike] attempt=${rec.attempt}/${rec.gaveUpAfterAttempts || "?"} blocks=${rec.count}x${rec.blockLen}ch` +
      `${rec.suspectedPostCompaction ? " POST-COMPACTION" : ""}` +
      `${rec.resolvedByRetry ? " RESOLVED-BY-RETRY" : rec.gaveUp ? " GAVE-UP" : ""}` +
      ` :: ${JSON.stringify(rec.snippet)}`,
  );
}

/** Extract assistant-visible text from either protocol's shapes. */
function extractText(body) {
  try {
    const parts = [];
    if (Array.isArray(body.choices)) {
      for (const ch of body.choices) {
        const m = ch.message || ch.delta || {};
        if (typeof m.content === "string") parts.push(m.content);
        else if (Array.isArray(m.content)) {
          for (const p of m.content) if (p?.type === "text" && p.text) parts.push(p.text);
        }
        for (const tc of m.tool_calls || []) {
          if (tc.function?.arguments) parts.push(String(tc.function.arguments));
        }
      }
    }
    if (Array.isArray(body.content)) {
      for (const p of body.content) {
        if (typeof p?.text === "string") parts.push(p.text);
      }
    }
    if (body.type === "content_block_delta" && body.delta) {
      if (typeof body.delta.text === "string") parts.push(body.delta.text);
      if (typeof body.delta.thinking === "string") parts.push(body.delta.thinking);
    }
    return parts.join("");
  } catch {
    return "";
  }
}

function postCompaction(msgCount) {
  return (
    typeof msgCount === "number" &&
    typeof prevMessageCount === "number" &&
    msgCount * 2 < prevMessageCount
  );
}

/** Minimal SSE accumulator: pulls delta content out of the stream (tap-only). */
function sseTap(upRes, meta) {
  let buf = "";
  let text = "";
  upRes.on("data", (chunk) => {
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
        /* partial frames reassemble at next boundary */
      }
    }
  });
  upRes.on("end", () => {
    stats.requests++;
    const scan = loopScan(text);
    if (scan.count >= STRIKE_THRESHOLD) {
      const msgCount = meta?.messageCount ?? null;
      logStrike({
        ts: new Date().toISOString(),
        kind: "stream",
        model: meta?.model ?? "",
        messageCount: msgCount,
        suspectedPostCompaction: postCompaction(msgCount),
        count: scan.count,
        blockLen: scan.blockLen,
        outputChars: text.length,
        snippet: scan.snippet,
        attempt: 1,
        resolvedByRetry: false,
        note: "tap-only: streaming is never retried",
      });
    }
    prevMessageCount = typeof msgCount === "number" ? msgCount : prevMessageCount;
  });
}

function forwardOnce(method, targetPath, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    delete h["content-length"];
    delete h.host;
    h.host = `${UPSTREAM.hostname}:${UPSTREAM.port}`;
    const rq = http.request(
      { hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: targetPath, method, headers: h },
      (res) => {
        const cs = [];
        res.on("data", (c) => cs.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(cs) }));
      },
    );
    rq.on("error", reject);
    if (bodyBuf.length) rq.write(bodyBuf);
    rq.end();
  });
}

function escalateBody(reqRaw, rungIndex) {
  try {
    const b = JSON.parse(reqRaw.toString());
    const e = ESCALATIONS[rungIndex] || {};
    const origTemp = typeof b.temperature === "number" ? b.temperature : 0.7;
    Object.assign(b, e);
    b.temperature = Math.min(1.3, +(origTemp + 0.1 * rungIndex).toFixed(2));
    return Buffer.from(JSON.stringify(b));
  } catch {
    return reqRaw; // opaque body: resend as-is (best effort)
  }
}

const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];
  clientReq.on("data", (c) => chunks.push(c));
  clientReq.on("end", async () => {
    const reqBody = Buffer.concat(chunks);
    let meta = {};
    let wantsStream = false;
    try {
      const parsed = JSON.parse(reqBody.toString() || "{}");
      meta.model = parsed.model || "";
      meta.messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : null;
      meta.stream = parsed.stream === true;
      meta.url = clientReq.url;
      wantsStream = meta.stream;
      observeSampling(parsed, meta);
      if (DEBUG) console.error(`[req] ${clientReq.method} ${clientReq.url} msgs=${meta.messageCount} model=${meta.model}`);
    } catch {
      /* opaque body — still proxied fine */
    }

    if (wantsStream) {
      // ---- TIER 1 path: single request, piped live while tapped ----
      try {
        const upRes = await rawPipe(clientReq.method, clientReq.url, clientReq.headers, reqBody, clientRes, (u) =>
          sseTap(u, meta),
        );
      } catch (e) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: { message: `guard-proxy upstream error: ${e.message}` } }));
      }
      return;
    }

    // ---- NON-STREAMING: inspect → optional bounded retry → deliver ----
    try {
      const attempts = []; // strike records for looped generations
      let out = await forwardOnce(clientReq.method, clientReq.url, clientReq.headers, reqBody);
      let attempt = 1;
      const maxAttempts = AUTO_RETRY ? 1 + MAX_RETRIES : 1;

      const scanOf = (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          const text = extractText(parsed);
          return { text, scan: loopScan(text) };
        } catch {
          return null; // error bodies etc. — deliver as-is
        }
      };

      let cur = scanOf(out.raw);
      while (cur && cur.scan.count >= STRIKE_THRESHOLD && attempt < maxAttempts) {
        attempts.push({
          ts: new Date().toISOString(),
          kind: "json",
          model: meta?.model ?? "",
          messageCount: meta?.messageCount ?? null,
          suspectedPostCompaction: postCompaction(meta?.messageCount),
          count: cur.scan.count,
          blockLen: cur.scan.blockLen,
          outputChars: cur.text.length,
          snippet: cur.scan.snippet,
          attempt,
        });
        attempt++;
        stats.retriedRequests++;
        out = await forwardOnce(
          clientReq.method,
          clientReq.url,
          clientReq.headers,
          escalateBody(reqBody, attempt - 1),
        );
        cur = scanOf(out.raw);
        if (!cur) break; // became non-JSON (error) — stop escalating
      }

      const finalLooped = !!cur && cur.scan.count >= STRIKE_THRESHOLD;
      // every looped generation gets its own record — including the
      // terminal one when we gave up escalating
      if (finalLooped && (!attempts.length || attempts[attempts.length - 1].attempt !== attempt)) {
        attempts.push({
          ts: new Date().toISOString(),
          kind: "json",
          model: meta?.model ?? "",
          messageCount: meta?.messageCount ?? null,
          suspectedPostCompaction: postCompaction(meta?.messageCount),
          count: cur.scan.count,
          blockLen: cur.scan.blockLen,
          outputChars: cur.text.length,
          snippet: cur.scan.snippet,
          attempt,
        });
      }
      const gaveUpAfterAttempts = finalLooped ? attempt : undefined;
      const resolvedByRetry = attempts.length > 0 && !finalLooped;
      if (resolvedByRetry) stats.resolvedByRetry++;

      for (const rec of attempts) {
        logStrike({
          ...rec,
          resolvedByRetry,
          gaveUp: finalLooped,
          ...(finalLooped ? { gaveUpAfterAttempts } : {}),
        });
      }
      if (resolvedByRetry) {
        console.error(`[retry] ${meta.model || "req"}: ${attempts.length} looped attempt(s) -> clean on attempt ${attempt}`);
      }

      stats.requests++;
      prevMessageCount = typeof meta.messageCount === "number" ? meta.messageCount : prevMessageCount;
      clientRes.writeHead(out.status, out.headers);
      clientRes.end(out.raw);
    } catch (e) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: { message: `guard-proxy upstream error: ${e.message}` } }));
    }
  });
});

/** Issue request, pipe upstream straight to client, return upstream res for tapping.
    onUpRes runs BEFORE piping begins so taps never miss early chunks. */
function rawPipe(method, targetPath, headers, bodyBuf, clientRes, onUpRes) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    delete h["content-length"];
    delete h.host;
    h.host = `${UPSTREAM.hostname}:${UPSTREAM.port}`;
    const rq = http.request(
      { hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: targetPath, method, headers: h },
      (upRes) => {
        try {
          onUpRes?.(upRes);
        } catch {}
        clientRes.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(clientRes);
        resolve(upRes);
      },
    );
    rq.on("error", reject);
    if (bodyBuf.length) rq.write(bodyBuf);
    rq.end();
  });
}

server.listen(PORT, () => {
  console.error(
    `guard-proxy listening on :${PORT} -> ${UPSTREAM.href} | auto-retry=${AUTO_RETRY ? `on (max ${MAX_RETRIES})` : "off"}`,
  );
  console.error(`strikes -> ${STRIKES_LOG} | threshold: any block ${MIN_BLOCK}-${MAX_BLOCK}ch x${STRIKE_THRESHOLD}`);
});

setInterval(() => {
  console.error(
    `[stats] requests=${stats.requests} strikes=${stats.strikes} retried=${stats.retriedRequests} resolvedByRetry=${stats.resolvedByRetry}`,
  );
}, 60000).unref();

process.on("SIGINT", () => {
  console.error(
    `\n[final] requests=${stats.requests} strikes=${stats.strikes} retried=${stats.retriedRequests} resolvedByRetry=${stats.resolvedByRetry}`,
  );
  process.exit(0);
});
