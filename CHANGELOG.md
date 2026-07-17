# Changelog

## 0.2.19 - 2026-07 - Search quality (EmbeddingGemma prompts)

- **Fixes irrelevant search results.** EmbeddingGemma is a prompt-conditioned model: queries and
  documents must be embedded with different task prefixes. The companion now applies them
  ("task: search result | query:" vs "title: none | text:"), which is what makes semantic search,
  Connect, and chat grounding actually relevant. Requires a one-time full reindex (done
  automatically on the affected index; run "Reindex vault (full)" if needed). Companion >= 0.2.19.

## 0.2.18 - 2026-07 - Bound the model scan

- The model-folder scan is capped (entries + results) so pointing it at a huge tree cannot freeze
  the companion.

## 0.2.17 - 2026-07 - Bigger models + indexing feedback

- Model picker now finds models in subfolders and split (sharded) model sets, so large models
  (e.g. a sharded 35B) show up instead of only top-level single-file .gguf.
- Indexing shows a percentage and a "loading the model" note on the first (slow) run; AI Search
  says "indexing in progress" instead of a bare "no matches" while the index is still building.

## 0.2.16 - 2026-07 - Setup folder, chat formatting, connect + search tuning

- Setup panel: pick the models FOLDER too (not everyone keeps models in ~/.qvac/models).
- Chat: answers keep their Markdown formatting when you leave and return to the tab (history
  re-render now renders Markdown, not raw text).
- Connect: links made this session are excluded from the next scan (no re-proposing while
  Obsidian catches up), and the score threshold is higher so it proposes fewer, stronger links.
- AI Search: weak matches (<40%) are filtered, so a query with no real hit returns few/none
  instead of a wall of noise.

## 0.2.15 - 2026-07 - Embedder-swap safety

- Changing the embedding model can no longer silently break search. The index is tagged with the
  embedder that built it; queries refuse (clear error) or return nothing on a mismatch instead of
  wrong results, stale vectors are dropped, and the plugin reindexes automatically on a change.

## 0.2.14 - 2026-07 - Choose both models at setup

- The first-run Setup panel now lets you choose the chat model AND the embedding model: download
  the default, or pick an existing local .gguf (no download). Only the defaults you keep are fetched.
- Custom embedding model supported end to end (companion persists the choice; changing it later
  requires a reindex). Settings gained an "Embedding model" picker. Companion >= 0.2.14.

## 0.2.13 - 2026-07 - Respect the config dir

- "Color graph by folder" writes to the vault's actual config dir (Vault#configDir) instead of a
  hardcoded .obsidian, so it works when the user renamed that folder.

## 0.2.12 - 2026-07 - Note-path hardening

- Create note rejects a hand-typed `..` path so it can never write outside the vault.

## 0.2.11 - 2026-07 - Create notes, select text, link all

- **Create a note from a chat answer.** Each answer gets a "Create note" button: confirm the path
  and QVAC writes it to your vault (the model no longer claims it cannot create files).
- **Selectable text** in the panel, so you can copy any answer or search result.
- **Connect: "Link all"** button to accept every proposed link at once.

## 0.2.10 - 2026-07 - Setup reflects custom model

- Picking a custom model now updates the Setup panel live: it explains only the small embeddings
  model (~300 MB) still downloads, and the button says so. (You still run setup once for embeddings,
  which power search, Connect, and chat grounding.)

## 0.2.9 - 2026-07 - Model picker

