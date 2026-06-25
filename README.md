# QVAC for Obsidian

**Chat with your vault, fully local.** An Obsidian plugin that runs AI entirely on your machine: semantic search, cited answers, related-notes, inline writing commands, OCR over your images, and an optional model fine-tuned on your own notes. **Nothing leaves your computer.**

Obsidian has no built-in AI, and the existing AI plugins are cloud-first. The few local ones only do chat. This one ships the whole thing locally, and it is the only one that can **fine-tune a model on your vault** so the assistant learns your knowledge and your writing style.

A single panel with four tabs: **Chat · Search · Related · Train**.

## Two parts (like Ollama)

The AI runs in a small **companion** process; the **plugin** is a thin client that talks to it over `127.0.0.1` only.

- **`plugin/`** - the Obsidian plugin (TypeScript). Open source, no telemetry, no self-update.
- **`server/`** - the companion daemon. Runs [`@qvac/sdk`](https://www.npmjs.com/package/@qvac/sdk) (Apache-2.0), the local AI engine from Tether's QVAC. One daemon serves all your vaults.

## Features

One panel, four tabs:

| | |
|---|---|
| **Chat** | Ask questions, get answers grounded in your notes with clickable citations. |
| **AI Search** | Find notes by meaning, not keywords (Obsidian's built-in search is keyword-only). |
| **Connect** | The differentiator. Finds notes that belong together but are not linked yet, lets an LLM judge which deserve a real link, and **writes the `[[wikilink]]` for you** (per-note while you read, or a whole-vault scan). Turns a pile of notes into a graph. |
| **Train (optional)** | Fine-tune a small model on your notes so chat answers from memory (lighter on context) and in your voice. Runs on your machine; the plugin is fully usable without it. |

Plus: inline writing commands (summarize / rewrite / fix grammar / expand, with review-before-apply) and opt-in OCR so the text inside your screenshots becomes searchable.

## Run it (dev)

```bash
# 1. build + install the plugin into a vault, and start the companion:
./run-dev.sh "/path/to/your/Obsidian/Vault"
```

Or manually:

```bash
cd server && npm install && node server.js     # the companion
cd plugin && npm install && npm run build       # builds main.js
# copy plugin/{main.js,manifest.json,styles.css} into <vault>/.obsidian/plugins/qvac-local-ai/
```

Then enable **QVAC** in Obsidian (Settings -> Community plugins) and open it from the ribbon. The first question triggers a one-time model download (~7 GB, from the QVAC registry).

## Privacy

100% local. No vault content, queries, or telemetry are sent anywhere. The only network use is the companion's one-time model download. Your second brain never becomes someone else's training data.

Requires a desktop (Node/Electron); macOS first. See [`plugin/README.md`](plugin/README.md) for the full disclosures and [`docs/SUBMISSION.md`](docs/SUBMISSION.md) for release notes.

## License

MIT (plugin). The companion depends on `@qvac/sdk` (Apache-2.0).
