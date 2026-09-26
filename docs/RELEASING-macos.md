# Releasing AgentMBX.app (macOS)

`scripts/build-macos-app.sh` builds `build/AgentMBX.app` and `build/AgentMBX-macos.zip`. The app holds:
- `agentmbx-notify`: the main executable. It posts branded notifications through UserNotifications.
- `agentmbx-daemon`: the launcher the launchd agent runs. It execs Node.
- `agentmbx-auth`: the owner-key helper (docs/POLICY.md §6). It keeps the owner's Ed25519 key in the login Keychain and signs only after a Touch ID / password prompt whose text it writes from the bytes it signs.
- `AppIcon.icns`: drawn at build time by `macos/Icon/make-icon.swift`.

Both executables are universal (arm64 + x86_64), with a minimum of macOS 13.

## Signing states

| Build | How | Good for |
|---|---|---|
| Ad-hoc (default) | `scripts/build-macos-app.sh` | the Mac that built it. Gatekeeper blocks a downloaded ad-hoc app. The owner key's Keychain item asks once for access after every update (see below) |
| Stable self-signed | `MBX_CODESIGN_IDENTITY="AgentMBX Code Signing" scripts/build-macos-app.sh` | releases before a Developer ID exists: the Keychain keeps trusting `agentmbx-auth` across updates |
| Developer ID | `MBX_CODESIGN_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/build-macos-app.sh` | distribution, after notarization |

A certificate build signs each executable with the hardened runtime (`--options runtime`), then the bundle; Developer ID builds add a secure timestamp. `agentmbx-auth` is always signed with the identifier `com.agentmbx.auth`. The app needs no entitlements. (`AGENTMBX_CODESIGN_IDENTITY` still works as an older name for `MBX_CODESIGN_IDENTITY`.)

## The owner key and code signatures

The owner key's login-Keychain item (service `com.agentmbx.owner`) is created by `agentmbx-auth`, so its access list trusts that binary by its **designated requirement**:
- **Ad-hoc:** the requirement is the binary's hash (cdhash). Every rebuild or `agentmbx update` that replaces the app changes it, so the next owner signature first shows a Keychain dialog, "agentmbx-auth wants to use your confidential information stored in com.agentmbx.owner". Enter the login password and choose **Always Allow**, once per update. Denying it is treated as "not signed": the command stops with a one-line error and nothing is signed.
- **Certificate (self-signed or Developer ID):** the requirement is `identifier "com.agentmbx.auth" and certificate leaf = H"…"`. Every release signed with the same certificate satisfies it, so updates are silent. Rotating the certificate brings the one-time dialog back.

Only a binary signed with that certificate can read the key without asking, so the certificate's private key must stay secret (a GitHub Actions secret, not the repo).

### Creating the stable self-signed identity (once, by the maintainer)
1. Keychain Access > Certificate Assistant > Create a Certificate: name `AgentMBX Code Signing`, identity type Self Signed Root, certificate type **Code Signing**, validity e.g. 3650 days (override defaults).
2. Export it with its private key as a `.p12` with a strong password.
3. Add three repository secrets: `MBX_CODESIGN_P12` (`base64 -i agentmbx-signing.p12`), `MBX_CODESIGN_P12_PASSWORD`, and optionally `MBX_CODESIGN_IDENTITY` (the certificate's common name; default `AgentMBX Code Signing`).
4. The release workflow imports it into a temporary keychain and exports `MBX_CODESIGN_IDENTITY`/`MBX_CODESIGN_KEYCHAIN` for `scripts/build-macos-app.sh`. Without the secret the workflow falls back to an ad-hoc build.
5. After the first signed release, check the requirement on the downloaded app: `codesign -d -r- AgentMBX.app/Contents/MacOS/agentmbx-auth` should print `identifier "com.agentmbx.auth" and certificate leaf = H"…"`, and it must be the same in the next release.

Not verified yet: codesign on a GitHub runner with an untrusted self-signed certificate. If it refuses the identity, trust the certificate for code signing in the temporary keychain first (`security add-trusted-cert -p codeSign -k "$KC" cert.cer`). Like an ad-hoc build, a self-signed build is not notarized, so Gatekeeper treats a quarantined download the same way; the signature only fixes Keychain trust. Notarization needs Developer ID.

### Machines without Touch ID, and SSH
- `.deviceOwnerAuthentication` falls back to the account password on Macs without Touch ID (Mac mini/Studio without a Touch ID keyboard, VMs).
- Over SSH, or with no GUI login, no prompt can appear. `agentmbx-auth` checks its security session for graphic access and exits 9 at once (`agentmbx-auth check` reports this without prompting). `agentmbx setup` then prints the commands instead of waiting, and `agentmbx owner init` suggests `--backend file`.

List the signing identities on a Mac with `security find-identity -v -p codesigning`. As of 2026-09-26 the build Mac has none, so current builds are ad-hoc.

## Notarize (once a Developer ID certificate exists)

1. Store notary credentials in the keychain, once per Mac. Use an app-specific password from appleid.apple.com:
   ```sh
   xcrun notarytool store-credentials agentmbx-notary --apple-id you@example.com --team-id TEAMID
   ```
2. Build, signed:
   ```sh
   AGENTMBX_CODESIGN_IDENTITY="Developer ID Application: Keaton Hoskins (TEAMID)" scripts/build-macos-app.sh
   ```
3. Submit the zip and wait:
   ```sh
   xcrun notarytool submit build/AgentMBX-macos.zip --keychain-profile agentmbx-notary --wait
   ```
   If it fails, read the log: `xcrun notarytool log <submission-id> --keychain-profile agentmbx-notary`.
4. Staple the ticket to the app, then re-zip so the download carries it:
   ```sh
   xcrun stapler staple build/AgentMBX.app
   (cd build && rm AgentMBX-macos.zip && ditto -c -k --keepParent AgentMBX.app AgentMBX-macos.zip)
   ```
5. Check it:
   ```sh
   spctl -a -vvv -t exec build/AgentMBX.app      # expect: accepted, source=Notarized Developer ID
   codesign -dv --verbose=4 build/AgentMBX.app   # expect: flags=0x10000(runtime), a TeamIdentifier
   ```

## Login Items attribution

`agentmbx daemon install` writes a legacy launchd agent to `~/Library/LaunchAgents/com.agentmbx.daemon.plist`:
- `ProgramArguments[0]` is `~/Applications/AgentMBX.app/Contents/MacOS/agentmbx-daemon`.
- `AssociatedBundleIdentifiers` is `com.agentmbx.app`.

What we measured on macOS 27 with an ad-hoc build, using the Background Task Management database:
- **Launcher inside the app:** the item is recorded as **"AgentMBX"**.
- **Node directly, with only `AssociatedBundleIdentifiers`:** the item is still recorded as **"node"**.

This matches Apple's guidance: Background Task Management attributes a legacy item to the code in `ProgramArguments`. `AssociatedBundleIdentifiers` groups the item under an app only when the app and the executable share a signing Team ID, and ad-hoc signatures have none. With a Developer ID build, both mechanisms point at the same team, and the item should also group under the app's icon in System Settings. This has not been checked on screen yet.

The fully native alternative is `SMAppService.agent(plistName:)` with the plist inside `Contents/Library/LaunchAgents`. It needs the app itself to register the agent, and that registration step would have to be written first. The legacy plist keeps `agentmbx daemon install` working from the CLI on macOS 13+.
