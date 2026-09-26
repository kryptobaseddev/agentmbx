#!/bin/sh
# AgentMBX installer: downloads the single-executable build for this machine, verifies its sha256 against the
# release manifest, and installs it to ~/.local/bin/agentmbx. No sudo, no Node.js required.
#
#   curl -fsSL https://agentmbx.com/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/agentmbx/main/install.sh | sh
#
# Env: AGENTMBX_INSTALL_DIR (default ~/.local/bin)
#      AGENTMBX_MANIFEST_URL (default: the latest GitHub release's manifest.json; assets are fetched next to it)
# Updates after install: agentmbx update (verifies the Ed25519-signed manifest before replacing the binary).
set -eu

MANIFEST_URL="${AGENTMBX_MANIFEST_URL:-https://github.com/kryptobaseddev/agentmbx/releases/latest/download/manifest.json}"
INSTALL_DIR="${AGENTMBX_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "agentmbx-install: $*"; }
die() { printf '%s\n' "agentmbx-install: ERROR: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS $(uname -s) (AgentMBX binaries exist for macOS and Linux)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "unsupported CPU $(uname -m) (AgentMBX binaries exist for arm64 and x64)" ;;
esac
# an x64 shell under Rosetta on Apple silicon: prefer the native build
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
platform="$os-$arch"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "need curl or wget"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "need sha256sum or shasum to verify the download"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t agentmbx)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "fetching $MANIFEST_URL"
fetch "$MANIFEST_URL" "$tmp/manifest.json" || die "could not download the release manifest"

version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/manifest.json" | head -n 1)"
# the asset block for this platform: "darwin-arm64": { "file": ..., "sha256": ..., "size": ... }
block="$(awk -v key="\"$platform\"" 'index($0, key ":") { on = 1; next } on && /}/ { exit } on { print }' "$tmp/manifest.json")"
file="$(printf '%s\n' "$block" | sed -n 's/.*"file":[[:space:]]*"\([^"]*\)".*/\1/p')"
want="$(printf '%s\n' "$block" | sed -n 's/.*"sha256":[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' | tr 'A-F' 'a-f')"
[ -n "$version" ] || die "release manifest has no version"
[ -n "$file" ] || die "release $version has no binary for $platform"
case "$file" in *[!A-Za-z0-9._-]*) die "unexpected asset name in manifest: $file" ;; esac
[ "${#want}" -eq 64 ] || die "release manifest has no valid sha256 for $platform"

base="${MANIFEST_URL%/*}"
say "downloading agentmbx $version for $platform"
fetch "$base/$file" "$tmp/agentmbx" || die "could not download $base/$file"

got="$(sha256 "$tmp/agentmbx")"
if [ "$got" != "$want" ]; then
  die "CHECKSUM MISMATCH for $file
  expected $want
  got      $got
The download is corrupt or was tampered with. Nothing was installed."
fi
say "sha256 verified ($got)"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/agentmbx"
# move into place atomically (a running agentmbx keeps its old copy)
mv -f "$tmp/agentmbx" "$INSTALL_DIR/.agentmbx.new.$$"
mv -f "$INSTALL_DIR/.agentmbx.new.$$" "$INSTALL_DIR/agentmbx"
say "installed $INSTALL_DIR/agentmbx ($("$INSTALL_DIR/agentmbx" version 2>/dev/null || echo "agentmbx $version"))"

# macOS: the AgentMBX.app notifier (branded notifications; Login Items shows "AgentMBX"), same checksum rules
if [ "$os" = darwin ]; then
  ablock="$(awk -v key='"macos-app"' 'index($0, key ":") { on = 1; next } on && /}/ { exit } on { print }' "$tmp/manifest.json")"
  afile="$(printf '%s\n' "$ablock" | sed -n 's/.*"file":[[:space:]]*"\([^"]*\)".*/\1/p')"
  awant="$(printf '%s\n' "$ablock" | sed -n 's/.*"sha256":[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' | tr 'A-F' 'a-f')"
  if [ -n "$afile" ] && [ "${#awant}" -eq 64 ]; then
    case "$afile" in *[!A-Za-z0-9._-]*) die "unexpected asset name in manifest: $afile" ;; esac
    fetch "$base/$afile" "$tmp/app.zip" || die "could not download $base/$afile"
    [ "$(sha256 "$tmp/app.zip")" = "$awant" ] || die "CHECKSUM MISMATCH for $afile. The app was not installed."
    mkdir -p "$HOME/Applications" && rm -rf "$HOME/Applications/AgentMBX.app"
    ditto -x -k "$tmp/app.zip" "$HOME/Applications" && say "installed $HOME/Applications/AgentMBX.app (notifications)"
  fi
fi

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ;;
  *) say "WARNING: $INSTALL_DIR is not on your PATH. Add it, e.g.:"
     say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile   (or ~/.zshrc / ~/.bashrc)" ;;
esac

say "next step: agentmbx setup"
