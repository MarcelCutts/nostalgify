# SoundCloud development

Nostalgify can resolve public SoundCloud tracks and playlists, save them alongside
Spotify shelf entries, and play their API streams through the Winamp interface.
Next/previous navigate the loaded SoundCloud playlist. Shuffle visits each track
once; repeat restarts the context. Eject/Open Current Source opens the track on
SoundCloud. Liked Songs remains Spotify-owned.

Live macOS checks on 9 October 2026 authenticated and refreshed application tokens,
resolved Forss's 11-track “Soulhack” playlist, and decoded real AAC HLS using the
native Electron network stack. The live test passed pause, keyboard seek, volume,
next/previous, automatic playlist advancement, shelf persistence and playback
after renderer reload. Both handoffs with the signed-in Spotify desktop app passed:
Spotify's clock stopped during SoundCloud playback, and switching back stopped and
released SoundCloud's native audio element before Spotify advanced. Full and compact
source attribution passed with the Green Dimension skin. The separate offline
self-test uses explicit fixtures, including silent AAC/HLS. Physical speaker output
was not verified; application-token checks do not exercise user OAuth/Keychain storage.

The ad-hoc-signed arm64 package passed the real Spotify assertions and signature
verification. Packaged UI checks also passed SoundCloud clipboard paste, public
track/playlist resolution, advancing playback, pause, Next, persisted shelf entries
and switching back to Spotify metadata. The archive was checked for `.env` files
and the supplied credential values; neither was included. The local suite passes
163 tests. Compact attribution also passes hit checks with Webamp Double Size.

## Credentials for local development

Use your own application from <https://soundcloud.com/you/apps>. Current SoundCloud
guidance requires an Artist Pro subscription for the application owner. Do not
register another app if you already have a working application/client ID.

For development against public content, provide `SOUNDCLOUD_CLIENT_ID` and
`SOUNDCLOUD_CLIENT_SECRET` through your shell or cloud environment settings, then
start Nostalgify from that environment with `npm start`. Values must be exported
to the process; adding an unexported shell variable or a `.env` file does not inject
them. The app does not load `.env` files. Do not commit credentials, put them in
command arguments, or bundle a shared client secret in a distributed desktop app.

For an existing repository-root `.env` file, Node 24 can load it explicitly without
printing values or executing it as a shell script:

```sh
node --env-file=.env scripts/check-soundcloud.js --refresh https://soundcloud.com/forss/sets/soulhack
npm run build
node --env-file=.env node_modules/electron/cli.js .
```

The repository ignores `.env` and `.env.*`, and packaging explicitly excludes those
root files. Keep the file private (for example, `chmod 600 .env`). Never copy it into
the app bundle. Normal `npm start` still requires exported credentials.

With both variables set, the main process uses HTTP Basic authentication for the
client-credentials grant and caches an application token without opening a browser.
This path has passed the live command-line check using the existing environment
credentials; no new registration or local key file is needed in that environment.
Paste/drop a public track or playlist link into the
shelf, then double-click it. **Playback → Connect SoundCloud…** explicitly obtains
a fresh token if credentials or authorization changed. Application tokens remain
in memory and disappear on quit. **Playback → Forget Local SoundCloud Sign-in**
does not disable developer-owned environment credentials; remove them from the
environment to do that.

An empty profile does not access Keychain just to check for saved tokens. Existing
encrypted user-token files still require secure storage before they can be read.

Check environment credentials without printing their values:

```sh
npm run soundcloud:check
npm run soundcloud:check -- 'https://soundcloud.com/artist/track'
```

Replace the example URL with a real public track or playlist. The second check
verifies URL resolution, context retrieval and initial media access. It does not
play audio. In the prepared cloud image, Node 24 can use the injected HTTPS proxy:

```sh
NODE_USE_ENV_PROXY=1 npm run soundcloud:check -- 'https://soundcloud.com/artist/track'
NODE_USE_ENV_PROXY=1 npm run soundcloud:check -- --refresh 'https://soundcloud.com/forss/flickermood'
```

The script emits only check outcomes and sanitized errors. It never prints client
IDs, secrets, tokens or signed stream URLs. A successful authentication check does
not establish full catalogue availability or successful audio decoding.
The optional `--refresh` check advances only the authentication module's clock
past expiry, performs a real refresh-token grant, and verifies API/media access
with the renewed token. It does not wait an hour or alter the system clock.

## Optional account sign-in

