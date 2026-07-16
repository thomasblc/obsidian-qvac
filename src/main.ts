import { Plugin, WorkspaceLeaf, TFile, Notice, Editor, requestUrl, FileSystemAdapter } from "obsidian";
import { WsClient } from "./lib/ws";
import { readDaemonInfo, wsUrl, DaemonInfo } from "./lib/daemon";
import { vaultId as computeVaultId } from "./lib/vaultid";
import { planTextIndex } from "./lib/diff";
import { insertRelatedSection } from "./lib/links";
import type {
  Hit, Adapter, ChatMessage, ManifestEntry,
  Health, ChatData, CompleteData, HitsData, ScanData, TrainData, AdaptersData, ManifestData,
  ModelsData, CheckData,
  ChatFrame, CompleteFrame, ProvisionFrame, ScanFrame, TrainFrame,
} from "./lib/rpc";
import { QvacSettings, DEFAULT_SETTINGS, migrateSettings, QvacSettingTab } from "./settings";
import { QvacView, VIEW_TYPE_QVAC, QvacTab } from "./qvac-view";
import { ReviewModal } from "./review-modal";

const INLINE_CMDS: { id: string; name: string; title: string; instruction: string }[] = [
  { id: "summarize-selection", name: "Summarize selection", title: "Summarize", instruction: "Summarize the following text concisely. Output only the summary." },
  { id: "rewrite-selection", name: "Rewrite selection (clearer)", title: "Rewrite", instruction: "Rewrite the following to be clearer and more concise, keeping the meaning. Output only the rewrite." },
  { id: "fix-grammar", name: "Fix grammar in selection", title: "Fix grammar", instruction: "Fix spelling and grammar in the following text. Output only the corrected text." },
  { id: "expand-selection", name: "Expand selection", title: "Expand", instruction: "Expand the following into a fuller paragraph. Output only the expanded text." },
];

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return "unknown error"; }
}

export default class QvacPlugin extends Plugin {
  settings: QvacSettings = DEFAULT_SETTINGS;
  ws: WsClient | null = null;
  daemon: DaemonInfo | null = null;
  vaultId = "default";
  private indexing = false;

  async onload() {
    await this.loadSettings();
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) this.vaultId = computeVaultId(adapter.getBasePath());

