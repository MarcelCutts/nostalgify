# SoundCloud integration research

Reviewed 8 October 2026 against directly fetched official documentation, OpenAPI,
release notes and selected consumer source code. This records implementation
decisions and remaining release gates; it does not certify catalogue coverage or
permission to distribute a combined streaming service.

## Chosen architecture

Nostalgify retains its Webamp skin and Spotify AppleScript adapter. A main-process
playback coordinator routes controls and native menus to the selected provider,
pauses the previous provider and rejects stale asynchronous results. The shelf
stores provider-qualified contexts; next/previous navigate the active SoundCloud
playlist, rather than a mixed-service song queue.

For SoundCloud, a small HTTP client resolves public links, retrieves tracks and
playlists, and selects HLS streams. The main process owns authentication and an
allowlisted media proxy; the renderer receives opaque `soundcloud-media:` handles
and plays audio through hls.js. OAuth credentials never enter the renderer or CDN
requests. The proxy rewrites manifests and serves keys/segments without offline
storage. A native API player preserves the existing skin better than a companion
widget, but it adds authentication, stream lifecycle and attribution work.

## What the official sources establish

| Decision | Evidence and limits |
| --- | --- |
| Use the current specification first | [Building with AI](https://developers.soundcloud.com/docs/building-with-ai) calls [OpenAPI JSON](https://developers.soundcloud.com/docs/api/explorer/api.json) the source of truth for routes, parameters and shapes. Some guide examples remain outdated. |
| Default to confidential credentials | The [guide](https://developers.soundcloud.com/docs/api/guide#authentication) says all clients are confidential. Client-credentials exchange requires HTTP Basic auth; putting the credentials in the form is unsupported. Public content needs an app token, not necessarily a listener login. |
| Do not assume public-client approval | [Historical support](https://github.com/soundcloud/api/issues/365#issuecomment-2672212435) enabled exceptions; a [September follow-up](https://github.com/soundcloud/api/issues/365#issuecomment-5866679564) requires verification. An exception for another application is not approval for Nostalgify. |
| Rotate and reuse tokens | Access tokens last roughly one hour; refresh tokens are single-use. Fresh client-credentials grants are limited to 50 per 12 hours per app and 30 per hour per IP. Refreshes must be serialized. |
| Keep URNs and `/streams` | The [URN migration](https://developers.soundcloud.com/blog/urn-num-to-string) deprecates numeric identity. OpenAPI exposes `/tracks/{track_urn}/streams` and marks `stream_url` deprecated/preview-only, despite legacy `/stream` examples in the guide. |
| Prefer AAC HLS | The [streaming announcement](https://developers.soundcloud.com/blog/api-streaming-urls) specifies AAC 160, then AAC 96. [August 2026 releases](https://github.com/soundcloud/api/releases/tag/2026-08-14) removed progressive MP3. MP3 HLS remains in the schema, so it is only a compatibility fallback. |
| Authenticate the second API hop | [SoundCloud's explanation](https://github.com/soundcloud/api/issues/478#issuecomment-3528580348) confirms URLs returned by `/streams` can themselves need OAuth before redirecting to a credential-free CDN URL. This justifies the main-process proxy. |
| Treat stream URLs as transient | [Staff expiry guidance](https://github.com/soundcloud/api/issues/254#issuecomment-2395223279) says to follow redirects immediately. No fixed stream-URL lifetime was established. Long pauses and expired segments need bounded recovery tests. |
| Separate artist from uploader | The public Track model exposes [`metadata_artist`](https://developers.soundcloud.com/blog/api-artist-metadata). The uploader remains separately relevant for attribution; its username can differ from the performing artist. |
| Honor full/preview/blocked access | The [guide](https://developers.soundcloud.com/docs/api/guide#playing) and [staff clarification](https://github.com/soundcloud/api/issues/578#issuecomment-5727484181) explain creator, monetization and country restrictions. Website/Go+ playback does not guarantee API availability. |

The [rate-limit documentation](https://developers.soundcloud.com/docs/api/rate-limits)
specifies a shared allowance of 15,000 playable-stream requests per 24-hour window
per client ID. Its error body provides `errors[].meta.reset_time`; a `Retry-After`
header is not guaranteed. Handle structured reset times, retain long cooldowns
without blocking the app, and avoid tight retries. [Self-service apps may have
lower limits](https://github.com/soundcloud/api/issues/532#issuecomment-4616732227).

The [latest release](https://github.com/soundcloud/api/releases/tag/2026-09-30)
adds server-side `POST /disconnect` revocation. Nostalgify's
**Forget Local SoundCloud Sign-in** action clears local credentials only. Adding
remote revocation requires deliberate handling of unsupported token types; it
should not accidentally invalidate shared
application credentials when changing providers.

## Lessons from other consumers

These are source-review comparisons, not endorsements or evidence of permission
to use another application's credentials. No third-party SDK was added.

| Consumer/source | Useful evidence | Decision for Nostalgify |
| --- | --- | --- |
| [soundcloud-api-ts](https://github.com/twin-paws/soundcloud-api-ts/tree/b5b72c375815bd8785e1f4da21221397b830ac24) | An actively updated official-API client with injectable fetch, pagination, coalesced token refresh, request deduplication and retries. Its stream types omit AAC96, examples retain MP3, and absolute-URL pagination does not enforce an API-origin boundary. | Compare useful patterns against the official contract; keep Nostalgify's stricter origin checks and structured quota resets instead of importing the wrapper wholesale. |
| [SoundCloud-Swift](https://github.com/superturboryan/SoundCloud-Swift/tree/0ed613fdb9dccb60621ed57f0c1a45de733ddc96) | Uses URNs, typed pages/streams and PKCE; its README identifies WatchCloud as a consumer. The README's client-ID-only example conflicts with the [actual Config initializer](https://github.com/superturboryan/SoundCloud-Swift/blob/0ed613fdb9dccb60621ed57f0c1a45de733ddc96/Sources/SoundCloud/Config.swift), which requires a secret. | Useful native-app comparison, but no evidence of supported secretless authentication for a new app. |
| [Mopidy-SoundCloud](https://github.com/mopidy/mopidy-soundcloud/blob/260abd94cae6f400b3cd975d00fa6e877dcc6d1d/README.md) | Its current README explicitly warns that authentication is broken after SoundCloud changes and requests a maintainer. | Do not copy its authentication or older progressive-stream assumptions. Maintenance cost is real. |
| [Official JavaScript SDK](https://github.com/soundcloud/soundcloud-javascript/blob/9c097e97cee51b9dab2b5a16d5f1fc78375357fc/README.md) | Explicitly deprecated, unmaintained and out of sync with current API changes. | Use the current API directly; repository ownership does not make an old SDK current. |
| [Official Python SDK](https://github.com/soundcloud/soundcloud-python/tree/4f7050182ee37e7c503253ffa79a09a2b55742cf) | Historical wrapper still documenting client-ID-only reads, password grants and the old token endpoint. | Treat those authentication examples as legacy. |
| [Guggenheim integration report](https://github.com/soundcloud/api/issues/523#issuecomment-4077375263) and [Shotgun preview report](https://github.com/soundcloud/api/issues/478#issuecomment-3543331914) | Both document breakage around the additional authenticated stream hop. | Test the complete API-to-CDN-to-decoder chain, not only a successful metadata response. |

## Validation so far

- Live command-line checks passed authentication, resolution of Forss's
  “Flickermood” and “Soulhack,” retrieval of the playlist's 11 playable tracks, and
  initial HLS media access. Existing supplied credentials worked; no additional
  registration is needed for these checks.
- Offline Electron fixtures exercise actual AAC/HLS decoding and controls,
  independently of the live catalogue. Unit tests cover authentication, API
  boundaries, media URL handling, source switching and shelf behavior.
  The final suite passed **136 tests**, the renderer build passed, and the existing
  Spotify-mock buttons/layout/window-size smoke checks passed after the changes.
- Live Electron AAC decoding, advancing clock, pause, keyboard seek, volume,
  next/previous, natural ending/advancement, reload and recovery passed. The cloud
  path opts into bundled Node fetch with `NODE_USE_ENV_PROXY=1`, reusing the working
  proxy/CA configuration; normal desktop launches use Electron `net.fetch`. TLS
  verification remained enabled and no Chromium trust-store changes were made.
  Source-logo/uploader attribution passed full/compact visibility checks and
  screenshot review; switching to Spotify hides SoundCloud's attribution.
- A separate live refresh check simulated token expiry using an injected clock,
  performed a real refresh-token grant and accessed metadata/HLS with the renewed
  token. Removed/unavailable content returned the expected sanitized 404 error.
- Real Spotify automation and packaged macOS regression remain pending. Fixture
  success is not a substitute for either.

See [development instructions](soundcloud.md) for reproducible checks. Validation
status should be updated with the actual live/package results before release.

## Effort and release gates

The initial estimate for one experienced Electron/JavaScript engineer was **1–3
days for a prototype, 9–16 days for a widget release, or 20–40 days for a native
API/HLS release**. These were whole-feature planning ranges, not estimates of work
still remaining after this implementation. The native path now has substantial
implementation and automated coverage: provider coordination, API/auth handling,
the protected HLS path, shelf support and controls are built. Remaining effort
depends on longer-session behavior, packaged macOS behavior and the distribution credential
model. As a provisional planning allowance, reserve **3–7 engineer-days** for
remaining integration/regression checks and resulting fixes if the live path
works; a production credential backend could add **1–3 weeks** of separately
scoped work. These are low-confidence remaining-work estimates, exclude external
permission/verification time, and must be revised after packaged checks. No
external approval timeline is promised.

The remaining gates are:

1. **Playback and regression:** extend the passing live decode/control checks to
   background and long-paused playback, actual signed-stream expiry, restricted
   catalogue/preview behavior, and packaged macOS/Spotify source switching.
   Quota errors and failure recovery have deterministic coverage; no live quota
   was intentionally exhausted. Physical audio output remains unverified here.
2. **Credential distribution:** a shared secret cannot ship in Electron. Confirm
   an explicitly approved public-client exception or scope a trusted backend and
   its ongoing operation. Local developer credentials are not that architecture.
3. **Product permission:** the [API terms](https://developers.soundcloud.com/docs/api/terms-of-use)
   restrict multi-service aggregation, qualified by **“except wherever the
   aforementioned acts are explicitly licensed for such use.”** Assess that
   exception for Nostalgify before distribution. Continue authorized development
   and testing while this release review remains open.
4. **Attribution and retention:** credit uploader and source, link to the work and
   use the current [7-bar Cloudmark](https://developers.soundcloud.com/docs/api/buttons-logos).
   Terms allow necessary session caching and broadly cover metadata as well as
   audio. Review persisted shelf titles/artist data; prefer user-created bookmarks
   and labels with metadata hydrated per session. No offline audio is included.

Account-library browsing, search, likes/follows, private content, a mixed-provider
song queue, portable desktop releases and real audio EQ/visualization remain
separate scope. Public-source research and working credentials do not remove
these product, maintenance or validation costs.
