// SDK model manager for Second Self. One LLM slot (reloaded when the base or the
// LoRA changes, since `lora` is a load-time modelConfig key) and one embedder slot.
// All calls are validated against the installed SDK examples (completion-events.js,
// rag/rag-sqlite.js, embed.d.ts). Do NOT improvise the surface.
import {
  loadModel, unloadModel, completion, embed, ocr,
  startQVACProvider, stopQVACProvider,
  QWEN3_1_7B_INST_Q4, LLAMA_3_2_1B_INST_Q4_0, QWEN3_8B_INST_Q4_K_M, QWEN3_600M_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  BITNET_B1_58_3B_INST_TQ2_0, EMBEDDINGGEMMA_300M_Q4_0, OCR_LATIN_RECOGNIZER_1,
} from "@qvac/sdk";

// Same keys as spike/finetune.js so a LoRA trained there loads here on the SAME base.
// Fine-tunable + relevant (non-medical) bases: Qwen3 0.6B + 1.7B (Q4_0) and BitNet-b1.58 3B
// (TQ2_0, general-purpose, the largest fine-tunable base, probe-verified). Llama-3.2-1B (Q4_0)
// + Qwen3 8B (Q4_K_M) are chat-only (Llama arch + Q4_K_M aren't fine-tunable).
export const BASES = {
  "600m": QWEN3_600M_INST_Q4,
  "1.7b": QWEN3_1_7B_INST_Q4,
  "3b": BITNET_B1_58_3B_INST_TQ2_0,
  "1b": LLAMA_3_2_1B_INST_Q4_0,
  "4b": QWEN3_4B_INST_Q4_K_M, // default CHAT base for the Obsidian companion (Q4_K_M = chat-only, not trainable)
  "8b": QWEN3_8B_INST_Q4_K_M,
};

export class ModelManager {
  constructor({ ctxSize = 4096 } = {}) {
    this.ctxSize = ctxSize;
    this.llm = null;   // { modelId, baseKey, lora, tools, remote }
    this.emb = null;   // { modelId } (always local: the vault never leaves)
    this.remote = null;    // { providerPublicKey } -> chat/agent completions run on a remote machine
    this.provider = null;  // this machine's provider public key when sharing its GPU
    this.ocrId = null;     // OCR recognizer slot (loaded on first /api/ocr; pulls a CRAFT detector too)
    // ONE mutex for the single global ~/.qvac worker. EVERY worker RPC (load, completion, embed,
    // unload, download) serializes on it - the WS dispatcher runs handlers concurrently, so without
    // this an embed (memory/context/select) could collide with a chat/load on the one worker.
    this._lock = Promise.resolve();
  }

  // chain fn after the current lock holder; the lock advances even if fn rejects
  _serialize(fn) {
    const run = this._lock.then(() => fn());
    this._lock = run.then(() => {}, () => {});
    return run;
  }

  status() {
    return {
      llm: this.llm ? { baseKey: this.llm.baseKey, lora: this.llm.lora || null } : null,
      embed: this.emb ? { loaded: true } : null,
      remote: this.remote ? this.remote.providerPublicKey : null,
      provider: this.provider,
    };
  }

  // ---- remote / delegated inference (run the LLM on another machine over QVAC P2P) ----
  setRemote(pk) { this.remote = pk ? { providerPublicKey: pk } : null; }
  getRemote() { return this.remote ? this.remote.providerPublicKey : null; }
  async startProvider(allowedKeys) {
    const firewall = allowedKeys && allowedKeys.length ? { mode: "allow", publicKeys: allowedKeys } : undefined;
    const r = await startQVACProvider(firewall ? { firewall } : {});
    this.provider = r.publicKey || null;
    return this.provider;
  }
  async stopProvider() { try { await stopQVACProvider(); } catch { /* */ } this.provider = null; }