    this.registerView(VIEW_TYPE_QVAC, (leaf) => new QvacView(leaf, this));
    this.addRibbonIcon("bot", "QVAC", () => { void this.activateView("chat"); });
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => { void this.activateView("chat"); } });
    this.addCommand({ id: "open-search", name: "Open semantic search", callback: () => { void this.activateView("search"); } });
    this.addCommand({ id: "open-connect", name: "Open Connect (find missing links)", callback: () => { void this.activateView("connect"); } });
    this.addCommand({ id: "open-train", name: "Train a model on your vault", callback: () => { void this.activateView("train"); } });
    this.addCommand({ id: "index-vault", name: "Index vault (incremental)", callback: () => { void this.indexVault(false); } });
    this.addCommand({ id: "reindex-vault", name: "Reindex vault (full)", callback: () => { void this.indexVault(true); } });
    this.addCommand({ id: "color-graph", name: "Color graph by folder", callback: () => { void this.colorGraph(); } });
    this.addSettingTab(new QvacSettingTab(this.app, this));

    // Inline writing commands (selection -> review modal -> apply).
    for (const c of INLINE_CMDS) this.addCommand({ id: c.id, name: c.name, editorCallback: (e) => this.runInline(e, c.title, c.instruction) });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      if (!editor.getSelection().trim()) return;
      for (const c of INLINE_CMDS.slice(0, 3)) menu.addItem((i) => i.setTitle("QVAC: " + c.title).setIcon("bot").onClick(() => this.runInline(editor, c.title, c.instruction)));
    }));

    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        const up = await this.ensureDaemon();
        // Only auto-index once the models are provisioned; otherwise the first embed-doc triggers a
        // multi-GB download inside a 60s rpc timeout and fails. Un-provisioned users go through the
        // Setup panel in the view first (which streams download progress).
        if (up && this.settings.provisioned && this.settings.indexOnStartup) await this.indexVault(false);
      })();
    });
  }

  onunload() { this.ws?.close(); }

  async loadSettings() { this.settings = migrateSettings(await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  // ---- companion daemon ----
  async checkHealth(): Promise<Health | null> {
    this.daemon = readDaemonInfo();
    if (!this.daemon) return null;
    if (!this.ws) this.ws = new WsClient(wsUrl(this.daemon));
    else this.ws.setUrl(wsUrl(this.daemon));
    // Liveness over WS, NOT an HTTP fetch: the renderer (origin app://obsidian.md) CORS-blocks a
    // plain fetch to a localhost server, but a WebSocket is exempt. This is the one transport gotcha.
    try { const r = await this.ws.rpc<Health>("health", {}, { timeoutMs: 6000 }); return r.ok ? (r.data ?? null) : null; }
    catch { return null; }
  }
  async ensureDaemon(): Promise<boolean> { return (await this.checkHealth()) !== null; }
  private async ensureWs(): Promise<WsClient> {
    if (!(await this.ensureDaemon()) || !this.ws) throw new Error("QVAC companion not running. Start the QVAC app.");
    return this.ws;
  }

  // ---- chat ----
  async chat(message: string, history: ChatMessage[], onFrame: (f: ChatFrame) => void) {
    const ws = await this.ensureWs();
    const voice = this.settings.voiceEnabled && !!this.settings.voiceAdapter;
    return ws.rpc<ChatData, ChatFrame>("chat", { vaultId: this.vaultId, message, history, memory: true, voice, adapter: this.settings.voiceAdapter || null, baseKey: this.settings.chatBaseKey, modelSrc: this.settings.customModelSrc || undefined }, { onFrame, timeoutMs: 180000 });
  }

  // ---- first-run provisioning: download the models with visible progress (instead of a silent
  // multi-GB stall inside a timed rpc). Embeddings enable search + Connect in minutes; chat second.
  async provision(onFrame: (f: ProvisionFrame) => void) {
    const ws = await this.ensureWs();
    return ws.rpc<unknown, ProvisionFrame>("provision", { modelSrc: this.settings.customModelSrc || undefined, embedSrc: this.settings.customEmbedSrc || undefined }, { onFrame, timeoutMs: 60 * 60 * 1000 });
  }
  // Persist the embedder choice on the companion (used when it changes after first setup).
  async setEmbedConfig() {
    try { const ws = await this.ensureWs(); await ws.rpc("config", { embedSrc: this.settings.customEmbedSrc || undefined }); }
    catch { /* companion offline; applied at next provision/connect */ }
  }
  isProvisioned(): boolean { return this.settings.provisioned; }
  async markProvisioned() { this.settings.provisioned = true; await this.saveSettings(); }

  // Browse candidate chat models (.gguf) in a folder, for the settings dropdown.
  async listModels(dir: string, kind: "chat" | "embed" | "all" = "chat"): Promise<ModelsData> {
    const ws = await this.ensureWs();
    const r = await ws.rpc<ModelsData>("models.scan", { dir, kind }, { timeoutMs: 15000 });
    return r.data ?? { dir, models: [] };
  }
  // Cheaply validate a chosen model source (exists + is a GGUF; URLs pass through).
  async checkModel(src: string): Promise<CheckData> {
    const ws = await this.ensureWs();
    const r = await ws.rpc<CheckData>("model.check", { modelSrc: src || undefined }, { timeoutMs: 15000 });
    return r.data ?? { ok: false, error: "no response from companion" };
  }

  async openSource(source: string) {
    const f = this.app.vault.getFileByPath(source);
    if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
    else new Notice("QVAC: source not found - " + source);
  }

  // Write an AI-drafted note to the vault (path confirmed by the user in a modal). Creates any
  // parent folders, refuses to overwrite, then opens the new note.
  async createNote(rawPath: string, content: string) {
    let p = rawPath.trim().replace(/^\/+/, "");
    if (!p) return;
    // Never let a hand-typed "../" escape the vault (getAbstractFileByPath returns null for
    // out-of-vault paths, so the overwrite guard alone would not catch it).
    if (p.split("/").includes("..")) { new Notice("QVAC: invalid path (no '..' allowed)"); return; }
    if (!p.toLowerCase().endsWith(".md")) p += ".md";
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (dir) {
      const parts = dir.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        if (!this.app.vault.getAbstractFileByPath(cur)) {
          try { await this.app.vault.createFolder(cur); } catch { /* already exists / race */ }
        }
      }
    }
    if (this.app.vault.getAbstractFileByPath(p)) { new Notice("QVAC: a note already exists at " + p); return; }
    try {
      const f = await this.app.vault.create(p, content);
      new Notice("QVAC: created " + p);
      await this.app.workspace.getLeaf(false).openFile(f);
    } catch (e) { new Notice("QVAC: could not create note - " + errMsg(e)); }
  }

  // ---- inline writing commands + related notes ----
  async complete(system: string, message: string, onFrame?: (f: CompleteFrame) => void) {
    const ws = await this.ensureWs();
    return ws.rpc<CompleteData, CompleteFrame>("complete", { system, message, modelSrc: this.settings.customModelSrc || undefined }, { onFrame, timeoutMs: 120000 });
  }
  async related(text: string, excludePath: string): Promise<Hit[]> {
    let ws: WsClient;
    try { ws = await this.ensureWs(); } catch { return []; }
    const r = await ws.rpc<HitsData>("related", { vaultId: this.vaultId, text, excludePath, topK: 6 }, { timeoutMs: 30000 });
    return r.ok ? (r.data?.hits ?? []) : [];
  }
  async search(query: string): Promise<Hit[]> {
    const ws = await this.ensureWs();
    const r = await ws.rpc<HitsData>("search", { vaultId: this.vaultId, query, topK: 12 }, { timeoutMs: 30000 });
    return r.ok ? (r.data?.hits ?? []) : [];
  }

  // ---- connect (find + create the missing [[links]]) ----
  // Obsidian's resolved-links graph: { sourcePath: { targetPath: count } }. We read it to know what
  // is ALREADY linked, so the scan never re-proposes an existing edge.
  existingLinkPairs(): string[][] {
    const rl = this.app.metadataCache.resolvedLinks;
    const out: string[][] = [];
    for (const a of Object.keys(rl)) for (const b of Object.keys(rl[a] || {})) out.push([a, b]);
    return out;
  }
  linkedTargetsOf(fromPath: string): string[] {
    const rl = this.app.metadataCache.resolvedLinks;
    return Object.keys(rl[fromPath] || {});
  }
  async connectScan(existingPairs: string[][], onFrame: (f: ScanFrame) => void) {
    const ws = await this.ensureWs();
    return ws.rpc<ScanData, ScanFrame>("connect.scan", { vaultId: this.vaultId, existingPairs, minScore: 0.3, maxCandidates: 20, modelSrc: this.settings.customModelSrc || undefined }, { onFrame, timeoutMs: 10 * 60 * 1000 });
  }
  // Insert [[to]] into the note `from`, under a "## Related" section (created if missing). Uses
  // vault.process (atomic read-modify-write). Hardened (review-pass): identity dedup via the
  // resolved-links graph (not substring, so an aliased [[Foo|x]] is not duplicated); the heading
  // match is anchored to a real "## Related" LINE (not a prefix like "## Relatedness") and skips
  // any "## Related" that sits inside a fenced code block, so it never corrupts a note's content.
  async insertLink(fromPath: string, toPath: string): Promise<boolean> {
    const from = this.app.vault.getFileByPath(fromPath);
    const to = this.app.vault.getFileByPath(toPath);
    if (!(from instanceof TFile) || !(to instanceof TFile)) { new Notice("QVAC: note not found"); return false; }
    if (this.linkedTargetsOf(fromPath).includes(toPath)) return true; // already linked (by identity)
    const link = `[[${this.app.metadataCache.fileToLinktext(to, fromPath, true)}]]`;
    await this.app.vault.process(from, (content) => insertRelatedSection(content, link));
    new Notice(`QVAC: linked ${to.basename} -> ${from.basename}`);
    return true;
  }
  private runInline(editor: Editor, title: string, instruction: string) {
    const sel = editor.getSelection();
    if (!sel.trim()) { new Notice("QVAC: select some text first"); return; }
    const modal = new ReviewModal(this.app, title, sel, (text) => editor.replaceSelection(text));
    modal.open();
    this.complete(instruction, sel, (f) => { if (f.type === "complete.token") modal.appendToken(f.text ?? ""); })
      .then((r) => { if (r.ok) modal.setResult(r.data?.contentText ?? ""); else modal.fail(r.error ?? "failed"); })
      .catch((e: unknown) => modal.fail(errMsg(e)));
  }
  // ---- training (optional LoRA voice) ----
  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }
  async trainStart(opts: { epochs?: number }, onFrame: (f: TrainFrame) => void) {
    const ws = await this.ensureWs();
    return ws.rpc<TrainData, TrainFrame>("train.start", { vaultId: this.vaultId, vaultPath: this.getVaultPath(), baseKey: "1.7b", epochs: opts.epochs ?? 1 }, { onFrame, timeoutMs: 30 * 60 * 1000 });
  }
  async trainList(): Promise<Adapter[]> { const ws = await this.ensureWs(); const r = await ws.rpc<AdaptersData>("train.list"); return r.ok ? (r.data?.adapters ?? []) : []; }
  async trainDelete(file: string): Promise<Adapter[]> { const ws = await this.ensureWs(); const r = await ws.rpc<AdaptersData>("train.delete", { file }); return r.ok ? (r.data?.adapters ?? []) : []; }
  async setVoiceAdapter(file: string | null) { this.settings.voiceAdapter = file; this.settings.voiceEnabled = !!file; await this.saveSettings(); }
  // OCR an image's bytes via the daemon. Uses requestUrl (Obsidian's Node HTTP client) which
  // bypasses CORS for a localhost POST that a renderer fetch would be blocked from making.
  async ocrImage(bytes: ArrayBuffer, ext: string): Promise<string> {
    if (!this.daemon && !(await this.ensureDaemon())) throw new Error("companion not running");
    const d = this.daemon;
    if (!d) throw new Error("companion not running");
    const r = await requestUrl({ url: `http://127.0.0.1:${d.port}/api/ocr?t=${encodeURIComponent(d.token)}&ext=${encodeURIComponent(ext)}`, method: "POST", body: bytes, throw: false });
    const j = r.json as { data?: { text?: string } } | undefined;
    return j?.data?.text ?? "";
  }
  // ---- incremental indexing ----
  private excluded(p: string): boolean {
    const ex = this.settings.excludeFolders.split(",").map((s) => s.trim()).filter(Boolean);
    return ex.some((e) => p === e || p.startsWith(e + "/"));
  }
  private localManifest(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (this.excluded(f.path)) continue;
      out[f.path] = f.stat.mtime;
    }
    return out;
  }

  async indexVault(full: boolean) {
    if (this.indexing) { new Notice("QVAC: already indexing"); return; }
    let ws: WsClient;
    try { ws = await this.ensureWs(); } catch (e) { new Notice(errMsg(e)); return; }
    this.indexing = true;
    const notice = new Notice("QVAC: indexing…", 0);
    try {
      const local = this.localManifest();
      // Always fetch the remote manifest (even for "full") so deleted notes are dropped. The manifest
      // includes BOTH markdown and OCR'd images; split by sourceType so images never enter the TEXT
      // diff - otherwise diffManifest would put every image in `toDrop` (they're not in the md-only
      // `local`) and the OCR loop would then skip re-embedding them on an mtime match => image search
      // silently oscillates on/off every other run. (P0)
      const manifestRes = await ws.rpc<ManifestData>("index-manifest", { vaultId: this.vaultId });
      const remoteFull: Record<string, ManifestEntry> = manifestRes.data?.manifest ?? {};
      const { toUpsert, toDrop, imgRemote } = planTextIndex(local, remoteFull, full);
      let done = 0;
      for (const p of toUpsert) {
        const f = this.app.vault.getFileByPath(p);
        if (!(f instanceof TFile)) continue;
        const text = await this.app.vault.cachedRead(f);
        await ws.rpc("embed-doc", { vaultId: this.vaultId, path: p, text, mtime: f.stat.mtime }, { timeoutMs: 60000 });
        notice.setMessage(`QVAC: indexing ${++done}/${toUpsert.length}`);
      }
      for (const p of toDrop) await ws.rpc("drop-doc", { vaultId: this.vaultId, path: p });
      // Multimodal (opt-in): OCR the text inside images into the index, incrementally. Managed
      // SEPARATELY from the markdown diff above (own manifest slice), so it never fights it.
      let imgDone = 0, imgDropped = 0;
      if (this.settings.ocrImages) {
        const IMG = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"]);
        const live = new Set<string>();
        for (const f of this.app.vault.getFiles()) {
          if (!IMG.has(f.extension.toLowerCase()) || this.excluded(f.path)) continue; // respect exclude (#16)
          live.add(f.path);
          const r = imgRemote[f.path];
          if (!full && r && Math.floor(r.mtime) === Math.floor(f.stat.mtime)) continue; // unchanged
          try {
            const bytes = await this.app.vault.readBinary(f);
            const text = await this.ocrImage(bytes, f.extension);
            if (text.trim()) { await ws.rpc("embed-doc", { vaultId: this.vaultId, path: f.path, text, mtime: f.stat.mtime, sourceType: "image" }); imgDone++; }
            notice.setMessage(`QVAC: OCR ${imgDone} image(s)…`);
          } catch { /* skip unreadable image */ }
        }
        // drop OCR entries for images deleted from the vault (or now excluded)
        for (const p of Object.keys(imgRemote)) if (!live.has(p)) { await ws.rpc("drop-doc", { vaultId: this.vaultId, path: p }); imgDropped++; }
      }
      notice.setMessage(`QVAC: indexed ${toUpsert.length} changed, ${toDrop.length + imgDropped} removed${imgDone ? `, ${imgDone} image(s)` : ""}`);
      window.setTimeout(() => notice.hide(), 4000);
    } catch (e) {
      notice.setMessage("QVAC: index failed - " + errMsg(e));
      window.setTimeout(() => notice.hide(), 6000);
    } finally { this.indexing = false; }
  }

  async activateView(tab?: QvacTab) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_QVAC)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE_QVAC, active: true });
    }
    if (leaf) {
      await workspace.revealLeaf(leaf);
      if (tab && leaf.view instanceof QvacView) leaf.view.setTab(tab);
    }
  }

  // Re-render open QVAC panels (used when tab-visibility settings change).
  refreshOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QVAC)) {
      if (leaf.view instanceof QvacView) leaf.view.rebuild();
    }
  }

  // Color the Obsidian graph nodes by top-level folder (plus a group for #moc hubs), using the
  // QVAC accent for the first cluster. Writes .obsidian/graph.json; Obsidian applies it when the
  // Graph view is (re)opened.
  async colorGraph() {
    const palette = [0x16E3C1, 0xA855F7, 0x3B82F6, 0xF5A623, 0x22C55E, 0xEC4899, 0xEAB308];
    const folders = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const i = f.path.indexOf("/");
      if (i > 0) folders.add(f.path.slice(0, i));
    }
    const groups: { query: string; color: { a: number; rgb: number } }[] = [
      { query: "tag:#moc", color: { a: 1, rgb: 0xFF7043 } },
    ];
    let n = 0;
    for (const folder of Array.from(folders).sort()) {
      groups.push({ query: `path:"${folder}/"`, color: { a: 1, rgb: palette[n % palette.length] } });
      n++;
    }
    const path = `${this.app.vault.configDir}/graph.json`;
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(await this.app.vault.adapter.read(path)) as Record<string, unknown>; } catch { /* no existing config */ }
    cfg.colorGroups = groups;
    cfg["collapse-color-groups"] = false;
    await this.app.vault.adapter.write(path, JSON.stringify(cfg, null, 2));
    new Notice("QVAC: colored the graph by folder. Reopen the Graph view to see it.");
  }
}
