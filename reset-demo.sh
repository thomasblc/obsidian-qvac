#!/usr/bin/env bash
# Reset the Connect demo vault to pristine (wipes any [[links]] Connect wrote) + clears its index.
# Run this between demo recordings. Leaves .obsidian (plugin + window state) alone.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VAULT="$HERE/demo-vault"
python3 "$HERE/gen_demo_vault.py" "$VAULT"
VID=$(python3 -c "import hashlib;print(hashlib.sha1('$VAULT'.encode()).hexdigest()[:16])")
rm -rf "$HOME/.qvac-obsidian/$VID"
echo "reset done: notes pristine, index cleared (vaultId $VID). Re-index happens automatically when you open/reload the vault."
