#!/usr/bin/env node
// QVAC for Obsidian - companion daemon (Phase 0a).
// ONE daemon serves ALL vaults (multiplexed by vaultId), owning the single ~/.qvac worker.
// Transport: WebSocket for streaming/control, HTTP for /health + a non-stream /chat fallback.
// Auth: per-boot bearer token (?t= on WS, ?t= or Authorization on HTTP). Loopback bind only.
// Phase 0a = chat + search over a whole-vault folder index; incremental upsert/OCR land in 0b.
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { unlinkSync, writeFileSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { EMBEDDINGGEMMA_300M_Q4_0 } from "@qvac/sdk";
import { ModelManager, BASES, cosine } from "./models.js";
import { ContextIndex } from "./context.js";
import { Trainer } from "./train.js";
import { Vault } from "./vault.js";
import { buildRecords, buildCausalDataset } from "./select.js";
import { CONFIG_DIR, vaultDir, ensureToken, writeDaemonFile, removeDaemonFile, safeVaultId } from "./config.js";

const VERSION = "0.0.1-0a";
const PORT = Number(process.env.PORT || 8849);
const HOST = "127.0.0.1";
const TOKEN = process.env.QVAC_OBSIDIAN_TOKEN || ensureToken();
const IDLE_EXIT_MS = process.env.QVAC_NO_IDLE_EXIT ? 0 : 30 * 60 * 1000; // self-exit after 30min with no clients

// Context budget for the 4096+ window: cap grounding, trim history, always pin system+grounding.
const CHAT_BASE = "4b";
const GROUND_TOPK = 6, GROUND_CHARS = 700, HISTORY_TURNS = 8;

const mm = new ModelManager({ ctxSize: 8192 });

// Persist the optional custom embedder source across restarts (all embed calls read one central
// slot, so setting it here applies everywhere consistently). Changing it means the caller reindexes.
const EMBED_CFG = path.join(CONFIG_DIR, "embed.json");
function loadEmbedSrc() {
  try { const j = JSON.parse(readFileSync(EMBED_CFG, "utf8")); return (typeof j.embedSrc === "string" && j.embedSrc) ? j.embedSrc : null; }
  catch { return null; }
}
function saveEmbedSrc(src) { try { writeFileSync(EMBED_CFG, JSON.stringify({ embedSrc: src || null }), { mode: 0o600 }); } catch { /* */ } }
mm.setEmbedSrc(loadEmbedSrc());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trainer = new Trainer(path.join(CONFIG_DIR, "training"), path.join(__dirname, "finetune.js"));
let training = false; // a LoRA run holds the global ~/.qvac worker; chat/embed are paused during it
const MODEL_OPS = new Set(["chat", "search", "embed-doc", "index", "complete", "related", "provision", "connect.scan"]);

// A user-configured custom chat model (GGUF path or URL) from the plugin settings, if any.
function customModelSrc(msg) {
  return (typeof msg.modelSrc === "string" && msg.modelSrc.trim()) ? msg.modelSrc.trim() : null;
}
function customEmbedSrc(msg) {
  return (typeof msg.embedSrc === "string" && msg.embedSrc.trim()) ? msg.embedSrc.trim() : null;
}
// "|emb2" = the prompt-prefixed embedding scheme; bumping it invalidates pre-prefix indexes so they
// are rebuilt (old unprefixed vectors are not comparable to new prefixed query embeddings).
function currentEmbedTag() { return (mm.embedSrc || "default") + "|emb2"; }
// Refuse to query an index built by a different embedder (same-dim models would return silently
// wrong results). The dimension mismatch is separately guarded inside ContextIndex.search.
function assertEmbedMatch(idx) {
  if (idx.records.length && idx.embedTag && idx.embedTag !== currentEmbedTag())
    throw new Error("The embedding model changed since this vault was indexed. Run 'Reindex vault (full)' in QVAC.");
}

// ---- custom-model helpers (folder browse + cheap validation, no worker load) ----
function expandHome(p) {
  const s = String(p || "");
  return s.startsWith("~") ? path.join(homedir(), s.slice(1)) : s;
}
function isRemoteSrc(s) { return /^(https?|pear|registry):\/\//i.test(String(s || "")); }
// A model file whose name looks like a NON-chat asset (embedder, TTS, OCR, diffusion, ASR...).
const NON_CHAT = /embed|supertonic|parakeet|whisper|stable-diffusion|\bsd[-_]|ocr|craft|clip|mmproj|projection|\btts\b|\bvad\b|nmt|bergamot|smolvla|\bvla\b/i;
// Read the first 4 bytes and confirm the GGUF magic, without loading the model.
function isGgufFile(absPath) {
  let fd;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    return buf.toString("latin1") === "GGUF";
  } catch { return false; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } } }
}
// Recursively collect .gguf models under a folder (large models can live in sets/ or sharded/
// subfolders, and be split into -00001-of-000NN parts). We recurse a few levels, keep only the
// first shard of a split set (the rest load as siblings), and optionally hide non-chat assets.
function collectGguf(dir, chatOnly, depth, acc, budget = { entries: 20000 }) {
  if (acc.length >= 300 || budget.entries <= 0) return acc; // bound work if pointed at a huge tree
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (--budget.entries <= 0 || acc.length >= 300) break;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4) collectGguf(abs, chatOnly, depth + 1, acc, budget); continue; }
    if (!e.name.toLowerCase().endsWith(".gguf")) continue;
    if (chatOnly && NON_CHAT.test(e.name)) continue;
    const shard = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(e.name);
    if (shard && shard[1] !== "00001") continue; // represent a split set by its first part only
    let sizeMB = 0;
    try { sizeMB = Math.round(statSync(abs).size / (1024 * 1024)); } catch { continue; }
    acc.push({ name: e.name, path: abs, sizeMB });
  }
  return acc;
}

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
  assertEmbedMatch(idx);
  const qv = (await mm.embedMany([message], { mode: "query" }))[0];
  const hits = idx.search(qv, { topK: GROUND_TOPK, minScore: 0.3 })
    .map((h) => ({ source: h.source, sourceType: h.sourceType, score: Number(h.score.toFixed(4)), content: String(h.text).slice(0, GROUND_CHARS) }));
  if (!hits.length) return { grounding: "", hits: [] };
  const grounding = "Relevant excerpts from the user's Obsidian vault (cite by [n]):\n" +
    hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.content}`).join("\n");
  return { grounding, hits };
}
function buildSystem(grounding) {
  let s = "You are QVAC, a fully local AI assistant for the user's Obsidian vault. Be concise and helpful. Your replies render as Markdown. When the user asks you to create, draft, or write a note, output the complete note as Markdown starting with a top-level `# Title`; the user can save it to their vault in one click, so never say you cannot create files. ";
  if (grounding) s += "Answer using the excerpts below and cite them by their [n]. If they do not contain the answer, say so briefly.\n\n" + grounding;
  else s += "No vault excerpts were retrieved for this question; answer from general knowledge and note if you are unsure.";
  return s;
}
function trimHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-HISTORY_TURNS);
}

