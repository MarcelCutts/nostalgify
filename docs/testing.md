# Testing Nostalgify

Run commands from the repository root using Node 24 LTS (minimum 22.12). Unit
tests do not require credentials or launch Electron:

```sh
npm ci
npm test
npm run build
```

Electron checks require a graphical desktop. Real Spotify automation and macOS
packaging require a Mac. Quit Nostalgify between runs.

## Isolated profiles

Use a temporary profile so checks do not change your normal shelf or settings:

```sh
export NOSTALGIFY_USER_DATA="$(mktemp -d "${TMPDIR:-/tmp}/nostalgify-test.XXXXXX")"
```

Create a fresh directory for an independent run. This isolates Nostalgify's
files, not the real Spotify app or macOS audio settings. Tests intentionally
exercise controls on the selected source. To return to your usual configuration,
quit the app and unset `NOSTALGIFY_USER_DATA`, `NOSTALGIFY_SELFTEST` and
`NOSTALGIFY_MOCK` before restarting.

## Electron diagnostics and fixtures

`NOSTALGIFY_MOCK=1` replaces Spotify with a simulated player. It does **not** mock
SoundCloud unless the exact development mode is `NOSTALGIFY_SELFTEST=soundcloud`.
Any nonempty value of `NOSTALGIFY_MOCK`, including `0`, enables the Spotify mock, so
unset the variable for real Spotify checks.

```sh
NOSTALGIFY_MOCK=1 npm start
NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=buttons npm start
NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=soundcloud npm start
```

| Mode | What it exercises | Result to inspect |
| --- | --- | --- |
| `buttons` | Transport buttons with mock Spotify | Command log |
| `layout` | Window toggles and resizing | Geometry log and screenshots |
| `size` | Window size and screen boundaries | Geometry log |
| `shelf` | Adding, playing and removing saved links | Shelf/command logs and screenshot; Spotify metadata may use the network |
| `eq` | Showing EQ artwork only when supplied by a skin | State log and screenshots; requires the expected local skins |
| `menus` | Native popups at multiple sizes, submenu actions, shelf edits and reload cleanup | Assertions; nonzero exit on failure |
| `soundcloud` | Offline AAC/HLS decoding, controls, source switching, shelf persistence, attribution and reload | Assertions; nonzero exit on failure |

The first five modes are diagnostic scripts, so review their output rather than
assuming a zero exit code proves every behavior. The `menus` and `soundcloud`
modes assert their results. The SoundCloud fixture is
[generated silence](../tests/fixtures/soundcloud/README.md) and makes no live
SoundCloud requests. It checks compact attribution hit targets, including Webamp
Double Size, without proving physical speaker output.

Set `NOSTALGIFY_SHOTS` to an existing directory to save diagnostic screenshots
there. The offline SoundCloud failure report also includes bounded geometry and
hit-test information. Logs and screenshots can contain track titles and uploader
names; review them before sharing.

## SoundCloud API check

