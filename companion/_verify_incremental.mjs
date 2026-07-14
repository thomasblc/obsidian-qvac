// Phase 0b E2E: the incremental push index. Upsert per-note docs, check the manifest tracks
// mtimes, editing one note changes only it, dropping one removes it from search. Headless.
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8852, TOKEN = "test-token", VID = "inc";
const CONFIG_DIR = path.join(os.tmpdir(), "qvac-obsidian-inc-" + Date.now());

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

const daemon = spawn("node", [path.join(__dirname, "server.js")], {
  env: { ...process.env, PORT: String(PORT), QVAC_OBSIDIAN_CONFIG_DIR: CONFIG_DIR, QVAC_OBSIDIAN_TOKEN: TOKEN, QVAC_NO_IDLE_EXIT: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
daemon.stdout.on("data", (d) => process.stdout.write("[daemon] " + d));
function cleanup(code) { try { daemon.kill("SIGKILL"); } catch {} try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {} process.exit(code); }

async function waitHealth() {
  for (let i = 0; i < 30; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/health?t=${TOKEN}`); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error("no health");
}
let ws, seq = 0;
function rpc(type, payload = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = "r" + ++seq; const frames = [];
    const timer = setTimeout(() => { ws.off("message", onMsg); reject(new Error(type + " timeout")); }, timeoutMs);
    function onMsg(raw) { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.id !== id) return; if (m.ok === undefined) { frames.push(m); return; } clearTimeout(timer); ws.off("message", onMsg); resolve({ final: m, frames }); }
    ws.on("message", onMsg); ws.send(JSON.stringify({ id, type, ...payload }));
  });
}
const up = (p, text, mtime) => rpc("embed-doc", { vaultId: VID, path: p, text, mtime });
const manifest = async () => (await rpc("index-manifest", { vaultId: VID })).final.data.manifest;
const search = async (q) => (await rpc("search", { vaultId: VID, query: q, topK: 3 })).final.data.hits;

(async () => {
  await waitHealth();
  console.log("=== Phase 0b E2E (incremental index) ===");
  ws = new WebSocket(`ws://127.0.0.1:${PORT}?t=${TOKEN}`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  const a = await up("a.md", "The capital of France is Paris, a major European city.", 1000);
  ok("upsert a.md", a.final.ok && a.final.data.chunks > 0, JSON.stringify(a.final.error || ""));
  await up("b.md", "Medical note: the patient is allergic to penicillin.", 2000);
  await up("c.md", "Project Aurora is a secret notebook that launches in Q3 2026.", 3000);

  let man = await manifest();
  ok("manifest has 3 docs", Object.keys(man).length === 3, `(${Object.keys(man).join(",")})`);
  ok("manifest tracks mtime", man["c.md"]?.mtime === 3000, `(c.md mtime=${man["c.md"]?.mtime})`);

  let hits = await search("what project launches in Q3");
  ok("search finds c.md", /c\.md/.test(hits[0]?.source || ""), `(top=${hits[0]?.source})`);

  // edit c.md: re-upsert with new text + mtime -> only c.md changes
  const before = { a: man["a.md"].mtime, b: man["b.md"].mtime };
  await up("c.md", "Project Aurora was RENAMED to Project Borealis, launching in Q4.", 4000);
  man = await manifest();
  ok("edit changed only c.md mtime", man["c.md"].mtime === 4000 && man["a.md"].mtime === before.a && man["b.md"].mtime === before.b, JSON.stringify(man));
  hits = await search("what is Borealis");
  ok("re-upsert reflected in search", /c\.md/.test(hits[0]?.source || "") && /borealis/i.test(hits[0]?.content || ""), `(top=${hits[0]?.source})`);

  // drop b.md -> gone from manifest + search
  await rpc("drop-doc", { vaultId: VID, path: "b.md" });
  man = await manifest();
  ok("drop removed b.md from manifest", !man["b.md"] && Object.keys(man).length === 2);
  hits = await search("penicillin allergy");
  ok("dropped doc not in search", !hits.some((h) => h.source === "b.md"), `(hits=${hits.map((h) => h.source).join(",")})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  ws.close(); cleanup(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e?.stack || e); cleanup(1); });
