#!/usr/bin/env bash
# Builds build/AgentMBX.app (branded notifier + launchd launcher + Touch ID owner-key helper) and build/AgentMBX-macos.zip.
#   scripts/build-macos-app.sh                                   # ad-hoc signed (works on this Mac)
#   MBX_CODESIGN_IDENTITY="AgentMBX Code Signing" scripts/build-macos-app.sh            # stable self-signed identity
#   MBX_CODESIGN_IDENTITY="Developer ID Application: …" scripts/build-macos-app.sh      # Developer ID (notarizable)
# (AGENTMBX_CODESIGN_IDENTITY is accepted as an older name; MBX_CODESIGN_KEYCHAIN picks the keychain holding the identity.)
# Why a stable identity matters: the owner key's Keychain item trusts agentmbx-auth by its code signature. An ad-hoc
# signature is only a hash of the binary, so every rebuilt or updated app asks "allow access?" once; a certificate
# signature keeps the same designated requirement across releases. Details: docs/RELEASING-macos.md
set -euo pipefail
IDENTITY="${MBX_CODESIGN_IDENTITY:-${AGENTMBX_CODESIGN_IDENTITY:-}}"
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
compile "$APP/Contents/MacOS/agentmbx-auth" "$ROOT/macos/Auth/main.swift"

echo "==> icon"
swiftc -O "$ROOT/macos/Icon/make-icon.swift" -o "$TMP/make-icon"
"$TMP/make-icon" "$TMP/AppIcon.iconset" >/dev/null
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

sed "s/__VERSION__/$VERSION/g" "$ROOT/macos/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> signing"
if [[ -n "$IDENTITY" ]]; then
  # certificate identity: hardened runtime, inner executables first, then the bundle. A secure timestamp needs an
  # Apple-issued certificate, so only Developer ID builds ask for one.
  sign=(codesign --force --options runtime --sign "$IDENTITY")
  [[ "$IDENTITY" == "Developer ID Application"* ]] && sign+=(--timestamp)
  [[ -n "${MBX_CODESIGN_KEYCHAIN:-}" ]] && sign+=(--keychain "$MBX_CODESIGN_KEYCHAIN")
  "${sign[@]}" "$APP/Contents/MacOS/agentmbx-daemon"
  # the owner key's Keychain item trusts this helper by its designated requirement (identifier + certificate):
  # keep the identifier fixed so every release signed with the same certificate is trusted without a dialog
  "${sign[@]}" --identifier com.agentmbx.auth "$APP/Contents/MacOS/agentmbx-auth"
  "${sign[@]}" "$APP"
  echo "signed with: $IDENTITY"
  codesign -d -r- "$APP/Contents/MacOS/agentmbx-auth" 2>&1 | sed -n 's/^designated => /    agentmbx-auth designated requirement: /p'
else
  codesign --force --sign - "$APP/Contents/MacOS/agentmbx-daemon"
  codesign --force --deep --sign - "$APP"
  echo "ad-hoc signed (set MBX_CODESIGN_IDENTITY for a stable signature; ad-hoc updates ask once for Keychain access)"
fi
codesign --verify --deep --strict "$APP"

(cd "$OUT" && ditto -c -k --keepParent AgentMBX.app AgentMBX-macos.zip)
rm -rf "$TMP"
echo "==> $APP"
echo "==> $OUT/AgentMBX-macos.zip"
lipo -archs "$APP/Contents/MacOS/agentmbx-notify" | sed 's/^/    archs: /'
