import { App, PluginSettingTab, Setting, DropdownComponent } from "obsidian";
import type QvacPlugin from "./main";
import type { ModelsData } from "./lib/rpc";

export interface QvacSettings {
  settingsVersion: number;
  indexOnStartup: boolean;
  chatBaseKey: string;
  excludeFolders: string; // comma-separated folder paths
  voiceEnabled: boolean;  // reply in the trained voice (LoRA)
  voiceAdapter: string | null; // active adapter file
  ocrImages: boolean;     // also index the text inside images (OCR), opt-in
  provisioned: boolean;   // the models have been downloaded (gates auto-index + the Setup panel)
  // Which tabs to show in the panel. Off Train, for example, if you never fine-tune.
  tabChat: boolean;
  tabSearch: boolean;
  tabConnect: boolean;
  tabTrain: boolean;
  // Optional: use your own chat model (a local GGUF path or a URL) instead of downloading the
  // default. Empty = use the built-in model picked above. Embeddings still download (small).
  customModelSrc: string;
  modelsFolder: string; // folder browsed for local .gguf models in settings
}

// Chat model choices exposed in the picker, with rough resident RAM so users pick for their machine.
export const CHAT_MODELS: { key: string; label: string }[] = [
  { key: "600m", label: "Qwen3 0.6B - fastest, ~1 GB RAM" },
  { key: "1.7b", label: "Qwen3 1.7B - small, ~2 GB RAM" },
  { key: "4b", label: "Qwen3 4B - balanced (default), ~4 GB RAM" },
  { key: "8b", label: "Qwen3 8B - best quality, ~7 GB RAM" },
];

export const DEFAULT_SETTINGS: QvacSettings = {
  settingsVersion: 5,
  indexOnStartup: true,
  chatBaseKey: "4b",
  excludeFolders: "",
  voiceEnabled: false,
  voiceAdapter: null,
  ocrImages: false,
  provisioned: false,
  tabChat: true,
  tabSearch: true,
  tabConnect: true,
  tabTrain: true,
  customModelSrc: "",
  modelsFolder: "~/.qvac/models",
};

// Additive merge + version stamp. A renamed/removed key in a future version gets a migration step here.
export function migrateSettings(raw: unknown): QvacSettings {
  const s = Object.assign({}, DEFAULT_SETTINGS, (raw as Partial<QvacSettings>) || {});
  s.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  return s;
}

export class QvacSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: QvacPlugin) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const statusSetting = new Setting(containerEl)
      .setName("Companion")
      .setDesc("The local QVAC engine the plugin talks to. Nothing leaves your machine.");
    const statusEl = statusSetting.descEl.createDiv({ cls: "qvac-status" });
    const refresh = async () => {
      statusEl.setText("Checking...");
      const h = await this.plugin.checkHealth();
      statusEl.setText(h ? `Connected (v${h.version}).` : "Not running. Start the QVAC companion app, then Recheck.");
      statusEl.toggleClass("is-connected", !!h);
      statusEl.toggleClass("is-disconnected", !h);
    };
    statusSetting.addButton((b) => b.setButtonText("Recheck").onClick(refresh));
    void refresh();

    new Setting(containerEl)
      .setName("Chat model")
      .setDesc("The local model used for chat and writing commands. Bigger = better answers, more RAM, slower. Switch takes effect on the next message.")
      .addDropdown((d: DropdownComponent) => {
        for (const m of CHAT_MODELS) d.addOption(m.key, m.label);
        d.setValue(this.plugin.settings.chatBaseKey || "4b").onChange(async (v) => { this.plugin.settings.chatBaseKey = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl).setName("Custom chat model").setHeading();
    this.renderModelPicker(containerEl);

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

    new Setting(containerEl).setName("Tabs").setHeading();

    const tabToggle = (name: string, desc: string, key: "tabChat" | "tabSearch" | "tabConnect" | "tabTrain") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(this.plugin.settings[key]).onChange(async (v) => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        }));
    tabToggle("Show Chat", "Ask questions grounded in your notes.", "tabChat");
    tabToggle("Show AI Search", "Find notes by meaning.", "tabSearch");
    tabToggle("Show Connect", "Find and write the missing links between notes.", "tabConnect");
    tabToggle("Show Train", "Fine-tune a model on your vault. Turn off if you never fine-tune.", "tabTrain");

    new Setting(containerEl)
      .setName("Style the graph")
      .setDesc("Color the Obsidian graph nodes by folder. Reopen the Graph view after applying.")
      .addButton((b) => b.setButtonText("Color by folder").onClick(() => { void this.plugin.colorGraph(); }));
  }

  // Folder + dropdown + live validation for the custom chat model (replaces a raw path field).
  private renderModelPicker(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const basename = (p: string) => p.split("/").pop() || p;
    let dropdown: DropdownComponent | null = null;

    new Setting(containerEl)
      .setName("Models folder")
      .setDesc("Folder scanned for local .gguf chat models. Default is QVAC's own model store.")
      .addText((t) => t.setValue(s.modelsFolder).onChange(async (v) => { s.modelsFolder = v.trim() || "~/.qvac/models"; await this.plugin.saveSettings(); }))
      .addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("Rescan folder").onClick(() => { void populate(); }));

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Pick a local model, or keep Default to download the built-in one. The small embeddings model still downloads either way.")
      .addDropdown((dd) => {
        dropdown = dd;
        dd.addOption("", "Default (download the built-in model)");
        dd.setValue(s.customModelSrc);
        dd.onChange(async (v) => { s.customModelSrc = v; await this.plugin.saveSettings(); void validate(); });
      });

    const status = containerEl.createDiv({ cls: "qvac-status" });

    new Setting(containerEl)
      .setName("Or paste a path / URL")
      .setDesc("Advanced: a .gguf outside the folder above, or a model URL. Overrides the dropdown.")
      .addText((t) => t.setPlaceholder("/path/to/model.gguf or https://…").onChange(async (v) => { s.customModelSrc = v.trim(); await this.plugin.saveSettings(); void populate(); }));

    const validate = async () => {
      status.removeClass("is-connected"); status.removeClass("is-disconnected");
      if (!s.customModelSrc) { status.setText("Using the built-in model (downloads on first setup)."); return; }
      status.setText("Checking model…");
      try {
        const r = await this.plugin.checkModel(s.customModelSrc);
        if (r.ok) { status.setText(`Ready: ${basename(s.customModelSrc)}${r.sizeMB ? ` (${r.sizeMB} MB)` : ""}`); status.addClass("is-connected"); }
        else { status.setText(`Cannot use this model: ${r.error ?? "invalid"}`); status.addClass("is-disconnected"); }
      } catch { status.setText("Start the companion to validate the model."); }
    };

    const populate = async () => {
      if (dropdown === null) return;
      const d = dropdown;
      status.setText("Scanning folder…");
      let data: ModelsData;
      try { data = await this.plugin.listModels(s.modelsFolder); }
      catch { status.setText("Start the companion to browse models (or paste a path below)."); return; }
      d.selectEl.empty();
      d.addOption("", "Default (download the built-in model)");
      for (const m of data.models) d.addOption(m.path, `${m.name} (${m.sizeMB} MB)`);
      if (s.customModelSrc && !data.models.some((m) => m.path === s.customModelSrc)) d.addOption(s.customModelSrc, `(custom) ${basename(s.customModelSrc)}`);
      d.setValue(s.customModelSrc);
      if (data.error) { status.setText(`Folder not readable: ${data.error}`); status.addClass("is-disconnected"); return; }
      void validate();
    };

    void populate();
  }
}
