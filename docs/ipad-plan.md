# Native iPad implementation plan

The first iPad build keeps the Webamp interface in a native Capacitor host and
supports Spotify App Remote plus imported local audio. It is intended for
personal installation through Xcode or TestFlight. SoundCloud remains available
in the desktop application; adding its confidential backend and native player is
a separate feature.

## Architecture and ownership

- `apps/desktop`: Electron main process, preload, web audio host, packaging.
- `apps/ipad`: iPad web entry point, Swift bridge, native playback, Xcode project.
- `packages/player-ui`: shared skin/player presentation. It must not import
  Electron, Node host code, or a desktop HLS engine.
- `packages/contracts`: normalized bridge state, capabilities and fixtures.
- Native iPad code owns local audio sessions, queue advancement, interruption
  handling and remote controls. A suspended or reloaded WebView must not stop
  the local player or discard its queue.
- Spotify owns Spotify audio. Nostalgify must not activate its local playback
  audio session merely to keep its controller alive.

Shared source changes can be reviewed together, while desktop and iPad versions,
signing and release schedules remain independent. Existing desktop application
identity, preferences, skins and shelf data must survive the directory move.

## Work packages and acceptance gates

| Work | Acceptance evidence | Recovery if it fails |
| --- | --- | --- |
| Preserve the latest desktop baseline | Existing unit suite passes after moving imports; desktop mock self-tests exercise staged output | Fix the move before layering native behaviour onto shared code |
| Extract shared player and app entry points | Both builds succeed; iPad dependency graph contains no Electron, Node host or hls.js inputs | Move the dependency back to the owning app instead of adding browser shims |
| Establish bridge contract | Validate finite state, units, capabilities, errors, timeouts and stale responses in deterministic tests | Correct the contract/adapter first; do not mask failures as successful UI actions |
| Build the iPad touch shell | Browser smoke covers transport, source selection, settings, narrow layouts and diagnostics with explicit mocks | Use captured page errors and screenshots to distinguish layout failures from bridge failures |
| Integrate Spotify App Remote | Xcode compiles the pinned SDK; physical-device auth, callback, reconnect and transport checklist passes | Surface configuration/disconnection and provide an explicit reconnect action |
| Implement imported local audio | Native import, stable library IDs, playback, queue advancement, interruption and lock-screen checks | Preserve imported originals and show actionable failures; never depend on foreground JS for next-track playback |
| Persist skins and preferences | Import/restart/reload tests retain stable skin identity and shelf settings | Handle unavailable storage and failed writes explicitly |
| Add diagnostics | Bounded redacted records correlate commands with completions and state transitions; export works | Keep raw tokens, authorization URLs and user media metadata out of logs |
| Validate native app | macOS CI builds and launches an unsigned simulator app; physical device verifies real Spotify/audio | Keep build failures visible and attach logs; label simulator-only evidence accurately |
| Prepare personal installation | Reproducible build commands, Spotify client setup and Xcode signing steps are documented | Separate missing account/device setup from code failures |

## Test strategy

1. **Pure logic:** existing desktop provider/auth/media tests, normalized playback
   snapshots, URI parsing, capabilities, command failure and stale-result rules.
2. **Build boundaries:** inspect esbuild metadata and staged application contents;
   ensure a successful checkout build does not depend on sibling source files
   accidentally included in a release.
3. **Browser integration:** load the real built iPad UI using a deliberately
   selected mock native adapter. Test user interactions, disconnection, errors,
   resize and persistence. A mock pass is not native playback validation.
4. **Native compile and simulator:** resolve pinned Swift dependencies, compile
   with signing disabled, install/launch where available, collect screenshots and
   unified logs. Spotify's real app integration requires a physical device.
5. **Physical release-build checks:** cold launch, auth, multiple track boundaries,
   30-minute lock/background session, headphones/Bluetooth, network loss, file
   import and app upgrade. Run from the Home Screen without the Xcode debugger.

Each milestone should fail clearly when its prerequisites are absent. Never
replace a failed native integration with mock playback without an explicit demo
indicator. Keep automated tests deterministic and account-free; live Spotify
tests belong to the device checklist.