  // Run fn(modelId) holding the single-LLM-slot lock for the WHOLE duration, ensuring the
  // requested (base, lora) is loaded first. Holding across the completion (not just the
  // load) is what stops a second chat from reloading/unloading the slot mid-stream.
  // Ensure the requested (base, lora, tools, remote) LLM slot is loaded. NOT locked itself -
  // callers run it inside _serialize so it never races another worker RPC.
  async _loadLLMUnlocked({ baseKey = "1.7b", lora = null, reasoningBudget = 0, tools = false } = {}) {
    // tools + remote are load-time, so both are part of the slot identity (normal local chat
    // stays tools-free + local). When a remote is connected, the LLM runs on that machine.
    const remote = this.getRemote();
    if (!(this.llm && this.llm.baseKey === baseKey && (this.llm.lora || null) === (lora || null) && !!this.llm.tools === !!tools && (this.llm.remote || null) === (remote || null))) {
      if (this.llm) {
        try { await unloadModel({ modelId: this.llm.modelId, clearStorage: false }); } catch { /* */ }
        this.llm = null;
      }
      const src = BASES[baseKey];
      if (!src) throw new Error(`unknown base ${baseKey}`);
      const modelConfig = { device: "gpu", ctx_size: this.ctxSize, reasoning_budget: reasoningBudget };
      if (lora) modelConfig.lora = lora;
      if (tools) { modelConfig.tools = true; modelConfig.toolsMode = "dynamic"; }
      const opts = { modelSrc: src, modelType: "llm", modelConfig };
      // fallbackToLocal:false so a connected-but-unreachable remote errors honestly
      // (instead of silently running local and pretending it is remote).
      if (remote) opts.delegate = { providerPublicKey: remote, fallbackToLocal: false };
      const modelId = await loadModel(opts);
      this.llm = { modelId, baseKey, lora: lora || null, tools: !!tools, remote: remote || null };
    }
    return this.llm.modelId;
  }

  // Run fn(modelId) holding the worker mutex for the WHOLE duration (load + completion), so a
  // second chat/embed can't reload/unload the slot mid-stream.
  async _withLLM(opts = {}, fn = null) {
    return this._serialize(async () => {
      const id = await this._loadLLMUnlocked(opts);
      if (!fn) return id;
      try { return await fn(id); }
      catch (e) {
        // If the worker crashed (SIGSEGV/abort) or a modelId went stale, this.llm/this.emb still
        // point at dead ids and the next same-slot request would skip reloading + fail forever.
        // A worker death takes BOTH slots down with it, so drop both -> the next call reloads fresh.
        if (this._isWorkerGone(e)) { this.llm = null; this.emb = null; }
        throw e;
      }
    });
  }

  // Agentic chat: the model can call vault tools (search/read/list/edit). Loops until it
  // stops calling tools (capped at maxHops). executeTool(call)->string runs the actual vault
  // op (permission-gated by the caller). onToken streams content; onTool reports each call.
  async agentChat(history, { baseKey = "1.7b", tools, executeTool, onToken, onTool, maxHops = 6, reasoningBudget = 0 } = {}) {
    return this._withLLM({ baseKey, reasoningBudget, tools: true }, async (modelId) => {
      this._agentSeq = (this._agentSeq || 0) + 1;
      const kvCache = `agent-${this._agentSeq}`; // unique per call so the dynamic tool set never poisons a later turn
      let finalText = "", hops = 0;
      while (hops++ < maxHops) {
        const run = completion({ modelId, history, tools, kvCache, stream: true });
        let text = "";
        for await (const ev of run.events) {
          if (ev.type === "contentDelta") { text += ev.text; if (onToken) onToken(ev.text); }
          else if (ev.type === "toolCall" && onTool) onTool(ev.call);
        }
        const final = await run.final;
        text = final.contentText || text;
        const calls = final.toolCalls || [];
        history.push({ role: "assistant", content: text });
        if (!calls.length) { finalText = text; break; }
        for (const call of calls) {
          let res; try { res = await executeTool(call); } catch (e) { res = "error: " + (e?.message || e); }
          history.push({ role: "tool", content: String(res).slice(0, 4000) });
        }
      }
      // Dead-end guard: if we burned every hop still calling tools (small models can loop on
      // near-identical searches), force ONE final answer with NO tools so the user never gets an
      // empty reply. Fresh kvCache: the tool set changed, and reusing the loop's cache could poison it.
      if (!finalText) {
        history.push({ role: "system", content: "Stop using tools now. Answer the owner directly using what you already found above. If the notes did not contain the answer, say so briefly." });
        const wrap = completion({ modelId, history, kvCache: `${kvCache}-final`, stream: true });
        for await (const ev of wrap.events) { if (ev.type === "contentDelta") { finalText += ev.text; if (onToken) onToken(ev.text); } }
        const wf = await wrap.final; finalText = wf.contentText || finalText;
        history.push({ role: "assistant", content: finalText });
      }
      return { contentText: finalText, history };
    });
  }

