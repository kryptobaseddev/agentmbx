#!/usr/bin/env bash
# One-time, run by the maintainer (not by an agent): create the stable self-signed code-signing identity that release
# builds sign AgentMBX.app with, so the Keychain keeps trusting agentmbx-auth across updates (docs/RELEASING-macos.md).
#
#   scripts/make-codesign-identity.sh            # create, test, upload to GitHub secrets, back up to your Keychain
#   scripts/make-codesign-identity.sh --dry-run  # create and test only; nothing uploaded or stored
#
# What it does:
#   1. Creates an RSA-3072 key and a self-signed certificate "AgentMBX Code Signing" (codeSigning, 10 years), in a private
#      temp dir.
#   2. Proves it signs: imports it into a throwaway keychain (like CI does) and codesigns a test binary with it.
#   3. Stores it as the repo secrets MBX_CODESIGN_P12 (base64 .p12), MBX_CODESIGN_P12_PASSWORD and MBX_CODESIGN_IDENTITY
#      (gh reads them from files, so nothing appears in argv or your shell history).
#   4. Backs up the .p12 and its password in your login Keychain (items AGENTMBX_CODESIGN_P12 / _PASSWORD). Nothing
#      stays on disk.
# Re-running it replaces the identity. Do that only on purpose: installed apps then ask once more for Keychain access.
set -euo pipefail
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
NAME="AgentMBX Code Signing"
OPENSSL=/usr/bin/openssl   # macOS LibreSSL: writes .p12 files the macOS `security` tool can import
cd "$(dirname "$0")/.."
command -v gh >/dev/null || { echo "needs the GitHub CLI (brew install gh; gh auth login)"; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

T="$(mktemp -d)"; chmod 700 "$T"
KC="$T/test.keychain-db"; KCPASS="$($OPENSSL rand -hex 16)"
cleanup() { security delete-keychain "$KC" 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT

cat > "$T/cs.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$NAME
O=AgentMBX
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
EOF
umask 077
$OPENSSL req -x509 -newkey rsa:3072 -nodes -keyout "$T/key.pem" -out "$T/cert.pem" -days 3650 -config "$T/cs.cnf" 2>/dev/null
$OPENSSL rand -hex 24 > "$T/pass"
$OPENSSL pkcs12 -export -inkey "$T/key.pem" -in "$T/cert.pem" -name "$NAME" -out "$T/cs.p12" -passout "file:$T/pass"
rm -f "$T/key.pem"
base64 -i "$T/cs.p12" -o "$T/cs.p12.b64"
echo "created: $($OPENSSL x509 -in "$T/cert.pem" -noout -subject) (valid until $($OPENSSL x509 -in "$T/cert.pem" -noout -enddate | cut -d= -f2))"
echo "certificate SHA-256: $($OPENSSL x509 -in "$T/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"

# 2. prove it signs, the same way the release workflow will
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings -lut 600 "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security import "$T/cs.p12" -k "$KC" -P "$(cat "$T/pass")" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC" >/dev/null
cp /bin/echo "$T/probe"
codesign --force --sign "$NAME" --keychain "$KC" "$T/probe"
codesign --verify "$T/probe"
echo "test signature OK: $(codesign -d -r- "$T/probe" 2>&1 | sed -n 's/^designated => //p')"

if [[ $DRY == 1 ]]; then echo "dry run: nothing uploaded or stored"; exit 0; fi

# 3. GitHub secrets (values read from files/stdin)
gh secret set MBX_CODESIGN_P12 --repo "$REPO" < "$T/cs.p12.b64"
gh secret set MBX_CODESIGN_P12_PASSWORD --repo "$REPO" < "$T/pass"
printf '%s' "$NAME" | gh secret set MBX_CODESIGN_IDENTITY --repo "$REPO"
echo "GitHub secrets set on $REPO: MBX_CODESIGN_P12, MBX_CODESIGN_P12_PASSWORD, MBX_CODESIGN_IDENTITY"

# 4. backup in the login Keychain (to recover or rotate later without re-trusting every install)
security add-generic-password -U -a agentmbx -s AGENTMBX_CODESIGN_P12 -w "$(cat "$T/cs.p12.b64")"
security add-generic-password -U -a agentmbx -s AGENTMBX_CODESIGN_P12_PASSWORD -w "$(cat "$T/pass")"
echo "backup stored in your login Keychain: AGENTMBX_CODESIGN_P12, AGENTMBX_CODESIGN_P12_PASSWORD"
echo "done. The next tagged release signs AgentMBX.app with \"$NAME\"."
