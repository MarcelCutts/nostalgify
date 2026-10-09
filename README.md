<div align="center">

<img src="build/icon.png" width="128" alt="Nostalgify icon" />

# Nostalgify

**Classic Winamp skins for Spotify and SoundCloud.**

A macOS app that controls the Spotify desktop app and plays public SoundCloud tracks
through classic Winamp 2 skins. SoundCloud playback currently requires your own API application credentials.

[Install](#install) ·
[SoundCloud setup](docs/soundcloud.md) ·
[Upstream website and demo](https://0xchaosbi.github.io/nostalgify/)

<img src=".github/screenshot.png" width="540" alt="Nostalgify showing the Green Dimension V2 skin with its equalizer" />

</div>

---

Nostalgify uses the real `.wsz` skin files people made in Winamp's heyday. Over 100,000 of them are preserved
by the Internet Archive and the Winamp Skin Museum. Drop one into a folder and Nostalgify wears it.
Spotify plays through its desktop app in the background; SoundCloud audio plays inside Nostalgify.

## Features

- **Real skins.** Load classic Winamp 2 `.wsz` skins and switch between them from the Skins menu.
  New files appear as you add them; Cmd+R picks a random skin.
- **Two music sources.** Control Spotify through macOS scripting or play public SoundCloud tracks and playlists
  through SoundCloud's API. Switching sources pauses the previous one.
- **Transport controls.** Play, pause, stop, previous, next, seek, volume, shuffle and repeat follow the selected source.
- **A shelf for saved links.** Save Spotify tracks, playlists, albums and artists alongside public SoundCloud tracks
  and playlists. Double-click an entry to play it. Spotify's Liked Songs shortcut is added on launch.
- **Crisp scaling.** Drag an edge or corner to resize, or use Cmd+1, 2 and 3 for fixed window sizes.
- **Winamp keys.** Z, X, C, V and B for previous, play, pause, stop and next. Arrow keys seek.

## Install

This checkout is a fork of [0xchaosbi/nostalgify](https://github.com/0xchaosbi/nostalgify).
Build it locally to include the SoundCloud integration.

You need macOS, [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 22.12 or newer.
Node 24 LTS is recommended. For Spotify playback, install the
[Spotify desktop app](https://www.spotify.com/download/mac/) and sign in there; Nostalgify does not need
separate Spotify API credentials. For SoundCloud playback, follow the [application setup guide](docs/soundcloud.md).

```sh
git clone https://github.com/MarcelCutts/nostalgify.git
cd nostalgify
npm ci
npm start
```

On first launch, Nostalgify downloads three starter skins. When macOS asks whether the development app may
control Spotify, allow access. If access was denied, check
**System Settings → Privacy & Security → Automation** for Nostalgify, Electron or the terminal used to launch it.

To build and install a local app:

```sh
npm run install-app
```

This puts Nostalgify in your Applications folder. SoundCloud application credentials supplied in a shell are
not inherited when launching from Finder; see [launching with credentials](docs/soundcloud.md#application-credentials).
The local package uses an ad-hoc signature and is not notarized.

To update from the same folder:

```sh
git pull
npm ci
npm run install-app
```

Prebuilt [upstream releases](https://github.com/0xchaosbi/nostalgify/releases/latest) are also available,
but may not contain this fork's changes. Follow the instructions for that release when installing it.

## Using it

| To do this | Do this |
| --- | --- |
| Add a skin | Drop a `.wsz` file into `~/Music/Nostalgify/Skins`. **Skins → Open Skins Folder** takes you there. |
| Change skin | Pick one from the **Skins** menu, or press Cmd+R for a random one |
| Resize | Drag the right edge, bottom edge or corner. Cmd+1, 2 or 3 for fixed sizes |
| Move the window | Drag any Winamp title bar |
| Put music on your shelf | Drag a supported Spotify or SoundCloud link onto Nostalgify, or copy the link and press Cmd+V. The playlist window's **ADD** button also offers a clipboard action. |
| Play something from your shelf | Double-click it in the playlist window |
| Tidy the shelf | Drag entries to reorder them. Select one and use **REM** to remove it |
| Open the current source | Press **Eject** or choose **Playback → Open Current Source**. For Spotify, choose a track in its app and Nostalgify returns to the front. For SoundCloud, this opens the current track's web page. |
| Play your Liked Songs | Double-click **Liked Songs (Spotify)**, or press **Play** when Spotify is selected and has nothing loaded. |

### The shelf

Winamp's playlist window holds a **shelf of saved links**, not a queue of individual tracks.
It can contain Spotify tracks, playlists, albums and artists, plus public SoundCloud tracks and playlists.
Entries show the service's title and artist or uploader, with a SoundCloud label for SoundCloud entries.
The shelf is saved between launches; Spotify's Liked Songs shortcut is restored on launch.

Double-clicking an entry selects its source and starts it. Next and Previous move through that source's
current playback: Spotify controls its own queue, and SoundCloud moves through the loaded playlist.
They do not step between shelf entries. Reordering or removing shelf entries does not edit playlists on either service.
Nostalgify does not browse your full account library or provide search.

## Getting more skins

The easiest place to find skins is the [Winamp Skin Museum](https://skins.webamp.org/), which has a
searchable gallery of more than 100,000 classic skins.

1. Go to [skins.webamp.org](https://skins.webamp.org/).
2. Scroll the gallery, type in the **Search...** box (try "zelda", "chrome" or "matrix"), or click **Random Skin**.
3. Click a skin to see it up close. It opens in a working player, so you can try it before downloading.
4. Click **Download**, under the player. You get a `.wsz` file.
5. In Nostalgify, choose **Skins → Open Skins Folder** and drag the file in. It appears in the Skins menu right away.

The **Readme** button shows the author's notes, which often include their name and any requests about sharing.

You can also browse the [Internet Archive's Winamp Skin Collection](https://archive.org/details/winampskins).
On a skin's page, find the **Download Options** box. Click **Show All**, then click the file ending in `.wsz`.

A few things to know:

- **Winamp 2 skins only.** Nostalgify uses classic skins, which are `.wsz` files. Winamp 3 and 5 "modern" skins
  (`.wal` files) won't work. Nearly everything in the Skin Museum is a classic skin.
- **`.zip` works too.** A classic skin is a renamed zip file. If your browser saves one as `.zip`, drop it in as is.
  Don't unzip it.
- **Skins belong to their authors.** Download them for your own use, and check the readme before sharing one.

## Known limits

- **Some classic controls and readouts are decorative.** The equalizer and balance control do not process either
  source's audio; EQ artwork appears only when a skin supplies it. Spotify's own equalizer is separate. A silent
  synthesizer drives the visualizer. Spotify's bitrate/sample-rate labels are fixed values, not measurements;
  SoundCloud hides those labels.
- **The shelf contains saved links.** It does not expand playlists into tracks or provide a queue spanning both services.
- **SoundCloud playback depends on API access.** Public links can still be blocked or limited to previews by the
  service. Search, private content and account-library browsing are not implemented. Distribution of the integration
  needs the [credential and release review](docs/soundcloud-research.md#remaining-release-gates).
- **macOS only.** Spotify control uses AppleScript. Spotify may briefly appear when it starts before Nostalgify hides it.

If something goes wrong, Nostalgify writes a log to `~/Library/Application Support/Nostalgify/nostalgify.log`.
Review it for private information before attaching it to an [issue](https://github.com/MarcelCutts/nostalgify/issues).

## Developing

After cloning and running `npm ci`:

```sh
npm start              # build the renderer and launch from source
npm test               # unit and integration tests that do not launch Electron
npm run build          # bundle the renderer
npm run install-app    # build and install into Applications
npm run package -- arm64  # package for Apple Silicon; use x64 for Intel
```

Development skins live in the repository's `skins/` folder. See [Testing](docs/testing.md) for isolated profiles,
Electron diagnostics, live SoundCloud checks, real Spotify checks and package verification.
[SoundCloud setup](docs/soundcloud.md) covers credentials; [SoundCloud research](docs/soundcloud-research.md)
records API decisions and remaining release gates.

### Project layout

```
src/main/             Electron window, menus, Spotify control and playback coordination
src/main/soundcloud/  SoundCloud authentication, API client and protected media proxy
src/preload/          The narrow bridge between the renderer and main process
src/renderer/         Webamp UI, shelf, SoundCloud audio engine and layout rules
tests/                Unit tests, Electron test helpers and generated media fixtures
build/                App icon and macOS app settings
scripts/              Packaging, API checks and asset-generation tools
skins/                Local development skins (not committed)
```

### How it works

[Webamp](https://github.com/captbaritone/webamp) implements Winamp 2 in the browser, including its skin format.
Nostalgify runs it in Electron. A main-process playback coordinator routes controls to the selected source,
pauses the previous source when switching, and updates the display from playback state.

Spotify plays in its desktop app. AppleScript sends commands and reads its state once a second.
SoundCloud plays through an Audio element and hls.js inside Nostalgify; its authentication and media requests
stay in the main process. The shelf stores links and metadata, not downloaded audio.

### The upstream website

The original website and demo live on the upstream repository's `gh-pages` branch. The app's SoundCloud
integration does not change that website. See the [upstream repository](https://github.com/0xchaosbi/nostalgify)
for its source and contribution instructions.

### Releasing

Push a version tag and GitHub Actions builds both Mac downloads and opens a draft release:

```sh
npm version patch    # or minor or major. Updates package.json and creates a tag
git push --follow-tags
```

Then review the draft on the Releases page and publish it.

## Credits

- This fork builds on [0xchaosbi/nostalgify](https://github.com/0xchaosbi/nostalgify).
- [Webamp](https://github.com/captbaritone/webamp) by Jordan Eldredge, MIT License.
- Skins belong to their original authors. Nostalgify doesn't include any skins. It downloads the starter skins from
  the [Winamp Skin Museum](https://skins.webamp.org/) and the [Internet Archive](https://archive.org/details/winampskins).
  See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The website's demo song, "Dial-Up Dreams", is an original chiptune generated by a script on the `gh-pages` branch.

Nostalgify is free. If it made you smile, please consider [donating to the Internet Archive](https://archive.org/donate).
They keep the Winamp Skin Collection, and millions of other pieces of internet history, online for everyone.

Nostalgify is an independent fan project. It isn't affiliated with or endorsed by Winamp, Spotify, SoundCloud, or any skin author.

## License

[MIT](LICENSE)