  async ensureLLM(opts = {}) { return this._withLLM(opts, null); }

  // A worker death (SIGSEGV/abort) or a stale modelId ("Model with ID ... not found") means the
  // cached slot ids are dead; callers null this.llm/this.emb then reload on the next call.
  _isWorkerGone(e) {
    return /model with id .* not found|worker exited|in-flight calls were aborted|SIGSEGV|SIGABRT|SIGKILL/i.test(String(e?.message || e));
  }

  async _ensureEmbedUnlocked() {
    if (this.emb) return this.emb.modelId;
    const modelId = await loadModel({ modelSrc: EMBEDDINGGEMMA_300M_Q4_0, modelType: "llamacpp-embedding" });
    this.emb = { modelId };
    return modelId;
  }
  async ensureEmbed() { return this._serialize(() => this._ensureEmbedUnlocked()); }

  // Fetch a model's weights into ~/.qvac/models (loadModel downloads, then we unload).
  // onProgress receives the SDK load/download progress ({ percentage }). Loads with a
  // small ctx and no GPU to keep the transient footprint down; it is only being cached.
  async download(modelSrc, modelType, onProgress) {
    return this._serialize(async () => {
      const modelConfig = modelType === "llm" ? { ctx_size: 256 } : {};
      const modelId = await loadModel({ modelSrc, modelType, modelConfig, onProgress });
      try { await unloadModel({ modelId, clearStorage: false }); } catch { /* */ }
      return true;
    });
  }

  // Embed many texts; batches to keep each RPC small. Returns number[][] aligned to input.
  async embedMany(texts, { batch = 16, onProgress } = {}) {
    return this._serialize(async () => {
      // Retry once: if the embedder id went stale (the worker restarted out from under us),
      // embed() throws "Model with ID ... not found". Drop the cached slot and reload before failing.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const modelId = await this._ensureEmbedUnlocked();
          const out = [];
          for (let i = 0; i < texts.length; i += batch) {
            const slice = texts.slice(i, i + batch);
            const res = await embed({ modelId, text: slice });
            const vecs = Array.isArray(res.embedding[0]) ? res.embedding : [res.embedding];
            for (const v of vecs) out.push(v);
            if (onProgress) onProgress(Math.min(i + batch, texts.length), texts.length);
          }
          return out;
        } catch (e) {
          if (attempt === 0 && this._isWorkerGone(e)) { this.emb = null; continue; } // reload + retry
          throw e;
        }
      }
    });
  }


  // Stream a completion. onToken(text) for content, onThink(text) for thinking deltas.
  // Returns { contentText, thinkingText, stats }.
  async chat(history, { baseKey = "1.7b", lora = null, onToken, onThink, captureThinking = false, reasoningBudget = 0 } = {}) {
    return this._withLLM({ baseKey, lora, reasoningBudget }, async (modelId) => {
      const run = completion({ modelId, history, stream: true, captureThinking });
      for await (const ev of run.events) {
        if (ev.type === "contentDelta" && onToken) onToken(ev.text);
        else if (ev.type === "thinkingDelta" && onThink) onThink(ev.text);
      }
      const final = await run.final;
      return { contentText: final.contentText, thinkingText: final.thinkingText, stats: final.stats };
    });
  }

  // OCR an image file -> recognized text. Loads the Latin recognizer (+ an auto-pulled CRAFT
  // detector on first use, an extra one-time download). Serialized on the single worker.
  async ocr(imagePath) {
    return this._serialize(async () => {
      if (!this.ocrId) this.ocrId = await loadModel({ modelSrc: OCR_LATIN_RECOGNIZER_1, modelType: "ocr", modelConfig: { langList: ["en"], useGPU: true } });
      const run = ocr({ modelId: this.ocrId, image: imagePath, options: { paragraph: false } });
      const blocks = await run.blocks;
      return (blocks || []).map((b) => b.text).filter(Boolean).join(" ");
    });
  }

  async unloadAll() {
    return this._serialize(async () => {
      if (this.llm) { try { await unloadModel({ modelId: this.llm.modelId, clearStorage: false }); } catch { /* */ } this.llm = null; }
      if (this.emb) { try { await unloadModel({ modelId: this.emb.modelId, clearStorage: false }); } catch { /* */ } this.emb = null; }
      if (this.ocrId) { try { await unloadModel({ modelId: this.ocrId, clearStorage: false }); } catch { /* */ } this.ocrId = null; }
    });
  }
}

