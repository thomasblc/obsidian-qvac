import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile, debounce, setIcon } from "obsidian";
import type QvacPlugin from "./main";

export const VIEW_TYPE_QVAC = "qvac-view";
export type QvacTab = "chat" | "search" | "connect" | "train";

// One unified, QVAC-branded panel with four tabs. Surfaces every feature in one place:
// Chat, AI Search (semantic), Connect (related notes + create the missing [[links]]), Train.
export class QvacView extends ItemView {
  private tab: QvacTab = "chat";
  private tabsEl: HTMLElement;
  private bodyEl: HTMLElement;
  private statusDot: HTMLElement;
  private statusText: HTMLElement;

  // chat
  private history: { role: string; content: string }[] = [];
  private chatBusy = false;

  constructor(leaf: WorkspaceLeaf, private plugin: QvacPlugin) { super(leaf); }
  getViewType() { return VIEW_TYPE_QVAC; }
  getDisplayText() { return "QVAC"; }
  getIcon() { return "bot"; }

  async onOpen() {
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
    this.refreshStatus();

    // tab bar
    this.tabsEl = root.createDiv({ cls: "qvac-tabs" });
    const tabs: { id: QvacTab; label: string; icon: string }[] = [
      { id: "chat", label: "Chat", icon: "message-square" },
      { id: "search", label: "AI Search", icon: "search" },
      { id: "connect", label: "Connect", icon: "git-fork" },
      { id: "train", label: "Train", icon: "graduation-cap" },
    ];
    for (const t of tabs) {
      const b = this.tabsEl.createDiv({ cls: "qvac-tab" });
      const ic = b.createSpan({ cls: "qvac-tab-ic" }); setIcon(ic, t.icon);
      b.createSpan({ text: t.label });
      b.dataset.tab = t.id;
      b.onclick = () => this.setTab(t.id);
    }

    this.bodyEl = root.createDiv({ cls: "qvac-body" });
    this.setTab(this.tab);

    // refresh Connect's per-note section on note switch (debounced; file-open fires twice)
    this.registerEvent(this.app.workspace.on("file-open", debounce(() => { if (this.tab === "connect") this.renderConnect(); }, 400, true)));
  }
  async onClose() { /* */ }

  async refreshStatus() {
    const h = await this.plugin.checkHealth().catch(() => null);
    const on = !!h;
    this.statusDot?.toggleClass("on", on);
    this.statusDot?.toggleClass("off", !on);
    if (this.statusText) this.statusText.setText(on ? `connected · ${h.version}` : "companion offline");
  }

  setTab(tab: QvacTab) {
    this.tab = tab;
    for (const el of Array.from(this.tabsEl.children)) (el as HTMLElement).toggleClass("active", (el as HTMLElement).dataset.tab === tab);
    this.bodyEl.empty();
    if (tab === "chat") this.renderChat();
    else if (tab === "search") this.renderSearch();
    else if (tab === "connect") this.renderConnect();
    else if (tab === "train") this.renderTrain();
  }

