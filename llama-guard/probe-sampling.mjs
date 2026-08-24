/**
 * probe-sampling.mjs — D0.5: does THIS llama-server build honor extended
 * sampler fields (repeat_penalty / dry_multiplier) on BOTH endpoints?
 *
 * Method: identical "repeat this line 5x" request four ways —
 *   {endpoint} x {with absurd repeat_penalty 3.0 | without}
 * If a build honors repeat_penalty, the repeated phrase gets suppressed
 * (far fewer occurrences / mangled output). Occurrence counts tell truth.
 *
 * Run while llama-server is up:  node llama-guard/probe-sampling.mjs [port]
 */
import http from "node:http";

const PORT = Number(process.argv[2] || 8080);
const LINE = "the quick brown fox jumps over the lazy dog";
const PROMPT = `Output exactly these five lines and nothing else:\n${LINE}\n${LINE}\n${LINE}\n${LINE}\n${LINE}`;

function call(endpoint, extraParams) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "local",
      max_tokens: 500,
      temperature: 0.1,
      messages: [{ role: "user", content: PROMPT }],
      ...extraParams,
    });
    const rq = http.request(
      { hostname: "127.0.0.1", port: PORT, path: endpoint, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        const cs = [];
        res.on("data", (c) => cs.push(c));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(cs).toString());
            let text = "";
            if (Array.isArray(j.choices)) text = j.choices.map((c) => c.message?.content ?? "").join("");
            else if (Array.isArray(j.content)) text = j.content.map((p) => p.text ?? "").join("");
            resolve(text);
          } catch (e) {
            resolve(`<parse-error: ${e.message}>`);
          }
        });
      },
    );
    rq.on("error", reject);
    rq.write(body);
    rq.end();
  });
}

const countPhrase = (t) => (t.match(/quick brown fox/g) || []).length;

const results = {};
for (const ep of ["/v1/chat/completions", "/v1/messages"]) {
  results[ep] = {};
  for (const [label, params] of [
    ["baseline", {}],
    ["rp3.0", { repeat_penalty: 3.0 }],
  ]) {
    process.stderr.write(`probing ${ep} ${label}...\n`);
    const text = await call(ep, params);
    results[ep][label] = { chars: text.length, phraseCount: countPhrase(text), head: text.slice(0, 70).replace(/\n/g, "\\n") };
  }
}

console.log("\n=== D0.5 verdict ===");
for (const ep of Object.keys(results)) {
  const b = results[ep].baseline;
  const r = results[ep]["rp3.0"];
  const honored = r.phraseCount < b.phraseCount || Math.abs(r.chars - b.chars) > 40;
  console.log(`${ep}: baseline=${b.phraseCount}x phrase (${b.chars}ch) | rp3.0=${r.phraseCount}x (${r.chars}ch) -> ${honored ? "HONORED" : "IGNORED?"}`);
  console.log(`   baseline head: ${b.head}`);
  console.log(`   rp3.0    head: ${r.head}`);
}
