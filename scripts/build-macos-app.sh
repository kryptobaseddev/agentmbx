#!/usr/bin/env bash
# Builds build/AgentMBX.app (branded notifier + launchd launcher) and build/AgentMBX-macos.zip.
#   scripts/build-macos-app.sh                                   # ad-hoc signed (works on this Mac)
#   AGENTMBX_CODESIGN_IDENTITY="Developer ID Application: …" scripts/build-macos-app.sh   # hardened runtime
# Notarization for release builds: docs/RELEASING-macos.md
set -euo pipefail
[[ "$(uname)" == Darwin ]] || { echo "build-macos-app: macOS only" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build"
APP="$OUT/AgentMBX.app"
TMP="$OUT/.work"
MIN=13.0
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.0.0)"

rm -rf "$APP" "$TMP" "$OUT/AgentMBX-macos.zip"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

# universal binary when both slices compile, arm64/x86_64-only otherwise
compile() { # <output> <swift files…>
  local out="$1"; shift
  local slices=()
  for arch in arm64 x86_64; do
    if swiftc -O -target "$arch-apple-macos$MIN" "$@" -o "$TMP/$(basename "$out").$arch" 2>"$TMP/$arch.log"; then
      slices+=("$TMP/$(basename "$out").$arch")
    else
      echo "note: $arch slice of $(basename "$out") did not build (see $TMP/$arch.log)" >&2
    fi
  done
  [[ ${#slices[@]} -gt 0 ]] || { cat "$TMP"/*.log >&2; exit 1; }
  lipo -create "${slices[@]}" -output "$out"
}

echo "==> compiling"
compile "$APP/Contents/MacOS/agentmbx-notify" "$ROOT/macos/Notifier/main.swift"
compile "$APP/Contents/MacOS/agentmbx-daemon" "$ROOT/macos/Launcher/main.swift"

echo "==> icon"
swiftc -O "$ROOT/macos/Icon/make-icon.swift" -o "$TMP/make-icon"
"$TMP/make-icon" "$TMP/AppIcon.iconset" >/dev/null
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

sed "s/__VERSION__/$VERSION/g" "$ROOT/macos/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> signing"
if [[ -n "${AGENTMBX_CODESIGN_IDENTITY:-}" ]]; then
  # Developer ID: hardened runtime + secure timestamp, inner executables first, then the bundle
  sign=(codesign --force --options runtime --timestamp --sign "$AGENTMBX_CODESIGN_IDENTITY")
  "${sign[@]}" "$APP/Contents/MacOS/agentmbx-daemon"
  "${sign[@]}" "$APP"
  echo "signed with: $AGENTMBX_CODESIGN_IDENTITY"
else
  codesign --force --sign - "$APP/Contents/MacOS/agentmbx-daemon"
  codesign --force --deep --sign - "$APP"
  echo "ad-hoc signed (set AGENTMBX_CODESIGN_IDENTITY for a Developer ID signature)"
fi
codesign --verify --deep --strict "$APP"

(cd "$OUT" && ditto -c -k --keepParent AgentMBX.app AgentMBX-macos.zip)
rm -rf "$TMP"
echo "==> $APP"
echo "==> $OUT/AgentMBX-macos.zip"
lipo -archs "$APP/Contents/MacOS/agentmbx-notify" | sed 's/^/    archs: /'