  // ---------- CHAT ----------
  private renderChat() {
    const wrap = this.bodyEl.createDiv({ cls: "qvac-chat" });
    const toolbar = wrap.createDiv({ cls: "qvac-chat-toolbar" });
    const voiceBtn = toolbar.createEl("button", { cls: "qvac-pill" });
    const setVoiceLabel = () => { const on = this.plugin.settings.voiceEnabled && this.plugin.settings.voiceAdapter; voiceBtn.toggleClass("on", !!on); voiceBtn.setText(on ? "✓ Vault model" : "Vault model"); };
    setVoiceLabel();
    voiceBtn.onclick = async () => {
      if (!this.plugin.settings.voiceAdapter) { new Notice("QVAC: train a vault model first (Train tab)"); this.setTab("train"); return; }
      this.plugin.settings.voiceEnabled = !this.plugin.settings.voiceEnabled;
      await this.plugin.saveSettings(); setVoiceLabel();
    };
    const clearBtn = toolbar.createEl("button", { cls: "qvac-pill", text: "Clear" });
    clearBtn.onclick = () => { this.history = []; messages.empty(); };

    const messages = wrap.createDiv({ cls: "qvac-messages" });
    for (const m of this.history) this.renderMsg(messages, m.role as any, m.content, []);

    const inputRow = wrap.createDiv({ cls: "qvac-input" });
    const ta = inputRow.createEl("textarea", { attr: { rows: "1", placeholder: "Ask your vault…" } });
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    const sendBtn = inputRow.createEl("button", { cls: "qvac-send" }); setIcon(sendBtn, "arrow-up");
    const send = async () => {
      const q = ta.value.trim(); if (!q || this.chatBusy) return;
      ta.value = ""; ta.style.height = "auto"; this.chatBusy = true;
      this.renderMsg(messages, "user", q, []);
      const body = this.renderMsg(messages, "assistant", "", []);
      const bodyText = body.querySelector(".qvac-msg-body") as HTMLElement;
      bodyText.addClass("qvac-typing"); bodyText.setText("…");
      let acc = "", hits: any[] = [];
      try {
        const res = await this.plugin.chat(q, this.history, (f: any) => {
          if (f.type === "chat.start") hits = f.hits || [];
          else if (f.type === "chat.token") { acc += f.text; bodyText.removeClass("qvac-typing"); bodyText.setText(acc); messages.scrollTop = messages.scrollHeight; }
        });
        if (res.ok) {
          acc = res.data?.contentText || acc; hits = res.data?.hits || hits;
          bodyText.removeClass("qvac-typing"); bodyText.empty();
          await MarkdownRenderer.render(this.app, acc || "(no answer)", bodyText, "", this);
          this.renderCites(body, hits);
          this.history.push({ role: "user", content: q }); this.history.push({ role: "assistant", content: acc });
          if (res.data?.model?.includes("voice")) body.createDiv({ cls: "qvac-msg-model", text: "answered from your vault model" });
        } else bodyText.setText("Error: " + (res.error || "unknown"));
      } catch (e: any) { bodyText.setText("Error: " + (e?.message || e)); }
      finally { this.chatBusy = false; messages.scrollTop = messages.scrollHeight; }
    };
    sendBtn.onclick = send;
    setTimeout(() => ta.focus(), 0);
  }
  private renderMsg(container: HTMLElement, role: "user" | "assistant", text: string, hits: any[]): HTMLElement {
    const el = container.createDiv({ cls: `qvac-msg qvac-msg-${role}` });
    el.createDiv({ cls: "qvac-msg-role", text: role === "user" ? "You" : "QVAC" });
    const b = el.createDiv({ cls: "qvac-msg-body" });
    if (text) b.setText(text);
    if (hits?.length) this.renderCites(el, hits);
    container.scrollTop = container.scrollHeight;
    return el;
  }
  private renderCites(msgEl: HTMLElement, hits: any[]) {
    if (!hits?.length) return;
    const wrap = msgEl.createDiv({ cls: "qvac-cites" });
    const seen = new Set<string>(); let n = 0;
    for (const h of hits) {
      if (seen.has(h.source)) continue; seen.add(h.source); n++;
      const chip = wrap.createEl("a", { cls: "qvac-cite", href: "#" });
      const ic = chip.createSpan({ cls: "qvac-cite-ic" }); setIcon(ic, h.sourceType === "image" ? "image" : "file-text");
      chip.createSpan({ text: `${n}. ${h.source.replace(/\.md$/, "")}` });
      chip.onclick = (e) => { e.preventDefault(); this.plugin.openSource(h.source); };
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
          a.onclick = (e) => { e.preventDefault(); this.plugin.openSource(h.source); };
          top.createSpan({ cls: "qvac-result-score", text: Math.round((h.score || 0) * 100) + "%" });
          card.createDiv({ cls: "qvac-result-snippet", text: (h.content || "").slice(0, 180) });
        }
      } catch (e: any) { results.empty(); results.setText("Search unavailable: " + (e?.message || e)); }
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    setTimeout(() => inp.focus(), 0);
  }

  // ---------- CONNECT (related notes + create the missing [[links]]) ----------
  private async renderConnect() {
    const wrap = this.bodyEl.createDiv({ cls: "qvac-connect" });
    wrap.createDiv({ cls: "qvac-connect-intro", text: "Obsidian only knows the [[links]] you type. Connect finds notes that belong together but are not linked yet, and writes the link for you." });

    // vault-wide scan
    const scanBtn = wrap.createEl("button", { cls: "qvac-btn-primary", text: "Scan vault for missing links" });
    const scanStatus = wrap.createDiv({ cls: "qvac-connect-status" });
    const scanResults = wrap.createDiv({ cls: "qvac-connect-results" });
    scanBtn.onclick = async () => {
      scanBtn.disabled = true; scanStatus.setText("Scanning…"); scanResults.empty();
      try {
        const res = await this.plugin.connectScan(this.plugin.existingLinkPairs(), (f: any) => {
          if (f.type === "connect.progress") scanStatus.setText(`Judging ${f.done}/${f.total} candidates…`);
        });
        const cands = (res.ok && res.data?.candidates) || [];
        scanStatus.setText(cands.length ? `${cands.length} link(s) proposed` : `No missing links found (${res.data?.notes ?? 0} notes).`);
        for (const c of cands) this.renderProposal(scanResults, c);
      } catch (e: any) { scanStatus.setText("Scan failed: " + (e?.message || e)); }
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
      } catch (e: any) { list.empty(); list.setText("Unavailable: " + (e?.message || e)); }
    } else {
      wrap.createDiv({ cls: "qvac-empty", text: "Open a note to see + link related notes." });
    }
  }
  // a vault-scan proposal: A <-> B + reason; "Link" inserts [[B]] into A.
  private renderProposal(container: HTMLElement, c: any) {
    const card = container.createDiv({ cls: "qvac-proposal" });
    const top = card.createDiv({ cls: "qvac-proposal-top" });
    const a = top.createEl("a", { cls: "qvac-result-title", text: c.a.replace(/\.md$/, ""), href: "#" });
    a.onclick = (e) => { e.preventDefault(); this.plugin.openSource(c.a); };
    top.createSpan({ cls: "qvac-proposal-arrow", text: "↔" });
    const b = top.createEl("a", { cls: "qvac-result-title", text: c.b.replace(/\.md$/, ""), href: "#" });
    b.onclick = (e) => { e.preventDefault(); this.plugin.openSource(c.b); };
    card.createDiv({ cls: "qvac-proposal-reason", text: c.reason });
    const acts = card.createDiv({ cls: "qvac-proposal-acts" });
    const linkBtn = acts.createEl("button", { cls: "qvac-pill on", text: "Link" });
    linkBtn.onclick = async () => { if (await this.plugin.insertLink(c.a, c.b)) { card.addClass("qvac-done"); linkBtn.setText("✓ Linked"); linkBtn.disabled = true; } };
    acts.createEl("button", { cls: "qvac-pill", text: "Skip" }).onclick = () => card.remove();
  }
  // a related-note row for the active note: open, score, and "+ Link" (or "✓ linked").
  private renderRelatedRow(container: HTMLElement, fromPath: string, h: any, linked: boolean) {
    const card = container.createDiv({ cls: "qvac-result" });
    const top = card.createDiv({ cls: "qvac-result-top" });
    const a = top.createEl("a", { cls: "qvac-result-title", text: h.source.replace(/\.md$/, ""), href: "#" });
    a.onclick = (e) => { e.preventDefault(); this.plugin.openSource(h.source); };
    const right = top.createDiv({ cls: "qvac-result-right" });
    right.createSpan({ cls: "qvac-result-score", text: Math.round((h.score || 0) * 100) + "%" });
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

    const adaptersHead = wrap.createDiv({ cls: "qvac-train-subhead", text: "Your vault models" });
    const adaptersEl = wrap.createDiv({ cls: "qvac-adapters" });
    const refreshAdapters = async () => {
      adaptersEl.empty();
      let adapters: any[] = [];
      try { adapters = await this.plugin.trainList(); } catch { /* */ }
      if (!adapters.length) { adaptersEl.createDiv({ cls: "qvac-empty", text: "No vault models yet." }); return; }
      for (const a of adapters) {
        const active = this.plugin.settings.voiceAdapter === a.file;
        const card = adaptersEl.createDiv({ cls: "qvac-adapter" + (active ? " active" : "") });
        card.createDiv({ cls: "qvac-adapter-name", text: `${a.baseKey} · ${a.sizeMB} MB${active ? " · active" : ""}` });
        const acts = card.createDiv({ cls: "qvac-adapter-acts" });
        const useBtn = acts.createEl("button", { text: active ? "Active" : "Use" }); useBtn.disabled = active;
        useBtn.onclick = async () => { await this.plugin.setVoiceAdapter(a.file); refreshAdapters(); new Notice("QVAC: vault model enabled in chat."); };
        acts.createEl("button", { text: "Delete" }).onclick = async () => { await this.plugin.trainDelete(a.file); if (active) await this.plugin.setVoiceAdapter(null); refreshAdapters(); };
      }
    };
    refreshAdapters();

    startBtn.onclick = async () => {
      startBtn.disabled = true; statusEl.setText("Building dataset from your notes…"); barWrap.removeClass("hidden");
      try {
        const res = await this.plugin.trainStart({ epochs: 1 }, (f: any) => {
          if (f.type === "train.dataset") statusEl.setText(`Training on ${f.proseNotes} notes · chat is paused`);
          else if (f.type === "train.progress") {
            const pct = f.totalBatches ? Math.round((f.step / f.totalBatches) * 100) : 0;
            bar.style.width = pct + "%";
            sub.setText(`epoch ${f.epoch} · step ${f.step}/${f.totalBatches} · loss ${f.loss ?? "…"} · eta ${f.etaSec}s`);
          }
        });
        if (res.ok && res.data?.status === "COMPLETED") { statusEl.setText(`Done. Trained a vault model (${res.data.adapterMB} MB) in ${res.data.elapsedSec}s.`); new Notice("QVAC: vault model trained. Enable it in Chat."); }
        else statusEl.setText("Training did not complete: " + (res.error || res.data?.status || "unknown"));
      } catch (e: any) { statusEl.setText("Training failed: " + (e?.message || e)); }
      finally { startBtn.disabled = false; barWrap.addClass("hidden"); bar.style.width = "0%"; sub.setText(""); refreshAdapters(); }
    };
  }
}