Configure [application credentials](soundcloud.md#application-credentials) in
the environment first. The safe check reports outcomes and sanitized errors;
it does not print credentials, tokens or signed media URLs.

```sh
npm run soundcloud:check
npm run soundcloud:check -- https://soundcloud.com/forss/sets/soulhack
npm run soundcloud:check -- --refresh https://soundcloud.com/forss/sets/soulhack
```

The first command authenticates only. A public track or playlist URL adds
resolution, track retrieval and initial media access, without playing audio.
`--refresh` advances an injected authentication clock to force a real token
refresh; it does not alter the system clock or wait an hour.

For an existing private `.env` file, use Node's explicit loader:

```sh
node --env-file=.env scripts/check-soundcloud.js --refresh https://soundcloud.com/forss/sets/soulhack
```

If your environment requires its configured HTTPS proxy, prefix the command
with `NODE_USE_ENV_PROXY=1`. The standalone Node command requires Node 24 or
Node 22.21+ for this variable; it is ignored by the project's minimum Node 22.12.
Normal desktop playback uses Electron's native network stack; a successful
command-line check does not verify that route or audio decoding. The optional
[Electron proxy route](soundcloud.md#network-behavior) uses its bundled Node.

## Live SoundCloud with mock Spotify

This opt-in development test uses real API credentials and media, with mock
Spotify. Use the isolated profile above and mute macOS output if you do not want
the test to be audible; the test changes playback volume.

```sh
NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=soundcloud-live npm start
```

With a private `.env` file instead of exported application credentials:

```sh
npm run build
NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=soundcloud-live \
  node --env-file=.env node_modules/electron/cli.js .
```

The default is Forss's public Soulhack playlist. Set
`NOSTALGIFY_SOUNDCLOUD_TEST_URL` to another public playlist with at least two
playable tracks if needed. The test checks advancing decoded playback, pause,
seek, volume, navigation, automatic advancement, attribution, shelf persistence
and renderer reload. It asserts results, exits nonzero on failure and performs
no account writes. Packaged apps do not include this test helper.

Avoid rapid repeated runs: fresh application tokens have their own rate limits.
Do not deliberately exhaust live quotas; error and recovery paths also have
unit coverage.

## Real Spotify on macOS

Install Spotify and sign in there. Use an isolated Nostalgify profile and launch
normally once to approve macOS Automation access:

```sh
env -u NOSTALGIFY_MOCK -u NOSTALGIFY_SELFTEST npm start
```

Quit Nostalgify after approval. Mute macOS output for automated checks. Both
modes mute Spotify before starting tracks; `real` tests volume while paused.
Cleanup drains pending commands, pauses Spotify and restores its initial volume.
If cleanup cannot drain safely, the test reports failure and keeps Spotify muted.
Keep other apps from taking focus during these checks.

```sh
env -u NOSTALGIFY_MOCK NOSTALGIFY_SELFTEST=real npm start
env -u NOSTALGIFY_MOCK NOSTALGIFY_SELFTEST=focus npm start
```

`focus` asserts real shelf playback, metadata, an advancing clock and Spotify
staying hidden while Nostalgify remains in front. `real` also asserts pause,
seek, volume, resume and Eject's focus round trip. Both use bounded waits and
exit nonzero on failure. They reject non-macOS runs and any nonempty value of `NOSTALGIFY_MOCK`.

To check both handoffs with **real SoundCloud and real Spotify**, configure
SoundCloud credentials and run:

```sh
env -u NOSTALGIFY_MOCK NOSTALGIFY_SELFTEST=soundcloud-live-real npm start
```

Or, with a private `.env` file:

```sh
npm run build
env -u NOSTALGIFY_MOCK NOSTALGIFY_SELFTEST=soundcloud-live-real \
  node --env-file=.env node_modules/electron/cli.js .
```

This development-only macOS mode verifies that Spotify pauses and its clock
stops while SoundCloud plays, then that SoundCloud's Audio element stops and is
released before Spotify advances again. It includes the live SoundCloud checks
above and restores Spotify's original volume after pausing during cleanup.
Restore your original macOS output setting after diagnostics.

Physical audio needs a separate listening check: relaunch without test variables,
play each source, switch in both directions and listen for overlap or silence.
Check seek, Next/Previous, attribution and shelf persistence after restarting.

## Packaged macOS checks

Build for the Node process architecture (`arm64` or `x64`):

```sh
NOSTALGIFY_MAC_ARCH="$(node -p 'process.arch')"
npm run package -- "$NOSTALGIFY_MAC_ARCH"
codesign --verify --deep --strict "out/Nostalgify-darwin-$NOSTALGIFY_MAC_ARCH/Nostalgify.app"
env -u NOSTALGIFY_MOCK -u NOSTALGIFY_SELFTEST \
  "out/Nostalgify-darwin-$NOSTALGIFY_MAC_ARCH/Nostalgify.app/Contents/MacOS/Nostalgify"
```

The binary inherits exported credentials and `NOSTALGIFY_USER_DATA` from that
shell; a Finder launch does not. Node's `--env-file` flag applies to Node commands,
not the packaged binary. Use your configured shell or secret manager to supply
its environment without printing secrets.

The package has a separate macOS Automation identity, so development permission
may not transfer. Check the normal UI: paste public track and playlist links,
play/pause, seek, navigate, switch both sources, restart and confirm the shelf.
Check attribution in full and compact views and with Webamp Double Size. Inspect
the archive for accidental credential files before sharing it. A valid ad-hoc
signature is not Apple notarization.

If you use the optional account sign-in flow, check saved sign-in across restarts
with that configuration; application-token playback does not exercise Keychain
persistence. After rebuilding the ad-hoc package, macOS may request Keychain
access again. Check that the app remains responsive while a prompt is open and
can resume after granting access. In an isolated profile, also check recovery
after denying a prompt: restart, allow the expected app if prompted, and retry
before discarding the saved sign-in. A locked keychain needs unlocking separately.

## Recorded validation

The macOS validation recorded on 9 October 2026 for commit `c69cd44` passed the
unit suite and renderer build, offline AAC/HLS checks, live application-token
refresh and SoundCloud decoding/controls/reload, and both real Spotify handoffs.
Compact attribution passed with the Green Dimension V2 skin, including Double
Size. An ad-hoc-signed arm64 package passed signature verification, real Spotify
assertions and manual SoundCloud playback/shelf checks. Its archive was checked
for credential files and the supplied credential values; neither was included.

These are results for that revision, not an assertion that every later checkout
has been tested. Physical speaker output, user OAuth/Keychain persistence and
real Keychain prompt responsiveness/recovery were not verified. Restricted
previews, long pauses and actual signed-media expiry still need live coverage.
See [remaining checks](soundcloud-research.md#personal-use-and-remaining-checks).
