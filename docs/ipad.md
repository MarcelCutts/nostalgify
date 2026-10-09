# Nostalgify on iPad

The native iPad app uses the same Webamp skins as the desktop app. Spotify plays
through the installed Spotify app; imported, unprotected audio files play through
Nostalgify's native audio engine. The large touch controls accompany the original
skin controls. SoundCloud is currently available in the desktop app only.

This is a personal development build. Automated simulator checks are useful but
do not establish that Spotify authorization or long background sessions work on
a physical iPad. Follow [the device checklist](ipad-testing.md) before relying on
it for listening.

## Build and install with Xcode

You need a Mac with Xcode 26 or newer, its iOS platform support, Node.js 22.12 or
newer (Node 24 LTS recommended), an Apple account, and an iPad running iPadOS 17 or
newer. The committed project targets iPad; test on your actual iPadOS version.

From the repository root:

```sh
npm ci
npm run ipad:sync
npm run ipad:open
```

`ipad:sync` builds the web interface and copies it into the native project. Run it
again after web changes. Swift changes are built directly by Xcode. Keep the
Xcode project in Git; generated web assets, signing settings and build output
are ignored.

In Xcode:

1. Select the **App** target and open **Signing & Capabilities**.
2. Select your personal or development team and enable automatic signing. The
   default bundle identifier is `dev.nostalgify.ipad`; use a unique identifier if
   your account requires it. Change the app ID in
   `apps/ipad/capacitor.config.json` too if you intentionally change it.
3. Connect the iPad, trust the Mac, enable Developer Mode if prompted, and select
   the device as the run destination.
4. Build and run. A free Personal Team can install for development, with Apple's
   provisioning limits and periodic renewal. TestFlight requires paid Apple
   Developer Program membership and an App Store Connect app record.

For TestFlight, set a unique bundle ID, team, version and increasing build number,
choose a generic iOS device destination, then **Product → Archive → Distribute
App → App Store Connect**. Configure internal testing in App Store Connect after
the build processes. This repository does not contain a signing certificate,
provisioning profile, or automated upload credentials.

## Connect Spotify

1. Install Spotify on the iPad and sign in. Use Premium for on-demand playback;
   Spotify documents restricted shuffle playback for Free accounts. Your account
   must also be allowed by the developer application's current access mode.
2. Create an application in the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and enable its iOS SDK use. Register this redirect URI **exactly**:

   ```text
   nostalgify://spotify-login-callback
   ```

3. Register your iOS bundle identifier in the Spotify application settings where
   requested. Follow the dashboard's current account/development-mode limits.
4. Copy the application's **Client ID** into Nostalgify's settings and save it.
   The Client ID is public. Never enter or embed a client secret in this app.
5. Tap **Connect Spotify**, finish authorization in Spotify, then return to
   Nostalgify. An app switch can start or resume Spotify playback.
6. Add a full `open.spotify.com` track, album, artist, playlist or episode link
   to the shelf and play it. Shortened links and Liked Songs are not supported
   in this first iPad version.

The authorization token is stored in the iOS Keychain. **Forget Spotify** removes saved
authorization; **Disconnect** closes the control connection while retaining it. Reconnect explicitly if Spotify has been closed or authorization
expires. Opening Nostalgify does not silently launch Spotify to authorize again.
Spotify owns its own queue, audio session, background playback and lock-screen
controls. The Spotify SDK does not expose device volume control; use the iPad's
volume buttons or Control Center.

## Import local audio and skins

Use **Import audio** to select unprotected files from Files. Download cloud-backed
files first if a provider cannot supply them immediately. Nostalgify copies audio
into its own app storage, so it can play without maintaining access to the
original location. Common AAC/M4A, MP3 and WAV files are good first checks; actual
support depends on the file's codec and iPadOS. Protected subscription downloads
are not ordinary local audio files.

The native player owns local queue progression, seeking, interruptions and
lock-screen controls. Switching sources pauses the current source before the
next starts. Removing a file deletes Nostalgify's imported copy, not the original
in Files. Uninstalling the app deletes its imported library.

