import { App, Modal, Setting } from "obsidian";

// Confirm the path before writing an AI-drafted note to the vault (no silent file creation).
export class CreateNoteModal extends Modal {
  private path: string;
  constructor(app: App, defaultPath: string, private onCreate: (path: string) => void) {
    super(app);
    this.path = defaultPath;
  }

  onOpen() {
    this.setTitle("Create note");
    const { contentEl } = this;
    new Setting(contentEl)
      .setName("Path")
      .setDesc("Where to create the note, relative to the vault. Include a folder to file it (e.g. people/Jean-Mi.md).")
      .addText((t) => {
        t.setValue(this.path).onChange((v) => { this.path = v; });
        t.inputEl.addClass("qvac-fullwidth");
        window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
      });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Create").setCta().onClick(() => { const p = this.path.trim(); if (p) { this.onCreate(p); this.close(); } }))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}
