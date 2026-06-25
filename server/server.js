// QVAC for Obsidian - companion daemon (Phase 0a).
// ONE daemon serves ALL vaults (multiplexed by vaultId), owning the single ~/.qvac worker.
// Transport: WebSocket for streaming/control, HTTP for /health + a non-stream /chat fallback.
// Auth: per-boot bearer token (?t= on WS, ?t= or Authorization on HTTP). Loopback bind only.
// Phase 0a = chat + search over a whole-vault folder index; incremental upsert/OCR land in 0b.
import http from "node:http";
import path from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { EMBEDDINGGEMMA_300M_Q4_0 } from "@qvac/sdk";
import { ModelManager, BASES } from "./models.js";
import { ContextIndex } from "./context.js";
import { Trainer } from "./train.js";
import { Vault } from "./vault.js";
import { buildRecords, buildCausalDataset } from "./select.js";
import { CONFIG_DIR, vaultDir, ensureToken, writeDaemonFile, removeDaemonFile } from "./config.js";

const VERSION = "0.0.1-0a";
const PORT = Number(process.env.PORT || 8849);
const HOST = "127.0.0.1";
const TOKEN = process.env.QVAC_OBSIDIAN_TOKEN || ensureToken();
const IDLE_EXIT_MS = process.env.QVAC_NO_IDLE_EXIT ? 0 : 30 * 60 * 1000; // self-exit after 30min with no clients

// Context budget for the 4096+ window: cap grounding, trim history, always pin system+grounding.
const CHAT_BASE = "4b";
const GROUND_TOPK = 6, GROUND_CHARS = 700, HISTORY_TURNS = 8;

const mm = new ModelManager({ ctxSize: 8192 });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trainer = new Trainer(path.join(CONFIG_DIR, "training"), path.join(__dirname, "finetune.js"));
let training = false; // a LoRA run holds the global ~/.qvac worker; chat/embed are paused during it
const MODEL_OPS = new Set(["chat", "search", "embed-doc", "index", "complete", "related", "provision"]);
const indexes = new Map(); // vaultId -> ContextIndex
function getIndex(vaultId) {
  const id = String(vaultId || "default");
  if (!indexes.has(id)) indexes.set(id, new ContextIndex(vaultDir(id)));
  return indexes.get(id);
}

