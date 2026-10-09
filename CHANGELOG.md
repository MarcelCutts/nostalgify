# Changelog

All notable changes to Nostalgify are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

Unreleased local-development version, including this fork's personal-use SoundCloud integration.

### Added

- Classic Winamp 2 skins (`.wsz`) as a remote control for the Spotify desktop app on macOS.
- Skins folder at `~/Music/Nostalgify/Skins` that updates the Skins menu live, plus Cmd+R for a random skin.
- Three starter skins downloaded on first launch.
- Public SoundCloud tracks and playlists using locally supplied application credentials, with main-process
  authentication, protected HLS playback and visible SoundCloud/uploader attribution.
- Play, pause, stop, previous, next, seek, volume, shuffle and repeat for the selected source.
  Switching to SoundCloud pauses Spotify; switching to Spotify stops SoundCloud playback.
- Spotify launches hidden and stays hidden.
- Eject opens Spotify to pick music, then hides it and returns to Nostalgify once the song changes.
- Play starts your Liked Songs when Spotify has nothing loaded.
- Proportional resizing by dragging, and Cmd+1, 2 and 3 for fixed sizes.
- Decorative equalizer, shown only for skins that include equalizer artwork, flat and OFF with disabled
  audio controls and an explanation for the selected source.
- Winamp keyboard shortcuts: Z, X, C, V, B and arrow keys.
- A shelf in Winamp's playlist window: drag or paste supported Spotify and SoundCloud links, or add them
  from the clipboard menu, then double-click to play. Spotify's Liked Songs shortcut is added on launch.
- Native player and playlist menus with shelf actions that stay readable at different player sizes.
- Optional SoundCloud account sign-in for approved public clients, asynchronous Keychain-backed token
  persistence and a **Forget Local SoundCloud Sign-in** action that clears local state.
- `npm run install-app` builds Nostalgify and installs it into Applications.
- Log file at `~/Library/Application Support/Nostalgify/nostalgify.log`.
- Automated playback and menu checks, with separate instructions and recorded results for live macOS validation.

### Development requirements

- Node 22.12 or newer, matching the existing Electron and packaging tool requirements; Node 24 LTS is recommended.
