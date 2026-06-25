#!/usr/bin/env bash
# Dev loop: build the plugin, install it into a vault, run the companion daemon.
# Usage: ./run-dev.sh /path/to/your/Obsidian/Vault
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VAULT="${1:?usage: run-dev.sh /path/to/vault}"
echo "building plugin..."; (cd "$HERE/plugin" && npm run build >/dev/null)
DEST="$VAULT/.obsidian/plugins/qvac-local-ai"
mkdir -p "$DEST"
cp "$HERE/plugin/main.js" "$HERE/plugin/manifest.json" "$HERE/plugin/styles.css" "$DEST/"
echo "installed plugin into $DEST"
echo "starting companion daemon (Ctrl+C to stop)..."
exec node "$HERE/server/server.js"
