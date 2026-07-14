import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import WebSocket from "ws";
const info = JSON.parse(readFileSync(homedir() + "/.qvac-obsidian/daemon.json", "utf8"));
const VAULT = "/Users/thomasblanc/Documents/PRO/QVAC/QVAC-agent/test/27-obsidian-qvac/demo-vault";
const vaultId = "c75aef2926d6820f";
const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?t=${info.token}`);
const send = (o) => ws.send(JSON.stringify(o));
ws.on("open", () => { console.log("indexing demo vault..."); send({ id: "idx", type: "index", vaultId, vaultPath: VAULT }); });
ws.on("message", (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.type === "index.progress") process.stdout.write(`  index ${m.done}/${m.total} (${m.phase})\r`);
  if (m.id === "idx" && m.ok !== undefined) {
    if (!m.ok) { console.log("index failed:", m.error); process.exit(1); }
    console.log(`\nindexed: ${m.data.totalChunks} chunks. scanning for missing links...`);
    send({ id: "scan", type: "connect.scan", vaultId, existingPairs: [], minScore: 0.4, maxCandidates: 25 });
  }
  if (m.type === "connect.progress") process.stdout.write(`  judging ${m.done}/${m.total}\r`);
  if (m.id === "scan" && m.ok !== undefined) {
    if (!m.ok) { console.log("scan failed:", m.error); process.exit(1); }
    const c = m.data.candidates;
    console.log(`\n=== Connect proposed ${c.length} links (from ${m.data.notes} notes, ${m.data.scanned} candidates judged) ===`);
    for (const x of c) console.log(`  [${x.score}] ${x.a.replace(/\.md$/,'')}  <->  ${x.b.replace(/\.md$/,'')}\n        ${x.reason}`);
    process.exit(0);
  }
});
ws.on("error", (e) => { console.log("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 600000);
