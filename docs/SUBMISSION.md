# QVAC for Obsidian - release + submission checklist

The repo is now laid out the way the Obsidian validator expects: **`manifest.json`, `versions.json`,
`styles.css` and the plugin source (`src/`) sit at the repo root**; the companion is in `companion/`;
dev-only helpers and demo vaults are in `dev/`.

## Release artifacts
`npm run build` regenerates `main.js` (esbuild bundle, gitignored). `npm version <x.y.z>` bumps
`manifest.json` + `versions.json` (via `version-bump.mjs`). A GitHub Release must attach the three
assets as **separate binary files (not zipped)**: `main.js`, `manifest.json`, `styles.css`.

Release `0.2.0` already has all three attached.

## Community-directory submission

1. Repo is public: `thomasblc/obsidian-qvac` (MIT). `manifest.json` is at the root. Done.
2. GitHub Release with tag = the version (no leading `v`), the three assets attached. Done for `0.2.0`.
3. Open a PR to [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases)
   adding this entry to `community-plugins.json` (append at the end of the array):

```json
{
  "id": "qvac-local-ai",
  "name": "QVAC",
  "author": "Thomas Blanc",
  "description": "Chat with your vault, fully local. Semantic search and cited answers via a local QVAC companion.",
  "repo": "thomasblc/obsidian-qvac"
}
```

Review takes ~1-7 days (sometimes weeks); Obsidian runs automated security scans on every submitted
version. Expect a question about the local companion + subprocess. The README disclosures cover it,
but the reviewer must be able to actually run the companion (see below).

## The one thing that gates the review: a public companion
The plugin does nothing without the companion daemon. For the review to pass, a reviewer needs a
frictionless, public way to get it running. Two options (do at least one before the PR):
- **Notarized `.dmg`** attached to the GitHub Release. Build with `companion/package-macos.sh`
  (ad-hoc) then `companion/notarize-macos.sh` (Developer ID + notarize). Needs Thomas's Apple
  Developer ID (Team `2477AU4F6Y`); no App Store record required.
- **npm**, so anyone runs `npx qvac-obsidian-companion` from source. Needs the `companion/` package
  published (rename off the `private` package name first).

## Beta channel (BRAT) - ship before the directory PR
Users install [BRAT](https://github.com/TfTHacker/obsidian42-brat), add `thomasblc/obsidian-qvac`,
and get the release. No directory approval needed. Fastest way to get real users on it.

## Still on Thomas (identity-gated)
- The `obsidian-releases` PR (his GitHub identity).
- Apple Developer ID to notarize the `.dmg` (ad-hoc signing works for local/BRAT, but Gatekeeper
  warns on other machines without notarization).

## Nice-to-have before submitting (optional)
- Replace the few JS-assigned inline styles (`src/settings.ts`, `src/qvac-view.ts`) with CSS classes
  in `styles.css`; the review team sometimes flags direct `.style.` assignments.
- Add an optional `fundingUrl` to `manifest.json`.
