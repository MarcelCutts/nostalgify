# iPad validation

The iPad target uses the shared player UI, Spotify App Remote, and a native local-file player. The desktop target keeps its own Electron services. A successful simulator build verifies integration and native code; Spotify playback, audible output, background behavior, and routing still require a physical iPad.

## Repeatable automated checks

From the repository root, with Node 24:

```sh
npm ci
npm test
npm run build
npm run ipad:sync
npm run check
```

`npm test` runs the desktop, shared-contract, and iPad JavaScript tests. The build produces separate desktop staging and iPad web assets. `ipad:sync` copies the latter into the committed Capacitor project; it requires no Spotify account, client secret, signing certificate, or connected iPad. The browser smoke test runs the bundled UI against its test adapter:

```sh
npx playwright install --with-deps chromium
npm run test:ipad:browser
```

The portable checks inspect the actual esbuild input/import graphs and packaging output. They reject Electron/Node imports in either renderer, SoundCloud/HLS or desktop implementation imports in the iPad renderer, Capacitor/iPad imports in the desktop renderer, and iOS project files accidentally included in desktop staging. The native structural check verifies Swift build-phase membership, the shared XCTest scheme, pinned packages, iPad targeting, callback registration, background audio configuration, and bundled rather than remotely hosted web assets. These checks do not compile Swift.

On a Mac with Xcode and an installed iPad simulator runtime:

```sh
bash scripts/check-ios-simulator.sh
```

This resolves Swift packages, builds the actual application for iOS Simulator with signing disabled, creates a disposable iPad simulator, runs the `App` scheme's native tests, installs and launches the application, and captures a screenshot. A Debug-only `--native-local-selfcheck` launch also imports two generated WAV files into an isolated temporary library and verifies distinct identities, native queue advancement and persistence without JavaScript timers. CI requires its structured `native-selfcheck.json` result to pass; it does not infer success merely from launching the process. The simulator is removed afterward. Results are written under `out/ios-ci/run.*`: package/build/test logs, `.xcresult` bundles, simulator details, the self-check result, launch logs and a screenshot. This does not assert that every on-screen control works.

CI runs these checks on every push and pull request, with an additional manual dispatch option. The Linux `test` job is preserved; the macOS job uses `macos-26` and explicitly selects Xcode 26.6. This combination is listed in GitHub's [macOS 26 runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md). Missing tooling fails visibly instead of silently skipping native validation. Diagnostic artifacts are retained for seven days, including on failure. Use **CI / Required checks** as the combined required status check; it cannot pass when either platform job fails or is skipped. There are no path filters that leave documentation-only changes waiting for a missing required check.

## What each environment establishes

| Environment | Evidence it can provide | What it does not establish |
| --- | --- | --- |
| Node tests and build checks | Provider/contract behavior, isolated bundles, packaging boundaries, predictable errors with test doubles | Apple SDK compilation or device playback |
| Xcode simulator build and XCTest | Swift compilation, Spotify SDK linking, native unit tests, plugin/target integration | Spotify App Remote communication with the real Spotify iPad app |
| Simulator launch, native self-check and screenshot | Bundled UI starts; native WAV import, queue progression and persistence operate without live credentials | Correct audible output, long background sessions, Bluetooth/AirPlay behavior |
| Physical iPad | Real authentication/app switching, audible playback, Files imports, lock screen, interruptions and touch interaction | Compatibility with untested OS/device versions |

The iPad build must not load a Spotify client secret or reuse desktop SoundCloud credentials. Physical Spotify tests use an individually configured Spotify application and an account permitted by that application's current access mode. Keep credentials and private callback URLs out of test reports and shared logs.

## Physical iPad test matrix

Record the application commit, iPad model, iPadOS version, Spotify version, account eligibility, network state and output route for each session. Test at least one supported older iPadOS version as well as the current release when claiming support for both. Use small, owned or appropriately licensed audio samples; include two short tracks to exercise automatic advancement.

