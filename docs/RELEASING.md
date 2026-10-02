# Releasing AgentMBX

A release is a git tag `vX.Y.Z`. Pushing it runs `.github/workflows/release.yml`, which builds a single-executable
binary for each platform, signs a manifest listing their checksums, and publishes a GitHub release. Installs made with
`install.sh` read that manifest; `agentmbx update` trusts it only if its Ed25519 signature verifies against the public
key compiled into the binary.

## Cutting a release

1. Make sure `main` is green (`.github/workflows/ci.yml`: tests, typecheck, `npm run check-dist`, SEA build + smoke test).
2. Bump the version and rebuild `dist/`:
   ```sh
   npm version 0.2.0 --no-git-tag-version     # edits package.json + package-lock.json
   npm run build                               # dist/ is committed; npm installs run it
   git commit -am "release: v0.2.0"
   ```
   In the same commit, date the `CHANGELOG.md` section and update `README.md`: the status line, the roadmap rows and the
   tag in the npm source-install example (`archive/refs/tags/vX.Y.Z.tar.gz`).
3. Tag and push:
   ```sh
   git tag v0.2.0 && git push origin main v0.2.0
   ```
   A tag with a hyphen (`v0.3.0-rc.1`) becomes a GitHub pre-release and an npm `next` tag. Note that `releases/latest`
   (which `install.sh` and `agentmbx update` read) skips pre-releases.

The tag must match `package.json`; the workflow refuses to build otherwise.

## What the workflow does

| Job | Runs on | Does |
|-----|---------|------|
| `build` | `macos-14` (darwin-arm64), `macos-15-intel` (darwin-x64), `ubuntu-24.04` (linux-x64), `ubuntu-24.04-arm` (linux-arm64) | `npm ci`, `npm test`, typecheck, `node scripts/build-sea.mjs`, `node scripts/smoke-sea.mjs` (init, send, inbox, MCP initialize over stdio), upload `agentmbx-<platform>` |
| `release` | ubuntu | `scripts/make-manifest.mjs` writes `SHA256SUMS` and `manifest.json`; `scripts/sign-manifest.mjs` writes `manifest.json.sig` with the `RELEASE_SIGNING_KEY` secret; `gh release create` uploads the four binaries, `SHA256SUMS`, `manifest.json`, `manifest.json.sig` and `install.sh` |
| `npm` | ubuntu | `npm publish --provenance`, only when the `NPM_TOKEN` secret exists |

`manifest.json`:

```json
{ "name": "agentmbx", "version": "0.2.0", "released_at": "2026-09-26T12:00:00.000Z",
  "assets": { "darwin-arm64": { "file": "agentmbx-darwin-arm64", "sha256": "…", "size": 122738992 }, "…": {} } }
```

`manifest.json.sig` is the base64 Ed25519 signature over the exact bytes of `manifest.json`.

### The single executable (Node SEA)

`scripts/build-sea.mjs` bundles `src/cli.ts` and its dependencies into one CommonJS file with esbuild (the version is
baked in as `__AGENTMBX_VERSION__`), turns it into a SEA blob with `node --experimental-sea-config`, copies the Node
binary that runs the script, and injects the blob with postject. On macOS it removes the Node signature first and
signs ad hoc afterwards; set `AGENTMBX_CODESIGN_IDENTITY` to sign with a Developer ID (hardened runtime) instead.
Build locally with `node scripts/build-sea.mjs`; output lands in `build/` (git-ignored). Binaries are about 120 MB,
most of it the Node runtime.

## Release signing key

- **Public key**: pinned in `src/release-key.ts` (`RELEASE_PUBLIC_KEY`), base64 raw 32-byte Ed25519, the same raw format
  as `src/crypto.ts`. While it still holds the placeholder, `agentmbx update` fails closed with an explanation, and
  `sign-manifest.mjs` refuses to sign, so a release cannot ship with a key installs will not accept.
- **Private key**: the GitHub Actions secret `RELEASE_SIGNING_KEY` (base64 raw 32 bytes). Keep an offline copy in the
  owner's password manager. Nothing else needs it.

Generate a key pair:

```sh
node scripts/sign-manifest.mjs --keygen
#   public  (src/release-key.ts):          <paste into RELEASE_PUBLIC_KEY>
#   private (secret RELEASE_SIGNING_KEY):   <gh secret set RELEASE_SIGNING_KEY>
```

`sign-manifest.mjs` checks that the secret's public half equals the pinned key before it signs.

### Rotating the key

Installed binaries only trust the key they were built with, so rotation takes two releases:

1. `node scripts/sign-manifest.mjs --keygen`. Put the new public key in `src/release-key.ts`. Leave the
   `RELEASE_SIGNING_KEY` secret on the **old** private key and set the repository variable
   `RELEASE_ROTATION_PREVIOUS_KEY` to the **old** public key (`gh variable set RELEASE_ROTATION_PREVIOUS_KEY`).
   Cut release N: it is signed with the old key, so existing installs accept it, and its binaries pin the new key.
2. `gh secret set RELEASE_SIGNING_KEY` to the new private key and `gh variable delete RELEASE_ROTATION_PREVIOUS_KEY`.
   Release N+1 onward is signed with the new key.

Installs older than release N cannot verify releases signed with the new key; they reinstall with `install.sh`.

If the private key leaks, rotate immediately, and tell users to reinstall with `install.sh` rather than `agentmbx
update`, because an attacker holding the old key can sign manifests that old binaries accept.

## What each check protects

- `install.sh` verifies the sha256 from `manifest.json`, which it fetches over HTTPS from GitHub. It does not check the
  Ed25519 signature (a POSIX shell has no portable Ed25519), so a first install trusts GitHub's TLS and the repository.
- `agentmbx update` verifies the manifest signature against the pinned key, then the sha256 and size of the download,
  writes it next to the running binary and renames it over the binary atomically. A daemon service that runs that same
  binary is restarted (`launchctl kickstart -k` / `systemctl --user restart agentmbx`).
- npm and source installs are not replaced; `agentmbx update` prints `npm i -g agentmbx@latest` or `git pull`.

## Update check in the daemon

The daemon checks at most once every 24 hours (`kv` keys `update.checked_at`, `update.latest`, `update.notified`) and
shows one desktop notification per new version. `MBX_NO_UPDATE_CHECK=1` turns it off; `MBX_UPDATE_URL` points both the
daemon and `agentmbx update` at a different release directory (a mirror or a local test server).
