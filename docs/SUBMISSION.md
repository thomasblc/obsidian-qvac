# QVAC for Obsidian - release + submission checklist

The repo is now laid out the way the Obsidian validator expects: **`manifest.json`, `versions.json`,
`styles.css` and the plugin source (`src/`) sit at the repo root**; the companion is in `companion/`;
dev-only helpers and demo vaults are in `dev/`.

## Release artifacts
`npm run build` regenerates `main.js` (esbuild bundle, gitignored). `npm version <x.y.z>` bumps
`manifest.json` + `versions.json` (via `version-bump.mjs`). A GitHub Release must attach the three
assets as **separate binary files (not zipped)**: `main.js`, `manifest.json`, `styles.css`.

Release `0.2.0` already has all three attached.

## Community-directory submission (NEW web flow, 2026)

Obsidian **no longer accepts a PR to `obsidian-releases`** (PRs are disabled on that repo). Submission
is a web form. Prereqs already met: public repo `thomasblc/obsidian-qvac` (MIT), `README.md` + `LICENSE`
+ `manifest.json` at the ROOT, and a GitHub release whose tag == the manifest `version` with `main.js` +
`manifest.json` + `styles.css` attached (release `0.2.1`).

Steps (Thomas, needs his Obsidian + GitHub accounts):
1. Go to https://community.obsidian.md and sign in with the Obsidian account.
2. Link the GitHub account (proves repo ownership).
3. Sidebar -> **Plugins** -> **New plugin**.
4. Enter the repo URL: `https://github.com/thomasblc/obsidian-qvac`.
5. Review + agree to the Developer policies, confirm ongoing support, **Submit**.

The directory reads `manifest.json` at HEAD of the default branch (ours is at root on `main`), then runs
an automated review; feedback shows in the community.obsidian.md dashboard. Address it by pushing a new
release with an incremented version. `id` (`qvac-local-ai`) is unique and free of "obsidian". Expect a
review question about the local companion + subprocess. The README disclosures cover it, but the reviewer
must be able to actually run the companion (see below).

Once approved, the entry is added to `community-plugins.json` automatically (that is the "live" signal the
local watcher `scripts/watch_obsidian_pr.py` polls, in the QVAC-agent repo).

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
- The community.obsidian.md submission (his Obsidian + GitHub accounts) - see the steps above.
- Apple Developer ID to notarize the `.dmg` (ad-hoc signing works for local/BRAT, but Gatekeeper
  warns on other machines without notarization). Not required if the companion ships via `npx`.

## Nice-to-have before submitting (optional)
- Replace the few JS-assigned inline styles (`src/settings.ts`, `src/qvac-view.ts`) with CSS classes
  in `styles.css`; the review team sometimes flags direct `.style.` assignments.
- Add an optional `fundingUrl` to `manifest.json`.