// ---- Connect: discover missing links between notes ----
// Order-independent key so an A->B link and a B->A link count as the same connection.
function pairKey(a, b) { const x = String(a), y = String(b); return JSON.stringify(x < y ? [x, y] : [y, x]); }
// Collapse the chunk-level index into one averaged vector + a short excerpt per prose note.
// Only prose ("vault") sources are linkable; images/audio are not link targets.
function noteVectors(idx) {
  const groups = new Map();
  for (let i = 0; i < idx.records.length; i++) {
    const r = idx.records[i];
    if (r.sourceType && r.sourceType !== "vault") continue;
    const v = idx.vectors[i];
    if (!Array.isArray(v) || !v.length) continue;
    if (!groups.has(r.source)) groups.set(r.source, { vecs: [], text: "" });
    const g = groups.get(r.source);
    g.vecs.push(v);
    if (g.text.length < 600) g.text += (g.text ? " " : "") + r.text;
  }
  const out = [];
  for (const [source, g] of groups) {
    if (!g.vecs.length) continue;
    const dim = g.vecs[0].length;
    const avg = new Array(dim).fill(0);
    let used = 0;
    for (const v of g.vecs) { if (v.length !== dim) continue; for (let d = 0; d < dim; d++) avg[d] += v[d]; used++; }
    if (!used) continue;
    for (let d = 0; d < dim; d++) avg[d] /= used;
    out.push({ source, vec: avg, text: g.text.slice(0, 500) });
  }
  return out;
}
// LLM judges whether a wikilink between two notes is warranted (the differentiator: reasoning,
// not just cosine). One constrained line ("YES - reason" / "NO") is far more robust from a 4B
// than asking for JSON.
async function judgeLink(a, b, modelSrc = null) {
  const sys = "You decide whether two notes from a personal knowledge base should be linked with a wikilink. Link them only if they share a genuinely related topic, person, project, or idea, such that a reader of one would want to jump to the other. Generic overlap (both are notes, both mention a date) is NOT enough. Reply with exactly one line: `YES - <reason, max 8 words>` or `NO`.";
  const user = `Note A (${a.source}):\n${a.text}\n\nNote B (${b.source}):\n${b.text}\n\nShould A and B be linked?`;
  const r = await mm.chat([{ role: "system", content: sys }, { role: "user", content: user }], { baseKey: CHAT_BASE, modelSrc, reasoningBudget: 0 });
  const line = String(r.contentText || "").trim().split("\n")[0].trim();
  if (/^yes\b/i.test(line)) return { link: true, reason: (line.replace(/^yes\s*[-:]?\s*/i, "").trim() || "related").slice(0, 80) };
  return { link: false, reason: "" };
}

