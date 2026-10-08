# SoundCloud implementation tasks

- [x] Inspect current API/authentication guidance and define provider contracts.
- [x] Implement PKCE and local developer application grants without renderer secrets.
- [x] Add protected token storage, refresh/reconnect and account teardown tests.
- [x] Implement public track/playlist resolution, safe redirects and catalogue states.
- [x] Route HLS manifests/segments through opaque, bounded media handles.
- [x] Coordinate source switching and migrate mixed shelves.
- [x] Add HLS playback, transport, buffering/error state and source labels.
- [x] Add stateful unit tests and run existing Spotify mock smoke checks.
- [x] Exercise real AAC/HLS decoding in Electron using a local fixture.
- [x] Review authentication, renderer, media URLs and provider races independently;
      fix discovered credential-query, reconnect, reload and stale-command issues.
- [x] Document configuration, safe live checks and the development/release boundary.
- [x] Verify supplied credentials have reached the running cloud process and its
      SoundCloud network destinations are enabled.
- [x] Research current official guide, OpenAPI, releases, terms and five consumer
      implementations; record supported contracts and outdated examples.
- [x] Verify live public-track/playlist metadata, HLS access and unavailable-content
      errors with the supplied application credentials.
- [x] Force simulated token expiry and verify a real refresh grant plus subsequent
      live metadata/media requests.
- [x] Run live Electron AAC decoding and UI transport/seek/volume, playlist
      advancement, renderer reload/recovery and Spotify-mock source switching.
- [x] Fix review findings: Basic grants, structured quota resets, uploader metadata,
      slow stream progress, stale provider switches and position-preserving retry.
- [x] Verify current source-logo/uploader attribution in full and compact views;
      inspect live screenshots and hide SoundCloud branding when switching sources.
- [x] Run final 136-test suite, build, offline AAC integration and existing Spotify
      mock buttons/layout/size checks after the implementation changes.
- [ ] Extend live coverage to restricted previews, long pauses and signed-media
      expiry; these have deterministic contract/recovery tests, not live proof.
- [x] Validate native macOS SoundCloud playback and both real Spotify handoffs.
- [x] Build/sign arm64 macOS and verify real Spotify assertions plus packaged
      SoundCloud paste, playback, pause, navigation and persisted shelves.
- [x] Fix native manual redirects, asynchronous clipboard reads, failed-switch
      recovery, compact/Double Size attribution and needless empty-profile Keychain
      access; run 163 unit tests and offline/live Electron checks.
- [x] Keep local `.env` credentials out of Git and packaged archives.
- [ ] Validate user OAuth and encrypted-token persistence through OS Keychain.
- [ ] Confirm SoundCloud terms/attribution, application quota and public-client
      eligibility before distributing the integration.

Live testing used real SoundCloud credentials/API/media through the cloud Node
route and the native macOS network stack, with TLS verification enabled. Real
Spotify handoffs passed on macOS on 9 October 2026. Physical speaker output and
user-login Keychain persistence remain unverified. Remaining items are
extended-service and release gates; passing playback checks do not establish
permission to distribute.
