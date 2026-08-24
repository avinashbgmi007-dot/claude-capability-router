/**
 * quality-check.mjs — behavioral verification that task-aware profiles
 * produce clean, non-degraded answers (no gibberish, no loops, no DRY
 * distortion of legitimate repetition).
 *
 * Runs against the GUARD (:11435) so profiles are active; prints full text
 * per case + mechanical heuristics. Judgment on tone stays human.
 *
 * Run: node llama-guard/quality-check.mjs [guardPort]
 */
import http from "node:http";

const PORT = Number(process.argv[2] || 11435);

function call(body) {
  return new Promise((resolve, reject) => {
    const rq = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        const cs = [];
        res.on("data", (c) => cs.push(c));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(cs).toString());
            resolve(j.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 200));
          } catch (e) {
            resolve(`<error: ${e.message}>`);
          }
        });
      },
    );
    rq.on("error", reject);
    rq.write(JSON.stringify({ model: "local", max_tokens: 700, ...body }));
    rq.end();
  });
}

function loopScan(text) {
  const win = text.slice(-2048);
  let worst = 0;
  for (let b = 16; b <= 160; b += 8) {
    if (win.length < b * 6) continue;
    const block = win.slice(-b);
    let count = 0;
    let idx = 0;
    while ((idx = win.indexOf(block, idx)) !== -1) {
      count++;
      idx++;
    }
    if (count > worst) worst = count;
  }
  return worst;
}

const cases = [
  {
    name: "CODE — complete slugify function",
    body: { messages: [{ role: "user", content: "Complete this function so the example works. Return only code.\n```\nfunction slugify(title) {\n  // example: 'My Cool Post!' -> 'my-cool-post'\n}\n```" }] },
    judge: (t) => ({
      ok: /toLowerCase|replace\//.test(t) && /-/.test(t) && !/TODO/.test(t),
      note: "expects lowercase+replace logic, no leftover TODO",
    }),
  },
  {
    name: "PLAN — 5-step migration roadmap",
    body: { messages: [{ role: "user", content: "Give me exactly 5 numbered steps to migrate a JavaScript monorepo from npm to pnpm workspaces. One sentence per step." }] },
    judge: (t) => {
      const steps = (t.match(/^\s*\d[\).\s]/gm) || []).length;
      return { ok: steps >= 5 && loopScan(t) < 4, note: `numbered lines=${steps}` };
    },
  },
  {
    name: "CHAT — explain blue sky to a kid",
    body: { messages: [{ role: "user", content: "In two or three friendly sentences, explain why the sky is blue to a curious 8-year-old." }] },
    judge: (t) => ({ ok: t.length > 80 && /\b(light|sun)\b/i.test(t) && loopScan(t) < 4, note: `len=${t.length}` }),
  },
  {
    name: "ADVERSARIAL — deliberate refrain under CHAT anti-repeat pressure",
    body: { messages: [{ role: "user", content: 'Repeat exactly this line three times, nothing else:\nall systems operational' }] },
    judge: (t) => {
      const n = (t.match(/all systems operational/gi) || []).length;
      return { ok: n === 3, note: `"all systems operational" x${n} (want 3 — fewer means DRY distorted compliance)` };
    },
  },
];

console.log(`probing guard on :${PORT}...\n`);
for (const c of cases) {
  const t = await call(c.body);
  const j = c.judge(t);
  console.log("=".repeat(72));
  console.log(`${j.ok ? "PASS" : "FAIL"} ${c.name} (${j.note}, loopScore=${loopScan(t)})`);
  console.log("-".repeat(72));
  console.log(t.trim().slice(0, 600));
  console.log("");
}