// ---- request handlers (return data for the final reply; push() streams frames) ----
const handlers = {
  async health() {
    return { version: VERSION, models: mm.status(), vaults: [...indexes.keys()] };
  },

  // List candidate chat models (.gguf) in a folder, for the settings dropdown. Default: QVAC's own
  // model store (~/.qvac/models). fs-only, no worker load. Non-chat assets are filtered out.
  "models.scan"(msg) {
    const dir = expandHome(msg.dir || "~/.qvac/models");
    // kind "chat" (default) hides obvious non-chat assets; "embed"/"all" show every .gguf so the
    // user can pick an embedding model (whose name often contains "embed").
    const chatOnly = (msg.kind || "chat") === "chat";
    try { statSync(dir); } catch (e) { return { dir, models: [], error: String(e?.message || e) }; }
    const models = collectGguf(dir, chatOnly, 0, []);
    models.sort((a, b) => a.name.localeCompare(b.name));
    return { dir, models };
  },

  // Cheap validation of a chosen model source (no worker load): confirm a local path exists and is a
  // real GGUF; remote URLs are accepted as-is (validated for real on first use).
  "model.check"(msg) {
    const src = customModelSrc(msg);
    if (!src) return { ok: true, kind: "default" };
    if (isRemoteSrc(src)) return { ok: true, kind: "url" };
    const abs = expandHome(src);
    let st;
    try { st = statSync(abs); } catch { return { ok: false, error: "File not found." }; }
    if (!st.isFile()) return { ok: false, error: "Not a file." };
    if (!isGgufFile(abs)) return { ok: false, error: "Not a GGUF file (missing GGUF header)." };
    return { ok: true, kind: "gguf", sizeMB: Math.round(st.size / (1024 * 1024)) };
  },

  // Persist the custom embedder choice (set from settings after first setup). Changing it requires
  // a reindex, since existing vectors were produced by the previous embedder.
  config(msg) {
    const embedSrc = customEmbedSrc(msg);
    const changed = (embedSrc || null) !== mm.embedSrc;
    mm.setEmbedSrc(embedSrc);
    saveEmbedSrc(embedSrc);
    // The embedder changed: existing vectors are stale. Drop loaded indexes so queries return
    // nothing (safe) instead of wrong hits until the plugin reindexes.
    if (changed) for (const idx of indexes.values()) idx.reset();
    return { ok: true, embedSrc };
  },

  async index(msg, push) {
    const { vaultId, vaultPath } = msg;
    if (!vaultPath) throw new Error("index requires vaultPath");
    const idx = getIndex(vaultId);
    const onProgress = (done, total, phase) => push({ type: "index.progress", done, total, phase: phase || "embedding" });
    await idx.addFolderSource({ rootPath: vaultPath, type: "vault", exts: [".md", ".markdown", ".txt"] },
      (texts, opts) => mm.embedMany(texts, { ...opts, mode: "document" }), onProgress);
    return idx.stats();
  },

  async search(msg) {
    const { vaultId, query, topK = 8 } = msg;
    const idx = getIndex(vaultId);
    if (!idx.records.length) return { hits: [] };
    assertEmbedMatch(idx);
    const qv = (await mm.embedMany([String(query || "")], { mode: "query" }))[0];
    // Filter weak matches so a query with no real hit (e.g. "urgent tasks" in a vault that has none)
    // returns few/none rather than a wall of ~35% noise.
    const hits = idx.search(qv, { topK, minScore: 0.4 }).map((h) => ({ source: h.source, sourceType: h.sourceType, score: Number(h.score.toFixed(4)), content: h.text }));
    return { hits };
  },

  // Incremental push (Phase 0b): the plugin diffs mtimes vs index-manifest and pushes the delta.
  async "embed-doc"(msg) {
    const { vaultId, path: docPath, text, mtime, sourceType } = msg;
    if (!docPath) throw new Error("embed-doc requires path");
    const idx = getIndex(vaultId);
    // Embedder changed since this index was built: drop the old vectors so we never mix two models
    // (a full reindex then repopulates cleanly with the new one).
    if (idx.records.length && idx.embedTag && idx.embedTag !== currentEmbedTag()) idx.reset();
    const r = await idx.upsertDoc(docPath, text, mtime, (texts, opts) => mm.embedMany(texts, { ...opts, mode: "document" }), sourceType || "vault");
    if (idx.embedTag !== currentEmbedTag()) idx.stampEmbed(currentEmbedTag());
    return r;
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
    const modelSrc = customModelSrc(msg);
    const r = await mm.chat(history, { baseKey: CHAT_BASE, modelSrc, reasoningBudget: 0, onToken: push ? (t) => push({ type: "complete.token", text: t }) : undefined });
    return { contentText: r.contentText || "", model: modelSrc ? "custom" : CHAT_BASE };
  },

  // Related-notes: embed the given text, return the top-K OTHER notes (excluding the active one).
  async related(msg) {
    const { vaultId, text, excludePath, topK = 5 } = msg;
    const idx = getIndex(vaultId);
    if (!idx.records.length || !String(text || "").trim()) return { hits: [] };
    assertEmbedMatch(idx);
    const qv = (await mm.embedMany([String(text).slice(0, 2000)], { mode: "query" }))[0];
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

  // Connect: find pairs of notes that are semantically close but NOT already linked, then let the
  // LLM judge which deserve a real wikilink (with a one-line reason). The plugin passes the set of
  // pairs it already knows are linked (from Obsidian's resolved-links graph) so we never re-propose
  // an existing edge or waste a judge call on it.
  async "connect.scan"(msg, push) {
    const { vaultId, existingPairs = [], minScore = 0.35, maxCandidates = 20, judge = true } = msg;
    const modelSrc = customModelSrc(msg);
    const idx = getIndex(vaultId);
    assertEmbedMatch(idx);
    let notes = noteVectors(idx);
    // bound the O(N^2) pairwise scan so a huge (or hostile synced) vault can't wedge the worker
    const MAX_NOTES = 2000;
    const capped = notes.length > MAX_NOTES;
    if (capped) notes = notes.slice(0, MAX_NOTES);
    if (notes.length < 2) return { candidates: [], notes: notes.length, scanned: 0, capped };
    // existingPairs is caller-controlled: cap length + skip malformed entries (no unbounded Set alloc)
    const linked = new Set();
    for (const p of (Array.isArray(existingPairs) ? existingPairs.slice(0, 500000) : [])) {
      if (Array.isArray(p) && p.length >= 2) linked.add(pairKey(p[0], p[1]));
    }
    const pairs = [];
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (linked.has(pairKey(notes[i].source, notes[j].source))) continue;
        const score = cosine(notes[i].vec, notes[j].vec);
        if (score >= minScore) pairs.push({ a: notes[i], b: notes[j], score });
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    const top = pairs.slice(0, Math.max(1, Math.min(40, maxCandidates)));
    const out = [];
    let n = 0;
    for (const p of top) {
      n++;
      if (push) push({ type: "connect.progress", done: n, total: top.length });
      let link = true, reason = "semantically related";
      if (judge) { const v = await judgeLink(p.a, p.b, modelSrc); link = v.link; reason = v.reason; }
      if (link) out.push({ a: p.a.source, b: p.b.source, score: Number(p.score.toFixed(3)), reason });
    }
    return { candidates: out, scanned: top.length, notes: notes.length, capped };
  },

  // ---- LoRA training (optional; holds the global worker, so chat is paused for the run) ----
  async "train.start"(msg, push) {
    if (training) throw new Error("a training run is already active");
    // ctx MUST be a multiple of the 128-token batch (llama.cpp asserts n_ctx_train % n_batch == 0).
    const { vaultPath, baseKey = "1.7b", epochs = 1, ctx = 128 } = msg;
    const vaultId = safeVaultId(msg.vaultId); // client-controlled -> sanitize before ANY path/label use
    if (!vaultPath) throw new Error("train.start requires vaultPath");
    const vault = new Vault(vaultPath);
    const records = buildRecords(vault);
    const prose = records.filter((r) => r.kind === "prose").map((r) => r.path);
    if (prose.length < 2) throw new Error(`need at least 2 substantial prose notes to train (found ${prose.length})`);
    const outDir = path.join(CONFIG_DIR, "training", "datasets", vaultId);
    // evalFraction 0 = all docs in train; finetune carves its own validation split (robust for
    // small vaults, where a separate 10% eval file is too few tokens for the context length).
    const ds = buildCausalDataset(vault, prose, outDir, { evalFraction: 0 });
    push({ type: "train.dataset", proseNotes: prose.length, trainDocs: ds.trainDocs, trainChars: ds.trainChars });
    training = true;          // gate new dispatch AND stop the idle-exit from killing the run
    clearTimeout(idleTimer);  // a queued idle-exit must not fire mid-train
    mm.pause();               // reject any in-flight chat's next load instead of colliding with the lock
    await mm.unloadAll();     // free the worker so the training child can take the ~/.qvac lock
    try {
      return await new Promise((resolve, reject) => {
        trainer.start({ baseKey, mode: "causal", dataset: `vault-${vaultId}`, trainPath: ds.trainPath, evalPath: null, ctx, epochs }, (ev) => {
          if (ev.type === "done") resolve(ev);
          else if (ev.type === "error") reject(new Error(ev.message));
          else push({ type: `train.${ev.type}`, ...ev });
        });
      });
    } finally { training = false; mm.resume(); armIdle(); } // resume chat + re-arm idle now that the worker is free
  },
  async "train.list"() { return { adapters: trainer.listAdapters() }; },
  async "train.delete"(msg) {
    const a = trainer.listAdapters().find((x) => x.file === msg.file);
    if (a) { try { unlinkSync(a.abs); } catch { /* */ } }
    return { deleted: msg.file, adapters: trainer.listAdapters() };
  },
  async "train.stop"() { trainer.stop(); training = false; mm.resume(); armIdle(); return { stopped: true }; },

  async chat(msg, push) {
    const { vaultId, message, memory = true } = msg;
    const { grounding, hits } = memory ? await buildGrounding(vaultId, String(message || "")) : { grounding: "", hits: [] };
    if (push) push({ type: "chat.start", hits });
    const history = [
      { role: "system", content: buildSystem(grounding) },
      ...trimHistory(msg.history),
      { role: "user", content: String(message || "") },
    ];
    // A user-supplied GGUF (settings) overrides the registry base and disables voice (no matching
    // LoRA). Otherwise: voice toggle loads the LoRA forcing its training base; else the picker.
    const modelSrc = customModelSrc(msg);
    let baseKey = (msg.baseKey && BASES[msg.baseKey]) ? msg.baseKey : CHAT_BASE, lora = null, model = modelSrc ? "custom" : baseKey;
    if (!modelSrc && msg.voice && msg.adapter) {
      const a = trainer.listAdapters().find((x) => x.file === msg.adapter);
      if (a) { baseKey = a.baseKey; lora = a.abs; model = `${a.baseKey}+voice`; }
    }
    const r = await mm.chat(history, { baseKey, lora, modelSrc, reasoningBudget: 0, onToken: push ? (t) => push({ type: "chat.token", text: t }) : undefined });
    return { contentText: r.contentText || "", hits, stats: r.stats || null, model };
  },

  async provision(msg, push) {
    // Cache the chat + embed models (lazily; later phases defer TTS/OCR/LoRA-base). With a custom
    // chat model (a local GGUF already on disk), skip the big chat download; only embeddings is needed.
    const modelSrc = customModelSrc(msg);
    const embedSrc = customEmbedSrc(msg);
    mm.setEmbedSrc(embedSrc); saveEmbedSrc(embedSrc); // custom embedder is a local GGUF already on disk
    if (!modelSrc) await mm.download(BASES[CHAT_BASE], "llm", (p) => push({ type: "provision.progress", model: "chat", percentage: p?.percentage ?? null }));
    if (!embedSrc) await mm.download(EMBEDDINGGEMMA_300M_Q4_0, "llamacpp-embedding", (p) => push({ type: "provision.progress", model: "embed", percentage: p?.percentage ?? null }));
    return { provisioned: [...(modelSrc ? [] : ["chat"]), ...(embedSrc ? [] : ["embed"])] };
  },
};

// ---- HTTP (health + non-stream chat) ----
// Constant-time token check (length-guarded: timingSafeEqual throws on unequal length).
function tokenEq(t) {
  if (typeof t !== "string" || t.length !== TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN)); } catch { return false; }
}
function tokenOk(req, url) {
  const t = url.searchParams.get("t") || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return tokenEq(t);
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
// NOTE: on over-cap we must REJECT, not just req.destroy() - destroy emits 'close'/'aborted', not
// 'end'/'error', so the old code left the handler promise pending forever (a hung request + leaked
// buffer per oversized upload). Settle exactly once.
function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0, done = false;
    const fail = (e) => { if (done) return; done = true; reject(e); try { req.destroy(); } catch { /* */ } };
    req.on("data", (c) => { if (done) return; chunks.push(c); len += c.length; if (len > 30e6) fail(new Error("payload too large")); });
    req.on("end", () => { if (done) return; done = true; resolve(Buffer.concat(chunks)); });
    req.on("aborted", () => fail(new Error("request aborted")));
    req.on("error", fail);
  });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = "", done = false;
    const fail = (e) => { if (done) return; done = true; reject(e); try { req.destroy(); } catch { /* */ } };
    req.on("data", (c) => { if (done) return; b += c; if (b.length > 4e6) fail(new Error("payload too large")); });
    req.on("end", () => { if (done) return; done = true; try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("aborted", () => fail(new Error("request aborted")));
    req.on("error", fail);
  });
}

// ---- WebSocket (streaming + control) ----
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024 * 1024, // cap WS frame size (the HTTP path caps body; the WS path must too)
  verifyClient: (info, cb) => {
    const url = new URL(info.req.url, `http://${HOST}:${PORT}`);
    cb(tokenEq(url.searchParams.get("t")), 401, "unauthorized");
  },
});

let clients = 0, idleTimer = null;
function armIdle() {
  if (!IDLE_EXIT_MS) return;
  clearTimeout(idleTimer);
  // Never idle-exit while a LoRA run is active: exiting would orphan the finetune child (keeps
  // burning GPU) and lose its adapter (the copy-into-adapters/ on the child's close never runs).
  if (clients === 0 && !training) idleTimer = setTimeout(() => {
    if (training) { armIdle(); return; } // a run started during the countdown: re-arm, don't kill it
    console.log("[daemon] idle, exiting"); shutdown(0);
  }, IDLE_EXIT_MS);
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
