// Phase 0a E2E: spawn the daemon, drive it over WS, assert health/index/search/cited-chat + the
// error path. Headless, no Obsidian. Models are loaded from ~/.qvac cache (4B + EmbeddingGemma).
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8851, TOKEN = "test-token";
const CONFIG_DIR = path.join(os.tmpdir(), "qvac-obsidian-test-" + Date.now());
const VAULT = path.resolve(__dirname, "../sample-vault");
const VAULT_ID = "testvault";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };

const daemon = spawn("node", [path.join(__dirname, "server.js")], {
  env: { ...process.env, PORT: String(PORT), QVAC_OBSIDIAN_CONFIG_DIR: CONFIG_DIR, QVAC_OBSIDIAN_TOKEN: TOKEN, QVAC_NO_IDLE_EXIT: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
daemon.stdout.on("data", (d) => process.stdout.write("[daemon] " + d));
daemon.stderr.on("data", (d) => process.stderr.write("[daemon:err] " + String(d).split("\n").filter((l) => !/sdk:server|sdk:client|request-lifecycle|common_init|warming|parse:/.test(l)).join("\n")));

function cleanup(code) {
  try { daemon.kill("SIGKILL"); } catch {}
  try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

async function waitHealth() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health?t=${TOKEN}`); if (r.ok) return await r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon did not become healthy");
}

let ws, seq = 0;
function rpc(type, payload = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = "r" + ++seq;
    const frames = [];
    const timer = setTimeout(() => { cleanupHandler(); reject(new Error(`${type} timed out`)); }, timeoutMs);
    function onMsg(raw) {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id !== id) return;
      if (m.ok === undefined) { frames.push(m); return; } // streaming frame
      clearTimeout(timer); cleanupHandler(); resolve({ final: m, frames });
    }
    function cleanupHandler() { ws.off("message", onMsg); }
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, type, ...payload }));
  });
}

(async () => {
  console.log("waiting for daemon health...");
  const health = await waitHealth();
  console.log("=== Phase 0a E2E ===");
  ok("health version", health.version === "0.0.1-0a", `(got ${health.version})`);

  ws = new WebSocket(`ws://127.0.0.1:${PORT}?t=${TOKEN}`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  // bad token must be rejected
  await new Promise((res) => {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}?t=wrong`);
    bad.on("open", () => { ok("token gate", false, "(bad token connected)"); res(); });
    bad.on("error", () => { ok("token gate", true); res(); });
  });

  console.log("indexing sample vault (loads embed model)...");
  const idx = await rpc("index", { vaultId: VAULT_ID, vaultPath: VAULT }, 90000);
  ok("index ok", idx.final.ok === true, JSON.stringify(idx.final.error || ""));
  ok("index produced chunks", (idx.final.data?.totalChunks || 0) > 0, `(chunks=${idx.final.data?.totalChunks})`);

  console.log("search...");
  const s = await rpc("search", { vaultId: VAULT_ID, query: "what is the secret project codename", topK: 3 }, 30000);
  const topSource = s.final.data?.hits?.[0]?.source || "";
  ok("search returns hits", (s.final.data?.hits?.length || 0) > 0);
  ok("search top hit is aurora.md", /aurora/i.test(topSource), `(top=${topSource}, score=${s.final.data?.hits?.[0]?.score})`);

  console.log("chat (loads 4B chat model, may take ~15s)...");
  const c = await rpc("chat", { vaultId: VAULT_ID, message: "What is the codename of the secret project? Answer in one short sentence and cite the source.", memory: true }, 150000);
  const tokenFrames = c.frames.filter((f) => f.type === "chat.token").length;
  const startFrame = c.frames.find((f) => f.type === "chat.start");
  const reply = c.final.data?.contentText || "";
  ok("chat ok", c.final.ok === true, JSON.stringify(c.final.error || ""));
  ok("chat streamed tokens", tokenFrames > 0, `(token frames=${tokenFrames})`);
  ok("chat.start carried hits", (startFrame?.hits?.length || 0) > 0);
  ok("chat answer mentions Aurora", /aurora/i.test(reply), `(reply="${reply.slice(0, 120)}")`);
  console.log(`  chat reply: "${reply.slice(0, 160)}"`);

  // error path: unknown type -> ok:false
  const e = await rpc("doesnotexist", {}, 10000);
  ok("unknown type errors cleanly", e.final.ok === false && /unknown type/.test(e.final.error || ""));

  console.log(`\n${pass} passed, ${fail} failed`);
  ws.close();
  cleanup(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e?.stack || e); cleanup(1); });