- Custom chat model is now a proper picker: choose a folder (defaults to QVAC's model store),
  pick from the .gguf models found, and see instant validation (exists + real GGUF) instead of
  typing a blind path. A path/URL field remains for models outside the folder. Companion >= 0.2.9.

## 0.2.8 - 2026-07 - Connect honors the custom model

- Fix: the Connect scan now uses your custom chat model too (it was still pulling the default
  registry model, which a custom-model user has not downloaded). Requires companion >= 0.2.8.

## 0.2.7 - 2026-07 - Settings gear + bring your own model

- **Settings gear in the panel header** opens the plugin settings directly (no more hunting).
- **Bring your own chat model.** New setting "Custom chat model": point it at a local GGUF path or
  a model URL and the companion loads that instead of downloading the default (skips the big chat
  download; the small embeddings model still downloads). Voice/LoRA is disabled for a custom base.
  Requires companion `qvac-obsidian-companion` >= 0.2.7.

## 0.2.6 - 2026-07 - Polish

- No more "offline" card flashing on open when the companion is actually running (neutral
  "Connecting…" state until the first health check resolves).
- "Color graph by folder" now handles folder names with spaces.

## 0.2.5 - 2026-07 - Tabs, offline guidance, graph colors

- **Hide tabs you do not use.** Settings now has toggles for Chat / AI Search / Connect / Train
  (turn Train off if you never fine-tune). The panel updates live.
- **Clear offline state.** When the companion is not running, the panel explains how to start it
  (`npx qvac-obsidian-companion`) with a Recheck button, instead of failing on the first click.
- **Color your graph.** New command and settings button "Color graph by folder" that groups the
  Obsidian graph nodes by folder (with the QVAC accent), so clusters pop.

## 0.2.4 - 2026-07 - README title

- README title now matches the plugin name ("Local AI for your vault").

## 0.2.3 - 2026-07 - Review polish

Pushes the automated review toward a clean report. No behavior change.

- Renamed to **Local AI for your vault** (clearer, and no longer all-caps).
- Node built-ins (`fs`/`os`/`path`/`crypto`) go through a small typed shim (`lib/node.ts`),
  removing the remaining `no-unsafe-*` warnings.
- Timers use `window.setTimeout`/`clearTimeout` for popout-window compatibility.
- Releases are now built in CI with a GitHub build-provenance attestation on the assets.

## 0.2.2 - 2026-07 - Review fixes

Clears the Obsidian automated-review findings. No behavior change.

- `minAppVersion` bumped to `1.7.2` (the plugin uses `Workspace.revealLeaf`, async since 1.7.2).
- All UI styling goes through `setCssStyles` / CSS classes instead of inline `element.style`.
- Settings no longer create a raw `<h3>` heading.
- The companion RPC layer is fully typed (a small `lib/rpc.ts`), removing the `any`-driven
  type-safety warnings; unused code and unnecessary type assertions removed.
- Added an ESLint setup with `eslint-plugin-obsidianmd` (`npm run lint`) so future changes stay clean.

## 0.2.1 - 2026-07 - Submission prep

Repo restructured for the Obsidian community directory (plugin at the repo root, companion in
`companion/`, dev helpers in `dev/`). No behavior change.

- The companion connection status now toggles a CSS class instead of an inline color, so the whole
  UI is styled from `styles.css` (Obsidian review guideline).
- The companion is packaged for `npx qvac-obsidian-companion` (public npm), alongside the macOS app.

## 0.2.0 - 2026-07 - Hardening + onboarding

A correctness + security hardening pass (from a triple-review of the codebase) plus the first
onboarding improvements. No breaking changes; the companion protocol is unchanged.

### Fixed - data integrity
- **Images dropped from the search index (P0).** With "Index text inside images (OCR)" enabled, every
  incremental index silently removed all OCR'd images from the index, so image search flip-flopped
  on/off between runs. The markdown sync and the image sync are now cleanly separated (`planTextIndex`),
  and deleted/excluded images are dropped correctly.
- **"Reindex vault (full)" now drops deleted notes.** Previously a full reindex re-embedded everything
  but never removed notes deleted since the last run (they lingered as ghost citations).
- **OCR now respects "Exclude folders".** Images in excluded folders are no longer indexed.
- Training dataset no longer strands the first note in the eval split (it was excluded from training).

### Fixed - security
- **`daemon.json` and the auth token are now `0600`, the config dir `0700`.** They were world-readable,
  so any other local user could read the bearer token and connect to your companion. Existing files
  are tightened on the next start.
- **Path traversal in training closed.** A crafted `vaultId` could write dataset files outside the
  config dir; it is now sanitized at the boundary.
- **Remote images stripped from chat answers.** Chat replies render as Markdown; a note in your vault
  (e.g. a synced/shared one) could otherwise steer the model into emitting a remote `![](https://...)`
  that fires a network request on render. Remote images/`<img>` are now neutralized. This preserves
  the "nothing leaves your machine" guarantee.
- Token comparison is now constant-time.

### Fixed - stability
- **Reconnect after a companion restart.** A stale socket's close no longer rejects the requests of a
  freshly reconnected socket (chat/index could spuriously fail after the companion restarted).
- **Training is never interrupted by the idle timer.** Quitting Obsidian mid-train no longer lets the
  companion self-exit and orphan the run.
- **Chat/train race fixed.** Starting a training run while a chat is in flight can no longer collide on
  the model worker ("File descriptor could not be locked"); the in-flight request is paused cleanly.
- The Connect tab no longer stacks duplicate panels when you switch notes.
- Over-size uploads no longer hang a request on the companion.

### Added - onboarding & UX
- **First-run Setup panel.** Downloads the models with a visible progress bar (embeddings first, so
  search and Connect work within minutes) instead of a silent multi-gigabyte stall on your first chat.
- **Chat model picker** in settings (0.6B / 1.7B / 4B / 8B) with rough RAM guidance.
- **Streaming Markdown + a Stop button** in chat (answers render live; you can cancel a long generation).

### Tests
15 plugin unit tests (incl. the index-plan, reconnect-generation, and CRLF-link regressions) +
`server/_verify_wave0.mjs` (4/4) + `server/_verify_core.mjs` (11/11 end-to-end, no regression).

## 0.1.0 - Connect
Find and write the missing `[[links]]` between notes by meaning (embeddings + an LLM judge with a
one-line reason), one-click insert under `## Related`, and a vault-wide scan.

## 0.0.1 - Initial
Chat with your vault (cited), semantic search, related notes, inline writing commands, OCR into the
index, and optional on-device LoRA - all local, via the QVAC companion.
