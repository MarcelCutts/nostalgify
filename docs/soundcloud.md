# SoundCloud setup

Nostalgify plays public SoundCloud tracks and playlists through its API. Add a
link to the shelf and double-click it to start playback. Next and Previous move
through the loaded SoundCloud playlist; Shuffle changes that order, and Repeat
restarts the playlist or track. The shelf itself is a collection of saved links,
not a queue spanning Spotify and SoundCloud. Liked Songs always opens Spotify.

This integration currently uses credentials supplied by the developer running
it. A successful local setup does not establish a credential model for public
distribution; see the [release gates](soundcloud-research.md#remaining-release-gates).

## Application credentials

Use an existing SoundCloud API application's client ID and secret if you have
working credentials. Otherwise, consult SoundCloud's
[application registration guidance](https://developers.soundcloud.com/docs/api/guide#prerequisites)
and [Your Apps](https://soundcloud.com/you/apps); registration currently requires
Artist Pro. These are **application credentials**, not a listener's password or
Spotify credentials. Public playback with an application token does not require
a SoundCloud user sign-in.

Nostalgify reads these process environment variables:

| Variable | Purpose |
| --- | --- |
| `SOUNDCLOUD_CLIENT_ID` | Your registered API application's client ID |
| `SOUNDCLOUD_CLIENT_SECRET` | That application's secret; enables public playback using an application token |
| `SOUNDCLOUD_REDIRECT_URI` | Optional callback override for the separate account sign-in flow below |

If both application credentials are already exported by your shell or secret
manager, run `npm start` from that environment. The app does not automatically
load `.env` files. With Node 24, you can explicitly load an existing repository-root
`.env` file without printing its contents or executing it as a shell script:

```sh
node --env-file=.env scripts/check-soundcloud.js
npm run build
node --env-file=.env node_modules/electron/cli.js .
```

Keep the file private, for example with `chmod 600 .env`. The repository ignores
`.env` and `.env.*`, and packaging excludes those root files. Do not put secrets
in command arguments, logs, Git or app bundles.

Copy a public SoundCloud track or playlist link and paste it with Cmd+V, drag the
link onto Nostalgify, or use the playlist window's ADD button. Double-click the
new shelf entry. **Playback → Connect SoundCloud…** obtains a fresh application
token when both credentials are configured; it does not open a browser in this
mode. Application tokens stay in memory and are refreshed as needed during the
session. Quitting discards them.

**Playback → Forget Local SoundCloud Sign-in** clears saved user tokens and the
current connection. It does not remove environment credentials, so application
authentication can occur again. Remove those variables from the launch environment
to disable that configuration. Launching from Finder does not inherit variables
from a terminal; launch the app binary from the configured shell for this workflow.
See [packaged validation](testing.md#packaged-macos-checks) for an example.

## Optional account sign-in

Account sign-in is a separate authorization-code/PKCE path. It does not add
search, private tracks or account-library browsing to Nostalgify.

SoundCloud's [authentication guide](https://developers.soundcloud.com/docs/api/guide#authentication)
treats clients as confidential. This app's client-ID-only sign-in path therefore
requires an explicit public-client exception for your application. Do not assume
that PKCE or another app's historical approval supplies that exception. A public
release otherwise needs an architecture that keeps the shared secret outside the
Electron bundle, such as a trusted backend.

For an approved public client, register this exact callback with SoundCloud:

```text
http://127.0.0.1:47832/callback
```

Set `SOUNDCLOUD_CLIENT_ID` without `SOUNDCLOUD_CLIENT_SECRET`, then choose
**Playback → Connect SoundCloud…**. Complete sign-in in the system browser on the
same computer as Nostalgify. A browser on another computer cannot reach the app's
loopback callback.

For Finder launches, non-secret configuration can instead live in
`~/Library/Application Support/Nostalgify/soundcloud.json`:

```json
{
  "clientId": "your-public-client-id",
  "redirectUri": "http://127.0.0.1:47832/callback"
}
```

The file never stores a client secret. Environment values override file values.
A callback override must use `http://127.0.0.1` with an explicit port, have no query
or fragment, and match the registered callback. `NOSTALGIFY_USER_DATA` changes
the directory used for this configuration and saved state.

User access and refresh tokens remain in the main process. Electron's
[asynchronous safeStorage APIs](https://www.electronjs.org/docs/latest/api/safe-storage)
encrypt them using macOS Keychain before an atomic write with private file
permissions. Keychain prompts leave the app responsive. An empty profile does
not access Keychain to look for a missing token file. Plaintext storage and
hardcoded-key fallbacks are rejected.

Reads, writes and encryption-key rotation are serialized; a failed operation
preserves the existing file for a retry. Refreshes are also serialized because
refresh tokens are single-use. If Keychain access is denied or unavailable,
unlock it and restart Nostalgify before trying again. Electron caches the
initialized key provider, so reconnecting alone may not restore access.

**Forget Local SoundCloud Sign-in** removes the local encrypted sign-in. It does
not revoke authorization on SoundCloud's servers. Application tokens do not use
the user-token file or require Keychain persistence. Account sign-in and Keychain
persistence need their own validation; application-token playback cannot verify them.

## Playback and troubleshooting

- **A link is unavailable:** a public web page does not guarantee API playback.
  Tracks can be fully playable, preview-only or blocked. Choose another track or
  open the original page with Eject, **Playback → Open Current Source**, or the
  SoundCloud attribution button.
- **Authentication fails:** check that the intended application credentials reach
  the launched process. Use the [safe API check](testing.md#soundcloud-api-check)
  to test authentication without printing credentials or starting playback.
- **A stream expires:** press Play to retry at the current position and volume.
  Uninterrupted renewal after long pauses still needs live validation.
- **A rate limit is reached:** allow the reported cooldown to expire. The client
  honors retry headers and quota reset times. Avoid repeated Connect actions or
  rapid restarts, which request additional application tokens.
- **A source switch fails:** check the displayed error. On macOS, Spotify must be
  allowed to pause before SoundCloud can take over.

The equalizer, balance control and visualizer are decorative for both sources;
they do not process or analyze the selected music. Spotify's quality readouts use
fixed values, and SoundCloud hides them. The source button and uploader credit
provide a link back to the SoundCloud track.

## Network behavior

The main process contacts `secure.soundcloud.com` for tokens and
`api.soundcloud.com` for metadata. Public links use `soundcloud.com` or
`www.soundcloud.com`; supported short links use `on.soundcloud.com` or `snd.sc`.
Allowed media hosts include `sndcdn.com`, its subdomains, and
`playback.media-streaming.soundcloud.cloud`.

API authorization is sent only to the API host, never a media CDN. The renderer
receives opaque `soundcloud-media:` handles. The main-process proxy retrieves
and rewrites manifests, keys and segments with verified TLS; it does not save
audio for offline listening.

Normal desktop launches use Electron's native network stack. The adapter uses
`net.request` to expose redirects for validation before following each hop;
token requests use `net.fetch` with redirects rejected. This avoids Electron's
[manual-redirect limitation](https://github.com/electron/electron/issues/43715).

For an environment that already has a configured HTTPS proxy and CA trust,
`NODE_USE_ENV_PROXY=1 npm start` opts into Electron's bundled Node fetch for
SoundCloud requests. It is an optional proxy configuration, not a normal macOS
setup step. Neither route disables TLS certificate verification.

## Implementation

`src/main/playback.js` coordinates the selected source and invalidates stale
work. `src/main/soundcloud/` contains authentication, the API client and the media
proxy. `src/renderer/soundcloudAudio.js` owns the Audio/HLS engine. Playback
controls share the same IPC commands whether issued by Webamp or native menus.

A **source** is Spotify or SoundCloud; code uses the corresponding `provider`
value. A **shelf entry** is a saved link. A **playlist** belongs to a source and
contains tracks. Existing saved Spotify entries migrate to provider-tagged
entries without being removed.

See [Testing](testing.md) for repeatable commands and recorded validation, and
[SoundCloud research](soundcloud-research.md) for API decisions, attribution,
retention and distribution requirements.
