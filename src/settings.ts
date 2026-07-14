import { App, PluginSettingTab, Setting, DropdownComponent } from "obsidian";
import type QvacPlugin from "./main";

export interface QvacSettings {
  settingsVersion: number;
  indexOnStartup: boolean;
  chatBaseKey: string;
  excludeFolders: string; // comma-separated folder paths
  voiceEnabled: boolean;  // reply in the trained voice (LoRA)
  voiceAdapter: string | null; // active adapter file
  ocrImages: boolean;     // also index the text inside images (OCR), opt-in
  provisioned: boolean;   // the models have been downloaded (gates auto-index + the Setup panel)
}

// Chat model choices exposed in the picker, with rough resident RAM so users pick for their machine.
export const CHAT_MODELS: { key: string; label: string }[] = [
  { key: "600m", label: "Qwen3 0.6B - fastest, ~1 GB RAM" },
  { key: "1.7b", label: "Qwen3 1.7B - small, ~2 GB RAM" },
  { key: "4b", label: "Qwen3 4B - balanced (default), ~4 GB RAM" },
  { key: "8b", label: "Qwen3 8B - best quality, ~7 GB RAM" },
];

export const DEFAULT_SETTINGS: QvacSettings = {
  settingsVersion: 2,
  indexOnStartup: true,
  chatBaseKey: "4b",
  excludeFolders: "",
  voiceEnabled: false,
  voiceAdapter: null,
  ocrImages: false,
  provisioned: false,
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
      .setName("Chat model")
      .setDesc("The local model used for chat and writing commands. Bigger = better answers, more RAM, slower. Switch takes effect on the next message.")
      .addDropdown((d: DropdownComponent) => {
        for (const m of CHAT_MODELS) d.addOption(m.key, m.label);
        d.setValue(this.plugin.settings.chatBaseKey || "4b").onChange(async (v) => { this.plugin.settings.chatBaseKey = v; await this.plugin.saveSettings(); });
      });

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
