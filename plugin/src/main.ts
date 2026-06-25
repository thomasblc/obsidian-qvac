import { Plugin, WorkspaceLeaf, TFile, Notice, Editor, requestUrl } from "obsidian";
import { WsClient } from "./lib/ws";
import { readDaemonInfo, wsUrl, DaemonInfo } from "./lib/daemon";
import { vaultId as computeVaultId } from "./lib/vaultid";
import { diffManifest } from "./lib/diff";
import { insertRelatedSection } from "./lib/links";
import { QvacSettings, DEFAULT_SETTINGS, migrateSettings, QvacSettingTab } from "./settings";
import { QvacView, VIEW_TYPE_QVAC, QvacTab } from "./qvac-view";
import { ReviewModal } from "./review-modal";

const INLINE_CMDS: { id: string; name: string; title: string; instruction: string }[] = [
  { id: "summarize-selection", name: "Summarize selection", title: "Summarize", instruction: "Summarize the following text concisely. Output only the summary." },
  { id: "rewrite-selection", name: "Rewrite selection (clearer)", title: "Rewrite", instruction: "Rewrite the following to be clearer and more concise, keeping the meaning. Output only the rewrite." },
  { id: "fix-grammar", name: "Fix grammar in selection", title: "Fix grammar", instruction: "Fix spelling and grammar in the following text. Output only the corrected text." },
  { id: "expand-selection", name: "Expand selection", title: "Expand", instruction: "Expand the following into a fuller paragraph. Output only the expanded text." },
];

export default class QvacPlugin extends Plugin {
  settings: QvacSettings = DEFAULT_SETTINGS;
  ws: WsClient | null = null;
  daemon: DaemonInfo | null = null;
  vaultId = "default";
  private indexing = false;

