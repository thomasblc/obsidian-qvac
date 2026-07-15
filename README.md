# Local AI for your vault

**Chat with your vault, fully local.** An Obsidian plugin that runs AI entirely on your machine: semantic search, cited answers, related-notes, inline writing commands, OCR over your images, and an optional model fine-tuned on your own notes. **Nothing leaves your computer.**

Obsidian has no built-in AI, and the existing AI plugins are cloud-first. The few local ones only do chat. This one ships the whole thing locally, and it is the only one that can **fine-tune a model on your vault** so the assistant learns your knowledge and your writing style.

A single panel with four tabs: **Chat . Search . Related . Train**.

## Features

| | |
|---|---|
| **Chat** | Ask questions, get answers grounded in your notes with clickable citations. |
| **AI Search** | Find notes by meaning, not keywords (Obsidian's built-in search is keyword-only). |
| **Connect** | Finds notes that belong together but are not linked yet, lets an LLM judge which deserve a real link, and **writes the `[[wikilink]]` for you** (per-note while you read, or a whole-vault scan). Turns a pile of notes into a graph. |
| **Train (optional)** | Fine-tune a small model on your notes so chat answers from memory and in your voice. Runs on your machine; the plugin is fully usable without it. |

Plus: inline writing commands (summarize / rewrite / fix grammar / expand, with review-before-apply) and opt-in OCR so the text inside your screenshots becomes searchable.

## How it works (like Ollama)

This plugin is a thin client. The AI runs in a separate **QVAC companion** process on your computer, and the plugin talks to it over `127.0.0.1` (localhost) only. Same shape as plugins that use a local Ollama server.

**Disclosures (please read):**

- **A local companion is required.** Install and run the QVAC companion; the plugin connects to it. Without it, the plugin shows a "companion not running" state and does nothing. See [Install the companion](#install-the-companion).
- **Everything is local.** No vault content, no queries, and no telemetry are ever sent to any server. The only network use is the companion's **one-time model download** on first run (about 7 GB), fetched from the QVAC model registry.
- **Files outside the vault.** The plugin reads a small auth token the companion writes at `~/.qvac-obsidian/` so it can connect securely to the local server. The companion stores its index and models under `~/.qvac-obsidian/` and `~/.qvac/`.
- **Desktop only.** Requires Node/Electron APIs; it will not load on Obsidian mobile. macOS first; Windows/Linux companions are planned.
- **No self-update.** The plugin never downloads or runs code on its own. You install and update the companion yourself.
- **To stop it:** quit the QVAC companion. The plugin then simply reports it is offline.

## Install

1. Install the plugin (Community plugins once approved, or [BRAT](https://github.com/TfTHacker/obsidian42-brat) for the beta: add `thomasblc/obsidian-qvac`).
2. Install and run the **QVAC companion** (below).
3. Open the QVAC panel (ribbon icon or the command palette: "Open QVAC chat"). The first question triggers the one-time model download.

### Install the companion

The companion is a small local daemon that runs [`@qvac/sdk`](https://www.npmjs.com/package/@qvac/sdk) (Apache-2.0), the local AI engine from Tether's QVAC. One daemon serves all your vaults. It lives in [`companion/`](companion/).

**macOS (packaged app):** download `QVAC-Companion.dmg` from the [Releases](https://github.com/thomasblc/obsidian-qvac/releases), drag it to Applications, and launch it once. It writes its connection token to `~/.qvac-obsidian/` and the plugin connects automatically.

**From source (any platform with Node 20+):**

```bash
cd companion && npm install && node server.js
```

## Commands

- **Open QVAC chat** / **Open related notes** / **Train a voice on your vault**
- **Index vault (incremental)** / **Reindex vault (full)**
- **Summarize / Rewrite / Fix grammar / Expand** the current selection (also in the right-click menu)

## Privacy

100% local. No vault content, queries, or telemetry are sent anywhere. Open source, no obfuscation, no analytics, no account. Your notes are yours. The whole point of this plugin is that your second brain never becomes someone else's training data.

## Development

The plugin source is at the repo root (`src/`, `manifest.json`, `styles.css`); the companion is in `companion/`; dev helpers and demo vaults are in `dev/`.

```bash
npm install && npm run build          # builds main.js
npm test                              # plugin unit tests
./dev/run-dev.sh "/path/to/Vault"     # build + install into a vault + start the companion
```

## License

MIT (plugin). The companion depends on `@qvac/sdk` (Apache-2.0).
