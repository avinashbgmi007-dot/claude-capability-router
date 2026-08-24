// D0.5b: is temperature honored on /v1/messages? Variety heuristic:
// temp 0 -> near-identical answers across repeats; temp 2 -> visibly varied.
import http from "node:http";
function call(temp) {
  return new Promise((res, rej) => {
    const b = JSON.stringify({ model: "local", max_tokens: 300, temperature: temp, messages: [{ role: "user", content: "Pick exactly one word: apple, banana, cherry, or dragon." }] });
    const rq = http.request({ hostname: "127.0.0.1", port: 8080, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (r) => {
      const cs = [];
      r.on("data", (c) => cs.push(c));
      r.on("end", () => {
        try { const j = JSON.parse(Buffer.concat(cs).toString()); res((j.content || []).map((p) => p.text || "").join("")); } catch { res("ERR"); }
      });
    });
    rq.on("error", rej);
    rq.write(b);
    rq.end();
  });
}
for (const t of [0, 2.0]) {
  const outs = [];
  for (let i = 0; i < 3; i++) outs.push((await call(t)).replace(/\s+/g, " ").slice(0, 45));
  console.log(`temp ${t}:`);
  outs.forEach((o) => console.log(`   "${o}"`));
}
