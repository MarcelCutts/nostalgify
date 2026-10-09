# SoundCloud integration research

This decision record began with source review on 8 October 2026. Authentication,
quota, branding and API terms were rechecked against official documentation on
9 October 2026. Consumer comparisons below are snapshots at their linked commits.
For setup, use [SoundCloud setup](soundcloud.md); for commands and recorded results,
use [Testing](testing.md).

## Chosen architecture

Nostalgify retains its Webamp skin and Spotify AppleScript adapter. A main-process
playback coordinator routes controls and native menus to the selected provider,
pauses Spotify before SoundCloud starts, stops SoundCloud before Spotify starts,
and rejects stale asynchronous results. A `provider`
value identifies Spotify or SoundCloud in code. Shelf entries are saved links;
Next/Previous navigate the active source's playback, not a queue of shelf entries.

For SoundCloud, a small HTTP client resolves public links, retrieves tracks and
playlists, and selects HLS streams. The main process owns authentication and an
allowlisted media proxy; the renderer receives opaque `soundcloud-media:` handles
and plays audio through an Audio element and hls.js. OAuth credentials never
enter the renderer or CDN requests. The proxy rewrites manifests and serves
keys/segments without offline storage. A native API player preserves the existing skin better than a companion
widget, but it adds authentication, stream lifecycle and attribution work.
Native desktop requests use the Electron adapter: `net.request` exposes manual
redirects for allowlist checks, while `net.fetch` handles token grants with
redirects rejected. The optional Node proxy route is described in
[Network behavior](soundcloud.md#network-behavior).

## What the official sources establish

| Decision | Evidence and limits |
| --- | --- |
| Use the current specification first | [Building with AI](https://developers.soundcloud.com/docs/building-with-ai) calls [OpenAPI JSON](https://developers.soundcloud.com/docs/api/explorer/api.json) the source of truth for routes, parameters and shapes. Some guide examples remain outdated. |
| Default to confidential credentials | The [guide](https://developers.soundcloud.com/docs/api/guide#authentication) says all clients are confidential. Client-credentials exchange requires HTTP Basic auth; putting the credentials in the form is unsupported. Public content needs an app token, not necessarily a listener login. |
| Do not assume public-client approval | [Historical support](https://github.com/soundcloud/api/issues/365#issuecomment-2672212435) enabled exceptions; a [September follow-up](https://github.com/soundcloud/api/issues/365#issuecomment-5866679564) requires verification. An exception for another application is not approval for Nostalgify. |
| Rotate and reuse tokens | The [authentication guide](https://developers.soundcloud.com/docs/api/guide#authentication) describes one-hour access tokens and single-use refresh tokens. The [quota documentation](https://developers.soundcloud.com/docs/api/rate-limits) limits fresh application grants to 50 per 12 hours per app and 30 per hour per IP. Refreshes must be serialized. |
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

The [30 September 2026 release](https://github.com/soundcloud/api/releases/tag/2026-09-30)
adds server-side `POST /disconnect` revocation. Nostalgify's
**Forget Local SoundCloud Sign-in** action clears the local sign-in only; it
does not remove application credentials from the environment. Adding
remote revocation requires deliberate handling of unsupported token types; it
should not accidentally invalidate shared application credentials when changing
providers.

## Lessons from other consumers

These are source-review comparisons, not endorsements or evidence of permission
to use another application's credentials. No third-party SDK was added.

| Consumer/source | Useful evidence | Decision for Nostalgify |
| --- | --- | --- |
| [soundcloud-api-ts](https://github.com/twin-paws/soundcloud-api-ts/tree/b5b72c375815bd8785e1f4da21221397b830ac24) | An official-API client reviewed at the linked commit with injectable fetch, pagination, coalesced token refresh, request deduplication and retries. Its stream types omit AAC96, examples retain MP3, and absolute-URL pagination does not enforce an API-origin boundary. | Compare useful patterns against the official contract; keep Nostalgify's stricter origin checks and structured quota resets instead of importing the wrapper wholesale. |
| [SoundCloud-Swift](https://github.com/superturboryan/SoundCloud-Swift/tree/0ed613fdb9dccb60621ed57f0c1a45de733ddc96) | Uses URNs, typed pages/streams and PKCE; its README identifies WatchCloud as a consumer. The README's client-ID-only example conflicts with the [actual Config initializer](https://github.com/superturboryan/SoundCloud-Swift/blob/0ed613fdb9dccb60621ed57f0c1a45de733ddc96/Sources/SoundCloud/Config.swift), which requires a secret. | Useful native-app comparison, but no evidence of supported secretless authentication for a new app. |
| [Mopidy-SoundCloud](https://github.com/mopidy/mopidy-soundcloud/blob/260abd94cae6f400b3cd975d00fa6e877dcc6d1d/README.md) | The reviewed README explicitly warns that authentication is broken after SoundCloud changes and requests a maintainer. | Do not copy its authentication or older progressive-stream assumptions. Maintenance cost is real. |
| [Official JavaScript SDK](https://github.com/soundcloud/soundcloud-javascript/blob/9c097e97cee51b9dab2b5a16d5f1fc78375357fc/README.md) | Explicitly deprecated, unmaintained and out of sync with current API changes. | Use the current API directly; repository ownership does not make an old SDK current. |
| [Official Python SDK](https://github.com/soundcloud/soundcloud-python/tree/4f7050182ee37e7c503253ffa79a09a2b55742cf) | Historical wrapper still documenting client-ID-only reads, password grants and the old token endpoint. | Treat those authentication examples as legacy. |
| [Guggenheim integration report](https://github.com/soundcloud/api/issues/523#issuecomment-4077375263) and [Shotgun preview report](https://github.com/soundcloud/api/issues/478#issuecomment-3543331914) | Both document breakage around the additional authenticated stream hop. | Test the complete API-to-CDN-to-decoder chain, not only a successful metadata response. |

## Personal use and remaining checks

This fork is a personal novelty player built locally for its owner's devices,
using the owner's own application credentials. A public service or distributed
SoundCloud product is outside the current scope.

Remaining playback checks include restricted previews, long pauses, background
playback and actual signed-stream expiry. Quota and recovery paths have
deterministic tests; live quotas were not deliberately exhausted. Physical audio,
user OAuth/Keychain persistence and real Keychain prompt recovery remain unverified.
Check uploader credit, the track link and the current
[7-bar Cloudmark](https://developers.soundcloud.com/docs/api/buttons-logos) when
trying additional skins and sizes. Existing native and packaged results are in
[Recorded validation](testing.md#recorded-validation).

Personal use is not a blanket exemption from the
[API terms](https://developers.soundcloud.com/docs/api/terms-of-use). They restrict
playback experiences aggregating SoundCloud with other services, except where
explicitly licensed, and limit retention of API content, including metadata,
to necessary session caching. Their application to this source-switching UI and
saved-link shelf remains an unresolved interpretation. The shelf currently saves
service titles, artist/uploader names, URNs and links between launches; no offline
audio is stored. User-created labels are a possible future alternative to
persisting service metadata, not an implemented feature or an established exemption.

If the scope later expands to distribution, revisit these terms and metadata
choices alongside a credential design that does not ship a shared client secret.
An explicitly approved public client or a trusted backend would be separate
design work; the current personal setup does not establish either.

Search, account-library browsing, private content, likes/follows, a queue spanning
sources, other desktop platforms and real audio EQ/visualization are outside the
current implementation. This list describes scope and unresolved work, not a
release schedule or a commitment to add those features.
