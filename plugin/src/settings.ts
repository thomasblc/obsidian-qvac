import { App, PluginSettingTab, Setting } from "obsidian";
import type QvacPlugin from "./main";

export interface QvacSettings {
  settingsVersion: number;
  indexOnStartup: boolean;
  chatBaseKey: string;
  excludeFolders: string; // comma-separated folder paths
  voiceEnabled: boolean;  // reply in the trained voice (LoRA)
  voiceAdapter: string | null; // active adapter file
  ocrImages: boolean;     // also index the text inside images (OCR), opt-in
}

export const DEFAULT_SETTINGS: QvacSettings = {
  settingsVersion: 1,
  indexOnStartup: true,
  chatBaseKey: "4b",
  excludeFolders: "",
  voiceEnabled: false,
  voiceAdapter: null,
  ocrImages: false,
};

// Additive merge + version stamp. A renamed/removed key in a future version gets a migration step here.
export function migrateSettings(raw: any): QvacSettings {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  s.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  return s;
}

export class QvacSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: QvacPlugin) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "QVAC - local AI for your vault" });

    const statusSetting = new Setting(containerEl)
      .setName("Companion")
      .setDesc("The local QVAC engine the plugin talks to. Nothing leaves your machine.");
    const statusEl = statusSetting.descEl.createDiv({ cls: "qvac-status" });
    const refresh = async () => {
      statusEl.setText("Checking...");
      const h = await this.plugin.checkHealth();
      statusEl.setText(h ? `Connected (v${h.version}).` : "Not running. Start the QVAC companion app, then Recheck.");
      statusEl.style.color = h ? "var(--text-success)" : "var(--text-warning)";
    };
    statusSetting.addButton((b) => b.setButtonText("Recheck").onClick(refresh));
    refresh();

    new Setting(containerEl)
      .setName("Index on startup")
      .setDesc("Incrementally sync the vault to the local index when Obsidian opens.")
      .addToggle((t) => t.setValue(this.plugin.settings.indexOnStartup).onChange(async (v) => { this.plugin.settings.indexOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Exclude folders")
      .setDesc("Comma-separated folder paths to skip when indexing (e.g. Templates, Archive).")
      .addText((t) => t.setPlaceholder("Templates, Archive").setValue(this.plugin.settings.excludeFolders).onChange(async (v) => { this.plugin.settings.excludeFolders = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Index text inside images (OCR)")
      .setDesc("Also read the text in your images so it becomes searchable. Runs in the background and downloads an OCR model on first use.")
      .addToggle((t) => t.setValue(this.plugin.settings.ocrImages).onChange(async (v) => { this.plugin.settings.ocrImages = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Reindex vault")
      .setDesc("Force a full incremental sync now.")
      .addButton((b) => b.setButtonText("Reindex").onClick(() => this.plugin.indexVault(true)));
  }
}
