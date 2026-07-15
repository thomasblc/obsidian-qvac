# qvac-obsidian-companion

The local companion daemon for the [**QVAC for Obsidian**](https://github.com/thomasblc/obsidian-qvac) plugin.

The Obsidian plugin is a thin client. The AI runs here, in this small local process, and the plugin talks to it over `127.0.0.1` (localhost) only. Same shape as running a local Ollama server. **Nothing leaves your machine.**

It runs [`@qvac/sdk`](https://www.npmjs.com/package/@qvac/sdk) (Apache-2.0), the on-device AI engine from Tether's QVAC: semantic search, cited chat over your vault (RAG), OCR, and optional on-device LoRA fine-tuning. One daemon serves all your vaults.

## Run it

Requires **Node 20+**.

```bash
npx qvac-obsidian-companion
```

That's it. The daemon starts on a loopback port and writes its connection token to `~/.qvac-obsidian/daemon.json`; the plugin picks it up automatically. Leave it running while you use Obsidian; quit it (Ctrl+C) to go offline.

On the first chat request it downloads the models once (about 7 GB, from the QVAC model registry) into `~/.qvac`. Nothing else touches the network.

Install globally instead of `npx`, if you prefer:

```bash
npm install -g qvac-obsidian-companion
qvac-obsidian-companion
```

## What it stores locally

- `~/.qvac-obsidian/` : the per-boot auth token (`0600`) and the vault index.
- `~/.qvac/` : the downloaded models and the SDK's local store.

## Privacy

No vault content, no queries, and no telemetry are ever sent to any server. Open source, no account, no obfuscation.

## License

MIT. Depends on `@qvac/sdk` (Apache-2.0).
