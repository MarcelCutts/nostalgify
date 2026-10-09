# Review of the open Nostalgify PR stack (#1 to #4)

Reviewed 2026-10-09 against heads f43461a (#1), c38587f (#2), 8ca1d5d (#3), 8327263 (#4). Each PR was reviewed on its own against its stacked base, and the four were reviewed together as one series. All suites were run locally and pass at every head (180, 188, 191, 194 tests); the renderer build passes at the top of the stack. No findings were posted to GitHub.

## Verdicts

| Scope | Verdict | Confirmed findings |
| --- | --- | --- |
| PR #1: Add public SoundCloud playback alongside Spotify | Request changes | 2 medium, 21 low, 8 nit |
| PR #2: Keep SoundCloud token storage responsive | Approve with nits | 6 low, 1 nit |
| PR #3: Disable decorative EQ controls for both sources | Request changes | 1 medium, 6 low |
| PR #4: Prevent clipped menus with native macOS popups | Request changes | 1 high, 7 low, 4 nit |
| The stack as a collection | Coherent with edits | 6 medium, 24 low, 10 nit |

- **#1:** Solid, well-tested SoundCloud architecture, but the README sells a feature the SoundCloud API Terms still gate, one default macOS path dead-ends with wrong instructions, and a cluster of small coordinator edge cases should be closed before this leaves draft.
- **#2:** The async migration is sound and well queued; what remains is a rotation test that hangs instead of failing, an availability branch Electron 44 never takes on macOS, dead message text, and two doc claims that outrun the evidence.
- **#3:** The flat/OFF decorative EQ behaves correctly and the code is sound, but the unit test added to guard the new DOM code cannot fail for the property its name promises, so the test needs fixing before merge; everything else is minor.
- **#4:** The native-menu design and its IPC validation are sound, but a physical right-click on a shelf row now leaves Webamp's drag-reorder armed so later pointer movement silently reorders and saves the shelf, and the window `closed` handler can throw on a destroyed window; fix those two, then tighten the self-test and README.
- **Collection:** The four PRs form one coherent, bisectable feature stack whose code is consistent at the top; what needs fixing before merge is the history and the prose: a stack order that implies dependencies that do not exist, one Keychain change split across #1 and #2 with comments that describe the wrong PR, nine fixup-sized commits scattered across all four PRs, an untouched CHANGELOG, and a SoundCloud terms gate and an ad-hoc-signing Keychain re-prompt that the shipped docs never state plainly.

## Cross-cutting summary

Read as one series, the four PRs are architecturally consistent and bisectable: every one of the 19 commits builds and passes its suite, the renderer never sees a credential or a signed URL, and the sandbox, context isolation and sender checks on the new IPC channels match Electron's checklist. The problems are concentrated in four places: one real interaction regression in #4, a licensing gate that #1 presents as a shipped feature, tests and validation prose that claim more than they check in every PR, and history and vocabulary hygiene across the stack. None of the confirmed findings is a data-loss or security hole at the top of the stack.

### Fix before merging

1. **#4 regression: a physical right-click on a shelf row arms Webamp's drag-reorder and the native menu swallows the release.** The next pointer movement over the list silently reorders the shelf and saves it. Both independent refuters confirmed the mechanism from Chromium and Electron source; only the end-to-end timing needs a Mac. The fix is a capture-phase `mousedown` guard for button 2 plus a self-test step. See PR #4, Blocking.
2. **#4: the window `closed` handler calls `closePopup(win)` on a window Electron has already marked destroyed**, which throws and skips the audio cancellation and `win = null`. One-line fix.
3. **#1: the SoundCloud API Terms gate is presented as a delivered feature.** The terms prohibit a playback experience that aggregates SoundCloud with another service unless explicitly licensed, and prohibit persisting user content across sessions; the shelf persists SoundCloud title and uploader. The PR's own research doc treats this as a release gate, but README, the setup guide and the PR body reduce it to a link. State it plainly on each surface and decide whether shelf metadata should be hydrated per session.
4. **#1: with Spotify running but Automation denied or pending, every switch to SoundCloud fails with "Pause Spotify before switching", which cannot help.** The right error already exists one function away.
5. **Tests that cannot fail for the property their name or the PR body claims.** This pattern appears in all four PRs: #2's rotation tests hang (seven tests cancelled) instead of failing when the rewrite is removed, and its "event-loop responsiveness" test asserts that an unresolved fake has not resolved; #3's fake DOM ignores selectors so the test named "without disabling working window controls" passes with `CONTROLS = "*"`, and its listener path is never exercised; #4's `menus` self-test passes with `menu.popup` deleted, and `contextMenu.js` has no unit test so three guard-removing mutations pass 194/194; #1's main-process audio bridge (ack correlation, 10 s timeout, reload cancellation) is untested and no asserting fixture ever presses Stop after the Stop contract changed. Each review gives the exact reorder, assertion or harness that closes the gap, and most are small.
6. **Keychain persistence is undermined by ad-hoc signing and misread availability.** `package.sh` ad-hoc signs every build, which Electron documents as causing Keychain to re-prompt on every update; on Electron 44 `isAsyncEncryptionAvailable()` is true whenever the app is ready, so #2's `storage_unavailable` branch, its message, docs and five tests model a state that cannot occur on macOS, while a real denial is reported as corruption with "Forget" guidance. The per-operation messages rewritten in f2c5913 are dead text because `auth.js` replaces them. Only the optional account sign-in path is affected, and both PRs already mark it unverified, but the docs should say so.

### Stack structure and narrative

- **The order implies dependencies that do not exist.** #2 shares no code file with #3 or #4 (only `docs/soundcloud.md` with #3); cherry-picking #3 and #4 onto #1 applies clean, tests pass and the build succeeds. The one real edge is #4 on #3 (`eq.canShowPanel()`), and it is invisible to the suite. Rebase #3 onto #1, or at least say which PRs depend on which.
- **#1's last commit tells #2's story.** f43461a's comment and test speak of a pending Keychain read that cannot be non-blocking until #2 makes decryption asynchronous; it was authored seven hours after #2's first commit. Move it or reword it.
- **Nine fixup-sized commits from one 09:04 to 09:28 sweep are spread across all four PRs** by a single rebase at 09:29. Squash each into the commit it corrects. Two subjects misdescribe their diff (599cebf is a behaviour change labelled "Clarify"; 29ce12b hides a safety-warning rewrite in a rename commit), c69cd44 bundles at least six unrelated changes with no body, and db869c6 raises the Node floor without saying why.
- **CHANGELOG.md is untouched by all 19 commits**, and two of its existing 0.1.0 lines are now wrong. No CI runs the 194-test suite the stack adds.
- **Vocabulary drifts despite three terminology commits.** The collection review's table lists seven concepts with up to seven names each (saved tokens, application credentials, source versus provider versus service, "Double-size Skin" versus "Webamp Double Size", two spellings of the Automation pane). Each has a recommended single name.
- **PR bodies use validation terms that no doc or command defines** ("combined build", "desktop checks", "accessibility inspection") and give no SHA for manual runs. The collection review supplies replacement sentences for each body, a readiness condition per draft, and a corrected mermaid edge for #1.

### What is good and should stay

The playback coordinator's generation and session guards are real and well tested (18 of 21 revert-the-fix experiments broke a test). The SoundCloud auth, client and media proxy are cleanly separated with host and query allowlists, PKCE with a 32-byte state, and single-use refresh handled correctly. #2's queue places the key-rotation rewrite inside the load's own queue entry, which is the right call and is pinned by tests. #3's `resetDisplay()` converges without loops and normalises provider input before touching the DOM. #4's template coercion, dual sender and frame checks, and its handling of Webamp's `REMOVE_TRACKS` quirks are all deliberate and correct. The bodies are honest about what was not run, down to the dated live-service results.

### How to read this report

The five reviews below are written for the author: one per PR against its stacked base, then the stack as a collection. Every finding in them survived adversarial verification by independent refuters who tried to disprove it from the code, the base checkout and the current Electron, SoundCloud, hls.js and Node documentation; findings that did not survive are listed in the companion appendix with the refuter's reasoning so you can see what was checked. Nothing was posted to GitHub.

## The stack as a collection

**Verdict: coherent with edits.** Read together, the four PRs are one feature plus three follow-ups. Every commit builds and passes its tests, and the top-of-stack code is architecturally consistent. What needs work before merging is the history and the prose: the stack order implies dependencies that do not exist, one Keychain-responsiveness change is split across #1 and #2 with comments that describe the wrong PR, nine fixup-sized commits are spread across all four PRs, CHANGELOG.md is untouched, and the shipped docs state the SoundCloud terms gate only in the research doc and never say that an ad-hoc-signed rebuild will re-prompt for Keychain access. None of this is a runtime defect at the top of the stack. All of it is cheap while the PRs are still drafts.

### What the stack does well

The stack is bisectable: every one of the 19 commits builds and passes `npm test` (136 tests at c8fd217 rising to 194 at 8327263), and the 180/188/191/194 counts in the bodies are exact. The architecture PR #1's body promises is followed by all four PRs: credentials, the media proxy and the menu labels stay in the main process (pr4 src/main/main.js:2, src/main/context-menu.js), the renderer only receives opaque `soundcloud-media://local/<id>` handles (pr4 src/main/soundcloud/media-proxy.js:145), and the sandboxed window, context isolation, CSP and the `fromPlayer` check on the new channels match Electron's checklist. Each PR ships its own tests and doc updates. The 9 October terminology sweep was split correctly per PR. PR #2 adopts the asynchronous safeStorage API Electron recommends. PR #4's claim that Stop reuses #1's coordinated pause-and-rewind is true end to end. hls.js usage and SoundCloud attribution match the current official docs. The bodies are honest about what was not verified, down to dating the live-service run at c69cd44 and saying it is not a fresh run.

### Stack structure and narrative

1. **Rebase #3 onto #1; name the one real dependency.** (low) #2 sits below #3 and #4 but neither needs it. PR #2 touches five files (docs/soundcloud.md, src/main/soundcloud/auth.js, src/main/soundcloud/token-store.js and two tests). Cherry-picking #3 and then #4 onto f43461a applies clean, passes 183 and then 186 tests, and builds. The one real cross-PR edge is #4 on #3: pr4 src/renderer/contextMenu.js:9 `equalizerPanelAvailable: eq.canShowPanel(),` and :61 `case "toggleEqualizerPanel": if (eq.canShowPanel()) ...` call a method 39a0883 introduced, while pr1 src/renderer/eq.js:40 still reads `allowed: () => allowed,`. #4 also cherry-picks clean onto #1 alone, passes 183 tests and builds, so this edge is invisible to the suite and the first right-click would throw a TypeError. GitHub merges stacks bottom up, so as placed today the two UI PRs cannot land before the Keychain review. Rebase codex/eq-availability onto codex/soundcloud-support (verified conflict-free) and say in #4's body that it needs #3's `canShowPanel()` rename.

2. **Move f43461a into #2, or reword it.** (medium; one refuter reads it as a wording slip only) PR #1's last commit says at pr1 src/main/soundcloud/auth.js:306-307 "Bound this caller's wait even when a shared Keychain read is still pending" and its test asserts `'the caller does not wait for Keychain'` (pr1 tests/soundcloud-auth.test.js:144). At #1's head the store decrypts synchronously, pr1 src/main/soundcloud/token-store.js:44 `return JSON.parse(safeStorage.decryptString(encrypted));`, which Electron documents as a call that "can block the current thread to collect user input". So the scenario the comment and test describe cannot happen until #2's pr4 token-store.js:80 `await safeStorage.decryptStringAsync(encrypted);`. f43461a was authored at 09:27:55, seven and a half hours after 9cb943c (01:58:26), and 9cb943c cherry-picks clean onto 1894a73. Either move f43461a above 9cb943c, or keep it in #1 (the bounded wait is coherent against the queued file I/O there) and change "Keychain" to "storage" in the comment and the test message. Either way, say in both bodies that the two PRs together make token loading non-blocking.

3. **Squash the 09:04 to 09:28 sweep into the commits it corrects.** (low) Nine commits authored in that window were spread across all four PRs by a single rebase at 09:29:03 (every commit from 9cb943c on carries that committer time): 29ce12b, 97e607d, 773ddcb, f2c5913, c38587f, 39a0883, a1fa976, bef917d, 8327263. Each only renames, rewords or completes something an earlier commit in the same PR introduced. #4 renames its action IDs and labels three times (8fe6b49, a1fa976, bef917d). c38587f adds to `load()` the same Linux `v10` check 9cb943c put in `writeTokens()` (pr4 token-store.js:44 and :74). The repository's squash setting is COMMIT_MESSAGES, so these subjects land on main as noise under squash, and verbatim under merge or rebase. `git rebase -i --autosquash` them.

4. **Split c69cd44 or give it a body.** (medium) It is 22 files, +1361/-133, subject "Fix native macOS SoundCloud playback and verify real Spotify handoff", no body. Besides those two things it adds the electron-fetch redirect adapter, AppleScript error sanitising that changes `spotifyCommand`/`playShelf` from logging to throwing, the `.env` ignore and packaging rules, a `fromPlayer` check on `clipboard:read`, the failed-switch recovery in playback.js and the Keychain-avoidance reorder in token-store.js. The only itemisation of these, docs/soundcloud-tasks.md, is added in c8fd217, extended in c69cd44 and deleted in db869c6, so it is gone from the tree and from the PR body. The minimal fix is a commit body that restates that checklist.

5. **Drop docs/soundcloud-tasks.md from the series.** (nit) c8fd217 is 42 files, +5273/-111, and the checklist's add, modify, delete churn inside one PR is the part that should not be in history. Squash-merging #1 also solves it.

6. **Fix two subjects that misdescribe their diff.** (low) 599cebf "Clarify decorative equalizer availability for each source" removes the 0.1.0 loudness curve, forces the panel to flat/OFF and disables its controls (pr4 src/renderer/eq.js:19-33 `resetDisplay()`). That is a behaviour change; the PR title says so correctly, the subject does not. 29ce12b, a rename commit, rewrites tests/helpers/soundcloud-live.js:1-3 from "Opt-in, read-only live service check. No fixture fetch or user-account writes." to a warning that live-real mode "controls the real Spotify app and temporarily changes its volume". That correction deserves its own subject or a body.

7. **Say why db869c6 raises Node.** (low) Under "Clarify source setup, testing and project terminology" it changes package.json engines from `>=20` to `>=22.12`, repoints repository.url and deletes the tasks file. The bump is correct: electron 44.7.0 and @electron/packager 20.3.0, already in base's lock file, declare `>= 22.12.0`. Nothing in the commit, the PR body or the README says so. One sentence fixes it; do not lower the floor.

8. **Write commit bodies and state the merge method.** (low) All 19 commits are subject-only; main's single commit has a six-bullet body. With the configured defaults (merge message PR_TITLE, squash message COMMIT_MESSAGES, every PR has three or more commits) none of the bodies' rationale, diagrams or validation notes reaches `git log` on main unless the merger hand-edits. Put the "why" on the feature commits and say in #1 which method you intend.

9. **State a readiness condition.** (low) All four are drafts. #1, #2 and #4 list unverified items without saying whether they gate the draft; #3 gives no reason at all. #4's body, which says "This top branch contains the complete build", names only live-service/listening validation as pending and drops the Keychain and stream-expiry caveats that #1, #2 and pr4 docs/testing.md:205-208 carry. (nit)

### Terminology

| Concept | Names in use (pr4) | Recommended |
| --- | --- | --- |
| Saved Authorization Code tokens | "account tokens" (token-store.js:10, :77); "sign-in tokens" (:56); "Saved SoundCloud sign-in" (:92, auth.js:71, :74); "user-delegated tokens" (auth.js:85); "saved user tokens" (docs/soundcloud.md:53); "local encrypted sign-in" (:111); "user-token file" (:113) | "saved sign-in" in messages, "user tokens" in code and docs, defined in the glossary paragraph at docs/soundcloud.md:171 |
| SOUNDCLOUD_CLIENT_ID and SECRET | "application credentials" (docs/soundcloud.md:19); "API application credentials" (README.md:10); "Environment credentials" (main.js:69); "confidential credentials" (soundcloud-research.md:34); "Developer-supplied credentials" (:83); "application grants" (:36, scripts/check-soundcloud.js:19) | "application credentials"; "grant" only for the token exchange itself |
| Spotify or SoundCloud as a thing | "source" (docs/soundcloud.md:171, UI strings, tests); "provider" in 14 code comments (src/main/playback.js:1, src/renderer/eq.js:1, main.js:2 and others) and in prose at soundcloud-research.md:12-14; "service" (README.md:99, :104, :138, :140) | "source" in prose and comments; `provider` only as the code value |
| A Spotify track on the shelf | "Spotify song" (main.js:802 fallback title) and "track" (src/renderer/shelf.js:5), which renders "Spotify song (track)" when oEmbed fails; comments at renderer.js:227, :288 and main.js:475 still say "song" | "track" |
| The macOS Automation pane | "System Settings > Privacy > Automation" (renderer.js:325); "System Settings > Privacy & Security > Automation" (src/main/spotify-errors.js:6), both reachable in the same marquee | "Privacy & Security > Automation" |
| Doubling the skin | "Double-size Skin" (context-menu.js:19); "Webamp Double Size" (docs/testing.md:57, :191); "double size" in the menus PASS log (tests/helpers/context-menu-selftest.js:136) | "Double-Size Skin" (Apple title style capitalises the second word of a hyphenated compound) and that name in testing.md |
| Simulated Spotify | "a fake Spotify" (selftest.js:2, main.js:318); "simulated player" (docs/testing.md:31); "mock Spotify" (docs/testing.md:44) | "mock Spotify" |
| The menu holding Connect SoundCloud | "Playback" is both the menu-bar menu (main.js:626) and the player submenu (context-menu.js:33); messages say "Playback > Connect SoundCloud" (auth.js:49, :124) and "Playback > Forget Local SoundCloud Sign-in" (auth.js:74, token-store.js:92), but the player's Playback submenu has neither item | "the Playback menu in the menu bar" in those four messages |

### Docs and changelog at the merged state

- **CHANGELOG.md is byte-identical to main across all 19 commits.** (medium) It omits SoundCloud playback, the async Keychain store and the Forget action, the flat/OFF EQ, native menus, hls.js 1.7.3 and the Node floor, while the same stack rewrites README.md and THIRD_PARTY_NOTICES.md. Two 0.1.0 lines now contradict the tree: :14 "all mirrored from Spotify" against README.md:32 "follow the selected source", and :21 "ADD → URL" against the native "Add Music Link from Clipboard" item (context-menu.js:41). Line :19 on the decorative EQ is still true. There are no tags, so 0.1.0 is genuinely unreleased: fold the entries into the existing "## [0.1.0] - Unreleased" section and correct :14 and :21.

- **The SoundCloud terms gate is one link deep on every surface.** (medium; one refuter calls it a nit because the fact is in the PR's own linked doc) docs/soundcloud-research.md:84-86 says the API terms "restrict playback combining SoundCloud with other services unless explicitly licensed" and that permission must be established "before distributing this integration". PR #1's body reduces that to "release gates cover credentials, licensing and retention"; README.md:139-141 and docs/soundcloud.md:9-11 frame the gate as a credential review. The shelf persists SoundCloud title, uploader and URL across launches (src/main/soundcloud/client.js:275-280, src/main/shelf.js:13-22, main.js:918 `shelfVersion: 2`), which research.md:89-92 itself flags as unreviewed against the terms' session-caching clause. release.yml, the README's Releasing section and CHANGELOG are untouched, so whoever pushes a `v*` tag gets no reminder. One sentence on each surface would do it; this is the fact that decides whether the headline feature can ship.

- **Ad-hoc rebuilds will re-prompt for Keychain and nothing says so.** (medium) README.md:69-75 is the update path, `git pull`, `npm ci`, `npm run install-app`; scripts/package.sh:36 signs with `codesign --force --deep --sign - "$APP"`. Electron's safeStorage page says that without a consistent signature macOS "can cause the Keychain to re-prompt the user for permission on every update", and its code-signing page names ad-hoc signed apps. A Deny lands in token-store.js:92 / auth.js:74 "Unlock your system keychain", which misdescribes a permission prompt. Only the optional account sign-in path is affected, and both PRs already mark it unverified, but docs/soundcloud.md:98-114 never mentions signing. Add one sentence there and a "rebuild, relaunch, allow the prompt" item to the manual checks. Observable only on macOS.

- **An orphaned JPEG and a stale hero.** (low) docs/images/equalizer-flat-off.png (267,154 bytes) is JPEG data under a .png name (JFIF header), nothing in the tree references it, and it exists only for PR #3's body via a raw.githubusercontent URL. README.md:16 keeps the upstream web-demo hero with the alt text "with its equalizer" under a tagline that now says "Classic Winamp skins for Spotify and SoundCloud." (README.md:7). Reference the capture from the README or do not commit it; rename or re-encode it; refresh or re-caption the hero.

- **The recorded validation is pinned to a stack-internal short SHA.** (low) docs/testing.md:197 "for commit `c69cd44`" and PR #1's body links docs by branch name. Under squash or rebase the SHA survives only in GitHub's PR view. The staleness is already disclosed at :205-206. Use the full SHA plus "PR #1"; permalink the body links.

- **Nothing runs the suite.** (low) The stack adds a 194-test node:test suite that runs in under two seconds here, but no CI workflow; release.yml runs `npm ci` and `npm run package:release` (which builds via package.sh:13) and never `npm test`.

- Smaller gaps: docs/testing.md:33 says "Any nonempty value of `NOSTALGIFY_MOCK`, including `0`, enables the Spotify mock", but the asserting `menus`, `soundcloud` and `soundcloud-live` modes require exactly `"1"` (selftest.js:8, :22, :25) and otherwise fall through and exit 0 without asserting (low). src/main/selftest.js:3 still says "The modes are listed in the README" after db869c6 moved the table to docs/testing.md:42-50 (nit). README.md:10 and :46 never say that registering an application needs SoundCloud's paid Artist Pro plan; that appears only at docs/soundcloud.md:18-19, which links the generic guide anchor rather than SoundCloud's register-app page (nit). README.md:88 says "press Shift+F10" where an Apple keyboard at default settings needs Fn+Shift+F10 and has no ContextMenu key (nit). docs/soundcloud-research.md:51-57 names only the app-wide `POST /disconnect` and omits the per-user `POST /sign-out` a future remote sign-out would need (nit).

### Cross-PR code consistency

- **IPC sender validation is half applied.** (low) PR #1 added `fromPlayer` (main.js:54-56) and used it on its six handlers; PR #4 added a seventh bespoke check for `menu:show` (main.js:586). Eleven pre-existing handlers stay unguarded: layout, resize:start, resize:end, skins:init, skins:chosen, shelf:load, shelf:save, ui:load, ui:save, window:close, window:minimize. The guarded ones reject four ways: `null` (:891), `{ error: "Invalid player" }` (:892, :920), `""` (:927) and silent return. Exposure is nil with one sandboxed window and a fixed preload surface, but the next handler author has two patterns and four shapes to copy. One helper over all 18 channels, in #1.

- **No single module defines a valid shelf URI.** (low) The Spotify regex appears at main.js:483, src/main/shelf.js:7, playback.js:151 and :208; the SoundCloud URN at playback.js:2 and shelf.js:8 with `[A-Za-z0-9_-]+` and at client.js:10 with `\d+`; the https/host/credential/port check at playback.js:245, shelf.js:21 and client.js:2/:25. Export both patterns and one host check from shelf.js.

- **Two file-naming systems, two quote styles, three error factories.** (low) src/main gained eight kebab-case modules beside base's camelCase starterSkins.js while the renderer stays camelCase, so #4 ships src/main/context-menu.js next to src/renderer/contextMenu.js. auth.js, token-store.js and media-proxy.js are single-quoted with `node:` requires (102/1, 35/0 and 90/3 single/double); every other module is double-quoted with bare requires. `Object.assign(new Error(message), { code })` exists at auth.js:8, client.js:12 and token-store.js:6. No formatter config settles any of it. Rename while the PRs are drafts.

- **Packaged builds show SoundCloud items that cannot work.** (low) main.js:965 reads the secret only from the environment, soundcloud.json refuses it (docs/soundcloud.md:93), and the client-ID-only path needs a public-client exception SoundCloud does not grant (docs/soundcloud.md:65-70). A Finder-launched `npm run install-app` build still offers Use SoundCloud and Connect SoundCloud… (main.js:633-636) and fails with "Configure your SoundCloud application credentials before connecting." with no pointer to the docs. Disable the items when unconfigured or point the dialog at docs/soundcloud.md. Documented and release-gated, not a regression.

- **A design choice attributed to SoundCloud.** (low) auth.js:22 "SoundCloud requires a registered HTTP callback on 127.0.0.1 with an explicit port." (and main.js:972). SoundCloud's guide only requires an exactly matching registered redirect_uri and suggests a custom scheme for desktop apps; the loopback-with-fixed-port rule, which also rejects `localhost` and `[::1]` (tests/soundcloud-auth.test.js:434-438), is Nostalgify's. Say so in the message and the docs.

- **Dead wiring after #4.** (nit) The capture-phase click intercept at src/renderer/contextMenu.js:30-37 makes Webamp's HTML ADD menu unreachable, so `handleAddUrlEvent: () => shelf.handleAddUrl()` (renderer.js:66) and the `return [];` at src/renderer/shelf.js:117 have no live caller except the native `addMusicLink` action (contextMenu.js:54). a1fa976's subject claims to remove obsolete handlers.

- contextMenu.js:59-60 dispatches internal `TOGGLE_SHUFFLE`/`TOGGLE_REPEAT` where webamp 2.3.1 documents `toggleShuffle()`/`toggleRepeat()`, while :57 already uses the public `webamp.stop()`. The other new internal action types have no public equivalent. (nit)

### Against current practice

- **SoundCloud token reuse.** (low) The guide says "Store and reuse the token; use refresh_token to renew expired tokens." and limits client-credentials grants to "50 tokens per 12 hours per application" and "30 tokens per 1 hour per IP address". auth.js:182-186 keeps application tokens in memory only and :349-350 requests a fresh grant on every Connect (main.js:70-71 routes Connect to `reconnect()` whenever a secret is set), so each SoundCloud session, each Connect click and each `npm run soundcloud:check` spends a grant. The in-session refresh is implemented and the memory-only choice is deliberate (auth.js:85) and tested, so the cost is bounded. But the Keychain store #2 hardens serves only the user path, and the same guide says "All clients are currently treated as confidential rather than public", so that path is not currently issued tokens. Decide whether application tokens should persist and say in #2 which path it protects. Source: SoundCloud API guide.

- **Electron IPC guidance.** The security tutorial says "You should be validating the sender of all IPC messages by default." PR #4 cites the section and the stack applies it to 7 of 18 handlers. Source: Electron security tutorial.

- **Electron safeStorage and signing.** The safeStorage page says "On macOS, your app should be code signed" and that an inconsistent signature "can cause the Keychain to re-prompt the user for permission on every update"; the code-signing page names ad-hoc signed apps. scripts/package.sh:36 is ad-hoc. Sources: Electron safeStorage, Electron code signing.

- **Electron's async preference.** "We recommend using the asynchronous API ( encryptStringAsync / decryptStringAsync ) over the synchronous API." and "The synchronous API may be deprecated in a future version of Electron." #1 ships sync, #2 moves to async. Fine as a progression, but #1's last commit describes #2's property. Source: Electron safeStorage.

- **SoundCloud API terms.** The terms prohibit, unless "explicitly licensed", "any playback experience which aggregates and streams User Content with content from other services", and say "any cached content must cease to be available, accessible or playable within your app at the end of that session". The research doc knows both; the user-facing docs and PR body do not state them. Source: SoundCloud API Terms of Use.

- **Keep a Changelog.** "A changelog which only mentions some of the changes can be as dangerous as not having a changelog." Source: keepachangelog.com 1.1.0.

- **GitHub stacked PRs.** "pull requests must merge from the bottom up" and merging a mid-stack PR merges "The pull requests below it" too. That is why #2's position gates #3 and #4. GitHub's key principle (a dependency must be "in the same branch or a lower one") is satisfied, so this is a workflow cost, not a rule violation. Source: GitHub docs, about stacked PRs.

- **Commit granularity.** git's SubmittingPatches: "Make separate commits for logically separate changes." c69cd44 and c8fd217 do not. Source: git SubmittingPatches.

- **CI.** GitHub's Node.js starter workflow runs `npm ci`, `npm run build --if-present` and `npm test` on `pull_request`; the stack adds a suite and no equivalent. Source: actions/starter-workflows ci/node.js.yml.

### PR descriptions

All four bodies describe Electron and manual validation with terms that appear in no doc or commit message ("combined Electron build", "combined renderer build", "combined build", "complete build", "desktop checks", "desktop inspection", "accessibility inspection"), name no command, and, apart from #1's live results pinned to c69cd44 with a disclaimer, give no revision; the test counts are unlabeled stack totals (+8, +3, +3). One refuter rates this a wording nit; I would still replace each Validation opener. (medium) Concrete edits:

**#1, Validation.** Replace "180 tests and renderer build pass ... The combined Electron build also passes offline AAC/HLS decoding, controls, source switching and reload." with: "`npm test` (180 tests) and `npm run build` pass at f43461a. `NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=soundcloud npm start` passes at f43461a (offline AAC/HLS decoding, controls, source switching, shelf persistence, reload; no credentials needed). Live SoundCloud and real Spotify checks last ran at c69cd44; see docs/testing.md#recorded-validation."

**#1, Limits.** Replace "[Setup] and [release gates] cover credentials, licensing and retention." with: "SoundCloud's API terms restrict a playback experience that combines SoundCloud with another service unless explicitly licensed; no permission has been obtained, so this integration is for local builds with your own credentials until the [release gates] are cleared. Registering credentials currently requires SoundCloud's paid Artist Pro plan."

**#1, add a paragraph.** "For existing users: the Node minimum rises from 20 to 22.12 (electron 44 requires it). Shelf prefs gain `shelfVersion: 2` with provider and url fields; a build from main keeps Spotify entries and silently drops SoundCloud entries on its next save."

**#1, diagram.** Change `Proxy -->|opaque media handles| Audio` to `Playback -->|load message with opaque handle| Audio` and add `Audio -->|soundcloud-media:// fetches| Proxy`. The handle reaches the renderer in the coordinator's load message (playback.js:135-140); the proxy only answers the renderer's own fetches (main.js:977, soundcloudAudio.js:138, :141).

**#2, after the first paragraph.** "Only the client-ID-only account sign-in path writes this store; application-token playback keeps tokens in memory. That path needs a public-client exception SoundCloud does not currently grant, which is why Keychain prompts and persistence remain unverified. The Linux checks exist because Electron checks run on non-Mac desktops during development; `v10` is the hardcoded-key ciphertext prefix of Electron's Linux backend." Validation: "`npm test` (188 tests, 8 new in tests/token-store.test.js) at c38587f."

**#3.** Validation: "`npm test` (191 tests, 3 new in tests/eq-policy.test.mjs) and `npm run build` at 8ca1d5d. The screenshot was captured at 8ca1d5d with `NOSTALGIFY_MOCK=1 npm start` and the Green Dimension V2 skin." Add: "Does not depend on #2. Ready for review once #1 is; nothing here waits on macOS validation."

**#4.** Replace "194 tests, renderer build and the Electron menu regression pass at 1×/2×/3×" with "`npm test` (194 tests, 3 new in tests/context-menu.test.js), `npm run build` and `NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=menus npm start` (asserts at 1x, 2x and 3x) at 8327263." Replace "Shift+F10 opens the player menu" with "Shift+F10 (Fn+Shift+F10 on Apple keyboards at default settings) opens the player menu". Replace the Stack line with: "Stack: #1 → #2 → #3 → #4. Needs #3 (`eq.canShowPanel()`); does not need #2. Still unverified across the stack: physical listening, user OAuth/Keychain persistence, stream expiry; see docs/testing.md#recorded-validation."

**All four.** One readiness sentence each: "Draft until: a fresh live-service run at the head SHA (#1); a macOS Keychain prompt check after an ad-hoc rebuild (#2); #1 landing (#3, #4)."

### Unverified notes

No refuter result; listed for completeness only.

- collection-55: 'keychain' vs 'Keychain', and 'secure storage' vs 'safeStorage' vs 'OS-protected keys', are mixed across PR #2's strings, docs and commit titles.
- collection-56: docs/soundcloud.md:108 "Electron caches the initialized key provider" asserts a behaviour the safeStorage page does not state.
- collection-57: each new doc is linked under two or three different names (SoundCloud setup / application setup guide / Setup; Testing / Testing Nostalgify; SoundCloud research / decision record / credential and release review).
- collection-58: the research doc cites GitHub comments by numeric ID with relative dates a reader cannot verify from the rendered page.
- collection-59: preload exposes two listener conventions, `onAudioCommand` returns an unsubscribe and `onMenuAction` does not.

### Coverage

Six lenses examined the combined diff main 28e08b5 to 8327263 and each PR's diff: terminology across code, strings, docs, commits and bodies; stack narrative and dependencies (cherry-pick and `git apply --check` experiments in scratch clones; `npm test` at each head); commit hygiene (every one of the 19 commits built and tested, 136 to 194 passing, so the stack is bisectable); docs at the merged state (every intra-repo link and anchor resolves; every external URL returned 200 except the login-only soundcloud.com/you/apps; hls.js licence and SoundCloud logo provenance verified byte for byte); cross-PR code coherence (IPC coverage, duplicated regexes, queues, test helpers, unused exports); and modern practice and prior art (Electron checklist items, hls.js and Webamp typings, npm dist-tags: electron 44.7.0, hls.js 1.7.3, webamp 2.3.1, esbuild 0.28.2 all current). Adversarial verification confirmed 46 findings, refuted 13 and left 5 unverified. For this write-up I re-opened every quoted line at the pr4 (or pr1) checkout and re-read the Electron safeStorage, security and code-signing pages, the SoundCloud guide and terms, Keep a Changelog, GitHub's stacked-PR doc, git's SubmittingPatches, the Node starter workflow, and Apple's function-key and style-guide pages.

Checked and fine, where a reader might wonder: storing the SoundCloud uploader under the shelf field `artist` is deliberate and tested (tests/soundcloud-client.test.js, "saved public links retain the uploader's attribution") and matches SoundCloud's branding guidance; and the two transport routes (menu bar via `playbackCommand` in main, player menu via the renderer) both pre-date the stack and both end in `playback.command()`.

Could not be checked here: anything that needs macOS or a running Electron (the Keychain prompt after an ad-hoc rebuild, native menu rendering, whether a bare Shift+F10 reaches Chromium under Apple's default Fn mapping, the `menus` and `soundcloud` self-test modes), whether GitHub's stack UI currently recognises these four PRs, and the eight soundcloud/api issue-comment IDs cited in docs/soundcloud-research.md.

### References

- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron security tutorial](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron context menu tutorial](https://www.electronjs.org/docs/latest/tutorial/context-menu)
- [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide)
- [SoundCloud API Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use)
- [SoundCloud register an app](https://developers.soundcloud.com/docs/api/register-app)
- [SoundCloud self-serve API keys blog post](https://developers.soundcloud.com/blog/vibe-coding-ai-agent-docs-self-serve-api-keys)
- [soundcloud/api release 2026-09-30](https://github.com/soundcloud/api/releases/tag/2026-09-30)
- [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
- [GitHub docs: about stacked PRs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
- [GitHub docs: about stacked PRs (source)](https://raw.githubusercontent.com/github/docs/main/content/pull-requests/get-started/about-stacked-prs.md)
- [GitHub docs: about pull request merges](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges)
- [GitHub docs: configuring commit squashing (source)](https://raw.githubusercontent.com/github/docs/main/content/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests.md)
- [GitHub docs: automatically generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
- [GitHub docs: about pull requests (drafts)](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests)
- [GitHub docs: attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
- [GitHub docs: permanent links to files (source)](https://raw.githubusercontent.com/github/docs/main/content/repositories/working-with-files/using-files/getting-permanent-links-to-files.md)
- [git SubmittingPatches](https://raw.githubusercontent.com/git/git/master/Documentation/SubmittingPatches)
- [How to write a git commit message (cbea.ms)](https://cbea.ms/git-commit/)
- [GitHub Actions Node.js starter workflow](https://raw.githubusercontent.com/actions/starter-workflows/main/ci/node.js.yml)
- [Graphite: PR description best practices](https://graphite.dev/guides/github-pr-description-best-practices)
- [Apple: use function keys on Mac](https://support.apple.com/en-us/102439)
- [Apple Style Guide: capitalization](https://support.apple.com/guide/applestyleguide/c-apsgb744e4a3/web)
- [Apple Style Guide: sign-in](https://support.apple.com/en-az/guide/applestyleguide/apdaf2bc3367/web)
- [Apple: control access to automation (Privacy & Security)](https://support.apple.com/en-us/guide/mac-help/mchl211c911f/mac)
- [Apple TN3127: inside code signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements.md)
- [Apple Developer Forums thread 98484 (Keychain ACL and designated requirement)](https://developer.apple.com/forums/thread/98484)
- [Webamp changelog (toggleShuffle/toggleRepeat)](https://docs.webamp.org/docs/changelog)
- [Webamp OptionsContextMenu.tsx](https://raw.githubusercontent.com/captbaritone/webamp/master/packages/webamp/js/components/OptionsContextMenu.tsx)
- [RFC 8252: OAuth 2.0 for native apps](https://www.rfc-editor.org/rfc/rfc8252.txt)
- [electron@44.7.0 on npm (engines)](https://registry.npmjs.org/electron/44.7.0)
- [@electron/packager@20.3.0 on npm (engines)](https://registry.npmjs.org/@electron%2Fpackager/20.3.0)
- [MarcelCutts/nostalgify repository settings (API)](https://api.github.com/repos/MarcelCutts/nostalgify)
- [PR #1](https://github.com/MarcelCutts/nostalgify/pull/1)
- [PR #2](https://github.com/MarcelCutts/nostalgify/pull/2)
- [PR #3](https://github.com/MarcelCutts/nostalgify/pull/3)
- [PR #4](https://github.com/MarcelCutts/nostalgify/pull/4)

## PR #1: Add public SoundCloud playback alongside Spotify

**Verdict: request changes.** Two medium items (a Terms-of-Use gate presented as a shipped feature, and a dead-end error on a default macOS path) plus a set of small coordinator edge cases. All are cheap to fix and the architecture is sound.

The PR adds a main-process playback coordinator (src/main/playback.js) that owns the selected source and uses generation and session guards so late polls, stale audio acks and reloads cannot flip the provider; the tests for those orderings are real (21 revert-the-fix experiments were run against the suite and 18 of them failed at least one test). The SoundCloud side is split cleanly into auth (PKCE loopback with 32-byte state, Host check, listen-before-open, serialized single-use refreshes), an API client with host and query-key allowlists, and a media proxy that rewrites manifests into opaque handles so no token or signed URL ever reaches the renderer. The Electron posture is kept tight: contextIsolation and sandbox unchanged, three new preload channels with every argument validated, O_NOFOLLOW token file with a 0600 temp and rename, no plaintext fallback. The repository goes from zero tests to 180 passing in about 1.3 s plus an offline Electron fixture, and docs/testing.md is honest about what was validated and on which commit.

### Blocking

**README presents combined Spotify+SoundCloud playback and persisted SoundCloud metadata as a feature while the SoundCloud API Terms gate both** (medium)
`README.md:30-31`, `src/main/soundcloud/client.js:277-278`, `src/main/shelf.js:15-16`, `src/main/main.js:885`, `src/renderer/shelf.js:54-61`, `docs/soundcloud-research.md:84-93`
README.md:30-31 says "Two music sources. Control Spotify through macOS scripting or play public SoundCloud tracks and playlists through SoundCloud's API." with no qualifier, and README.md:137-139 only links to "credential and release review". The SoundCloud API Terms prohibit "any playback experience which aggregates and streams User Content with content from other services (e.g. SoundCloud with YouTube)" unless explicitly licensed, say an app must not "persistently store any User Content", and name a username as Personal Data not to be retained "for longer than is reasonably necessary". The code persists exactly that: client.js:277-278 builds `title: text(resource.title, ...)` and `artist: text(resource.user?.username, "Unknown artist")`, shelf.js:15-16 keeps both, main.js:885 writes them to prefs.json, and renderer shelf.js:54-61 `load()` re-displays them on relaunch with no per-session fetch. Only docs/soundcloud-research.md:84-93 and the word "retention" in the PR body disclose this. Whether a UI that remote-controls Spotify counts as "aggregates and streams" is a legal reading, and your own research doc already treats it as a gate, so this is about honesty of the feature list and the cheap half of the fix.
Fix: (1) add one sentence to README Features and Known limits saying the SoundCloud API Terms restrict combined-service playback and persisted metadata until permission is established, so a reader of the feature list sees it; (2) for retention, store only URN and permalink in prefs and hydrate title/uploader per session (one `/resolve` or `/tracks/{urn}` per entry per launch, which docs/soundcloud-research.md:91-92 already proposes), or record an explicit decision to defer that until the licence question is answered.
Source: [SoundCloud API Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use)

**Switching to SoundCloud with Automation denied or pending fails with an instruction that cannot help** (medium)
`src/main/main.js:949-955`, `src/main/main.js:489-491`, `src/main/main.js:597`, `src/main/main.js:961`
main.js:961 launches Spotify hidden at every start in the default Spotify mode. If the user clicks Don't Allow on the Automation prompt (or it is still pending), `getSpotifyState()` returns `error: "permission"` or `"waiting"` (main.js:356-357), and the pause gate at :953 throws `"Pause Spotify before switching music sources."` on every SoundCloud shelf double-click. Pausing Spotify by hand does not help because the next state read still returns the error. `playOrFallback` already does the right thing at :491 with `throw spotifyCommandError(s.error)`, which yields "Allow Nostalgify to control Spotify in System Settings > Privacy & Security > Automation, then try again." The Playback > Use SoundCloud item at :597 discards the result, so that route fails with no message at all. The block itself (never start SoundCloud over an unpaused Spotify) is a sensible design and I am not suggesting changing it.
Fix: at :953 `if (state.error) throw spotifyCommandError(state.error);` and have the Use SoundCloud / Use Spotify menu clicks surface `result.error` (a dialog or the same flash path the renderer uses). Needs a Mac with a denied grant to observe, so confidence is on the code path, not a reproduction.

### Should fix

**Seek and Previous after the last queued track ends are dropped and overwrite the marquee with the empty-shelf prompt** (low)
`src/main/playback.js:324-329`, `src/main/playback.js:286-289`, `src/main/playback.js:262-263`, `src/main/playback.js:275-276`
On `ended` with Repeat off, :326-328 sets `state.state = "stopped"` and `session = null` but leaves `state.track` and `index`. A later seek-bar drag reaches :286-289 `if (!session) { state.message = "Paste a SoundCloud track or playlist to begin"; return; }`, and Previous (position at track end fails `state.position <= 3`) becomes `seek 0` at :263 and hits the same branch. renderer.js:375-377 shows that message over a still-displayed track. The next Play reloads from 0 via :275-276, dropping the dragged position. tests/playback.test.js:241-254 covers only Play after the end. Reproduced with a probe test in a scratch copy.
Fix: reserve the prompt for `index < 0`; when `!session && index >= 0`, store `pendingPosition` for seek (and pass it to the reload at :276) and move `index` for Previous.

**Unattended playlist advance halts at the first blocked or stream-less track** (low)
`src/main/soundcloud/client.js:291`, `src/main/soundcloud/client.js:321-323`, `src/main/playback.js:200`, `src/main/playback.js:329`, `src/main/playback.js:144-146`
client.js:291 deliberately widens the request to `access=playable,preview,blocked` (the API default is `playable,preview`), but `nextTrack(true)` at :329 loads exactly one candidate (:200) and any `track_blocked` or `stream_unavailable` rejection becomes a terminal paused-with-error state via :144-146. The guide says blocked tracks are common (creator restricted, paywalled, geo-blocked). docs/soundcloud.md:113-114 documents this only for manual selection.
Fix: in the automatic path, skip entries whose `access` is `"blocked"` (the field is already on each queue entry) and treat a stream failure on automatic advance as a bounded skip rather than `fail()`.
Source: [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide), [OpenAPI access parameter](https://developers.soundcloud.com/docs/api/explorer/api.json)

**playShelf switches to Spotify without `spotify.start()`, unlike selectProvider** (low)
`src/main/playback.js:154-156`, `src/main/playback.js:215-216`, `src/main/main.js:961`, `src/main/main.js:289`, `src/main/main.js:416-417`
With `prefs.provider === "soundcloud"`, main.js:961 no longer pre-launches Spotify (base launched it unconditionally). playShelf at :154-156 goes straight to `spotifyCommand("playShelf", uri, g)`, whereas selectProvider at :216 does `await spotify.start()` first. So a double-click on a Spotify shelf entry makes the 4 s `osascript` call (main.js:289) cold-launch Spotify itself; your own readiness budget in `launchSpotifyHidden` (main.js:416-417) waits up to about 9 s, so "Spotify did not respond" with Spotify in the foreground is plausible. macOS-only to confirm.
Fix: after `select(next)` in playShelf, `if (next === "spotify" && g === generation) await spotify.start();` and add a test asserting the start call.

**An explicit Play on SoundCloud is awaited through `audio.play()` under the 10 s IPC deadline, but the load path is not** (low)
`src/main/main.js:44-47`, `src/renderer/soundcloudAudio.js:160`, `src/renderer/soundcloudAudio.js:158`, `src/main/playback.js:297-300`, `src/main/playback.js:275-276`
soundcloudAudio.js:160 `if (command.type === "play") await play(instance);` holds the ack until the media element actually starts (the WHATWG play() promise resolves only once enough data is buffered), while the load path at :158 fires `void play(instance).catch(() => {})`. A slow HLS start (manifest plus first segment through the proxy) past 10 s rejects at main.js:44-47, `fail()` runs at :297-300, and the next Play at :275-276 tears down the nearly-ready stream and re-runs `loadTrack` from scratch. Network dependent and uncommon.
Fix: resolve the IPC `play` command once `play()` has been invoked, as load does, and let the state reports carry the outcome.
Source: [WHATWG media element play()](https://html.spec.whatwg.org/multipage/media.html)

**getState returns a partial state object on a generation bump while Spotify stays desired** (low)
`src/main/playback.js:304-310`
`getState` only reaches `spotify.getState()` when `desired === "spotify"`, so the guard at :308 `g !== generation || desired !== "spotify"` is entered either because desired flipped to soundcloud or because the generation moved with Spotify still desired. The nested ternary re-tests the first case; the second returns `{ provider, running: true, state: "paused" }` with no `track`, and `provider` is the committed value, which can still be `"soundcloud"` mid-switch. The renderer then shows "Nothing loaded" (renderer.js:334) or "Add a SoundCloud track..." (:336) for one 1 s poll. tests/playback.test.js:112-121 covers only the first branch.
Fix: a fresh Spotify read is not stale when Spotify remains desired, so return `{ ...result, provider: "spotify" }` in that case, and add a test for the generation-bump branch.

**Four of seven entries in the command() catch allowlist are unreachable, so the list misleads** (low)
`src/main/playback.js:263`, `src/main/playback.js:264-266`, `src/main/playback.js:268`, `src/main/playback.js:299`
`cmd` is rewritten before any await: previous to seek (:263), playpause to pause/play (:264-266), playOrFallback to play (:268), and `next` only calls `nextTrack`, which never throws out of the catch. So `"previous"`, `"playpause"`, `"playOrFallback"` and `"next"` in the allowlist at :299 are dead, and a rejected seek-from-Previous or pause-from-Play/Pause returns `{error}` without `fail()`. A probe confirmed `state.error` stays null in those cases. The renderer still flashes the error for 6 s (playbackMedia.js:14-15, renderer.js:90), so this is clarity and dead code, not a user-visible bug.
Fix: capture `const requested = cmd;` before the rewrites and test `requested` in the allowlist (or dispatch to small handlers), and add a test for a rejected seek-from-Previous.

**A 429 from the token endpoint is reported as a credentials problem with no cooldown** (low)
`src/main/soundcloud/auth.js:154-155`, `src/main/soundcloud/auth.js:178-183`, `src/main/soundcloud/auth.js:345-346`, `src/main/soundcloud/client.js:176-178`, `src/main/main.js:69`
auth.js:154-155 maps every non-2xx token response to `auth_failed` "SoundCloud authentication failed. Check the application credentials and authorization settings, then connect again." Application tokens never reach the store (:178-183) and `reconnect()` always sends a fresh client-credentials grant (:345-346), so each launch that uses SoundCloud, each Connect click (main.js:69) and each check-script run burns one of the documented 50-per-12h-per-app / 30-per-hour-per-IP grants. A probe with a 429 plus `retry-after: 3600` showed three calls sending three new grants, and `client.loadContext` surfacing `unauthorized` ("Connect or reconnect SoundCloud before loading music.") with no retryAfterMs. The memory-only design is documented (docs/soundcloud.md:50-51, :121-123); the misreport is the defect. Reaching the quota needs a restart-heavy session, so this is recoverable and time-bounded.
Fix: in `exchange()`, map 429 to a distinct `rate_limited` error carrying the reset time, and keep a cooldown so subsequent `getAccessToken`/`reconnect` calls fail fast until it expires. Persisting application tokens is optional.
Source: [SoundCloud rate limits](https://developers.soundcloud.com/docs/api/rate-limits), [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide)

**The media proxy attaches the OAuth token to any hop whose host is api.soundcloud.com, including URLs chosen by CDN content** (low)
`src/main/soundcloud/media-proxy.js:229-234`, `src/main/soundcloud/media-proxy.js:244`, `src/main/soundcloud/media-proxy.js:157`, `src/main/soundcloud/media-proxy.js:16-19`
The `if (url.hostname === 'api.soundcloud.com')` check at :229 runs on every hop, and a hop's URL can come from a CDN redirect (:244) or a CDN-served manifest line (:157), because the allowlist at :16-19 includes `api.soundcloud.com` beside the CDN hosts. A manifest line `https://api.soundcloud.com/me` served from sndcdn.com would be registered and fetched with `Authorization: OAuth <token>` when hls.js requests it, and non-JSON bodies are relayed (:252-262, :281). The token only goes to api.soundcloud.com over HTTPS, so this is request steering with ambient authority, not a leak, but the PR's own tests treat CDN content as hostile. tests/soundcloud-media-proxy.test.js covers only the API-to-CDN direction.
Fix: authorize only hop 0 of a `register()`-created entry (or only URLs matching the `/tracks/{id}/streams` shape), never a URL that came from a manifest or redirect, and add the manifest-to-API test.

**fromPlayer() sender validation is applied to the new channels only, with no comment** (low)
`src/main/main.js:53-55`, `src/main/main.js:858-862`, `src/main/main.js:886-887`, `src/main/main.js:894`, `src/main/main.js:849-857`, `src/main/main.js:870-885`, `src/main/main.js:895-907`
`fromPlayer` guards playback:*, links:resolve and clipboard:read, while layout, resize:*, skins:*, shelf:save, ui:save, window:close (`app.quit()`) and window:minimize remain open. The unguarded handlers pre-date this PR and no untrusted frame can reach ipcRenderer today (single window, sandbox, will-navigate blocked, no webview), so this is consistency and defense in depth, not an exploit. Electron's guidance is to validate the sender of all IPC messages by default.
Fix: one `handleFromPlayer`/`onFromPlayer` wrapper applied to every channel, or a comment at the open ones saying why they are exempt.
Source: [Electron security checklist, item 17](https://www.electronjs.org/docs/latest/tutorial/security), [IpcMainEvent](https://www.electronjs.org/docs/latest/api/structures/ipc-main-event), [IpcMainInvokeEvent](https://www.electronjs.org/docs/latest/api/structures/ipc-main-invoke-event)

**Ad-hoc signing gives every packaged build a new code identity, which the Keychain-backed token store is not documented to tolerate** (low)
`scripts/package.sh:35-36`, `src/main/soundcloud/token-store.js:22-31`, `src/main/soundcloud/token-store.js:43-44`, `docs/soundcloud.md:98-101`, `docs/testing.md:171-191`
package.sh:36 `codesign --force --deep --sign - "$APP"` (pre-existing line) means each `npm run package` output is a different identity to Keychain ACLs. Electron's docs say that without a consistent signature macOS may re-prompt for Keychain permission on every build; a third-party report says an ad-hoc-signed package can fail the lookup entirely. If the prompt is denied or the lookup fails, `requireEncryption()` throws "Secure credential storage is unavailable. Enable your system keychain before connecting SoundCloud." (token-store.js:29), which is misleading because the keychain is fine. Only the optional account-sign-in path is affected (a missing file never touches Keychain, :41-46), and that path is already marked unverified. Needs a Mac to observe.
Fix: document the signing requirement in docs/soundcloud.md next to :98-101, add a packaged-app sign-in/Keychain step to the packaged checks in docs/testing.md:171-191, and reword the storage_unavailable message so it does not claim the keychain is disabled.
Source: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [electron_api_safe_storage.cc v44.7.0](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_safe_storage.cc), [Clerk Electron storage notes](https://clerk.com/docs/reference/electron/storage)

**The token store uses the synchronous safeStorage API, which can block the main thread on a Keychain prompt** (low)
`src/main/soundcloud/token-store.js:44`, `src/main/soundcloud/token-store.js:59`, `src/main/soundcloud/auth.js:120`
`safeStorage.decryptString` (:44) and `encryptString` (:59) run inline on the JS thread; Electron recommends the async API and warns that on macOS these calls "can block the current thread to collect user input". The PR body's "Authentication deadlines and cancellation also cover waiting for saved tokens" holds for JS-level queueing (`op.wait(loadTokens())`) but cannot pre-empt a native block, so a Keychain prompt during the first SoundCloud action freezes IPC, menus and the 120 s auth timer (auth.js:120) until answered. Nothing touches the store at launch, and only the account path has a file, so the freeze is at first use. PR #2 already replaces this with the async API.
Fix: none needed if #2 lands with #1; if #1 is validated or merged alone, note the freeze in docs/soundcloud.md or pull the async change down.
Source: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [electron_api_safe_storage.cc v44.7.0](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_safe_storage.cc)

**README and the research doc say switching sources "pauses" the previous one; SoundCloud is stopped and released** (low)
`README.md:31`, `README.md:178-179`, `docs/soundcloud-research.md:13`, `src/main/playback.js:56-63`, `src/main/playback.js:77-83`, `src/renderer/soundcloudAudio.js:164`, `src/renderer/soundcloudAudio.js:66-70`
`select()` sends `stop` to the host session, clears `session`, `media.clear()`, then resets `state.track = null`, `queue = []`, `index = -1` (:77-83); the renderer's `stop` handler calls `release()` (:164), which destroys hls.js and unloads the element (:66-70). Only Spotify is paused (main.js:949-955). A user on a SoundCloud playlist who double-clicks a Spotify entry and then picks Playback > Use SoundCloud gets an empty player, not a paused playlist. The behaviour is deliberate and asserted by tests/playback.test.js:97-110, whose name ("switching sources pauses the old source") has the same wording problem. The PR body and docs/testing.md:159-161 describe it correctly.
Fix: reword the three sentences to "stops SoundCloud and pauses Spotify", and rename the test.

**`NODE_USE_ENV_PROXY=1` is recommended but does nothing on Node 22.12 to 22.20, which the same PR declares supported** (low)
`docs/testing.md:85-86`, `docs/soundcloud.md:150-151`, `package.json:32`, `README.md:43`, `docs/testing.md:3`, `src/main/main.js:927`
Node's CLI docs list `NODE_USE_ENV_PROXY` as "Added in: v24.0.0, v22.21.0" and Stability 1.1. The floor is `"node": ">=22.12"`, so on 22.12-22.20 `node scripts/check-soundcloud.js` silently ignores the variable and runs without the proxy. The `npm start` route is unaffected because Electron 44.7.0 bundles Node 24.21.
Fix: say the variable needs Node 22.21 or 24, or raise the floor.
Source: [Node CLI docs](https://nodejs.org/api/cli.html), [Electron releases](https://releases.electronjs.org/releases.json)

**docs/soundcloud.md presents application-token mode and the public-client sign-in as interchangeable, but a public-client exception removes client_credentials for that app permanently** (low)
`docs/soundcloud.md:66-67`, `docs/soundcloud.md:78-79`, `docs/soundcloud-research.md:35`, `src/main/main.js:69`
The research doc cites soundcloud/api#365, where SoundCloud staff say marking an app public "will disallow you from client credentials" and that it is "an action that can't be undone". The setup doc never says this, and main.js:69 routes to `reconnect()` (client credentials) whenever `SOUNDCLOUD_CLIENT_SECRET` is set, so a developer who gets the exception and later sets the secret gets "SoundCloud authentication failed. Check the application credentials...". The source is a maintainer comment, not official docs.
Fix: one warning in docs/soundcloud.md near :66-67 that, according to SoundCloud staff on the cited issue, the exception forfeits application-token mode for that client ID, and a recommendation to register a separate app for it.
Source: [soundcloud/api#365](https://github.com/soundcloud/api/issues/365), [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide)

**No workflow runs the 180 tests or the renderer build** (low)
`.github/workflows/release.yml:5-7`, `package.json:15`
The only workflow triggers on `v*` tags and runs `npm ci` and `npm run package:release`. The absence of CI is pre-existing, but the asset it would protect (the suite and the "180 tests ... pass" claim that the three stacked PRs re-assert) is new, and a Linux job needs no display for `node --test`.
Fix: add a ci.yml on push and pull_request running `npm ci`, `npm test` and `npm run build` on ubuntu-latest.
Source: [Electron testing on headless CI](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)

**The main-process audio bridge has no unit coverage** (low)
`src/main/main.js:40-51`, `src/main/main.js:57-63`, `src/main/main.js:653-657`, `src/main/main.js:861-869`
`sendAudio` (requestId map, 10 s timer), `cancelAudioRequests`, the `did-start-loading` hook and the `playback:audio-done` handler live in main.js, which no file under tests/ loads, so losing the 10 s timeout (which would leave `loadTrack`'s `await audio.send(...)` at playback.js:140 hanging if the renderer never acks) passes `npm test`. The reload cancellation is exercised only by the Electron fixture on a Mac. The renderer half of the ack protocol is unit-tested.
Fix: extract the bridge into an injectable module in the style of playback.js and test the timeout and reload cancellation.
Source: [Electron automated testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing)

**No asserting Electron self-test presses Stop, and the recorded validation predates the Stop contract change** (low)
`docs/testing.md:195`, `tests/helpers/soundcloud-fixture.js:136-160`, `src/renderer/playbackMedia.js:84-91`, `src/main/playback.js:222-241`
docs/testing.md:195 records the macOS run "for commit `c69cd44`", and 1894a73 later changed Stop from pause-then-seek in the renderer to a single `stop` command (playbackMedia.js:88) handled at playback.js:222-241. The asserting fixture clicks `#pause`, then seek, volume, play, next and reload, never Stop. Unit coverage of both halves is real (removing the SoundCloud stop branch fails 7 tests, the Spotify half 3), so this is a modest gap; the Webamp button to `stop` IPC path can only be checked on macOS.
Fix: add a Stop step to the asserting offline fixture, and either re-run or add a note under Recorded validation that Stop was not re-run after 1894a73.
Source: [Webamp custom media implementation](https://docs.webamp.org/docs/API/custom-media-impl), [Webamp IMedia](https://raw.githubusercontent.com/captbaritone/webamp/master/packages/webamp/js/media/index.ts)

**The playback.test.js audio fixture reports state synchronously before the ack, which the real renderer never does** (low)
`tests/playback.test.js:47-66`, `src/renderer/soundcloudAudio.js:30-40`, `src/renderer/soundcloudAudio.js:182`
The fixture calls `instance.audioState(...)` inside `send()` before the promise resolves. The real renderer acks in `finally` (:182) and throttles reports by up to 250 ms (:30-40), so main-process `state.state` can lag the ack, and a playpause issued in that window (:264-266 derives it from `state.state`) re-sends `pause`. Narrow (two toggles within about 250 ms), but the suite cannot observe it.
Fix: add a fixture mode that acks first and defers the state report by a tick, and a playpause-within-window test.

**The media-host allowlist and credential-key regex are maintained twice, with one difference** (low)
`src/main/soundcloud/client.js:9`, `src/main/soundcloud/client.js:78-79`, `src/main/soundcloud/media-proxy.js:16-19`, `src/main/soundcloud/media-proxy.js:20-23`, `src/main/soundcloud/media-proxy.js:27`
Same four hosts and the same four credential keys in both files; the proxy additionally rejects an explicit `:443` authority (:20-23) that `httpsURL` accepts. Harmless today because `streamURL` returns the normalized href, but a host added only to `streamURL` passes the client tests and is rejected at runtime with the opaque "SoundCloud media is unavailable." The comment at client.js:77 shows the CDN host has already changed once.
Fix: one shared module exporting the allowlist and the credential regex, and decide the `:443` rule once.

**The Spotify URI grammar is copied four times and playShelf validates twice, with the second check unreachable** (low)
`src/main/playback.js:151-153`, `src/main/playback.js:208`, `src/main/main.js:482`, `src/main/shelf.js:7`
`/^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/` appears at all four sites (base had two). `command()` rejects at :208 before calling `playShelf`, and `playShelf` is not exported, so the `throw new Error("Unsupported music link")` at :151-153 is dead.
Fix: one exported regex or provider helper, validate once at the `command()` boundary, delete the dead throw.

**Fatal hls.js MEDIA_ERROR skips the library's one-shot `recoverMediaError()`** (low)
`src/renderer/soundcloudAudio.js:131-137`, `src/main/playback.js:275-276`
The ERROR handler treats every fatal error the same (error state, `stopLoad()`, pause) without inspecting `data.type`. hls.js documents `recoverMediaError()` for fatal MEDIA_ERROR (rate-limited to one attempt), which resets the MediaSource in place; here recovery needs an explicit Play that re-runs `loadTrack` with a fresh `/streams` request and a new Hls instance.
Fix: on `data.fatal && data.type === MEDIA_ERROR`, call `hls.recoverMediaError()` once (with a 5 s guard) before surfacing the error.
Source: [hls.js v1.7.3 API: Fatal Error Recovery](https://raw.githubusercontent.com/video-dev/hls.js/v1.7.3/docs/API.md)

### Minor

**The "suppress stale ... play rejections" test never asserts the `play-old` ack** (nit)
`tests/soundcloud-audio.test.mjs:96-116`, `src/renderer/soundcloudAudio.js:85`
The guard at :85 only affects the ack, and the test asserts only on `h.reports`, so removing the guard passes.
Fix: `assert.deepEqual(h.acknowledgements.find((a) => a.requestId === "play-old"), { requestId: "play-old", session: "old" })`.

**Half of the series is rename/reword/delete of things the series itself added, and validation is pinned to a mid-series hash** (nit)
`docs/testing.md:195`
29ce12b, 97e607d and 773ddcb rework c8fd217's own names and strings, and docs/soundcloud-tasks.md is added in c8fd217 and deleted in db869c6. Rewriting history now would force rebases of #2-#4, so only the cheap parts are worth it.
Fix: squash or fixup at merge time, and make the "commit `c69cd44`" reference survive a rebase (date plus tag, or "PR #1 head at validation").
Source: [git SubmittingPatches](https://raw.githubusercontent.com/git/git/master/Documentation/SubmittingPatches)

**Three hand-written reset blocks and four copies of the idle prompt in playback.js** (nit)
`src/main/playback.js:75-87`, `src/main/playback.js:98-105`, `src/main/playback.js:352-361`, `src/main/playback.js:26`, `src/main/playback.js:80`, `src/main/playback.js:287`, `src/main/playback.js:361`
The three blocks reset different subsets (rendererReset keeps `visited` and `wantsPlay`); the differences are harmless today but nothing says which are deliberate.
Fix: a `resetQueue()` helper and an `IDLE_MESSAGE` constant.

**main.js duplicates reconnect()'s own mode decision using a different signal** (nit)
`src/main/main.js:68-70`, `src/main/main.js:932`, `src/main/soundcloud/auth.js:333-334`
`reconnect()` already falls back to `connect()` when there are no application credentials. main.js:69 re-decides with `process.env.SOUNDCLOUD_CLIENT_SECRET`, while :932 passes `"offline-fixture-secret"` in fixture mode, so the two can disagree there.
Fix: call `await soundcloudAuth.reconnect()` unconditionally.

**`DEFAULT_REDIRECT_URI` is exported but never imported; the literal is pasted twice** (nit)
`src/main/soundcloud/auth.js:6`, `src/main/soundcloud/auth.js:384`, `src/main/main.js:933`, `src/main/main.js:940`
Fix: import the constant (or omit `redirectUri` so the default parameter applies), or drop the export.

**src and tests import each other, and packaged builds silently skip the soundcloud self-test modes** (nit)
`src/main/main.js:922-924`, `src/main/selftest.js:17-23`, `tests/helpers/soundcloud-live.js:7`
main.js and selftest.js require `tests/helpers/*`; soundcloud-live.js requires `src/main/spotify-selftest` for `bounded()`. selftest.js:19 and :22 fall through to the layout test when `app.isPackaged`, with no message (the `soundcloud-live-real` branch at :11-16 does print one). The placement is documented and guarded, so this is structural.
Fix: move `bounded()` to a shared util, and print a skip reason for the two silent modes.

**"Forget Local SoundCloud Sign-in" stops playback by re-selecting the current provider** (nit)
`src/main/main.js:601-604`
The effect of `playbackCommand("selectProvider", "soundcloud")` on an already-selected provider (stop, release handles, reset queue) is only discoverable in `select()`. The sibling items use `playback?.getProvider()`; this one uses `playback.getProvider()` (cosmetic, menus are built after `playback` exists).
Fix: a one-line comment or a named coordinator operation such as `stopCurrent()`.

**A local `const fetch` shadows the global inside whenReady** (nit)
`src/main/main.js:923-929`
It forces the `globalThis.fetch` spelling at :928 and will capture any future `fetch(...)` in that block.
Fix: rename to `soundcloudFetch`.

**Checked and fine.** "Forget Local SoundCloud Sign-in" only deletes the local file and does not call SoundCloud's `/sign-out`; the label says "Local" and docs/soundcloud.md:105-106 says so, which is a reasonable scope for an unverified sign-in path. token-store.js:48 contains a "Disconnect SoundCloud and connect again" string, but auth.js:68-71 replaces every store error before it can reach a user, so the stale wording is not user-facing.

### Unverified notes

These came from the finders but had no verifier result, so treat them as leads, not findings.
- pr1-35 (unverified): the PR body's mermaid edge "Proxy -> opaque media handles -> Audio" misdescribes the flow; the coordinator delivers handles, the proxy serves bytes on request.
- pr1-36 (unverified): the three PR-body links point at the branch name and will 404 once the branch is deleted after merge.
- pr1-37 (unverified): docs/soundcloud.md:160 says Webamp and native menus share "the same IPC commands"; menu clicks call the coordinator in-process without IPC.
- pr1-38 (unverified): docs/testing.md:33 says any nonempty `NOSTALGIFY_MOCK` enables the mock, but the SoundCloud fixture and self-test modes require exactly `"1"` (main.js:922, selftest.js:19/22).
- pr1-39 (unverified): the redirect-URI error at auth.js:22 attributes Nostalgify's loopback-only rule to SoundCloud, whose guide suggests custom URI schemes.
- pr1-40 (unverified): tests/soundcloud-auth.test.js binds an ephemeral port, releases it and re-binds later, and one test uses a real 50 ms timer; possible CI flake sources.
- pr1-41 (unverified): the refresh_token grant at auth.js:324 omits `redirect_uri`, which the OpenAPI schema marks required for that grant while the guide example omits it.

### Coverage

Checked: `npm test` at the pr1 head (180 tests, 180 pass, 1.26 s in this run; the finders ran it five times with no flakes, and the base checkout has no tests directory, so the whole suite is new); `npm run build` exits 0. The full diff 28e08b5...f43461a (52 files, 6943 insertions, 289 deletions) was read by six lenses (security, correctness, tests and verification, narrative accuracy, clarity, standards and prior art), plus the per-commit diffs of c69cd44, 1894a73 and f43461a and the base versions of main.js, selftest.js and spotifyMedia.js for pre-existing versus new. Probes written in scratch copies: the dead-allowlist probe for `command()`, the token-endpoint 429 probe, the end-of-queue seek/previous probe, the playlist-halt-on-blocked-track probe, and 21 revert-the-fix mutation experiments (18 broke at least one test). Docs and prior art read: the Electron security checklist, safeStorage, ipcMain, protocol, net and ClientRequest docs and the v44.7.0 safe_storage source; the SoundCloud guide, Terms of Use, rate limits and OpenAPI schema plus soundcloud/api issues 365, 441, 478, 532, 571 and 578; hls.js v1.7.3 API.md and LICENSE; the WHATWG media spec; Node CLI docs; the Webamp IMedia type and Webamp 2.3.1 bundle; RFC 8252; git SubmittingPatches; PR #1 and #2 metadata on GitHub. The SoundCloud logo asset was verified byte-identical to the Media Kit file. Every path:line quoted above was re-opened at the pr1 checkout before writing.

Not checkable here: Electron cannot launch in this Linux container, so the Automation-denied path, Spotify cold-launch timing, Keychain prompts under ad-hoc signing, the main-thread freeze on a Keychain prompt, the Webamp Stop button to `stop` IPC path end to end, and the offline Electron fixture all need a Mac. No live SoundCloud or Spotify calls were made, so token quotas, blocked-track behaviour on real playlists and stream expiry were judged from code and docs only.

### References

- [SoundCloud API Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use)
- [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide)
- [SoundCloud API rate limits](https://developers.soundcloud.com/docs/api/rate-limits)
- [SoundCloud OpenAPI schema](https://developers.soundcloud.com/docs/api/explorer/api.json)
- [soundcloud/api issue 365](https://github.com/soundcloud/api/issues/365)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron IpcMainEvent](https://www.electronjs.org/docs/latest/api/structures/ipc-main-event)
- [Electron IpcMainInvokeEvent](https://www.electronjs.org/docs/latest/api/structures/ipc-main-invoke-event)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [electron_api_safe_storage.cc v44.7.0](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_safe_storage.cc)
- [Clerk Electron storage notes](https://clerk.com/docs/reference/electron/storage)
- [Electron automated testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing)
- [Electron testing on headless CI](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)
- [Webamp custom media implementation](https://docs.webamp.org/docs/API/custom-media-impl)
- [Webamp IMedia type](https://raw.githubusercontent.com/captbaritone/webamp/master/packages/webamp/js/media/index.ts)
- [WHATWG media element](https://html.spec.whatwg.org/multipage/media.html)
- [Node CLI docs](https://nodejs.org/api/cli.html)
- [Electron releases JSON](https://releases.electronjs.org/releases.json)
- [hls.js v1.7.3 API.md](https://raw.githubusercontent.com/video-dev/hls.js/v1.7.3/docs/API.md)
- [git SubmittingPatches](https://raw.githubusercontent.com/git/git/master/Documentation/SubmittingPatches)
- [PR #1 on GitHub](https://github.com/MarcelCutts/nostalgify/pull/1)

## PR #2: Keep SoundCloud token storage responsive

**Verdict: approve with non-blocking fixes.** Nothing here is a correctness bug on the supported platform. Four items are worth fixing before the stack lands because they affect what the tests prove and what users read; three are minor.

The PR swaps the base's three synchronous safeStorage calls (pr1 token-store.js:24 `safeStorage?.isEncryptionAvailable()`, :44 `decryptString`, :59 `encryptString`) for the async trio and keeps every operation in one `serialized` queue (c38587f token-store.js:15-20). The key decision is right: the `shouldReEncrypt` rewrite runs inside load()'s own queue entry (:85-87) rather than being re-queued, so a clear issued during rotation cannot be undone by a late write and the self-deadlock is avoided; the test at tests/token-store.test.js:162-190 pins that ordering for both save and clear. The temp-file, fsync, rename and 0600 write path and the O_NOFOLLOW size-capped read are carried over unchanged, the decrypt result shape is checked (:81-83), and every thrown message is a constant so adapter text never leaks (tests :111, :217, :236). The Linux v10 guard is justified by Electron 44.7.0's provider table (browser_process_impl.cc:515-519 registers PosixKeyProvider as the Linux fallback independently of the sync backend label) and is correctly platform-scoped because the macOS Keychain provider also emits v10. The async-only test (:116-125) is a strong guard against the one in-repo regression that could block the main thread. Suite goes from 180 to 188, all passing.

### Should fix

**The rotation tests hang instead of failing when the rewrite goes missing** (pr2-06, low)
tests/token-store.test.js:180 (and :151)
`await entered.promise;` is resolved only from inside the stubbed `encryptStringAsync` (:174-178). If load() ever stops calling it, the promise never settles. Node's runner unrefs the `{ timeout: 5000 }` timer (lib/internal/test_runner/test.js:135-136: `timer = setTimeout(() => deferred.resolve(), timeout); timer.unref();`), so the loop drains and the runner cancels the test and everything after it. I reproduced this in a scratch copy by replacing line 87 `if (decrypted.shouldReEncrypt) await writeTokens(tokens);` with a comment: 8 pass, 7 cancelled in 0.28 s, each reported as `failureType: 'cancelledByParent'` with 'Promise resolution is still pending but the event loop has already resolved'. Test 10 (:192-204), whose `assert.notDeepEqual(rotated, previous)` at :202 would have named the regression, never runs, and neither do the Linux-guard (:243, :261) and symlink (:275) tests.
Fix: race the hook against the operation so a load that finishes without re-encrypting fails with a message. At :180: `await Promise.race([entered.promise, loading.then(() => assert.fail('load resolved without re-encrypting'))]);` and the same at :151 with `pending`. The `timeout` option can then go.
Source: [Node test runner source](https://raw.githubusercontent.com/nodejs/node/v22.x/lib/internal/test_runner/test.js)

**The 'event-loop responsiveness' test cannot detect what it is named for, and the docs state the property as fact** (pr2-04, low)
tests/token-store.test.js:154; docs/soundcloud.md:101
`assert.equal(settled, false, \`${method} is still awaiting Keychain\`)` checks that an awaited, deliberately unresolved fake has not resolved. The verifier's mutation runs show it has no unique detection power: a no-await on `isAsyncEncryptionAvailable` (:24) still passes it, and the one mutation that trips it (fire-and-forget save) also fails eight other tests. Main-thread blocking is an Electron/Chromium property (Keychain IO is posted to a ThreadPool worker, keychain_key_provider.mm:34 "This function runs on a worker thread and performs blocking Keychain IO", :82-83) that a Node suite with an async fake cannot observe. What the suite really guarantees is the sync-method guard at :116-125 and the queued-clear ordering at :158. Yet the PR body lists 'event-loop responsiveness' under coverage, and docs/soundcloud.md:101 now says 'Keychain prompts leave the app responsive.' as fact, while the unverified lists at docs/soundcloud.md:113-114 and docs/testing.md:204-205 do not mention it.
Fix: rename the test to what it proves ('queued clear waits for an in-flight Keychain call'), drop or reword the `settled` assertion, attribute responsiveness in the PR body to Electron's documented async API rather than to coverage, hedge the docs sentence ('Electron performs the Keychain lookup off the main thread; not yet verified on macOS'), and add Keychain prompt responsiveness to both unverified lists.
Source: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage): "The async API is non-blocking, supports key rotation, and handles temporary unavailability gracefully."

**The storage_unavailable branch models a state Electron 44 cannot produce on macOS, while the real denial signal is discarded** (pr2-02, low)
src/main/soundcloud/token-store.js:24
requireEncryption() gates on `if (!await safeStorage?.isAsyncEncryptionAvailable() ||`. In Electron 44.7.0, `OnOsCryptReady` sets `is_available_ = true;` unconditionally (electron_api_safe_storage.cc:89-92), and `IsAsyncEncryptionAvailable` resolves false only `if (!electron::Browser::Get()->is_ready())` (:165-168); the store is built inside `app.whenReady()` (main.js:912-935), so that never happens. After a denied Keychain prompt, Chromium maps the empty password to `kTemporarilyUnavailable` (keychain_key_provider.mm:54-58) and Electron rejects decrypt with "safeStorage.decryptStringAsync is temporarily unavailable. Please try again." (:353-356). The store collapses that rejection into `storage_error` (:89-92), whose text ends with the Forget step for a sign-in that a restart with Allow would recover. My probe with an Electron-44-shaped adapter (availability true, no `getSelectedStorageBackend`, decrypt rejecting with that exact message) gave `load -> storage_error`, `save -> storage_error`, `auth.status -> storage_error`. So the five `isAsyncEncryptionAvailable: async () => false` and missing-method cases (tests :48-56, :225-236) and the separate auth.js:69-71 sentence cover a condition the pinned Electron does not produce on the only supported platform. This is new: the base's sync `isEncryptionAvailable()` did reflect Keychain state. Impact is limited because the Connect dialog (main.js:73) is the only display path and the sentence leads with the restart remedy; client.js:176-178 and media-proxy.js:230-232 replace getAccessToken failures with generic text.
Fix: treat isAsyncEncryptionAvailable() as the 'API present and app ready' check it is. Classify a decrypt or encrypt rejection matching /temporarily unavailable/ as `storage_unavailable` with restart-only guidance; keep 'Error while decrypting' and bad JSON as `storage_error` with the Forget step. Replace the `async () => false` fixtures with an adapter that resolves true and rejects with Electron's exact messages, and assert the resulting code and sentence through createSoundCloudAuth as well. Note in docs/soundcloud.md that the availability check does not reflect Keychain consent in Electron 44.
Sources: [electron_api_safe_storage.cc v44.7.0](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_safe_storage.cc), [keychain_key_provider.mm 152.0.7977.130](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/components/os_crypt/async/browser/keychain_key_provider.mm)

**The per-operation store messages rewritten in f2c5913 are dead text; auth.js shows one keychain sentence for every failure** (pr2-03, low)
src/main/soundcloud/auth.js:68-75
`storageFailure()` reads only `error?.code` and returns one of two fixed sentences, both starting 'Saved SoundCloud sign-in could not be accessed securely. Unlock your system keychain'. It wraps every store call (:86 load, :199 save, :323 clear during refresh, :367 clear in disconnect), and auth.js is the store's only consumer (main.js:935). So the six sentences f2c5913 rewrote in token-store.js (:31, :45, :56, :75, :92, :104) are never shown; :104 'Saved SoundCloud sign-in could not be removed. Check the application data directory permissions.' is the accurate one and it is the one thrown away. Inside writeTokens(), the single catch at :54-56 also blames the keychain for mkdir, open, writeFile and rename failures. The structure predates the PR (pr1 auth.js:68-70 did the same substitution), and the only display path is the Connect dialog, so user impact is small. But the commit titled 'Clarify account-token storage and recovery messages' made both layers longer and more specific without making the specific layer reachable.
Fix: pick one owner for the words. Either pass the store's already-sanitized message through for the two storage codes (`return authError(error.code, error.message)`) and keep auth prose only for unknown errors, or keep the prose in auth.js and parameterize it by operation. In writeTokens(), wrap only `safeStorage.encryptStringAsync(...)` in the keychain-flavoured catch and let fs failures share clear()'s directory-permissions sentence. Make tests/soundcloud-auth.test.js:261-266 assert the sentence that is actually displayed.

### Minor

**A failed re-encryption after a successful decrypt is reported as a read failure** (pr2-01, low)
src/main/soundcloud/token-store.js:87
`if (decrypted.shouldReEncrypt) await writeTokens(tokens);` sits inside load()'s try, so any fs error during the rotation rewrite (or the Linux v10 write guard at :44-46) lands in the catch at :89-92 and becomes `storage_error` 'Saved SoundCloud sign-in could not be read securely ... use Playback > Forget Local SoundCloud Sign-in', although the tokens were decrypted and the old ciphertext is intact. In application mode auth.js:83-93 swallows the error and sets `loaded = true`, so the saved sign-in is silently dropped for the session. Chromium documents the flag as advice ("should be re-encrypted with a call to Encrypt", encryptor.h:103-106) and Element Web treats a failed rewrite as non-fatal (store.ts:143-153: "Failing to do so is not fatal - we still have the secret"). The test at tests :217 pins the fail-closed choice. With Electron 44.7.0's single macOS KeychainKeyProvider (browser_process_impl.cc:522-528) the flag cannot become true, so there is no impact today; this is a design choice to make explicit rather than a bug.
Fix: wrap the rewrite in its own try/catch that logs a sanitized warning and still returns `tokens`, keeping it inside the same queue entry; change tests :217 to `assert.deepEqual(await store.load(), { token: 'preserved' })` while keeping the ciphertext and temp-file assertions. If fail-closed is intended, say so in the comment at :85-87 and in docs/soundcloud.md:105-106, and make the message say the sign-in was read but could not be re-encrypted.
Sources: [encryptor.h 152.0.7977.130](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/components/os_crypt/async/common/encryptor.h), [Element Web store.ts](https://raw.githubusercontent.com/element-hq/element-web/7c7df8d244e1ce366e20e293ce75d6cd2066c02a/apps/desktop/src/store.ts)

**The rewritten docs link the safeStorage page but skip its macOS signing caveat, and 'unlock it' is the wrong remedy for a denied prompt** (pr2-09, low)
docs/soundcloud.md:107-108
The new sentence reads 'If Keychain access is denied or unavailable, unlock it and restart Nostalgify before trying again.' The linked Electron page says: "On macOS, your app should be code signed for safeStorage to behave consistently. Without a valid, consistent signature, macOS may not recognize different builds of your app as the same application, which can cause the Keychain to re-prompt the user for permission on every update." scripts/package.sh:36 signs ad hoc (`codesign --force --deep --sign - "$APP"`), so every rebuild re-prompts, and a Deny at that prompt is fixed by restarting and choosing Always Allow, not by unlocking the login keychain. The omission is pre-existing in spirit, but the recovery guidance is new in this PR.
Fix: say that the ad-hoc build re-prompts after each `npm run package`, that the answer is Always Allow, that a denial disables secure storage until restart, and that a stable Developer ID signature is what Electron requires for prompt-free updates. Align the in-app `storage_*` strings (token-store.js:31/:45/:56, auth.js:70-71) with the same wording.
Sources: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)

**The Linux v10 read guard is a copy of the write guard and sends a permanently rejected file to the wrong message** (pr2-05, nit)
src/main/soundcloud/token-store.js:73-76 vs :42-46
Byte-identical three-line blocks, the explanatory comment on the write copy only, and the string 'Secure storage is unavailable. Unlock your system keychain, restart Nostalgify, and try again.' at :31, :45 and :75. On read, a v10 file gets `storage_unavailable` text that a restart can never fix, bypassing both the :92 message that names the only remedy (Forget) and the shouldReEncrypt rotation that would have migrated it. Only foreign or tampered files can reach it (the write guard shipped in 9cb943c, and the app is macOS-only), hence a nit.
Fix: one helper near storageError() (`rejectLinuxFallback(ciphertext)` plus a shared `unavailable()` error with the comment once), then decide the read policy: let a v10 file decrypt and rotate, or fail it with the Forget message.

### Checked and fine

Two things a reader might wonder about that I looked at and would not change. The PR re-encrypts with `encryptStringAsync` on `shouldReEncrypt`, while the Electron page says "If true, you should call decryptStringAsync again". Chromium's encryptor.cc:267 `flags->should_reencrypt = provider != provider_for_encryption_;` makes the PR's reading the correct one; the doc sentence is the imprecise party. And the body's 'macOS ciphertext compatibility' phrase is backed only by the platform-gate test at tests :261-273 with a hand-made buffer, but the next sentence already says sign-in persistence is unverified, and the Chromium source confirms the macOS async provider uses the same v10 tag and key derivation as the sync backend, so files written by #1 should decrypt.

### Unverified notes

These four had no refuter result, so they are listed, not asserted:
- pr2-13 (nit): the rotation comment at token-store.js:85-87 explains the queueing but not why the code re-encrypts rather than following the linked Electron sentence; a future literal 'fix' would silently stop rotating.
- pr2-14 (nit): the comment at :77-78 still says 'prompting/blocking' though the store no longer blocks, and the JSDoc at :10 dropped the base's no-plaintext policy sentence.
- pr2-15 (nit): the fixture at tests :32 leaves `platform` to the host, so the v10 prefix check runs on Linux CI but not on a Mac; pin it to 'darwin' except in the Linux tests.
- pr2-16 (nit): the stored artifact is called account tokens, user tokens, sign-in and Secure storage across body, docs, comments and messages.

### Coverage

Checked here: the full diff f43461a...c38587f (5 files, 252 insertions, 48 deletions) and each of the four commits; token-store.js and auth.js in full at c38587f and at the base; main.js wiring (store built inside app.whenReady(), Connect dialog at :73, Forget menu at :601-604); client.js and media-proxy.js error paths. I ran `npm test` in a scratch copy of c38587f: 188 pass, 0 fail (base is 180; the eight new tests are all in tests/token-store.test.js). The finders also ran `npm run build` at head successfully. Probes I wrote: removing the rotation rewrite at :87 (8 pass, 7 cancelled, 0.28 s), and an Electron-44-shaped adapter driven through the store and createSoundCloudAuth (storage_error on load, save and status). I also drew on the verifiers' probes: an ENOSPC rename after a successful decrypt with shouldReEncrypt (pr2-01), clear() EACCES through disconnect (pr2-03), and a mutation matrix over token-store.js (pr2-04, pr2-06). Read for this review: the Electron safeStorage page and code-signing tutorial, Electron v44.7.0 electron_api_safe_storage.cc and browser_process_impl.cc, Chromium 152.0.7977.130 encryptor.h, encryptor.cc and keychain_key_provider.mm, Node v22 test runner source, and Element Web's store.ts as prior art. The kUseKeychainKeyProvider default (chrome_features.cc, ENABLED_BY_DEFAULT) and the once-per-process key ring (os_crypt_async.cc) come from the verifier notes.

Not checkable here: anything that needs macOS or a running Electron. That includes the real Keychain prompt and its Deny path, whether the ad-hoc signed bundle re-prompts per rebuild, responsiveness during a live prompt, decrypting a file written by #1's sync API, account sign-in persistence across launches, and whether a future Electron adds a second macOS key provider that would make shouldReEncrypt true.

### References

- [Electron safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron code signing tutorial](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron_api_safe_storage.cc at v44.7.0](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_safe_storage.cc)
- [browser_process_impl.cc at v44.7.0](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/browser_process_impl.cc)
- [Chromium encryptor.h at 152.0.7977.130](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/components/os_crypt/async/common/encryptor.h)
- [Chromium encryptor.cc at 152.0.7977.130](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/components/os_crypt/async/common/encryptor.cc)
- [Chromium keychain_key_provider.mm at 152.0.7977.130](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/components/os_crypt/async/browser/keychain_key_provider.mm)
- [Node v22 test runner test.js](https://raw.githubusercontent.com/nodejs/node/v22.x/lib/internal/test_runner/test.js)
- [Element Web apps/desktop/src/store.ts](https://raw.githubusercontent.com/element-hq/element-web/7c7df8d244e1ce366e20e293ce75d6cd2066c02a/apps/desktop/src/store.ts)
- [Chromium chrome_features.cc at 152.0.7977.130 (verifier-read)](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/chrome/common/chrome_features.cc)
- [Chromium os_crypt_async.cc at 152.0.7977.130 (verifier-read)](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/components/os_crypt/async/browser/os_crypt_async.cc)

## PR #3: Disable decorative EQ controls for both sources

**Verdict: request changes.** The runtime behaviour is right and nothing here is user-breaking. The one thing to fix before merge is the test that was added to guard the new DOM code: it cannot fail for the property its name promises. Everything else is minor.

This PR replaces the base's hand-set loudness curve (pr2 `src/renderer/eq.js:7-19`, applied with `SET_EQ_ON` at :28) with a flat, OFF display, which stops the UI implying that the EQ shapes the audio for either source. The rewrite is careful where it matters. `resetDisplay()` only dispatches when state deviates from the fixed point (`eq.js:24-28`, `if (value === 50) continue;`), so preset loads and `SET_BAND_VALUE` bursts converge without a loop, and the `resetting` guard keeps the nested subscriber call from double-dispatching. `setProvider()` normalises its input to `"spotify"` or `"soundcloud"` before indexing `DESCRIPTION` (`eq.js:81`), so no IPC string reaches the DOM. The dispatch shapes match Webamp 2.3.1's equalizer reducer, including the `preamp` versus numeric band key. The `allowed()` to `canShowPanel()` rename is clean with no stale callers (`renderer.js:221`). eq.js gains its first unit tests (the base had none), the fakes are restored via `t.after`, and README.md and docs/soundcloud.md now say the same thing as the code; the "Spotify Settings > Playback > Equalizer" string matches Spotify's own support page.

### Should fix

**The eq-policy test cannot fail for an over-broad or wrong `CONTROLS` selector (medium, pr3-01)**
`tests/eq-policy.test.mjs:15`, `:36-37`, `:84`, `:105-108`
The fake DOM discards the selector (`querySelectorAll() { return children; },`) and the close/shade/volume nodes are never placed inside the panel (`panel = element({ children: [band, on, presets] });`), so the test named "source-specific disabled semantics survive control replacement without disabling working window controls" asserts `tabIndex === 0` and no `aria-disabled` on nodes that nothing could ever touch. I re-ran it in a scratch copy with `CONTROLS = "*"`: 3/3 pass. In the real Webamp 2.3.1 DOM, `#equalizer-shade`, `#equalizer-close` and the shade-mode `#equalizer-volume`/`#equalizer-balance` range inputs all live under `div#equalizer-window` (webamp.bundle.js:33851, :33861, :33906), so an over-broad selector would really disable them and nothing would catch it. The PR body does not overclaim this; the test name does.
Fix: give the fake element a `matches()` over `#id`/`.class` tokens and make `querySelectorAll(selector)` filter the subtree by it. Build the fixture from Webamp's actual markup (div controls `.band`, `#on`, `#auto`, `#presets-context`, `#presets`, `#plus12db`, `#zerodb`, `#minus12db`, plus `#equalizer-shade`/`#equalizer-close` and the shade-mode inputs, all inside the panel) and assert those last four are untouched. Or run the policy under jsdom 30.1.2 or happy-dom 20.14.6 as a devDependency. At minimum, drop "without disabling working window controls" from the test name.
Sources: [jsdom on npm](https://registry.npmjs.org/jsdom/latest), [happy-dom on npm](https://registry.npmjs.org/happy-dom/latest).

**The "survive control replacement" test never exercises the state-change listener (low, pr3-03)**
`tests/eq-policy.test.mjs:97-100`; `src/renderer/eq.js:69-72`, `:80-86`
`h.policy.setProvider("soundcloud");` at :97 queues the single rAF before `h.replaceControls();` at :98, so the frame flushed at :100 is setProvider's own and the listener's `scheduleDescription()` returns early on the `scheduled` flag. In production the listener is the only path that re-describes after a shade toggle or skin change (renderer.js calls `setProvider` only from `apply()` at :324), and deleting `scheduleDescription();` from the listener keeps the suite at 3/3 (reproduced). The dispatched `WINDOW_SHADE_CHANGED` is not a Webamp action (0 hits in the bundle; the real one is `TOGGLE_WINDOW_SHADE_MODE`, 5 hits), and test 1's title mentions presets and shortcuts that are not exercised (`enableHotkeys: false` at renderer.js:64).
Fix: reorder to `setProvider` -> `flush` -> `replaceControls` -> dispatch `TOGGLE_WINDOW_SHADE_MODE` -> assert the replacement has no `aria-description` yet -> `flush` -> assert it is described. That ordering passes on head and fails when the listener's `scheduleDescription()` is removed. Rename test 1 to say it reverts direct EQ actions.
Source: [Redux Store API](https://redux.js.org/api/store) ("It will be called any time an action is dispatched").

**The `FOCUSABLE` sweep and native `disabled` branch are dead against Webamp 2.3.1 and exist only for the fabricated `<input>` fixtures (low, pr3-02)**
`src/renderer/eq.js:4`, `:47-53`; `tests/eq-policy.test.mjs:17`, `:31`, `:34`
Every `CONTROLS` match is a role-less `div` with no inputs, buttons or tabindex, so `control.querySelectorAll(FOCUSABLE)` matches nothing on the first run (afterwards only `#presets`, which :51 itself tagged), `"disabled" in target` is never true for a div, and the inner `aria-*` writes repeat what :44-45 just wrote. The test reaches those lines only because `if (input) node.disabled = false;` gives the fake slider a `disabled` property; deleting :47-53 fails only that assertion (2/3, reproduced). Click-inertness still comes from the unchanged base CSS `pointer-events: none` rule (app.css:64-75), so what the PR adds is the Redux reset plus ARIA/title text. Also, `aria-disabled` on a role-less div is "Global use deprecated in ARIA 1.2".
Fix: delete `FOCUSABLE` and the `targets` loop, keep the per-control `aria-disabled`/`aria-description`/`title` writes, reword the comment at :66-68 to "re-apply the ARIA description/disabled state", and model the fixture on div-only markup. Optional polish: give the controls real roles (`role="button"` on the switches, `role="slider"` with `aria-orientation="vertical"` on each `.band`) so `aria-disabled` is valid, or mark them `role="presentation"` and rely on the panel-level group description.
Sources: [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/), [HTML form-control infrastructure](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html), [ARIA in HTML](https://www.w3.org/TR/html-aria/).

### Minor

**Panel-wide `title` and group semantics brand the working Close and Shade buttons as "Decorative equalizer" (low, pr3-06)**
`src/renderer/eq.js:39-42`, `:46`
`panel.title = description;`, `role="group"` and `aria-label="Equalizer (decorative)"` sit on `#equalizer-window`. Webamp renders `#equalizer-shade` and `#equalizer-close` without a `title` (bundle :33851), and MDN documents that an element without `title` inherits its parent's, so hovering Close or Shade shows the decorative-EQ tooltip, and in shade mode the still-working volume/balance sliders are announced inside a group named "decorative". The per-control `title` writes at :46 are redundant: `pointer-events: none` means those controls are never the hover target.
Fix: attach the explanatory title/description to the inner content div rather than the window root, or set `title=""` (or explicit "Close" / "Toggle Windowshade Mode") on `#equalizer-shade`/`#equalizer-close` after each render, and drop the per-control `title` writes. Visual confirmation needs macOS.
Source: [MDN title attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/title).

**Re-description runs on every Redux dispatch, not only when the EQ DOM changes (low, pr3-04)**
`src/renderer/eq.js:69-72`, `:57-64`
`__onStateChange` is a plain `store.subscribe`, and Webamp's marquee dispatches `STEP_MARQUEE` every 220 ms even when idle, plus `UPDATE_TIME_ELAPSED` every 200 ms during playback. Each dispatch re-arms one rAF that rewrites about 112 unchanged attributes on the 18 controls, and the corrective EQ dispatches pass through `mediaMiddleware` and the app's `forwardToProvider`. Blink skips style and accessibility invalidation for same-value attribute sets, so this is wasted but cheap work, not a user-visible problem.
Fix: re-describe only when the EQ DOM can change: a `MutationObserver({ childList: true, subtree: true })` on `#equalizer-window`, or react to `TOGGLE_WINDOW`/`CLOSE_WINDOW`/`TOGGLE_WINDOW_SHADE_MODE`/skin actions through the existing `actionListeners`, or return early on a `data-eq-described=<provider>` marker. Swallowing `SET_EQ_ON`/`SET_EQ_AUTO`/`SET_BAND_VALUE` in the existing `__customMiddlewares` chain would also remove `resetDisplay` and the `resetting` flag. The per-frame cost can only be profiled on macOS.
Sources: [Redux Store API](https://redux.js.org/api/store), [MDN MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver), [Blink element.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/dom/element.cc?format=TEXT).

**The on-screen and assistive-technology claims rest on unrecorded manual checks, and the existing `eq` self-test asserts nothing (low, pr3-05)**
`src/main/selftest.js:85-102`; `src/renderer/renderer.js:221`, `:324`; `docs/testing.md:48`, `:195`
No test imports renderer.js: I reverted :221 to the stale `eq.allowed()` and got 191/191 with a clean build (it would surface only as a console TypeError in the capture-phase click handler, since Webamp's own onClick still runs). The `eq` diagnostic already reads `on` and `sliders` but only logs them (`console.log("bands unchanged:", ...)` at :102), and this PR leaves it and docs/testing.md untouched; the eq row and the c69cd44 "Recorded validation" paragraph predate this change. The gap is pre-existing in kind, so this is a note rather than a defect.
Fix: in the `eq` mode, after the Green skin loads, assert `on === false`, `auto === false`, every band `=== 50`, the `#equalizer-window .band[aria-disabled="true"]` count, and that `#equalizer-close` has no `aria-disabled`, exiting nonzero on failure the way `tests/helpers/soundcloud-fixture.js:166-170` does; add this PR's run to "Recorded validation". Running it and the VoiceOver check requires macOS.
Sources: [Electron automated testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing), [Electron headless CI](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci).

**`docs/images/equalizer-flat-off.png` is a 267 KB JPEG under a `.png` name that nothing references (low, pr3-07)**
`docs/images/equalizer-flat-off.png` (commit 8ca1d5d, `Bin 0 -> 267154 bytes`)
`file` reports "JPEG image data, JFIF standard 1.01 ... baseline, precision 8, 1100x928". No README or docs page links it; the only consumer is the PR body's raw URL pinned to the commit SHA, which breaks on rebase while the binary stays in every clone. The image content itself matches the body's description (flat curve, centred bands, ON/AUTO unlit).
Fix: drop 8ca1d5d and attach the screenshot to the PR description, or re-export it as a real PNG and link it from README's "Known limits" bullet so it has a reader.

Checked and fine: `aria-description`. MDN still says to prefer `aria-describedby`, but this is a Chromium-only macOS app and Chromium exposes `aria-description` to VoiceOver via AXCustomContent, so docs/soundcloud.md:134-135 is accurate for this platform. Also fine: the deeper reliance on `webamp.store`/`__onStateChange` under `"webamp": "^2.3.1"`. The pattern pre-exists in renderer.js and layout.js, package-lock.json pins 2.3.1, and Webamp exposes no public EQ API, so there is no better hook.

### Unverified notes

These three had no refuter result and are listed as unverified.
- pr3-13: README.md:135 (184 characters) and docs/soundcloud.md:138 (120 characters) were spliced into wrapped paragraphs without re-flowing. I measured the lengths; whether to re-wrap is a style call.
- pr3-14: the decorative-control selector list exists twice, in app.css:66-73 and eq.js:3, with no cross-reference in either file.
- pr3-15: the test bundles eq.js through esbuild and a base64 `data:` URL although a direct `import("../src/renderer/eq.js")` works. On Node 22.22 the direct import prints a `MODULE_TYPELESS_PACKAGE_JSON` warning because package.json has no `"type"`, so keeping the shared esbuild pattern is defensible.

### Coverage

Checked here: `npm test` in a scratch copy of the head checkout (191 pass, 0 fail; the base has 188, so the PR adds exactly the three EQ tests) and `npm run build` (exit 0). The full diff c38587f...8ca1d5d was read (README.md, docs/soundcloud.md, docs/images/equalizer-flat-off.png, src/renderer/eq.js, src/renderer/renderer.js, tests/eq-policy.test.mjs; 216 insertions, 36 deletions) along with each of the three commits. Read at head: eq.js in full, the test in full, renderer.js:205-245 and :318-330, app.css:60-80, selftest.js:80-105, docs/testing.md:44-52 and :190-200, tests/helpers/soundcloud-fixture.js:160-172; the base eq.js at pr2; and the installed webamp 2.3.1 bundle at the cited lines (EqTitleButtons :33851, EqualizerShade :33861, `#equalizer-window` :33906, `__onStateChange` :36797) plus action-name counts. Mutation probes run in the scratch copy: `CONTROLS = "*"` (3/3 pass), listener without `scheduleDescription()` (3/3 pass), `FOCUSABLE` loop deleted (2/3, only the fabricated-input assertion fails), renderer.js:221 reverted to `eq.allowed()` (191 pass, build ok), direct `import()` of eq.js (works, with the typeless-package warning). The finders and verifiers additionally probed CONTROLS widened with the close/shade/volume ids, `CONTROLS = ""`, deleted `aria-label`, the suggested test reorder (passes on head, fails on the listener mutant), and a fake-DOM timing run of describeControls (112 writes per run, 273 runs in 60 s idle). Docs re-read for this write-up: WAI-ARIA 1.2 (aria-disabled "Global use deprecated in ARIA 1.2"; generic role "Authors SHOULD NOT use this role in content"), MDN title inheritance, Redux Store subscribe. Docs the finders consulted and that this review relies on: WHATWG grouping-content, dom and form-control-infrastructure, ARIA in HTML, MDN aria-disabled/tabindex/aria-description/MutationObserver, Webamp docs (Accessing Internals, Constructor, Instance Methods), Electron automated-testing and headless-CI pages, Blink element.cc, and the npm registry for jsdom/happy-dom. Not checkable here: Electron cannot launch in this container, so the flat/OFF rendering, the inherited tooltip on Close/Shade, VoiceOver or Accessibility Inspector exposure of `aria-description`, the per-frame CPU cost of the re-description, and the `NOSTALGIFY_SELFTEST=eq` diagnostic all need macOS. No live service is involved in this PR.

### References

[WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/)
[ARIA in HTML](https://www.w3.org/TR/html-aria/)
[HTML form-control infrastructure](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html)
[HTML grouping content](https://html.spec.whatwg.org/multipage/grouping-content.html)
[HTML DOM interfaces](https://html.spec.whatwg.org/multipage/dom.html)
[DOM Standard](https://dom.spec.whatwg.org/)
[MDN title attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/title)
[MDN aria-disabled](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled)
[MDN aria-description](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-description)
[MDN tabindex](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/tabindex)
[MDN MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
[Redux Store API](https://redux.js.org/api/store)
[Redux Store.md on GitHub](https://raw.githubusercontent.com/reduxjs/redux/master/docs/api/Store.md)
[Webamp: Accessing Internals](https://docs.webamp.org/docs/API/acessing-internals)
[Webamp: Constructor](https://docs.webamp.org/docs/API/webamp-constructor)
[Webamp: Instance Methods](https://docs.webamp.org/docs/API/instance-methods)
[Webamp README](https://raw.githubusercontent.com/captbaritone/webamp/master/packages/webamp/README.md)
[jsdom on npm](https://registry.npmjs.org/jsdom/latest)
[happy-dom on npm](https://registry.npmjs.org/happy-dom/latest)
[Electron automated testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing)
[Electron headless CI](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)
[Blink element.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/dom/element.cc?format=TEXT)
[Spotify equalizer support page](https://support.spotify.com/us/article/equalizer/)

## PR #4: Prevent clipped menus with native macOS popups

**Verdict: request changes.** One confirmed high-severity regression in the PR's headline interaction, one small but real exception path, and a few cheap test and docs fixes.

The PR moves every popup out of the clipped DOM into main-process `Menu.buildFromTemplate` menus. The renderer sends only a menu kind plus boolean state over `menu:show` (src/preload/preload.js:6) and gets fixed action IDs back. `contextMenuTemplate` (src/main/context-menu.js:3-8) coerces every flag with `=== true`, and tests/context-menu.test.js proves injected roles, labels, clicks and submenus never reach the template. `fromPlayer` (src/main/main.js:54-56) checks both `event.sender` and `event.senderFrame`, stricter than Electron's checklist item 17, and the action callback re-checks `frame === contents.mainFrame` plus `isDestroyed()` at :592 so a click queued across a reload is dropped. Two Webamp quirks are handled on purpose: `clearShelf` uses `REMOVE_TRACKS` on `trackOrder` (src/renderer/contextMenu.js:70) so the now-playing pseudo-track that renderer.js:297-298 keeps outside `trackOrder` survives, and the selection filter at :48 accounts for Webamp 2.3.1's `REMOVE_TRACKS` reducer keeping exactly the removed ids in `selectedTracks` (webamp.bundle.js:25629). Extracting the template into a unit-tested module and writing a self-test that asserts and exits nonzero are both improvements over the base.

### Blocking

**A physical right-click on a shelf row leaves Webamp's drag-reorder armed; the next pointer movement silently reorders the shelf and saves it**
src/renderer/contextMenu.js:18-23 (with src/main/main.js:604)
Webamp's TrackCell `onMouseDown` has no button check: a plain press dispatches `CLICKED_TRACK` and calls `handleMoveClick(e)` (node_modules/webamp/built/webamp.bundle.js:33145-33148), which sets `moving` to true (:33192-33195), and the only thing that disarms it is a `window` `mouseup` (:33220-33221). Your capture-phase handler then calls `show("main")` and main pops a native NSMenu with `menu.popup({ window: win, callback: clear })` while the right button is still held. On macOS Blink raises `contextmenu` from the mousedown, and the NSMenu's nested tracking loop (`ScopedAllowApplicationTasksInNativeNestedLoop` then `popUpMenuPositioningItem`, electron_api_menu_mac.mm:233-243) consumes the release, so no DOM `mouseup` reaches the page; Chromium synthesizes one only for its own `<select>` popup, and the W3C UI Events measurement records "No corresponding mouseup" when a native menu is shown. After the menu closes, the next vertical movement over the list dispatches `DRAG_SELECTED` (:33212), which shelf.js:12-19 lists in `CHANGES` and :123-124 persists through `save()`. On the base there was no native menu, so Webamp's in-DOM `onContextMenu: (e) => e.preventDefault()` (:33170) let the release reach the page. This affects physical secondary buttons (two-button mouse, Magic Mouse secondary click, trackpad two-finger click). Ctrl+click is unaffected because TrackCell returns early on `ctrlKey`, and a two-finger tap probably releases before the popup. The end-to-end timing can only be confirmed on macOS; the mechanism is confirmed from Chromium and Electron source. The `menus` self-test cannot catch it because it dispatches a bare `contextmenu` with no preceding `mousedown` (tests/helpers/context-menu-selftest.js:22-28).
Fix: add a capture-phase `mousedown` listener that calls `event.stopPropagation()` when `event.button === 2` and the target is inside `#webamp`, so TrackCell and WindowManager never arm on a right press. Alternatively dispatch `window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 2 }))` before `show("main")` in the `contextmenu` handler. Add a self-test step that dispatches `mousedown` then `contextmenu` on a shelf row with no `mouseup`, closes the menu, dispatches a `mousemove` one row lower inside the list, and asserts `trackOrder` is unchanged.
Sources: https://raw.githubusercontent.com/electron/electron/44-x-y/shell/browser/api/electron_api_menu_mac.mm, https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/input/event_handler.cc, https://lists.w3.org/Archives/Public/public-webapps-github/2020Jul/0002.html, https://codereview.chromium.org/118453006/

### Should fix

**The `closed` handler calls `closePopup(win)` on a window Electron has already marked destroyed**
src/main/main.js:580-583 and :695
`closeContextMenu` does `contextMenu?.closePopup(win)`. Electron 44.7.0's `Menu.prototype.closePopup` reads `window.id` when given a BaseWindow (lib/browser/api/menu.ts:135-138), and BaseWindow calls `MarkDestroyed()` before `Emit("closed")` (electron_api_base_window.cc:182-184), so that getter throws `Object has been destroyed`. When the popup closed normally, `menu-will-close` has already nulled `contextMenu` and the line is a no-op. When a popup is still tracking at close (quit Apple event, the renderer's `window:close` IPC), it throws inside the `closed` handler and `cancelAudioRequests()` and `win = null` never run. The exact AppKit ordering is macOS-only to confirm, but the line is wrong on both paths.
Fix: in the `closed` handler just set `contextMenu = null`, or make `closeContextMenu` call `contextMenu?.closePopup()` with no argument (menu.ts:139-141 says -1 closes every runner of this menu), or guard with `if (win && !win.isDestroyed())`.
Sources: https://raw.githubusercontent.com/electron/electron/v44.7.0/lib/browser/api/menu.ts, https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_base_window.cc

**README's Shift+F10 does not work with Apple's default function-key setting, and the keyboard-opened menu appears at the pointer**
README.md:88, src/renderer/contextMenu.js:38-43, src/main/main.js:602-604
Apple's Mac User Guide: "By default, keyboard function keys are set up to control system features. To use the function keys for keyboard shortcuts, you must also press and hold the Fn key or the Globe key". So on an Apple keyboard at defaults, bare Shift+F10 is the mute key and the keydown handler never sees `event.key === "F10"`. Separately, `menu.popup` gets no `x`/`y`, and the Menu docs say the default "is the current mouse cursor position", so a keyboard-opened menu appears wherever the pointer is, not at the player. The self-test dispatches a synthetic `KeyboardEvent` (:132), so it does not exercise the OS path.
Fix: write "press Fn+Shift+F10 (Shift+F10 if your F-keys are set as standard function keys)" and say the menu opens at the pointer. Optionally include the `#main-window` rect in the `menu:show` payload for keyboard triggers, validate it as finite numbers in main, multiply by `zoom`, and pass `x`/`y` to `menu.popup`.
Sources: https://support.apple.com/guide/mac-help/use-keyboard-function-keys-mchlp2596/mac, https://www.electronjs.org/docs/latest/api/menu

**src/renderer/contextMenu.js has no unit coverage, so the shelf behaviours the PR body advertises survive mutation**
src/renderer/contextMenu.js:48, :67, :70
`npm test` stays at 194/194 if the stale-id filter at :48 is removed, if the `selected.length` guard at :67 is dropped, or if `clearShelf` switches to `REMOVE_ALL_TRACKS` (which sets `currentTrack: null`, bundle :25617, and loses the now-playing entry). The tests directory bundles only eq.js, playbackMedia.js and soundcloudAudio.js; only the hand-run macOS `menus` self-test exercises this module. A 54-line esbuild harness in the tests/eq-policy.test.mjs pattern was written during verification and it catches all three mutations.
Fix: add tests/context-menu-actions.test.mjs that bundles contextMenu.js, provides a fake `window` with `addEventListener(){}` and `nostalgify: { showContextMenu, onMenuAction(cb) { fire = cb } }`, a recording store whose `selectedTracks` includes a removed id, and stubs for `eq`, `shelf`, `transport` and `webamp.stop`. Assert `removeSelected` dispatches `REMOVE_TRACKS` with live ids then `SELECT_ZERO`, `keepOnlySelected` with a stale-only selection dispatches nothing, `clearShelf` dispatches `REMOVE_TRACKS` with `trackOrder`, and `show("main")` sends `hasSelection: false` for stale ids.

**The `menus` self-test never observes the native popup**
tests/helpers/context-menu-selftest.js:29, :16-17, :40; src/main/main.js:599, :604
`open()` waits for `contextMenu()`, which main.js:599 assigns before `menu.popup()` runs at :604. `close()` asserts the null that `closeContextMenu()` wrote one line earlier. `choose()` calls `item.click()` on the main-process MenuItem. Running main.js:579-605 against a stubbed Menu whose `popup` was a no-op, deleted, or throwing passed every one of these checks, so the script prints "PASS native menus" even if nothing is presented (for example `MenuMac::PopupOnUI`'s early return). docs/testing.md:49 ("Native popups at multiple sizes") and the log lines at :33 and :136 overstate what is machine-checked; un-clipped placement, nested submenus and keyboard navigation are manual-only, which the PR body does list under desktop checks.
Fix: in `showContextMenu` register `menu.once("menu-will-show", ...)` and expose a counter or promise through the selftest ctx; make `open()` wait on it, and have `close()` await `menu-will-close`, as Electron's own spec does (`const menuWillShow = once(menu, 'menu-will-show'); menu.popup({ window: w }); await menuWillShow;`, spec/api-menu.spec.ts:856-858). State in docs/testing.md which menu checks are manual.
Sources: https://www.electronjs.org/docs/latest/api/menu, https://raw.githubusercontent.com/electron/electron/v44.7.0/spec/api-menu.spec.ts

**The self-test reads renderer state after fixed sleeps instead of polling**
tests/helpers/context-menu-selftest.js:18, :30-32, :43, :62-63
`choose()` does `item.click()`, then `close()` (200 ms sleep), then `wait(150)`, and the assertions at :63, :67, :70, :75, :95 and :130 read state immediately. So the main-to-renderer `menu:action` plus the Redux dispatch must land within about 350 ms, ahead of a separate `executeJavaScript`, or the run exits 1 falsely. The comment at :30-31 does not describe what the test does: `item.click()` is a JS call and never touches the native popup, Electron 44.7.0 stores the popup controller before presenting (electron_api_menu_mac.mm:168-169 then :243), and its spec calls `menu.closePopup()` immediately after `menu.popup()` (api-menu.spec.ts:863-864). The 200 ms in `open()` does have an unstated job: the `getContentSize` check at :57 only means something after the popup presented, which `menu-will-show` would signal.
Fix: use the file's own `until()` for every post-`choose` read, for example `await until(async () => (await js("...timeMode")) === "REMAINING")`, await the events from the previous item for open and close, and delete or reword :30-31. tests/helpers/soundcloud-fixture.js already polls with `until(label, ...)` for every state read.
Sources: https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_menu_mac.mm, https://raw.githubusercontent.com/electron/electron/v44.7.0/spec/api-menu.spec.ts

### Minor

**The main-process menu glue is untested, like every `fromPlayer` handler since PR #1**
src/main/main.js:586, :592, :683, :695
main.js requires `electron` at the top and no test imports it; the self-test never sends `menu:show` from another frame or clicks an item after reload. Removing :586, dropping `frame === contents.mainFrame` at :592 and removing :683 leaves 194/194. This is a stack-wide pattern from PR #1, not something this PR introduced, and extracting `contextMenuTemplate` already improved testability. Optional: extract `createContextMenuController({ Menu, getWindow, fromPlayer, template })` returning `{ show, close, current }` and test it with a fake `Menu.buildFromTemplate`.

**"Equalizer Panel" is never asserted enabled or checked**
src/main/context-menu.js:34; tests/context-menu.test.js:9-12
Only the coerced-false case is covered, and the self-test never looks up the label, so swapping the `checked` and `enabled` arguments passes everything. The renderer guards `toggleEqualizerPanel` with `eq.canShowPanel()` (contextMenu.js:61), so a polarity bug shows a wrongly greyed or inert item rather than an EQ the skin cannot draw. Fix: add `contextMenuTemplate("main", { equalizerPanelAvailable: true, equalizerPanelOpen: true }, dependencies)` and assert `enabled` and `checked` are both true.

**"Double-size Skin" and the docs' "Webamp Double Size" name the same feature differently**
src/main/context-menu.js:19-20; src/main/main.js:571; docs/testing.md:57, :191
The Options submenu lists "Double-size Skin" directly above "Window Size", whose first item is "Double Size" (Chromium zoom). docs/testing.md still calls the skin mode "Webamp Double Size", so the docs' term is now attached to the zoom item. At base both features carried the identical label, so the PR reduced the collision; this is vocabulary consistency only. Fix: pick one name and apply it to the menu and docs/testing.md:57 and :191.

**The live-selection rule is derived twice with no comment**
src/renderer/contextMenu.js:15 and :48
`hasSelection` uses `.some` and the handler uses `.filter`, and nothing says why ids must still be in `trackOrder`. The reason is Webamp's `REMOVE_TRACKS` reducer keeping exactly the removed ids in `selectedTracks` (bundle :25629). Fix: one module-level `liveSelection(s)` helper with that comment, used at both sites.

**Three overlapping ways to learn that the popup closed**
src/main/main.js:590-593, :600-604
`clear` is registered as both the `menu-will-close` listener and the popup `callback`, and `action` also calls `closeContextMenu()`. Electron 44.7.0 fires `menu-will-close` synchronously in `menuDidClose:` before the item action, so for real clicks the per-action close is a no-op; it only does work for the self-test's synthetic `item.click()`. Fix: keep `callback: clear`, drop the listener, and either drop `closeContextMenu()` from `action` or comment that it exists for synthetic clicks.
Source: https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/ui/cocoa/electron_menu_controller.mm

**`until` has no label, so timeouts report a stale phase**
tests/helpers/context-menu-selftest.js:7-13; :111, :116, :133, :135
`phase` only changes inside `open()` and `close()`, so a timeout at any of those four waits logs "FAIL native menus: close menu Native menu self-test timed out" against the wrong step. Fix: `until(label, check)` like tests/helpers/soundcloud-fixture.js:101.

Checked and fine: the renderer-driven `menu:show` route is Electron's documented second context-menu recipe and `fromPlayer` is stricter than checklist item 17, and the pre-existing `window:close` IPC already lets a compromised renderer quit the app, so the popup adds negligible surface. The Stop assertion at selftest :127-130 is sound: renderer.js:21-22 and :174 record quiet dispatches as `"STOP (quiet)"`, so the strict `action === 'STOP'` filter would catch a future `quietly(...)` wrapper.

### Unverified notes

These were raised but not verified; treat them as pointers, not findings.
- pr4-20: tests/context-menu.test.js:24's injection assertion tests a code path the function cannot take; rename or tighten it.
- pr4-21: docs/testing.md:197 records validation only for c69cd44 and does not show how to run the `menus` mode.
- pr4-22: the self-test's `clientX`/`clientY` values are never read by main; they suggest placement is tested.
- pr4-23: menu kinds `misc` and `list` are Webamp button ids rather than intents, and the action parameter is named `name`.
- pr4-24: the menu says "Shelf" where README.md:89-97 says "the playlist window".
- pr4-25: src/main/selftest.js:3 says the modes are listed in the README; they live in docs/testing.md.
- pr4-26: the Mermaid diagram and the context-menu.js header omit the inbound state payload and the second frame check at main.js:592.

### Coverage

Checked: the full diff 8ca1d5d...8327263 (11 files, +385/-38) and each of the four commits; every cited line re-opened at the head checkout; `npm test` in a scratch copy of the head (194 pass, 0 fail) and `npm run build` (clean), with the base at 191 confirmed by the verifiers; eight guard-removing mutations of contextMenu.js and main.js (six pass the suite unchanged); a 54-line esbuild test for contextMenu.js that catches the three renderer mutations; main.js:579-605 run against stubbed Menus (no-op, missing, throwing popup) to show the self-test's open/close checks cannot see presentation; the installed Webamp 2.3.1 bundle for TrackCell/TrackList mouse handling and the REMOVE_TRACKS/REMOVE_ALL_TRACKS reducers; Electron 44.7.0 and 44-x-y sources (menu.ts, electron_api_base_window.cc, electron_api_menu_mac.mm, electron_menu_controller.mm, gin_helper, init.ts, spec/api-menu.spec.ts); Chromium sources for Mac contextmenu dispatch and mouseup synthesis; the Electron Menu, MenuItem, IpcMainEvent, security and context-menu docs; Apple's function-key guide and QA1362; the W3C UI Events thread, Chromium review 118453006, SDL #13134 and G6 #4221.
Could not check here: anything needing macOS or a live Electron, namely the `menus` self-test, whether the right-button release is consumed before the IPC-triggered popup, AppKit's menuDidClose versus windowWillClose ordering, un-clipped placement, nested submenus, keyboard navigation, quit with a menu open, and the PR body's offline AAC/HLS and live-service checks.

### References

- https://www.electronjs.org/docs/latest/api/menu
- https://www.electronjs.org/docs/latest/api/menu-item
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/context-menu
- https://www.electronjs.org/docs/latest/api/structures/ipc-main-event
- https://raw.githubusercontent.com/electron/electron/v44.7.0/lib/browser/api/menu.ts
- https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_base_window.cc
- https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_menu_mac.mm
- https://raw.githubusercontent.com/electron/electron/44-x-y/shell/browser/api/electron_api_menu_mac.mm
- https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/ui/cocoa/electron_menu_controller.mm
- https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/common/gin_helper/function_template.h
- https://raw.githubusercontent.com/electron/electron/v44.7.0/lib/browser/init.ts
- https://raw.githubusercontent.com/electron/electron/v44.7.0/spec/api-menu.spec.ts
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/input/event_handler.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/frame/web_frame_widget_impl.cc
- https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/forms/external_popup_menu.cc
- https://chromium.googlesource.com/chromium/src/+/main/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm
- https://codereview.chromium.org/118453006/
- https://lists.w3.org/Archives/Public/public-webapps-github/2020Jul/0002.html
- https://developer.apple.com/library/archive/qa/qa1362/_index.html
- https://github.com/libsdl-org/SDL/issues/13134
- https://github.com/antvis/G6/issues/4221
- https://support.apple.com/guide/mac-help/use-keyboard-function-keys-mchlp2596/mac
- https://support.apple.com/en-us/102439
- https://raw.githubusercontent.com/captbaritone/webamp/master/packages/webamp/js/components/PlaylistWindow/TrackCell.tsx
- https://raw.githubusercontent.com/captbaritone/webamp/master/packages/webamp/js/components/PlaylistWindow/TrackList.tsx
- https://playwright.dev/docs/api/class-electron

## Appendices

Verifier notes for every confirmed finding, the refuted findings with the refuters' reasoning, the unverified notes, the method statistics and the full list of sources are in the companion file nostalgify-pr-stack-review-appendix.md.