// ---- chat grounding (cited from the retrieval layer, never the model) ----
async function buildGrounding(vaultId, message) {
  const idx = getIndex(vaultId);
  if (!idx.records.length) return { grounding: "", hits: [] };
  const qv = (await mm.embedMany([message]))[0];
  const hits = idx.search(qv, { topK: GROUND_TOPK, minScore: 0.3 })
    .map((h) => ({ source: h.source, sourceType: h.sourceType, score: Number(h.score.toFixed(4)), content: String(h.text).slice(0, GROUND_CHARS) }));
  if (!hits.length) return { grounding: "", hits: [] };
  const grounding = "Relevant excerpts from the user's Obsidian vault (cite by [n]):\n" +
    hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.content}`).join("\n");
  return { grounding, hits };
}
function buildSystem(grounding) {
  let s = "You are QVAC, a fully local AI assistant for the user's Obsidian vault. Be concise and helpful. Your replies render as Markdown. ";
  if (grounding) s += "Answer using the excerpts below and cite them by their [n]. If they do not contain the answer, say so briefly.\n\n" + grounding;
  else s += "No vault excerpts were retrieved for this question; answer from general knowledge and note if you are unsure.";
  return s;
}
function trimHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-HISTORY_TURNS);
}

// ---- request handlers (return data for the final reply; push() streams frames) ----
const handlers = {
  async health() {
    return { version: VERSION, models: mm.status(), vaults: [...indexes.keys()] };
  },

  async index(msg, push) {
    const { vaultId, vaultPath } = msg;
    if (!vaultPath) throw new Error("index requires vaultPath");
    const idx = getIndex(vaultId);
    const onProgress = (done, total, phase) => push({ type: "index.progress", done, total, phase: phase || "embedding" });
    await idx.addFolderSource({ rootPath: vaultPath, type: "vault", exts: [".md", ".markdown", ".txt"] },
      (texts, opts) => mm.embedMany(texts, opts), onProgress);
    return idx.stats();
  },

  async search(msg) {
    const { vaultId, query, topK = 8 } = msg;
    const idx = getIndex(vaultId);
    if (!idx.records.length) return { hits: [] };
    const qv = (await mm.embedMany([String(query || "")]))[0];
    const hits = idx.search(qv, { topK }).map((h) => ({ source: h.source, sourceType: h.sourceType, score: Number(h.score.toFixed(4)), content: h.text }));
    return { hits };
  },

  // Incremental push (Phase 0b): the plugin diffs mtimes vs index-manifest and pushes the delta.
  async "embed-doc"(msg) {
    const { vaultId, path: docPath, text, mtime, sourceType } = msg;
    if (!docPath) throw new Error("embed-doc requires path");
    return getIndex(vaultId).upsertDoc(docPath, text, mtime, (texts, opts) => mm.embedMany(texts, opts), sourceType || "vault");
  },
  async "drop-doc"(msg) {
    const { vaultId, path: docPath } = msg;
    if (!docPath) throw new Error("drop-doc requires path");
    return getIndex(vaultId).dropDoc(docPath);
  },
  async "index-manifest"(msg) {
    return { manifest: getIndex(msg.vaultId).manifest() };
  },

  // Inline commands (summarize/rewrite/fix/expand): a plain LLM completion, no RAG. Streams.
  async complete(msg, push) {
    const history = [
      { role: "system", content: String(msg.system || "You are a precise writing assistant. Output only the requested text, no preamble.") },
      { role: "user", content: String(msg.message || "") },
    ];
    const r = await mm.chat(history, { baseKey: CHAT_BASE, reasoningBudget: 0, onToken: push ? (t) => push({ type: "complete.token", text: t }) : undefined });
    return { contentText: r.contentText || "", model: CHAT_BASE };
  },

  // Related-notes: embed the given text, return the top-K OTHER notes (excluding the active one).
  async related(msg) {
    const { vaultId, text, excludePath, topK = 5 } = msg;
    const idx = getIndex(vaultId);
    if (!idx.records.length || !String(text || "").trim()) return { hits: [] };
    const qv = (await mm.embedMany([String(text).slice(0, 2000)]))[0];
    const seen = new Set();
    const hits = [];
    for (const h of idx.search(qv, { topK: topK + 8, minScore: 0.25 })) {
      if (h.source === excludePath || seen.has(h.source)) continue;
      seen.add(h.source);
      hits.push({ source: h.source, sourceType: h.sourceType, score: Number(h.score.toFixed(4)) });
      if (hits.length >= topK) break;
    }
    return { hits };
  },

  // ---- LoRA training (optional; holds the global worker, so chat is paused for the run) ----
  async "train.start"(msg, push) {
    if (training) throw new Error("a training run is already active");
    // ctx MUST be a multiple of the 128-token batch (llama.cpp asserts n_ctx_train % n_batch == 0).
    const { vaultId, vaultPath, baseKey = "1.7b", epochs = 1, ctx = 128 } = msg;
    if (!vaultPath) throw new Error("train.start requires vaultPath");
    const vault = new Vault(vaultPath);
    const records = buildRecords(vault);
    const prose = records.filter((r) => r.kind === "prose").map((r) => r.path);
    if (prose.length < 2) throw new Error(`need at least 2 substantial prose notes to train (found ${prose.length})`);
    const outDir = path.join(CONFIG_DIR, "training", "datasets", String(vaultId || "default"));
    // evalFraction 0 = all docs in train; finetune carves its own validation split (robust for
    // small vaults, where a separate 10% eval file is too few tokens for the context length).
    const ds = buildCausalDataset(vault, prose, outDir, { evalFraction: 0 });
    push({ type: "train.dataset", proseNotes: prose.length, trainDocs: ds.trainDocs, trainChars: ds.trainChars });
    training = true;
    await mm.unloadAll(); // free the worker so the training child can take the ~/.qvac lock
    try {
      return await new Promise((resolve, reject) => {
        trainer.start({ baseKey, mode: "causal", dataset: `vault-${vaultId}`, trainPath: ds.trainPath, evalPath: null, ctx, epochs }, (ev) => {
          if (ev.type === "done") resolve(ev);
          else if (ev.type === "error") reject(new Error(ev.message));
          else push({ type: `train.${ev.type}`, ...ev });
        });
      });
    } finally { training = false; }
  },
  async "train.list"() { return { adapters: trainer.listAdapters() }; },
  async "train.delete"(msg) {
    const a = trainer.listAdapters().find((x) => x.file === msg.file);
    if (a) { try { unlinkSync(a.abs); } catch { /* */ } }
    return { deleted: msg.file, adapters: trainer.listAdapters() };
  },
  async "train.stop"() { trainer.stop(); training = false; return { stopped: true }; },

  async chat(msg, push) {
    const { vaultId, message, memory = true } = msg;
    const { grounding, hits } = memory ? await buildGrounding(vaultId, String(message || "")) : { grounding: "", hits: [] };
    if (push) push({ type: "chat.start", hits });
    const history = [
      { role: "system", content: buildSystem(grounding) },
      ...trimHistory(msg.history),
      { role: "user", content: String(message || "") },
    ];
    // Voice toggle: load the user's LoRA, FORCING its training base (a mismatch SIGSEGVs llama.cpp).
    let baseKey = CHAT_BASE, lora = null, model = CHAT_BASE;
    if (msg.voice && msg.adapter) {
      const a = trainer.listAdapters().find((x) => x.file === msg.adapter);
      if (a) { baseKey = a.baseKey; lora = a.abs; model = `${a.baseKey}+voice`; }
    }
    const r = await mm.chat(history, { baseKey, lora, reasoningBudget: 0, onToken: push ? (t) => push({ type: "chat.token", text: t }) : undefined });
    return { contentText: r.contentText || "", hits, stats: r.stats || null, model };
  },

  async provision(msg, push) {
    // Cache the chat + embed models (lazily; later phases defer TTS/OCR/LoRA-base).
    await mm.download(BASES[CHAT_BASE], "llm", (p) => push({ type: "provision.progress", model: "chat", percentage: p?.percentage ?? null }));
    await mm.download(EMBEDDINGGEMMA_300M_Q4_0, "llamacpp-embedding", (p) => push({ type: "provision.progress", model: "embed", percentage: p?.percentage ?? null }));
    return { provisioned: ["chat", "embed"] };
  },
};

// ---- HTTP (health + non-stream chat) ----
function tokenOk(req, url) {
  const t = url.searchParams.get("t") || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return t === TOKEN;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!tokenOk(req, url)) { res.writeHead(401).end("unauthorized"); return; }
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === "GET" && url.pathname === "/health") return send(200, await handlers.health());
    if (req.method === "POST" && url.pathname === "/chat") {
      const body = await readJson(req);
      const data = await handlers.chat(body, null); // non-stream: no push
      return send(200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/ocr") {
      if (training) return send(503, { ok: false, error: "training in progress" });
      const buf = await readBuffer(req);
      const ext = (url.searchParams.get("ext") || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
      const tmp = path.join(tmpdir(), `qvac-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      writeFileSync(tmp, buf);
      try { const text = await mm.ocr(tmp); return send(200, { ok: true, data: { text } }); }
      finally { try { unlinkSync(tmp); } catch { /* */ } }
    }
    send(404, { ok: false, error: "not found" });
  } catch (e) { send(500, { ok: false, error: e?.message || String(e) }); }
});
function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    req.on("data", (c) => { chunks.push(c); len += c.length; if (len > 30e6) req.destroy(); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 4e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ---- WebSocket (streaming + control) ----
const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    const url = new URL(info.req.url, `http://${HOST}:${PORT}`);
    cb(url.searchParams.get("t") === TOKEN, 401, "unauthorized");
  },
});