| Scenario | Procedure | Required result |
| --- | --- | --- |
| Fresh installation and cold launch | Launch before entering Spotify settings and with no local library | Shared player is visible; setup and empty-library states are actionable; no indefinite loading or crash |
| Spotify not installed | Attempt a connection with Spotify removed | Explain that Spotify is required and offer a usable next step; local files remain usable |
| Invalid client ID or callback | Supply an invalid ID or mismatched redirect, attempt authorization, then cancel | Failure/cancellation is visible; no false connected state; settings can be corrected and retried |
| Valid Spotify authorization | Connect, approve in Spotify, return through the registered callback | App Remote connects; track state reflects Spotify; transport controls act on that player |
| App switching and reconnection | Switch to Spotify, change tracks there, return; repeat after a long background interval | State is refreshed; disconnection/reconnection is explicit; stale callbacks cannot overwrite a newer provider selection |
| Session expiry or revoked access | Revoke authorization or wait for expiry, then retry | Reauthorization is recoverable; tokens are not logged or embedded in saved diagnostics |
| Spotify playback restrictions | Try an unavailable track/context or an account with limited playback capability | Report the SDK/service result; do not claim playback succeeded or enable unavailable controls |
| Provider switching | While playing Spotify, switch to local files; then reverse | Source and controls agree with the audible player; no unintended overlapping local audio or stale metadata |
| Import from Files | Select multiple supported audio files from On My iPad and iCloud Drive; cancel once | Import reports success/failure accurately, cancellation is harmless, and imported files appear once in the intended library |
| Unsupported, corrupt or unavailable file | Import a non-audio/corrupt file and a cloud file that cannot be downloaded | Show a recoverable per-file failure; retain already imported valid tracks; do not freeze the picker or player |
| Persistent local library | Import, terminate/relaunch, then enable Airplane Mode | App-managed imports and library entries remain available; missing originals do not silently become playable entries |
| Local playback controls | Play, pause, seek near the end, change volume and resume | Position and duration remain valid, seeking matches audible output, and errors leave a recoverable state |
| Local background and next track | Start two short tracks, lock the iPad, leave it locked through the transition | Playback and queue advancement continue without JavaScript timers; lock-screen title/elapsed time and controls reflect the active track |
| Interruption | During local playback trigger an audio interruption, dismiss it, and return | Playback follows the interruption's resume indication; user-paused playback does not unexpectedly restart |
| Route change | Connect/disconnect wired or Bluetooth audio; test AirPlay where supported | State follows the native audio session; unplugging does not unexpectedly play loudly through the speaker; no duplicate audio engine |
| EQ and visualisation | Adjust EQ on a local track; switch to Spotify | Local EQ has an audible effect and its meter follows audio; Spotify-only unsupported DSP controls remain unavailable and decorative animation is not described as measured audio |
| Skins and touch | Load representative supported Winamp skins; drag/resize windows and seek with touch | Controls remain reachable, text fits, no hover-only actions are required, and gestures do not accidentally start playback |
| Rotation and multitasking | Rotate and resize the app using supported iPad multitasking modes | Windows remain recoverable and safe areas are respected; playback continues across layout changes |
| Recovery and diagnostics | Repeat failure/retry cycles, switch providers rapidly, reconnect after network loss | No crash, stuck spinner, accumulating listeners, secret-bearing logs, or misleading success state |

For long-running audio checks, record elapsed time and whether the device was locked, backgrounded or force-quit. Background playback and continuing after the user explicitly force-quits an app are different behaviors; do not report one as evidence of the other.

## Results and release boundaries

Attach the CI run URL and commit to the implementation report. Record physical cases individually as **passed**, **failed**, or **not run**, with a brief observation; do not mark the physical matrix passed from simulator results. For a failure, include the exact reproduction, source, device/OS and a sanitized message. `.xcresult` bundles open in Xcode; build errors and native test failures must be resolved before calling the native build verified.

Desktop releases are separate: only `desktop-v*` tags trigger the workflow that packages desktop ZIPs and creates a draft GitHub release. iPad code is never packaged into those desktop artifacts. The repository does not automatically sign, distribute, upload to TestFlight, or submit an iPad app. Personal device installation uses the documented Xcode signing setup; keep personal team/configuration files local.
