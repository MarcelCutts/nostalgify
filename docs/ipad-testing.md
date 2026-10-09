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
npx playwright install --with-deps chromium webkit
npm run test:ipad:browser
IPAD_SMOKE_BROWSER=webkit npm run test:ipad:browser
```

The same UI smoke test runs in Chromium and WebKit, including touch layout, controls, provider changes, skin import and persistence after reload. These browser checks use a test adapter; the simulator self-check separately verifies the real Capacitor bridge. CI runs each engine in the official Playwright 1.62.1 Ubuntu Noble container, pinned by digest and checked against the npm dependency. Browsers and their OS dependencies are already installed; CI does not download Ubuntu packages for each smoke test. Each engine saves its screenshot, result and Playwright trace under a separate artifact directory. Linux WebKit is useful cross-engine coverage, but does not establish behavior in the iPad's WKWebView.

The portable checks inspect the actual esbuild input/import graphs and packaging output. They reject Electron/Node imports in either renderer, SoundCloud/HLS or desktop implementation imports in the iPad renderer, Capacitor/iPad imports in the desktop renderer, and iOS project files accidentally included in desktop staging. The native structural check verifies Swift build-phase membership, the shared XCTest/XCUITest scheme, exact Swift dependency revisions, iPad targeting, callback registration, background audio configuration, and bundled rather than remotely hosted web assets. These checks do not compile Swift.

On a Mac with Xcode and an installed iPad simulator runtime:

```sh
bash scripts/check-ios-simulator.sh
```

This resolves only the committed Swift package revisions, builds the actual application for iOS Simulator with signing disabled, also compiles an unsigned Release build against the device SDK, creates a disposable iPad simulator, runs the `App` scheme's native and application UI tests, installs and launches the application, and captures a screenshot. A Debug-only `--native-local-selfcheck` launch also imports two generated WAV files into an isolated temporary library and verifies distinct identities, native queue advancement and persistence without JavaScript timers. It additionally verifies that the shared player has mounted in the real WKWebView and a native-plugin `getState` call resolves through Capacitor. CI requires its structured `native-selfcheck.json` result to pass within 60 seconds; it does not infer success merely from launching the process. The simulator is removed afterward. Results are written under `out/ios-ci/run.*`: package/build/test logs, `.xcresult` bundles, selected runtime, resolved dependencies, a deduplicated first-party Swift warning inventory, the self-check result, launch logs and a screenshot. XCUITest operates the real app with a Debug-only, isolated local library fixture. It exercises settings, local playback and persistence, provider switching, rotation, and accessible controls. Files and Settings accessibility audits run as independent cases, preserving audit categories while keeping individual failures and timings attributable. The Xcode 27 lane also checks actual VoiceOver navigation and speech through `XCUIVoiceOverService`; that test is explicitly skipped on the compatibility lane because the service requires iPadOS 27. These tests do not authenticate to Spotify or assert audible output. CI inspects both compiled executables: the Debug binary must contain the fixture storage marker, and the Release binary must exclude the UI-test launch flag and fixture markers. The result is saved as `release-fixture-check.json`. The native suite currently contains 31 tests, including ten audio-recovery tests, plus seven application UI tests; the compatibility lane runs six UI tests and explicitly skips the VoiceOver service test. These are expected test counts, not evidence that a particular run passed. On UI-test failure, `tests.xcresult` includes the app screenshot and accessibility hierarchy; cleanup exports attachments under `test-attachments` for inspection without Xcode, recording any export failure in `attachment-export.log`; cleanup also attempts a simulator-screen capture if the later launch check was not reached.

CI runs on pull requests, pushes to `main`, and manual dispatch. A branch push that updates an open PR starts its PR run, avoiding a second identical heavy native run for the same update. There are no path filters that leave documentation-only changes waiting for a missing required check. Linux unit/build checks and both browser engines remain independent required jobs. Native validation runs two explicit environments:

| Lane | GitHub runner | Xcode selection | Required iPad simulator runtime |
| --- | --- | --- | --- |
| Current platform | `xcode-27` | `/Applications/Xcode_27.app/Contents/Developer` (27.0) | iOS 27.0 |
| Compatibility | `macos-26` | `/Applications/Xcode_26.6.app/Contents/Developer` | iOS 26.5 |

These paths and runtimes were verified against GitHub's [Xcode 27 image](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md) and [macOS 26 image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md) on 9 October 2026. The `xcode-27` runner image is still labelled a [public preview](https://github.com/actions/runner-images/issues/14404); the selected Xcode 27.0 is stable. Neither lane silently selects a beta SDK or the newest installed simulator. Local runs default to the selected Xcode's simulator SDK version; set `NOSTALGIFY_IOS_RUNTIME=27.0` to choose explicitly.

The current lane enables `SWIFT_STRICT_CONCURRENCY=complete` while retaining Swift 5 language mode. `swift-warnings.json` records unique first-party source/message pairs, including warnings from failed builds. This is a migration diagnostic inventory, not a claim of Swift 6 compatibility or a zero-warning gate. Spotify's Objective-C delegate protocols need a documented main-thread compatibility boundary; new application warnings must be reviewed rather than hidden with blanket suppression.

Reviewed migration work includes actor-aware teardown for native observer and
remote-command tokens, typed Sendable results for Spotify's request continuation,
and explicit isolation adapters for Capacitor/Spotify's unannotated protocols.
Do not solve those diagnostics by declaring SDK objects unchecked Sendable or by
assuming every final reference is released on the main actor. Notification
delivery can use the main actor directly because its observer explicitly selects
the main operation queue; a background-post regression checks that boundary.

`Package.resolved` commits Capacitor 8.5.3 and Spotify iOS SDK 5.0.1 with their official Git tag commit IDs. Both package manifests were inspected and have no transitive package dependencies. Portable checks verify the full set of identities, URLs, versions and revisions; Xcode resolves and builds with `-onlyUsePackageVersionsFromResolvedFile` and `-disableAutomaticPackageResolution`. Dependency changes require updating the reviewed manifest versions, lockfile and structural check together. CI also uploads the actual lockfile used by Xcode.

Xcode's additional system-wide failure diagnostics are disabled with `-collect-test-diagnostics never`, an [Apple-documented command-line option](https://developer.apple.com/forums/thread/698054). CI verifies the flag exists in each selected toolchain's help output. This addresses an observed Xcode 27 run where all test verdicts were complete, then simulator diagnostic collection stalled for exactly 600 seconds before timing out. Test failures, `.xcresult` results, XCTest screenshot/hierarchy attachments, exported attachments, app, WebKit and relevant simulator lifecycle logs and our screenshots remain collected. `test-started-at.log` records the test interval start and UTC offset; `simulator.log` captures that full interval rather than only its last five minutes, bounded by the native job deadline. This retains evidence from the first cold launch even when later tests take several minutes. A full system-wide sysdiagnose is no longer part of normal CI; investigate platform-wide failures separately when that extra evidence is needed.

Native unit tests default to a 120-second execution allowance; application UI tests explicitly request 180 seconds to allow simulator interaction and accessibility work. Every case has an absolute 180-second cap, using Apple's [test-timeout options](https://developer.apple.com/documentation/xcode-release-notes/xcode-11_4-release-notes). A timed-out test fails and records diagnostics in the result bundle. The separate 45-minute native job timeout allows clean simulator boot plus both builds and the suite; it does not bypass a failure. Missing tooling fails visibly. Diagnostic artifacts are retained for seven days, including on failure. Use **CI / Required checks** as the combined required status check; it cannot pass when a unit/build, browser engine or native lane fails or is skipped.

## What each environment establishes

| Environment | Evidence it can provide | What it does not establish |
| --- | --- | --- |
| Node tests and build checks | Provider/contract behavior, isolated bundles, packaging boundaries, predictable errors with test doubles | Apple SDK compilation or device playback |
| Chromium and WebKit browser smoke | Mounted UI, touch layout, controls and persistent skin import against the test adapter | Real Capacitor/Spotify integration or native audio playback |
| Xcode simulator/device builds, XCTest and XCUITest | Debug simulator and unsigned Release device compilation on both lanes, Spotify SDK linking, native unit tests, application interaction and selected accessibility audits | Spotify App Remote communication with the real Spotify iPad app |
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
| Interruption | During local playback trigger an audio interruption, dismiss it, and return; repeat after manually pausing | Playback follows saved user intent and the interruption's resume indication; user-paused playback does not unexpectedly restart |
| Media services reset | Use the device's developer audio-reset control while local playback is playing, paused, and while Spotify is selected | Local audio objects and observers are recreated; selection/queue survive; local playback waits for a new user command and never takes audio ownership from Spotify |
| Route change | Connect/disconnect wired or Bluetooth audio; test AirPlay where supported | State follows the native audio session; unplugging does not unexpectedly play loudly through the speaker; no duplicate audio engine |
| EQ and visualisation | Inspect EQ on a local track; switch to Spotify | EQ remains flat, OFF and decorative for both sources; no synthetic audio is created to drive the iPad visualizer |
| Skins and touch | Load representative supported Winamp skins; drag/resize windows and seek with touch | Controls remain reachable, text fits, no hover-only actions are required, and gestures do not accidentally start playback |
| Accessibility | Navigate settings and playback with VoiceOver and a hardware keyboard; increase text size; test pointer controls | Focus order and spoken descriptions remain useful, sliders are adjustable, and the surrounding controls remain usable regardless of the imported skin |
| Rotation and multitasking | Rotate and resize the app using supported iPad multitasking modes | Windows remain recoverable and safe areas are respected; playback continues across layout changes |
| Recovery and diagnostics | Repeat failure/retry cycles, switch providers rapidly, reconnect after network loss | No crash, stuck spinner, accumulating listeners, secret-bearing logs, or misleading success state |

For long-running audio checks, record elapsed time and whether the device was locked, backgrounded or force-quit. Background playback and continuing after the user explicitly force-quits an app are different behaviors; do not report one as evidence of the other.

## Results and release boundaries

Attach the CI run URL and commit to the implementation report. Record physical cases individually as **passed**, **failed**, or **not run**, with a brief observation; do not mark the physical matrix passed from simulator results. For a failure, include the exact reproduction, source, device/OS and a sanitized message. `.xcresult` bundles open in Xcode; build errors and native test failures must be resolved before calling the native build verified.

Desktop releases are separate: only `desktop-v*` tags trigger the workflow that packages desktop ZIPs and creates a draft GitHub release. iPad code is never packaged into those desktop artifacts. The repository does not automatically sign, distribute, upload to TestFlight, or submit an iPad app. Personal device installation uses the documented Xcode signing setup; keep personal team/configuration files local.
