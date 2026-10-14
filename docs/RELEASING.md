# Releasing AgentMBX

The standard installation is `npm install --global agentmbx@latest` (Node ≥24).
The npm registry's `latest` dist-tag defines the current published stable package;
it can lag a merged version bump, Git tag, or GitHub binary release.

A release tag `vX.Y.Z` starts `.github/workflows/release.yml`: platform builds,
signed GitHub binary assets, then npm trusted publication and an installed-package
smoke check. Those are separate outcomes. Installs made with
`install.sh` read that manifest; `agentmbx update` trusts it only if its Ed25519 signature verifies against the public
key compiled into the binary.

## Cutting a release

1. Use the repository's approved release branch/PR workflow and confirm the exact
   merged source commit. Fetch first; a failed pull mustn't leave a tag on a stale
   local commit. Check the relevant CI and platform-sensitive validation before
   release; release CI runs its declared product checks.
2. Bump `package.json`, `package-lock.json`, and the bundled Claude plugin version
   together; rebuild committed `dist/` if source changed. Date the changelog
   section and include the owning CLEO task ID in the release commit.
3. Keep README's npm badge and `agentmbx@latest` installation commands dynamic.
   Update roadmap claims only from task/source/release evidence; don't replace the
   badge with a hardcoded “current” source version or a GitHub archive install pin.
4. After the release PR is merged, verify the remote main SHA and the local tag's
   target are the intended commit before the authorized tag push:

   ```sh
   git fetch origin
   git rev-parse origin/main
   git show --no-patch --format=fuller <intended-commit>
   git rev-list -n 1 <release-tag>
   ```

   The release tag must match `package.json` at that commit. Release publication
   requires the owner's normal authorization; these commands don't grant it.
5. Inspect all release jobs, then verify the registry's version, source commit,
   and immutable artifact metadata:

   ```sh
   npm view agentmbx@latest version gitHead dist.integrity dist.tarball --json
   npm view agentmbx@<released-version> version gitHead dist.integrity --json
   ```

   A successful tag push or GitHub release isn't npm publication. Registry
   metadata can precede CDN tarball availability; wait for the artifact and
   installed-package smoke result. Don't republish a version or treat a rerun's
   “already published” message as proof that the current tag's bytes were shipped.
6. Refresh the cloud site's generated reference from the **published** artifact,
   using its release resolver `--release latest` in the cloud repository.
   Retain the resolved npm version, `gitHead`, artifact integrity, and generated
   snapshot label. The page's install command remains `agentmbx@latest`; a
   historical reference snapshot mustn't pretend to be the current dist-tag.

A tag containing a hyphen is a GitHub prerelease and publishes to npm `next`.
GitHub `releases/latest` skips prereleases; npm `latest` and `next` are separate
tags. Query the appropriate tag before announcing its publication.

## What the workflow does

| Job | Runs on | Does |
|-----|---------|------|
| `build` | `macos-14` (darwin-arm64), `macos-15-intel` (darwin-x64), `ubuntu-24.04` (linux-x64), `ubuntu-24.04-arm` (linux-arm64) | `npm ci`, `npm test`, typecheck, `node scripts/build-sea.mjs`, `node scripts/smoke-sea.mjs` (init, send, inbox, MCP initialize over stdio), upload `agentmbx-<platform>` |
| `release` | ubuntu | `scripts/make-manifest.mjs` writes `SHA256SUMS` and `manifest.json`; `scripts/sign-manifest.mjs` writes `manifest.json.sig` with the `RELEASE_SIGNING_KEY` secret; `gh release create` uploads the four binaries, `SHA256SUMS`, `manifest.json`, `manifest.json.sig` and `install.sh` |
| `npm` | ubuntu | `npm publish --provenance --access public --tag latest` (or `next` for prereleases) through GitHub OIDC; polls exact-version metadata and CDN tarball availability, installs that exact published version in an isolated home/prefix, and checks `agentmbx --version` |

npm publishing uses trusted publishing: the `agentmbx` package on npmjs.com trusts this repository's
`release.yml` (Settings → Trusted Publisher → GitHub Actions, owner `kryptobaseddev`, repository `agentmbx`,
workflow `release.yml`), and its publishing access is "require two-factor authentication and disallow tokens".
There is no npm secret. Renaming `release.yml` breaks the trust binding. A version can never be published twice:
if `npm view` lags after a publish, wait; never re-publish. If an existing registry version has a different `gitHead` from the intended tag, preserve both sources and investigate the release mismatch; a new tag on that version doesn't replace its published bytes.

Pull requests run CI on Linux only. macOS runs on every push to `main` and in the release build; before tagging,
run the macOS-sensitive suites on a Mac.

Illustrative binary `manifest.json` (example values, not a current release pin):

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
- npm and source installs are not replaced; `agentmbx update` prints `npm i -g agentmbx@latest` or the source update command. Its check still consults the binary release manifest; npm users use `npm view agentmbx@latest version` and `npm install --global agentmbx@latest` for the package release.

## Update check in the daemon

The daemon checks at most once every 24 hours (`kv` keys `update.checked_at`, `update.latest`, `update.notified`) and
shows one desktop notification per new version. `MBX_NO_UPDATE_CHECK=1` turns it off; `MBX_UPDATE_URL` points both the
daemon and `agentmbx update` at a different release directory (a mirror or a local test server).
