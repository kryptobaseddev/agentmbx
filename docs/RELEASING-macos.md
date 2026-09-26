# Releasing AgentMBX.app (macOS)

`scripts/build-macos-app.sh` builds `build/AgentMBX.app` and `build/AgentMBX-macos.zip`. The app holds:
- `agentmbx-notify`: the main executable. It posts branded notifications through UserNotifications.
- `agentmbx-daemon`: the launcher the launchd agent runs. It execs Node.
- `AppIcon.icns`: drawn at build time by `macos/Icon/make-icon.swift`.

Both executables are universal (arm64 + x86_64), with a minimum of macOS 13.

## Signing states

| Build | How | Good for |
|---|---|---|
| Ad-hoc (default) | `scripts/build-macos-app.sh` | the Mac that built it. Gatekeeper blocks a downloaded ad-hoc app |
| Developer ID | `AGENTMBX_CODESIGN_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/build-macos-app.sh` | distribution, after notarization |

The Developer ID build signs each executable with the hardened runtime (`--options runtime`) and a secure timestamp, then signs the bundle. The app needs no entitlements.

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
