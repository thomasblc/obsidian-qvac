#!/usr/bin/env bash
# Package the QVAC companion as a standalone macOS .app/.dmg (Apple Silicon, arm64).
# Proven recipe (same one that built Voice Relay): fresh-install the SDK, trim it to
# darwin-arm64, bundle official node + static ffmpeg, ad-hoc sign, run-in-place.
# Produces an AD-HOC signed .dmg. For a shareable (notarized) build, run notarize-macos.sh after.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK_VER="${SDK_VER:-0.12.2}"
NODE_VER="${NODE_VER:-22.14.0}"
BUILD="${BUILD:-$HOME/Desktop/QVAC-Companion-build}"
APP="$BUILD/QVAC Companion.app"
OUT="${OUT:-$HOME/Desktop/QVAC-Companion.dmg}"

echo "==> clean payload + fresh SDK install ($SDK_VER)"
rm -rf "$BUILD"; mkdir -p "$BUILD/payload"
cd "$BUILD/payload"
npm init -y >/dev/null; npm pkg set type=module >/dev/null
npm install "@qvac/sdk@$SDK_VER" ws >/dev/null
cp "$HERE"/*.js "$BUILD/payload/"

echo "==> trim SDK to darwin-arm64 (2.2GB -> ~556MB)"
# keep only darwin-arm64 prebuilds
find node_modules -type d -name prebuilds | while read -r d; do
  find "$d" -mindepth 1 -maxdepth 1 -type d ! -name 'darwin-arm64' -exec rm -rf {} +
done
# drop the React-Native / mobile / build bloat the node server never uses
rm -rf node_modules/react-native-bare-kit node_modules/*/hermes-compiler node_modules/*/fb-dotslash 2>/dev/null || true
find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name testAssets \) -prune -exec rm -rf {} + 2>/dev/null || true
find node_modules -type f \( -name '*.so' -o -name '*.dll' \) -delete 2>/dev/null || true
# KEEP bare-runtime-darwin-arm64/bin/bare (the SDK worker runtime)

echo "==> .app layout"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/bin"
cp -R "$BUILD/payload/." "$APP/Contents/Resources/app/"

echo "==> bundle official node + static ffmpeg (homebrew binaries are not portable)"
curl -fsSL "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-darwin-arm64.tar.gz" -o "$BUILD/node.tgz"
tar -xzf "$BUILD/node.tgz" -C "$BUILD"
cp "$BUILD/node-v$NODE_VER-darwin-arm64/bin/node" "$APP/Contents/Resources/bin/node"
if command -v ffmpeg >/dev/null && ! otool -L "$(command -v ffmpeg)" | grep -q homebrew; then
  cp "$(command -v ffmpeg)" "$APP/Contents/Resources/bin/ffmpeg"
else
  curl -fsSL "https://www.osxexperts.net/ffmpeg81arm.zip" -o "$BUILD/ffmpeg.zip"
  ( cd "$BUILD" && unzip -oq ffmpeg.zip && cp ffmpeg "$APP/Contents/Resources/bin/ffmpeg" )
fi
chmod +x "$APP/Contents/Resources/bin/"*

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>QVAC Companion</string>
  <key>CFBundleExecutable</key><string>QVAC Companion</string>
  <key>CFBundleIdentifier</key><string>io.tether.qvac.obsidian-companion</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/QVAC Companion" <<'LAUNCH'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
export PATH="$DIR/bin:$PATH"
exec "$DIR/bin/node" "$DIR/app/server.js"
LAUNCH
chmod +x "$APP/Contents/MacOS/QVAC Companion"

echo "==> ad-hoc sign (every arm64 executable must be signed to run at all)"
codesign --force --sign - "$APP/Contents/Resources/bin/node"
codesign --force --sign - "$APP/Contents/Resources/bin/ffmpeg"
codesign --force --deep --sign - "$APP"

echo "==> dmg"
STAGE="$BUILD/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "QVAC Companion" -srcfolder "$STAGE" -format UDZO "$OUT" >/dev/null
echo "==> done: $OUT ($(du -h "$OUT" | cut -f1))"
echo "    ad-hoc signed. To share without Gatekeeper warnings, run: ./notarize-macos.sh \"$OUT\""
