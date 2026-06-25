# QVAC for Obsidian - release + submission staging

Everything below is prepared. The two identity-gated steps (GitHub repo, Apple signing) need Thomas.

## Release artifacts (already built)
`test/27-obsidian-qvac/plugin/` produces the three Obsidian release assets:
- `main.js` (esbuild bundle), `manifest.json`, `styles.css`

`npm run build` regenerates `main.js`. `npm version <x.y.z>` bumps `manifest.json` + `versions.json` (via `version-bump.mjs`).

## Community-directory submission (staged)

1. Push the plugin to a PUBLIC GitHub repo (e.g. `qvac/obsidian-qvac`).
2. Create a GitHub Release with tag = the version (no leading `v`), attaching `main.js` + `manifest.json` + `styles.css` as **separate** binary assets (not zipped).
3. Open a PR to `obsidianmd/obsidian-releases` adding this entry to `community-plugins.json` (alphabetical by id):

```json
{
  "id": "qvac-local-ai",
  "name": "QVAC",
  "author": "Thomas Blanc",
  "description": "Chat with your vault, fully local. Semantic search and cited answers via a local QVAC companion.",
  "repo": "<github-user>/<repo>"
}
```

Review takes ~1-7 days (sometimes weeks); Obsidian runs automated security scans on every submitted version. Expect a question about the local companion + subprocess - the README disclosures cover it.

## Beta channel (BRAT) - ship to users before the directory PR
Users install [BRAT](https://github.com/TfTHacker/obsidian42-brat), add the GitHub repo, and get the release. No directory approval needed. This is how we get real users on it first.

## Companion app (.dmg)
The companion (`test/27-obsidian-qvac/server/`) is packaged with the Voice Relay recipe (memory note `qvac-recipe-dmg-packaging`): trim `@qvac/sdk` to darwin-arm64, bundle official node + static ffmpeg, run-in-place, ad-hoc sign. The plugin's settings tab health-checks the companion and links to the download.

## Blocked on Thomas
- A GitHub account + the public plugin repo + the `obsidian-releases` PR (his identity).
- An **Apple Developer ID** to notarize the `.dmg` (ad-hoc signing works for local/BRAT, but Gatekeeper warns on other machines without notarization).

## Fully preparable now (done or doable without Thomas)
- All plugin + companion code, `manifest.json` / `versions.json`, README disclosures, the build, the staged `community-plugins.json` diff, and the ad-hoc `.dmg` for the BRAT beta.