The [current authentication guide](https://developers.soundcloud.com/docs/api/guide#authentication)
says all clients are treated as **confidential** and require a secret. The supported
development default above uses developer-supplied application credentials. A
distributed app needs a credential architecture that keeps a shared secret out of
the Electron bundle, such as a trusted backend.

SoundCloud has historically enabled public-client exceptions through support.
Use the following client-ID-only sign-in path **only after SoundCloud explicitly
confirms that exception for your application**. PKCE alone does not make an app
public, and historical SDK examples are not evidence that a new app qualifies.
For an approved application, register this exact callback:

```text
http://127.0.0.1:47832/callback
```

Set only `SOUNDCLOUD_CLIENT_ID`, then choose **Playback → Connect SoundCloud…**.
Sign-in opens the system browser on the same computer as Nostalgify. A browser on
your laptop cannot deliver a loopback callback to a different cloud machine.
An approved public client cannot use the client-credentials grant.

An optional `soundcloud.json` file in Electron's userData folder can hold non-secret
configuration for launching from Finder:

```json
{
  "clientId": "your-public-client-id",
  "redirectUri": "http://127.0.0.1:47832/callback"
}
```

On macOS this is normally
`~/Library/Application Support/Nostalgify/soundcloud.json`. The file never stores a
client secret. `SOUNDCLOUD_REDIRECT_URI` overrides its callback; only an HTTP numeric
loopback address with an explicit port is accepted. A different callback must also
be registered with SoundCloud.

User access/refresh tokens are encrypted through Electron safeStorage (Keychain on
macOS), written atomically with private file permissions, and stay in the main
process. Systems offering only plaintext/basic_text storage cannot persist a user
login; the app fails closed. Single-use refresh tokens rotate serially.
**Forget Local SoundCloud Sign-in** clears the local encrypted login; it does not
revoke SoundCloud-side authorization.
The current API also documents a separate `POST /disconnect` revocation endpoint;
this app does not call it. Environment application tokens do not require a desktop
keychain.

## Network and catalogue

The integration uses `secure.soundcloud.com` for tokens, `api.soundcloud.com` for
metadata, `soundcloud.com`/`www.soundcloud.com` for links, and `on.soundcloud.com` or
`snd.sc` for supported short links. Current media hosts are `*.sndcdn.com` and
`playback.media-streaming.soundcloud.cloud`. URL redirects are restricted; tokens
are sent only to the API host, never media CDN hosts. The renderer sees opaque
`soundcloud-media:` handles. Manifests, keys and segments are fetched by the main
process with verified TLS; no audio is saved for offline use.

API responses distinguish full playback, preview and blocked tracks. Some content
available on SoundCloud's website is unavailable through third-party APIs. A
blocked track remains visible with an error; choose another entry or open the
original SoundCloud page. Rate limits honor `Retry-After` and documented quota
reset times, including day-long waits, without blocking the UI or looping requests.
Expired streams can be retried with Play while preserving position and volume;
uninterrupted signed-URL renewal across long
playback still needs live validation.

Direct official documentation and command-line API/media requests now work in the
cloud environment. For the cloud proxy, launch with `NODE_USE_ENV_PROXY=1`:

```sh
NODE_USE_ENV_PROXY=1 npm start
```

That opt-in makes main-process SoundCloud requests use Electron's bundled Node
fetch with the existing proxy and CA configuration. Ordinary desktop launches use
Electron's native network stack. Its `net.fetch` rejects manual redirects, including
SoundCloud's `/resolve` responses ([Electron issue #43715](https://github.com/electron/electron/issues/43715)).
The native adapter exposes redirect status and headers from `net.request`, then
aborts that request; the existing API/media allowlists validate each subsequent hop
before making a new request. It never follows a redirect automatically with credentials.
Response bodies stream with bounded buffering and cancellation. Token grants keep
`net.fetch` with redirect rejection and cookies omitted. Full live Electron playback
has passed through both native macOS and cloud Node routes with certificate
verification enabled. No
Chromium trust-store migration or TLS verification bypass is required for this path.

## Distribution review

The [current API terms](https://developers.soundcloud.com/docs/api/terms-of-use)
restrict a playback experience combining SoundCloud content with other services,
with the express exception **“except wherever the aforementioned acts are
explicitly licensed for such use.”** Assess permission for Nostalgify's combined
Spotify/SoundCloud experience before distributing it. This is a release gate;
authorized local development and testing can continue.

Custom players must credit the uploader and SoundCloud and link to the original
work. The [current branding guidance](https://developers.soundcloud.com/docs/api/buttons-logos)
specifies the 7-bar Cloudmark and prohibits the previous 13-bar/legacy orange logo.
The player uses the current Media Kit's white logo on a dark source-link button;
artist metadata and uploader credit are distinct. Verify presentation on packaged
macOS and any additional skins before release.

The terms permit necessary session caching, but broadly restrict persistent User
Content, including metadata. Saved SoundCloud shelf titles and artist names need
review; do not assume that only audio is covered. Prefer user-created bookmarks
and labels with service metadata hydrated during the session. No offline audio is
supported. Confirm the app's actual quota and data-retention behavior as part of
the same review. See [research and remaining gates](soundcloud-research.md).

## Validation and architecture

```sh
npm ci
npm test
npm run build
NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=soundcloud npm start
```

The SoundCloud self-test uses a local fixture for authentication/metadata and real
AAC HLS segments. It asserts decoding and advancing playback position, pause, seek,
volume, playlist navigation, persistence and source switching. It requires an
Electron display; in the prepared Linux cloud environment use its launcher:

```sh
NOSTALGIFY_SELFTEST=soundcloud \
  /workspace/.nostalgify-environment/start-mock.sh
```

The opt-in live test uses real environment credentials, public metadata and media:

```sh
NODE_USE_ENV_PROXY=1 NOSTALGIFY_SELFTEST=soundcloud-live \
  NOSTALGIFY_USER_DATA="$(mktemp -d /workspace/.nostalgify-environment/live.XXXXXX)" \
  /workspace/.nostalgify-environment/start-mock.sh
```

It defaults to Forss's public Soulhack playlist, performs no account writes, and
checks the actual Webamp controls, decoding, end-of-track behavior and reload.
`NOSTALGIFY_SOUNDCLOUD_TEST_URL` can select another public playlist with at least
two playable tracks. The exact `soundcloud-live` mode never injects fixture fetch.
Avoid rapid repeated launches: application token grants have their own quotas.

Use a fresh `NOSTALGIFY_USER_DATA` directory for isolated runs. The cloud launcher's
`--no-sandbox` flag is a container workaround, not a required macOS launch flag.
Real Spotify automation and Mac packaging must be checked on macOS.

## macOS and real Spotify validation

Use Node 24 and the installed Spotify desktop app, signed in to your account.
Bind your own `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET` securely in the
local shell; cloud environment secrets are not transferred with this checkout.
From the repository root:

```sh
npm ci
npm test
export NOSTALGIFY_USER_DATA="$(mktemp -d "${TMPDIR:-/tmp}/nostalgify-macos.XXXXXX")"
env -u NOSTALGIFY_MOCK -u NOSTALGIFY_SELFTEST npm start
```

The temporary profile keeps the normal shelf/settings untouched. On this first
normal launch, approve macOS Automation access for the development app/Electron
to control Spotify. Check Privacy & Security → Automation if access was denied.
Quit Nostalgify before each subsequent run.

Mute **macOS output** before these diagnostics. Both tests mute Spotify before
starting tracks; `real` checks volume 37 while paused, then mutes before resuming.
Cleanup drains pending commands, pauses playback and restores the original Spotify
volume. Restore your original macOS mute setting afterward.

```sh
env -u NOSTALGIFY_MOCK NOSTALGIFY_SELFTEST=real npm start
env -u NOSTALGIFY_MOCK NOSTALGIFY_SELFTEST=focus npm start
```

These modes assert observed playback, metadata, clock advancement and shelf focus;
`real` also asserts Webamp pause, seek, volume, resume and Eject's focus round trip.
They use bounded waits, exit nonzero on failure and report safe failure diagnostics.
Keep other apps from taking focus during the checks. Then relaunch normally with
both test variables unset, as above. Play a
Spotify track, switch to SoundCloud and back, and verify that the previous source
pauses with no overlapping audio. Check audible output, seek, playlist navigation,
source attribution, and shelf persistence after restart.

To assert both handoffs against **real SoundCloud and real Spotify** in development:

```sh
env -u NOSTALGIFY_MOCK NOSTALGIFY_SELFTEST=soundcloud-live-real \
  node --env-file=.env node_modules/electron/cli.js .
```

Use the temporary profile and muted macOS output described above. This exact mode
requires macOS, rejects mock Spotify and packaged apps, and never installs fixture
fetch. It checks that Spotify's clock stops while decoded SoundCloud audio advances,
then that returning to a Spotify shelf entry stops and releases the native
SoundCloud audio element before Spotify advances. It also exercises live transport,
playlist navigation, attribution, renderer reload and cleanup. Physical speaker
output still needs a separate listening check.

Package explicitly for the Node process architecture (`arm64` or `x64`):

```sh
NOSTALGIFY_MAC_ARCH="$(node -p 'process.arch')"
npm run package -- "$NOSTALGIFY_MAC_ARCH"
env -u NOSTALGIFY_MOCK -u NOSTALGIFY_SELFTEST \
  "out/Nostalgify-darwin-$NOSTALGIFY_MAC_ARCH/Nostalgify.app/Contents/MacOS/Nostalgify"
```

Launching the app binary from this shell preserves the credential and temporary
profile bindings; launching from Finder does not inherit them. Repeat the manual
handoff and playback checks. The packaged app has its own macOS Automation/TCC
permission identity, so development approval may not transfer. Application-token
playback does not exercise user OAuth or Keychain token persistence; those remain
separate checks for an appropriately configured account-sign-in flow.

## Implementation layout

`src/main/playback.js` coordinates source selection and invalidates stale work;
`src/main/soundcloud/` contains authentication, API access and the protected media
proxy. `src/renderer/soundcloudAudio.js` owns the Audio/HLS engine. Both Webamp and
native menus use the same provider-neutral IPC. Existing shelves migrate to
provider-tagged entries without dropping Spotify items. No search, account library,
private-content support or mixed-service song queue is included. EQ and visualization
retain the existing decorative behavior.

References and implementation tradeoffs are recorded in
[SoundCloud research](soundcloud-research.md). Research reflects the official
documentation fetched on 8 October 2026; live validation status above remains
separate from documentation review.
