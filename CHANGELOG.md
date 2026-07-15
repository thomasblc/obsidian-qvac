# Changelog

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
