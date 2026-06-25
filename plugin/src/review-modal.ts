import { App, Modal } from "obsidian";

// Shows the original selection vs QVAC's proposed rewrite, streamed. Apply replaces the selection.
export class ReviewModal extends Modal {
  private resultEl: HTMLElement;
  private applyBtn: HTMLButtonElement;
  private result = "";

  constructor(app: App, private heading: string, private original: string, private onApply: (text: string) => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("qvac-review");
    contentEl.createEl("h3", { text: this.heading });

    const orig = contentEl.createDiv({ cls: "qvac-review-block" });
    orig.createEl("div", { cls: "qvac-review-label", text: "Original" });
    orig.createDiv({ cls: "qvac-review-text", text: this.original });

    const res = contentEl.createDiv({ cls: "qvac-review-block" });
    res.createEl("div", { cls: "qvac-review-label", text: "QVAC" });
    this.resultEl = res.createDiv({ cls: "qvac-review-text", text: "…" });

    const btns = contentEl.createDiv({ cls: "qvac-review-btns" });
    this.applyBtn = btns.createEl("button", { text: "Apply", cls: "mod-cta" });
    this.applyBtn.disabled = true;
    this.applyBtn.onclick = () => { this.onApply(this.result); this.close(); };
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }

  appendToken(t: string) { this.result += t; this.resultEl.setText(this.result); }
  setResult(t: string) { this.result = (t || "").trim(); this.resultEl.setText(this.result || "(no output)"); this.applyBtn.disabled = !this.result; }
  fail(msg: string) { this.resultEl.setText("Error: " + msg); }
  onClose() { this.contentEl.empty(); }
}