  async onload() {
    await this.loadSettings();
    try { this.vaultId = computeVaultId((this.app.vault.adapter as any).getBasePath()); } catch { /* */ }

    this.registerView(VIEW_TYPE_QVAC, (leaf) => new QvacView(leaf, this));
    this.addRibbonIcon("bot", "QVAC", () => this.activateView("chat"));
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => this.activateView("chat") });
    this.addCommand({ id: "open-search", name: "Open semantic search", callback: () => this.activateView("search") });
    this.addCommand({ id: "open-connect", name: "Open Connect (find missing links)", callback: () => this.activateView("connect") });
    this.addCommand({ id: "open-train", name: "Train a model on your vault", callback: () => this.activateView("train") });
    this.addCommand({ id: "index-vault", name: "Index vault (incremental)", callback: () => this.indexVault(false) });
    this.addCommand({ id: "reindex-vault", name: "Reindex vault (full)", callback: () => this.indexVault(true) });
    this.addSettingTab(new QvacSettingTab(this.app, this));

    // Inline writing commands (selection -> review modal -> apply).
    for (const c of INLINE_CMDS) this.addCommand({ id: c.id, name: c.name, editorCallback: (e) => this.runInline(e, c.title, c.instruction) });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      if (!editor.getSelection().trim()) return;
      for (const c of INLINE_CMDS.slice(0, 3)) menu.addItem((i) => i.setTitle("QVAC: " + c.title).setIcon("bot").onClick(() => this.runInline(editor, c.title, c.instruction)));
    }));

    this.app.workspace.onLayoutReady(async () => {
      const up = await this.ensureDaemon();
      if (up && this.settings.indexOnStartup) this.indexVault(false);
    });
  }

  onunload() { this.ws?.close(); }

  async loadSettings() { this.settings = migrateSettings(await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  // ---- companion daemon ----
  async checkHealth() {
    this.daemon = readDaemonInfo();
    if (!this.daemon) return null;
    if (!this.ws) this.ws = new WsClient(wsUrl(this.daemon));
    else this.ws.setUrl(wsUrl(this.daemon));
    // Liveness over WS, NOT an HTTP fetch: the renderer (origin app://obsidian.md) CORS-blocks a
    // plain fetch to a localhost server, but a WebSocket is exempt. This is the one transport gotcha.
    try { const r = await this.ws.rpc("health", {}, { timeoutMs: 6000 }); return r.ok ? r.data : null; }
    catch { return null; }
  }
  async ensureDaemon(): Promise<boolean> { return (await this.checkHealth()) !== null; }
  private async ensureWs(): Promise<WsClient> {
    if (!(await this.ensureDaemon()) || !this.ws) throw new Error("QVAC companion not running. Start the QVAC app.");
    return this.ws;
  }

  // ---- chat ----
  async chat(message: string, history: any[], onFrame: (f: any) => void) {
    const ws = await this.ensureWs();
    const voice = this.settings.voiceEnabled && !!this.settings.voiceAdapter;
    return ws.rpc("chat", { vaultId: this.vaultId, message, history, memory: true, voice, adapter: this.settings.voiceAdapter || null }, { onFrame, timeoutMs: 180000 });
  }

  async openSource(source: string) {
    const f = this.app.vault.getFileByPath(source);
    if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
    else new Notice("QVAC: source not found - " + source);
  }

  // ---- inline writing commands + related notes ----
  async complete(system: string, message: string, onFrame?: (f: any) => void) {
    const ws = await this.ensureWs();
    return ws.rpc("complete", { system, message }, { onFrame, timeoutMs: 120000 });
  }
  async related(text: string, excludePath: string): Promise<any[]> {
    let ws: WsClient;
    try { ws = await this.ensureWs(); } catch { return []; }
    const r = await ws.rpc("related", { vaultId: this.vaultId, text, excludePath, topK: 6 }, { timeoutMs: 30000 });
    return r.ok ? (r.data?.hits || []) : [];
  }
  async search(query: string): Promise<any[]> {
    const ws = await this.ensureWs();
    const r = await ws.rpc("search", { vaultId: this.vaultId, query, topK: 12 }, { timeoutMs: 30000 });
    return r.ok ? (r.data?.hits || []) : [];
  }

  // ---- connect (find + create the missing [[links]]) ----
  // Obsidian's resolved-links graph: { sourcePath: { targetPath: count } }. We read it to know what
  // is ALREADY linked, so the scan never re-proposes an existing edge.
  existingLinkPairs(): string[][] {
    const rl = (this.app.metadataCache as any).resolvedLinks || {};
    const out: string[][] = [];
    for (const a of Object.keys(rl)) for (const b of Object.keys(rl[a] || {})) out.push([a, b]);
    return out;
  }
  linkedTargetsOf(fromPath: string): string[] {
    const rl = (this.app.metadataCache as any).resolvedLinks || {};
    return Object.keys(rl[fromPath] || {});
  }
  async connectScan(existingPairs: string[][], onFrame: (f: any) => void) {
    const ws = await this.ensureWs();
    return ws.rpc("connect.scan", { vaultId: this.vaultId, existingPairs, minScore: 0.3, maxCandidates: 20 }, { onFrame, timeoutMs: 10 * 60 * 1000 });
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
    this.complete(instruction, sel, (f) => { if (f.type === "complete.token") modal.appendToken(f.text); })
      .then((r) => { if (r.ok) modal.setResult(r.data?.contentText || ""); else modal.fail(r.error || "failed"); })
      .catch((e) => modal.fail(e?.message || String(e)));
  }
  // ---- training (optional LoRA voice) ----
  getVaultPath(): string { try { return (this.app.vault.adapter as any).getBasePath(); } catch { return ""; } }
  async trainStart(opts: { epochs?: number }, onFrame: (f: any) => void) {
    const ws = await this.ensureWs();
    return ws.rpc("train.start", { vaultId: this.vaultId, vaultPath: this.getVaultPath(), baseKey: "1.7b", epochs: opts.epochs ?? 1 }, { onFrame, timeoutMs: 30 * 60 * 1000 });
  }
  async trainList(): Promise<any[]> { const ws = await this.ensureWs(); const r = await ws.rpc("train.list"); return r.ok ? (r.data?.adapters || []) : []; }
  async trainDelete(file: string): Promise<any[]> { const ws = await this.ensureWs(); const r = await ws.rpc("train.delete", { file }); return r.ok ? (r.data?.adapters || []) : []; }
  async setVoiceAdapter(file: string | null) { this.settings.voiceAdapter = file; this.settings.voiceEnabled = !!file; await this.saveSettings(); }
  // OCR an image's bytes via the daemon. Uses requestUrl (Obsidian's Node HTTP client) which
  // bypasses CORS for a localhost POST that a renderer fetch would be blocked from making.
  async ocrImage(bytes: ArrayBuffer, ext: string): Promise<string> {
    if (!this.daemon && !(await this.ensureDaemon())) throw new Error("companion not running");
    const d = this.daemon!;
    const r = await requestUrl({ url: `http://127.0.0.1:${d.port}/api/ocr?t=${encodeURIComponent(d.token)}&ext=${encodeURIComponent(ext)}`, method: "POST", body: bytes, throw: false });
    return (r.json && r.json.data && r.json.data.text) || "";
  }
  // ---- incremental indexing ----
  private localManifest(): Record<string, number> {
    const exclude = this.settings.excludeFolders.split(",").map((s) => s.trim()).filter(Boolean);
    const out: Record<string, number> = {};
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (exclude.some((e) => f.path === e || f.path.startsWith(e + "/"))) continue;
      out[f.path] = f.stat.mtime;
    }
    return out;
  }

  async indexVault(full: boolean) {
    if (this.indexing) { new Notice("QVAC: already indexing"); return; }
    let ws: WsClient;
    try { ws = await this.ensureWs(); } catch (e: any) { new Notice(e.message); return; }
    this.indexing = true;
    const notice = new Notice("QVAC: indexing…", 0);
    try {
      const local = this.localManifest();
      const remote = full ? {} : ((await ws.rpc("index-manifest", { vaultId: this.vaultId })).data?.manifest || {});
      const { toUpsert, toDrop } = diffManifest(local, remote);
      let done = 0;
      for (const p of toUpsert) {
        const f = this.app.vault.getFileByPath(p);
        if (!(f instanceof TFile)) continue;
        const text = await this.app.vault.cachedRead(f);
        await ws.rpc("embed-doc", { vaultId: this.vaultId, path: p, text, mtime: f.stat.mtime }, { timeoutMs: 60000 });
        notice.setMessage(`QVAC: indexing ${++done}/${toUpsert.length}`);
      }
      for (const p of toDrop) await ws.rpc("drop-doc", { vaultId: this.vaultId, path: p });
      // Multimodal (opt-in): OCR the text inside images into the index, incrementally.
      let imgDone = 0;
      if (this.settings.ocrImages) {
        const IMG = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"]);
        for (const f of this.app.vault.getFiles()) {
          if (!IMG.has(f.extension.toLowerCase())) continue;
          const r = remote[f.path];
          if (r && Math.floor(r.mtime) === Math.floor(f.stat.mtime)) continue;
          try {
            const bytes = await this.app.vault.readBinary(f);
            const text = await this.ocrImage(bytes, f.extension);
            if (text.trim()) { await ws.rpc("embed-doc", { vaultId: this.vaultId, path: f.path, text, mtime: f.stat.mtime, sourceType: "image" }); imgDone++; }
            notice.setMessage(`QVAC: OCR ${imgDone} image(s)…`);
          } catch { /* skip unreadable image */ }
        }
      }
      notice.setMessage(`QVAC: indexed ${toUpsert.length} changed, ${toDrop.length} removed${imgDone ? `, ${imgDone} image(s)` : ""}`);
      setTimeout(() => notice.hide(), 4000);
    } catch (e: any) {
      notice.setMessage("QVAC: index failed - " + (e?.message || e));
      setTimeout(() => notice.hide(), 6000);
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
      workspace.revealLeaf(leaf);
      if (tab && leaf.view instanceof QvacView) leaf.view.setTab(tab);
    }
  }
}
