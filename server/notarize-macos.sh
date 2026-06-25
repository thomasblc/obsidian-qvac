#!/usr/bin/env bash
# Developer ID sign + notarize the QVAC Companion .dmg so it opens cleanly on any Mac
# (no Gatekeeper right-click-open dance). Run this YOURSELF: it uses your Apple credentials,
# which I never handle.
#
# Prerequisites (one-time):
#   1. A "Developer ID Application" certificate in your login keychain
#      (Xcode > Settings > Accounts, or developer.apple.com > Certificates).
#   2. An app-specific password for your Apple ID: appleid.apple.com > Sign-In and Security.
#   3. Store credentials once so this script never prompts:
#        xcrun notarytool store-credentials qvac-notary \
#          --apple-id "toblanc34@gmail.com" --team-id "2477AU4F6Y" --password "<app-specific-password>"
#
# Usage: ./notarize-macos.sh /path/to/QVAC-Companion.dmg
set -euo pipefail
DMG="${1:?usage: notarize-macos.sh <dmg>}"
TEAM_ID="2477AU4F6Y"                                  # Gengrowth Consulting LTD
SIGN_ID="${SIGN_ID:-Developer ID Application}"        # codesign picks the cert matching the team
APP_INSIDE="${APP_INSIDE:-$HOME/Desktop/QVAC-Companion-build/QVAC Companion.app}"

echo "==> Developer ID sign the .app (deep, hardened runtime, timestamped)"
codesign --force --deep --options runtime --timestamp \
  --sign "$SIGN_ID" "$APP_INSIDE"

echo "==> rebuild the dmg from the signed .app"
STAGE="$(dirname "$APP_INSIDE")/stage-signed"; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP_INSIDE" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "QVAC Companion" -srcfolder "$STAGE" -format UDZO "$DMG" >/dev/null

echo "==> submit to Apple notary service (uses your stored 'qvac-notary' credentials)"
xcrun notarytool submit "$DMG" --keychain-profile "qvac-notary" --wait

echo "==> staple the ticket"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG" && echo "==> notarized + stapled: $DMG"