## Observability while developing

Use a request ID for commands, a monotonic sequence for state snapshots, and
bounded diagnostic buffers. Record safe event names, provider, elapsed time,
connection transitions and error codes. Avoid raw command arguments, filenames,
track titles, tokens and callback URLs. Native records should also use OSLog so
Xcode/Console can explain failures that occur while JavaScript is suspended.

Useful distinctions include command requested vs accepted vs reflected in player
state, disconnected vs paused, importing vs available, and an unsupported
capability vs an operation that failed. On resume, request authoritative native
state rather than trusting the pre-background clock.

CI should retain build logs, simulator logs, screenshots and test results on
failure. Shared changes exercise both applications; a successful JavaScript
build alone never closes the native acceptance gate.

## October 2026 hardening tasks

| Task | Automated acceptance | Device follow-up |
| --- | --- | --- |
| Adopt current tooling without losing compatibility | Explicit Xcode 27/iPadOS 27 and Xcode 26.6/iPadOS 26.5 lanes; committed Swift dependency resolution; unsigned Debug and Release builds | Install on the user's actual iPad and OS |
| Recover from media service resets | Ten native regressions exercise engine/observer replacement, inactive-provider ownership, interruption intent, background notification delivery, stale callbacks and explicit restart | Reset audio services from Developer settings during local playback and while Spotify is selected |
| Exercise the installed app | XCUITest operates real Capacitor and AVPlayer with isolated imported WAV files; verifies transport, persistence, settings and failed Spotify handoff recovery | Real Files providers, audible output, successful Spotify authorization and background sessions |
| Improve accessibility | Both browser engines test keyboard focus, range controls, reduced motion and 200% text; native tests run baseline accessibility audits, rotation and iPadOS 27 VoiceOver navigation | Manual VoiceOver, device text-size preferences and full visual assessment of selected skins |
| Make regressions diagnosable | Correlated OSLog command intervals, concurrency-warning inventory, xcresult bundles and browser failure traces | Inspect Instruments during long background/route-change sessions |

Keep Swift 5 language mode while collecting complete concurrency diagnostics in
the Xcode 27 lane. Resolve concrete ownership problems at callback boundaries;
do not suppress warnings broadly or combine this work with a wholesale Swift 6
migration. Retain the established AVPlayer and MediaPlayer implementations for
the iPadOS 17 deployment target. The newly announced playback/observability APIs
need separate availability and behavior experiments before replacing them.

Simulator fixtures compile only in Debug and use per-test storage. They exercise
native imports and playback; Spotify's unconfigured error path does not verify
real authorization. Pending Spotify authorization currently lives in memory:
if iPadOS terminates Nostalgify during the app switch, the user must retry Connect
Spotify. Ordinary background return and process-termination recovery are distinct
device checks.

## Research informing these decisions

- [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) provide
  local package linking and application-scoped scripts; no larger build system
  is required for two applications.
- [Capacitor workflow](https://capacitorjs.com/docs/basics/workflow) separates web
  build, native sync and native compilation. The Xcode project is maintained
  source, while copied web assets are generated.
- [Capacitor SPM](https://capacitorjs.com/docs/ios/spm) describes the generated
  package aggregate; app-owned dependencies must not be maintained by editing a
  file that sync overwrites.
- [Spotify lifecycle](https://developer.spotify.com/documentation/ios/concepts/application-lifecycle)
  requires connection management across app activity and explicit user flows
  when waking Spotify needs an app switch.
- [Apple logging](https://developer.apple.com/documentation/os/generating-log-messages-from-your-code)
  supports structured native diagnostics with privacy controls.
- [Apple release-build testing](https://developer.apple.com/documentation/xcode/testing-a-release-build)
  explains why debugger-attached background behaviour is not sufficient evidence.

The isolated feasibility probes showed that the existing coordinator can run
outside Electron, but its desktop renderer-reset semantics do not establish a
correct native lifecycle. This plan deliberately tests those boundaries rather
than assuming source sharing makes the runtimes equivalent.