// Split a document into overlapping word-windowed chunks for retrieval.
// Strips YAML front-matter, packs by paragraph up to wordsPerChunk, with a small
// word overlap so a fact split across a boundary is still retrievable.
// The embedder rejects any input over ~1024 tokens. Two guards keep every source embeddable
// WITHOUT changing how normal word-separated text chunks (so existing vaults don't re-chunk on
// reindex): (1) split an over-long single "word" - a long tracking URL, a base64 blob, a minified
// line - BEFORE word-chunking, since that is what actually overflows the batch; (2) a generous
// whole-chunk char cap as a final safety net for whitespace-sparse text (e.g. CJK, where the whole
// line is one "word"). A normal 120-word chunk of English or code stays well under MAX_CHUNK_CHARS,
// so it is returned byte-for-byte as before.
const MAX_WORD_CHARS = 800;   // a single token longer than this is split before chunking
// The embedder rejects any input line over 1024 TOKENS ("batch overflow: ... exceeds batch size
// (1024)"), and the limit cannot be raised via load config (the embedding schema rejects n_batch).
// Tokens-per-char varies (dense French markdown measured ~2.1 chars/token; CJK ~1), so cap chunks at
// 950 CHARS: that stays under 1024 tokens for any realistic content, incl. accents/markdown/CJK.
const MAX_CHUNK_CHARS = 950;
function splitLongWords(words) {
  const out = [];
  for (const w of words) {
    if (w.length <= MAX_WORD_CHARS) out.push(w);
    else for (let i = 0; i < w.length; i += MAX_WORD_CHARS) out.push(w.slice(i, i + MAX_WORD_CHARS));
  }
  return out;
}
function capChunk(s) {
  if (s.length <= MAX_CHUNK_CHARS) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) out.push(s.slice(i, i + MAX_CHUNK_CHARS));
  return out;
}

export function chunkText(doc, wordsPerChunk = 120, overlap = 20) {
  const body = String(doc || "").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (!body) return [];
  const rawWords = body.split(/\s+/);
  const words = splitLongWords(rawWords); // identity unless a single token exceeds MAX_WORD_CHARS
  // fast path: a short doc with no oversized token returns its text verbatim - byte-for-byte the
  // same as before this guard existed, so existing indexes don't re-chunk on reindex.
  if (words.length === rawWords.length && rawWords.length <= wordsPerChunk) return capChunk(body);
  const raw = [];
  if (words.length <= wordsPerChunk) raw.push(words.join(" "));
  else {
    const step = Math.max(1, wordsPerChunk - overlap);
    for (let i = 0; i < words.length; i += step) {
      raw.push(words.slice(i, i + wordsPerChunk).join(" "));
      if (i + wordsPerChunk >= words.length) break;
    }
  }
  return raw.flatMap(capChunk); // final safety net for whitespace-sparse chunks
}

// Cosine similarity for the graph's semantic edges.
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// Top-K nearest neighbors per item -> dedup pairs for "embed" edges.
export function topKPairs(ids, vectors, k = 4, minScore = 0.55) {
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    const sims = [];
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      sims.push([j, cosine(vectors[i], vectors[j])]);
    }
    sims.sort((x, y) => y[1] - x[1]);
    for (const [j, score] of sims.slice(0, k)) {
      if (score < minScore) break;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: ids[i], b: ids[j], score });
    }
  }
  return pairs;
}