Use the skin import control for a classic Winamp 2 `.wsz` or `.zip` file from the
[Winamp Skin Museum](https://skins.webamp.org/). Skin bytes and the selected skin
are saved on the device. Do not unzip the skin. The equalizer is decorative; the
iPad version does not create synthetic audio for the visualizer.

## Diagnose a problem

Use the app's diagnostics action to export bounded native events. Command request
IDs connect a control action with native completion, duration and failure codes.
The logs omit authorization tokens, callback URLs, filenames and track metadata.
Xcode's console and macOS Console also show native events under the
`dev.nostalgify.ipad` subsystem, including while JavaScript is suspended.

When reporting a failure, include what you tapped, expected and observed
behaviour, app/build and iPadOS versions, and whether Spotify or local playback
was selected. Include whether it happened after locking, changing audio route or
returning from Spotify. Review the exported file before sharing it.

For engineering checks, run:

```sh
npm test
npm run build
npm run ipad:sync
npm run check
npm run test:ipad:browser
npm run ipad:simulator       # macOS/Xcode only
```

Browser tests require Playwright Chromium (`npx playwright install chromium`).
The browser adapter is explicitly a demo; it does not authenticate Spotify or
play native audio. See [testing and observability](ipad-testing.md) and the
[implementation plan](ipad-plan.md) for the validation gates and remaining
physical-device checks.

## Why this repository and native host

The source comparison informed the native choice:

| Source | Browser route | Native route and decision |
| --- | --- | --- |
| Spotify | The Web Playback SDK supports iOS, but playback transfer still requires user interaction. A web controller through the Web API is another option, with separate device discovery and authorization. | App Remote delegates audio to Spotify and provides its documented app-switch/lifecycle model. Selected for the first build. |
| SoundCloud | The official widget is the simplest playback route, but its controls and presentation are not the existing skin engine. A custom API player needs token management. | An API backend plus native streaming player could reuse the current desktop concepts. Deferred: SoundCloud currently requires confidential-client credentials, including for token exchange; shipping a secret in the iPad app is unsuitable. |
| Local files | Browser-selected files can play in a foreground web experience, but library durability and background queue behaviour need separate device validation. | Copying imports to app storage and letting AVPlayer own playback gives explicit persistence, audio-session and lock-screen integration. Selected alongside Spotify. |

These are engineering tradeoffs, not a claim that Safari cannot play music.
Spotify documents its [current iOS Web Playback SDK limitation](https://developer.spotify.com/documentation/web-playback-sdk#troubleshooting);
SoundCloud documents [server-side authorization and client-secret requirements](https://developers.soundcloud.com/docs/api/guide#authentication).
The native choice fits the requested personal installation and local-file
background-playback goals while retaining the existing skin renderer.

| Approach | What works well | Limitation for this project |
| --- | --- | --- |
| Safari or installed web app | Fastest way to reuse the player and skins | Browser and service SDK restrictions do not provide the same native Spotify handoff, file library and background lifecycle |
| Capacitor with native playback | Keeps the existing skin engine while Swift owns Spotify integration and local audio | Requires maintaining and testing both the web/native bridge and Xcode project |
| Entirely SwiftUI | Native layout and lifecycle throughout | Recreating arbitrary classic Winamp skins and the existing interface is a substantial separate renderer project |
| Separate native repository | Independent access and release governance | Duplicates the skin UI or requires publishing/versioning a shared package for every cross-platform change |
| Small npm workspace (selected) | One change can update shared UI and both host adapters atomically | CI must enforce boundaries and validate both apps |

The shared package contains presentation and an explicit host contract. Electron,
AppleScript and SoundCloud playback stay in `apps/desktop`; native Swift code and
Capacitor stay in `apps/ipad`. Desktop and iPad have their own versions and
release paths. The move preserves the desktop application name and user-data
location. There is no need for a larger monorepo build system at this size.

## Primary references

- [Spotify iOS SDK overview and requirements](https://developer.spotify.com/documentation/ios)
- [Spotify iOS getting started](https://developer.spotify.com/documentation/ios/getting-started)
- [Spotify app lifecycle](https://developer.spotify.com/documentation/ios/concepts/application-lifecycle)
- [Spotify iOS SDK source and releases](https://github.com/spotify/ios-sdk)
- [Capacitor iOS requirements](https://capacitorjs.com/docs/ios)
- [Capacitor workflow](https://capacitorjs.com/docs/basics/workflow)
- [Apple: running your app on a device](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device)
- [Apple: TestFlight](https://developer.apple.com/testflight/)
- [Apple: testing a release build](https://developer.apple.com/documentation/xcode/testing-a-release-build)

Research and dependency verification: October 2026. The implementation pins
Capacitor 8.5.3 and SpotifyiOS 5.0.1; consult the installed SDK and developer
dashboard when service requirements change.