let clients = 0, idleTimer = null;
function armIdle() {
  if (!IDLE_EXIT_MS) return;
  clearTimeout(idleTimer);
  if (clients === 0) idleTimer = setTimeout(() => { console.log("[daemon] idle, exiting"); shutdown(0); }, IDLE_EXIT_MS);
}

wss.on("connection", (ws) => {
  clients++; clearTimeout(idleTimer);
  ws.on("close", () => { clients--; armIdle(); });
  ws.on("message", async (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    const { id, type } = msg;
    const reply = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify({ id, ...obj })); };
    const push = (frame) => reply(frame);
    const fn = handlers[type];
    if (!fn) return reply({ ok: false, error: `unknown type: ${type}` });
    if (training && MODEL_OPS.has(type)) return reply({ ok: false, error: "QVAC is training a model; chat is paused until it finishes." });
    try {
      const dataOut = await fn(msg, push);
      reply({ ok: true, data: dataOut });
    } catch (e) {
      // Worker death mid-stream must surface a terminal error frame, never a silent dropped socket.
      if (type === "chat") reply({ type: "chat.error", error: e?.message || String(e) });
      reply({ ok: false, error: e?.message || String(e) });
    }
  });
});

// ---- lifecycle ----
function shutdown(code = 0) {
  removeDaemonFile();
  try { wss.close(); } catch { /* */ }
  try { server.close(); } catch { /* */ }
  mm.unloadAll().catch(() => {}).finally(() => process.exit(code));
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

server.listen(PORT, HOST, () => {
  writeDaemonFile({ port: PORT, token: TOKEN });
  armIdle();
  console.log(`[daemon] QVAC-for-Obsidian companion v${VERSION} on http://${HOST}:${PORT} (config ${CONFIG_DIR})`);
});
