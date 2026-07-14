import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import WebSocket from "ws";
const info = JSON.parse(readFileSync(homedir() + "/.qvac-obsidian/daemon.json", "utf8"));
const vaultId = "315f35161ba5ac7c";
const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?t=${info.token}`);
const id = "c1";
ws.on("open", () => ws.send(JSON.stringify({ id, type: "connect.scan", vaultId, existingPairs: [], minScore: 0.3, maxCandidates: 10 })));
ws.on("message", (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.type === "connect.progress") process.stdout.write(`  judging ${m.done}/${m.total}\r`);
  if (m.id === id && m.ok !== undefined) {
    if (!m.ok) { console.log("ERROR:", m.error); process.exit(1); }
    console.log("\n=== connect.scan ===");
    console.log("notes:", m.data.notes, "| scanned:", m.data.scanned, "| proposed links:", m.data.candidates.length);
    for (const c of m.data.candidates) console.log(`  [${c.score}] ${c.a.replace(/\.md$/,'')}  <->  ${c.b.replace(/\.md$/,'')}   (${c.reason})`);
    process.exit(0);
  }
});
ws.on("error", (e) => { console.log("WS error:", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 180000);
