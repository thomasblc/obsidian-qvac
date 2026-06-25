# QVAC for Obsidian

Chat with your vault, fully local. Semantic search, cited answers, related-notes, inline writing commands, OCR over your images, and an optional personal voice (on-device fine-tuning). **Nothing leaves your machine.**

## What it does

- **Chat with your vault** - ask questions, get answers grounded in your notes with clickable `[[citations]]`.
- **Semantic search & related notes** - find notes by meaning; a sidebar shows notes related to whatever you are reading.
- **Inline writing commands** - select text and summarize / rewrite / fix grammar / expand, with a review-before-apply step.
- **Search inside images (OCR, opt-in)** - the text in your screenshots and scans becomes searchable.
- **Train a voice (optional)** - fine-tune a small model on your own prose so chat replies in your style. Runs on your machine; you can use everything else without ever training.

## How it works (and what to know)

This plugin is a thin client. The AI runs in a separate **QVAC companion app** on your computer, and the plugin talks to it over `127.0.0.1` (localhost) only. This is the same shape as plugins that use a local Ollama server.

**Disclosures (please read):**

- **A local companion is required.** Install and run the QVAC companion app; the plugin connects to it. Without it, the plugin shows a "companion not running" state and does nothing.
- **Everything is local.** No vault content, no queries, and no telemetry are ever sent to any server. The only network use is the companion's **one-time model download** on first run (about 7 GB), fetched from the QVAC model registry.
- **Files outside the vault.** The plugin reads a small auth token the companion writes at `~/.qvac-obsidian/` so it can connect securely to the local server. The companion stores its index and models under `~/.qvac-obsidian/` and `~/.qvac/`.
- **Desktop only.** Requires Node/Electron APIs; it will not load on Obsidian mobile. macOS first; Windows/Linux companions are planned.
- **No self-update.** The plugin never downloads or runs code on its own. You install and update the companion app yourself.
- **To stop it:** quit the QVAC companion app. The plugin then simply reports it is offline.

## Install

1. Install the plugin (Community plugins, or BRAT for beta).
2. Download and run the **QVAC companion** app for your platform.
3. Open the QVAC chat (ribbon icon or the command palette: "Open QVAC chat"). The first question triggers a one-time model download.

## Commands

- **Open QVAC chat** / **Open related notes** / **Train a voice on your vault**
- **Index vault (incremental)** / **Reindex vault (full)**
- **Summarize / Rewrite / Fix grammar / Expand** the current selection (also in the right-click menu)

## Privacy

Open source, no obfuscation, no analytics, no account. Your notes are yours. The whole point of this plugin is that your second brain never becomes someone else's training data.
