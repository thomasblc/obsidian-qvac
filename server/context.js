// Per-vault, source-tracked, on-device index. Carved from Second Self and adapted for the
// Obsidian companion: the macOS SQLite/os-stores branch is removed (an Obsidian vault is a folder
// of files), and the storage dir is passed in per vault (constructor(dataDir)) so one daemon can
// hold one index per vault. Each chunk keeps its source path so retrieval returns citable origins
// (we cite from the retrieval layer, never the model). Phase 0b adds incremental upsert/drop.
//
// Storage (under <dataDir>/):
//   index.json   - { dim, sources:[...], records:[{sourceId,source,sourceType,text}] }
//   vectors.bin  - Float32 matrix (records.length x dim), aligned to records order
import fs from "node:fs";
import path from "node:path";
import { cosine, chunkText } from "./models.js";
import { parseDocx, parsePdf } from "./docparse.js";

export const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".org", ".tex",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".sh", ".sql", ".lua", ".r",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv", ".html", ".css", ".xml",
  ".pdf", ".docx", // binary docs: text extracted via docparse (read as a buffer, not utf8)
]);
export const BINARY_EXTS = new Set([".pdf", ".docx"]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv"]);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_BINARY_FILE = 30 * 1024 * 1024;
const MAX_FILES = 20000;

const rid = () => "src-" + Math.random().toString(36).slice(2, 10);

export class ContextIndex {
  constructor(dataDir) {
    if (!dataDir) throw new Error("ContextIndex requires a dataDir");
    this.dir = dataDir;
    this.meta = path.join(dataDir, "index.json");
    this.vecs = path.join(dataDir, "vectors.bin");
    this.sources = []; // [{ id, type, path, label, exts, addedAt, lastIndexedAt, docCount, chunkCount }]
    this.records = []; // [{ sourceId, source, sourceType, text }] aligned to this.vectors
    this.vectors = []; // number[][]
    this.dim = 0;
    this.docs = {};    // path -> { mtime, chunks, sourceType } for the incremental push model (Phase 0b)
    this._load();
  }

  _load() {
    try {
      const meta = JSON.parse(fs.readFileSync(this.meta, "utf8"));
      this.sources = Array.isArray(meta.sources) ? meta.sources : [];
      this.records = Array.isArray(meta.records) ? meta.records : [];
      this.dim = Number(meta.dim) || 0;
      this.docs = (meta.docs && typeof meta.docs === "object") ? meta.docs : {};
      if (this.dim && this.records.length) {
        const buf = fs.readFileSync(this.vecs);
        // exact byte-size check rejects a torn meta/vectors pair (a short buffer yields empty subarrays
        // that would pass a count-only check).
        if (buf.byteLength !== this.records.length * this.dim * 4) throw new Error("vector file size mismatch");
        const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        this.vectors = [];
        for (let i = 0; i < this.records.length; i++) this.vectors.push(Array.from(f.subarray(i * this.dim, (i + 1) * this.dim)));
      } else if (this.records.length) { throw new Error("records without a dim"); }
      if (this.vectors.length !== this.records.length) throw new Error("record/vector misalignment");
    } catch {
      this.records = []; this.vectors = []; this.dim = 0; this.docs = {};
      this.sources = (this.sources || []).map((s) => ({ ...s, docCount: 0, chunkCount: 0 }));
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (this.dim && this.vectors.length) {
        const f = new Float32Array(this.vectors.length * this.dim);
        for (let i = 0; i < this.vectors.length; i++) f.set(this.vectors[i], i * this.dim);
        fs.writeFileSync(this.vecs + ".tmp", Buffer.from(f.buffer, f.byteOffset, f.byteLength));
        fs.renameSync(this.vecs + ".tmp", this.vecs);
      } else { try { fs.unlinkSync(this.vecs); } catch { /* */ } }
      fs.writeFileSync(this.meta + ".tmp", JSON.stringify({ dim: this.dim, sources: this.sources, records: this.records, docs: this.docs }));
      fs.renameSync(this.meta + ".tmp", this.meta);
    } catch (e) { console.error("[context] save failed (index kept in memory this session):", e?.message || e); }
  }

  stats() {
    return {
      sources: this.sources.map((s) => ({ id: s.id, type: s.type, path: s.path, label: s.label, docCount: s.docCount || 0, chunkCount: s.chunkCount || 0, lastIndexedAt: s.lastIndexedAt || null })),
      totalChunks: this.records.length,
    };
  }

  getSource(id) { return this.sources.find((s) => s.id === id) || null; }
  findByPath(p) { const r = path.resolve(p); return this.sources.find((s) => path.resolve(s.path) === r) || null; }

  // Walk a folder for readable text files (bounded). Returns { files:[{rel,abs,mtime}] }.
  _walk(rootAbs, exts) {
    const out = [];
    const allow = exts && exts.size ? exts : TEXT_EXTS;
    const stack = [rootAbs];
    while (stack.length && out.length < MAX_FILES) {
      const dir = stack.pop();
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(abs); continue; }
        if (!e.isFile()) continue;
        const xt = path.extname(e.name).toLowerCase();
        if (!allow.has(xt)) continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.size === 0 || st.size > (BINARY_EXTS.has(xt) ? MAX_BINARY_FILE : MAX_FILE)) continue;
        out.push({ rel: path.relative(rootAbs, abs), abs, mtime: st.mtimeMs });
        if (out.length >= MAX_FILES) break;
      }
    }
    return { files: out };
  }

  // Build a folder source's records + vectors WITHOUT mutating the index (so a failed embed never
  // corrupts existing data). embed(texts,{onProgress}) -> number[][].
  async _buildFolder({ rootPath, type = "vault", exts = null }, embed, onProgress) {
    const rootAbs = path.resolve(rootPath);
    if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) throw new Error("not a folder: " + rootPath);
    const extSet = exts && exts.length ? new Set(exts.map((x) => (x.startsWith(".") ? x : "." + x).toLowerCase())) : null;
    const { files } = this._walk(rootAbs, extSet);
    const records = [];
    let scanned = 0;
    for (const f of files) {
      scanned++;
      if (onProgress && (scanned === 1 || scanned % 25 === 0 || scanned === files.length)) onProgress(scanned, files.length, "scanning");
      const ext = path.extname(f.abs).toLowerCase();
      let content;
      if (BINARY_EXTS.has(ext)) {
        let buf; try { buf = fs.readFileSync(f.abs); } catch { continue; }
        try { content = ext === ".pdf" ? await parsePdf(buf) : parseDocx(buf); } catch { content = ""; }
      } else {
        try { content = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
      }
      if (!content) continue;
      for (const c of chunkText(content, 120, 20)) records.push({ sourceId: null, source: f.rel, sourceType: type, text: c });
    }
    if (!records.length) throw new Error("no readable text files found in that folder");
    const vectors = await embed(records.map((r) => r.text), { onProgress });
    if (vectors.length !== records.length) throw new Error("embedding returned the wrong count");
    return { rootAbs, fileCount: files.length, records, vectors, dim: vectors[0].length };
  }

  _commit(built, { type, label, exts }) {
    if (this.dim && built.dim !== this.dim) throw new Error(`embedding dim mismatch (${built.dim} vs ${this.dim})`);
    if (!this.dim) this.dim = built.dim;
    const id = rid();
    for (const r of built.records) { r.sourceId = id; this.records.push(r); }
    for (const v of built.vectors) this.vectors.push(v);
    const src = { id, type, path: built.rootAbs, label: label || path.basename(built.rootAbs), exts: exts || null, addedAt: Date.now(), lastIndexedAt: Date.now(), docCount: built.fileCount, chunkCount: built.records.length };
    this.sources.push(src);
    this._save();
    return src;
  }

  async addFolderSource({ rootPath, label, type = "vault", exts = null }, embed, onProgress) {
    const existing = this.findByPath(path.resolve(rootPath));
    if (existing) return this.reindexSource(existing.id, embed, onProgress);
    const built = await this._buildFolder({ rootPath, type, exts }, embed, onProgress);
    return this._commit(built, { type, label, exts });
  }

  removeSource(id) {
    if (!id) return false;
    const keepRec = [], keepVec = [];
    for (let i = 0; i < this.records.length; i++) if (this.records[i].sourceId !== id) { keepRec.push(this.records[i]); keepVec.push(this.vectors[i]); }
    this.records = keepRec; this.vectors = keepVec;
    this.sources = this.sources.filter((s) => s.id !== id);
    if (!this.records.length) this.dim = 0;
    this._save();
    return true;
  }

  _replaceSource(id, built, { label }) {
    if (this.dim && built.dim !== this.dim) throw new Error(`embedding dim mismatch (${built.dim} vs ${this.dim})`);
    const keepRec = [], keepVec = [];
    for (let i = 0; i < this.records.length; i++) if (this.records[i].sourceId !== id) { keepRec.push(this.records[i]); keepVec.push(this.vectors[i]); }
    for (const r of built.records) { r.sourceId = id; keepRec.push(r); }
    for (const v of built.vectors) keepVec.push(v);
    this.records = keepRec; this.vectors = keepVec;
    if (!this.dim) this.dim = built.dim;
    const src = this.sources.find((s) => s.id === id);
    if (src) { src.path = built.rootAbs; if (label) src.label = label; src.lastIndexedAt = Date.now(); src.docCount = built.fileCount; src.chunkCount = built.records.length; }
    this._save();
    return src;
  }

  async reindexSource(id, embed, onProgress) {
    const src = this.getSource(id);
    if (!src) throw new Error("unknown source");
    const prevDim = this.dim;
    const built = await this._buildFolder({ rootPath: src.path, type: src.type, exts: src.exts }, embed, onProgress);
    if (prevDim && built.dim !== prevDim) throw new Error(`embedding dim changed (${built.dim} vs ${prevDim}); clear + re-index`);
    if (!this.getSource(id)) return null;
    return this._replaceSource(id, built, { label: src.label });
  }

  // ---- Incremental push model (Phase 0b) ----
  // The PLUGIN owns file discovery and pushes per-note text. Records are keyed by `source` (the
  // vault-relative path), so re-pushing a path replaces exactly that note's chunks, dropDoc removes
  // them, and manifest() lets the plugin diff mtimes and push only the changed/new/removed delta.
  // This is what makes indexing incremental (the reused folder-walk re-embeds everything).
  async upsertDoc(docPath, text, mtime, embed, sourceType = "vault") {
    const chunks = chunkText(String(text || ""), 120, 20);
    if (!chunks.length) return this.dropDoc(docPath); // empty note: treat as removal
    const vectors = await embed(chunks, {});
    if (vectors.length !== chunks.length) throw new Error("embedding returned the wrong count");
    const dim = vectors[0].length;
    if (this.dim && dim !== this.dim) throw new Error(`embedding dim mismatch (${dim} vs ${this.dim})`);
    if (!this.dim) this.dim = dim;
    const keepRec = [], keepVec = [];
    for (let i = 0; i < this.records.length; i++) if (this.records[i].source !== docPath) { keepRec.push(this.records[i]); keepVec.push(this.vectors[i]); }
    for (let i = 0; i < chunks.length; i++) { keepRec.push({ sourceId: "push", source: docPath, sourceType, text: chunks[i] }); keepVec.push(vectors[i]); }
    this.records = keepRec; this.vectors = keepVec;
    this.docs[docPath] = { mtime: Number(mtime) || Date.now(), chunks: chunks.length, sourceType };
    this._save();
    return { path: docPath, chunks: chunks.length, totalChunks: this.records.length };
  }

  dropDoc(docPath) {
    const keepRec = [], keepVec = [];
    for (let i = 0; i < this.records.length; i++) if (this.records[i].source !== docPath) { keepRec.push(this.records[i]); keepVec.push(this.vectors[i]); }
    const removed = this.records.length - keepRec.length;
    this.records = keepRec; this.vectors = keepVec;
    delete this.docs[docPath];
    if (!this.records.length) this.dim = 0;
    if (removed) this._save();
    return { path: docPath, chunks: 0, removed, totalChunks: this.records.length };
  }

  manifest() { return { ...this.docs }; }

  // Cosine top-k over all (or a filtered set of) sources. Returns citable records + scores.
  search(queryVec, { topK = 8, sourceIds = null, minScore = 0.3 } = {}) {
    if (!this.records.length) return [];
    const allow = sourceIds && sourceIds.length ? new Set(sourceIds) : null;
    const scored = [];
    for (let i = 0; i < this.records.length; i++) {
      if (allow && !allow.has(this.records[i].sourceId)) continue;
      const score = cosine(queryVec, this.vectors[i]);
      if (score >= minScore) scored.push({ ...this.records[i], score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
