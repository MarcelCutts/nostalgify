<div align="center">

<img src="build/icon.png" width="128" alt="Nostalgify icon" />

# Nostalgify

**Your Spotify, wearing a real Winamp skin.**

A tiny macOS app that turns classic Winamp 2 skins into a remote control for the Spotify desktop app.

[Install](#install) ·
[Website and live demo](https://0xchaosbi.github.io/nostalgify/)

<img src=".github/screenshot.png" width="540" alt="Nostalgify showing the Green Dimension V2 skin with its equalizer" />

</div>

---

Nostalgify uses the real `.wsz` skin files people made in Winamp's heyday. Over 100,000 of them are preserved
by the Internet Archive and the Winamp Skin Museum. Drop one into a folder and Nostalgify wears it. Spotify plays
the music hidden in the background.

## Features

- **Real skins.** Any classic Winamp 2 skin works, unchanged.
- **Drop-in skins folder.** New skins appear in the Skins menu as soon as you add them. Cmd+R picks one at random.
- **Spotify stays out of sight.** Nostalgify opens Spotify in the background and keeps it hidden.
- **Full transport.** Play, pause, stop, previous, next, seek, volume, shuffle and repeat all control Spotify.
- **A shelf for your music.** Drag playlists, albums and artists from Spotify into Winamp's playlist window.
  Double-click one to play it. Liked Songs is always there.
- **Crisp scaling.** Drag an edge or the corner to resize, or use Cmd+1, 2 and 3 for single, double and triple size.
- **Winamp keys.** Z, X, C, V and B for previous, play, pause, stop and next. Arrow keys seek.
- **No account or login.** Nostalgify talks to the Spotify app through macOS's built-in scripting.

## Install

You need a Mac and the [Spotify desktop app](https://www.spotify.com/download/mac/). Nostalgify only presses
Spotify's own buttons, so a free account should work too, within whatever the free tier allows.

### Build it yourself (recommended)

You'll also need [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 20 or newer. If you don't have
them, `xcode-select --install` gets you Git, and the installer at nodejs.org (or `brew install node`) gets you Node.

```sh
git clone https://github.com/0xchaosbi/nostalgify.git
cd nostalgify
npm install
npm run install-app
```

That builds Nostalgify on your Mac, puts it in your Applications folder and opens it. Because you built it
yourself, macOS opens it without any "unidentified developer" warning.

When macOS asks whether Nostalgify may control Spotify, click **OK**. On first launch Nostalgify downloads three
starter skins. Press play.

To update later, run this from the same folder:

```sh
git pull && npm install && npm run install-app
```

### Or download the app

1. Download the latest `.zip` from [Releases](https://github.com/0xchaosbi/nostalgify/releases/latest).
   Pick `arm64` for Apple Silicon Macs (M1 and newer) or `x64` for Intel Macs.
2. Unzip it and drag **Nostalgify** into your Applications folder.
3. Open it the first time by right-clicking it and choosing **Open**, then **Open** again.
   Downloaded copies aren't signed by Apple, so a normal double-click is blocked the first time. On newer macOS
   versions, go to **System Settings → Privacy & Security** and click **Open Anyway**.
4. When macOS asks whether Nostalgify may control Spotify, click **OK**.

If you clicked "Don't Allow" by mistake, turn Nostalgify back on under
**System Settings → Privacy & Security → Automation → Nostalgify → Spotify**.

## Using it

| To do this | Do this |
| --- | --- |
| Add a skin | Drop a `.wsz` file into `~/Music/Nostalgify/Skins`. **Skins → Open Skins Folder** takes you there. |
| Change skin | Pick one from the **Skins** menu, or press Cmd+R for a random one |
| Resize | Drag the right edge, bottom edge or corner. Cmd+1, 2 or 3 for fixed sizes |
| Move the window | Drag any Winamp title bar |
| Put music on your shelf | Drag a playlist, album or artist from Spotify onto Nostalgify. Or copy its link with **Share → Copy link** and press Cmd+V, or click **ADD → URL** in the playlist window |
| Play something from your shelf | Double-click it in the playlist window |
| Tidy the shelf | Drag entries to reorder them. Select one and use **REM** to remove it |
| Find something new | Press **Eject**. Spotify opens. Choose a song and Nostalgify hops back |
| Play your Liked Songs | Double-click **Liked Songs**, or press **Play** when nothing is loaded |

### The shelf

Winamp's playlist window holds your shelf: the playlists, albums and artists you want close at hand.
Nostalgify looks up each link's name and artist from Spotify, so entries read like "Daft Punk - Discovery (album)".
The shelf is saved between launches. It needs no Spotify login, because playing an entry uses the same scripting
as the play button.

Nostalgify can't see your whole Spotify library or search it, so the shelf only holds what you add.

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

Spotify's audio is copy-protected, so a few parts are honest fakes:

- **The visualizer** is driven by a silent synthesizer. It moves while music plays, but not in time with it.
- **The equalizer** is decorative. It only appears when a skin includes its own equalizer artwork, and it can't
  change the sound.
- **The shelf** holds what you add. It can't list your whole Spotify library, show the songs inside a playlist, or
  search. Spotify only allows that through its developer API, which needs every user to register as a developer.
- **Mac only.** Nostalgify relies on macOS scripting to control Spotify.
- **Spotify may flash** for a moment when Nostalgify starts it. Spotify insists on coming to the front, and Nostalgify
  hides it again straight away.

If something goes wrong, Nostalgify writes a log to `~/Library/Application Support/Nostalgify/nostalgify.log`.
Please attach it when you [open an issue](https://github.com/0xchaosbi/nostalgify/issues).

## Developing

SoundCloud support is under development alongside Spotify. It supports public
track/playlist links and native HLS playback. Live API and Electron playback checks
passed on macOS, including real Spotify handoff and packaged Spotify controls.
Physical audio and user OAuth/Keychain validation remain separate checks.
See [SoundCloud setup](docs/soundcloud.md) and the
[implementation tasks](docs/soundcloud-tasks.md) for credentials, checks and scope.

After cloning and running `npm install`:

```sh
npm start              # run straight from the source code
npm run install-app    # build and install into Applications
npm run package        # build out/Nostalgify-darwin-<arch>/Nostalgify.app and a zip
```

When you run from source, macOS asks on behalf of your terminal app for permission to control Spotify.
In development, skins live in the `skins/` folder of the repo.

### Testing

Self-tests live in `src/main/selftest.js`. Run one with `NOSTALGIFY_SELFTEST=<mode>`. Add `NOSTALGIFY_MOCK=1` to
use a fake Spotify, and `NOSTALGIFY_USER_DATA=<folder>` to keep the test's settings away from your real ones.

```sh
NOSTALGIFY_MOCK=1 npm start                                  # a fake song that "plays"
NOSTALGIFY_MOCK=1 NOSTALGIFY_SELFTEST=buttons npx electron .
```

| Mode | What it checks | Fake Spotify? |
| --- | --- | --- |
| `buttons` | Every transport button sends the right command | Yes |
| `layout` | Opening and closing windows, and resizing | Yes |
| `size` | The player never grows past the screen | Yes |
| `shelf` | Pasting, dropping, playing and removing shelf entries | Yes |
| `eq` | The equalizer shows only for skins with equalizer artwork | Yes |
| `real` | Assert real playback, metadata, pause/seek/volume, shelf focus and Eject; restores Spotify volume | No |
| `focus` | Assert Spotify stays hidden after shelf playback; restores Spotify volume | No |
| `soundcloud` | Offline AAC/HLS playback, controls, compact attribution and reload | Yes |
| `soundcloud-live` | Real SoundCloud API/media, controls, playlist advancement and reload | Yes |
| `soundcloud-live-real` | Live SoundCloud plus both handoffs with real Spotify (development macOS) | No |

### Project layout

```
src/main/         Electron main process: Spotify control, skins folder, menus, window
src/preload/      The narrow bridge between the page and the main process
src/renderer/     The page: Webamp, the Spotify audio stand-in, layout, equalizer rules
build/            App icon and macOS app settings
scripts/          Packaging, plus the scripts that draw the icon and compose the demo song
skins/            Your local skins while developing (not committed)
```

### How it works

[Webamp](https://github.com/captbaritone/webamp) re-implements Winamp 2 in the browser, including the skin
format. Nostalgify runs it in a small Electron window and replaces Webamp's audio engine with a stand-in. The
stand-in forwards every button to Spotify through AppleScript. Once a second, Nostalgify asks Spotify what's
playing and updates the marquee, clock and seek bar to match.

### The website

The website lives on its own `gh-pages` branch, so this branch only holds the app. To edit it, run
`git switch gh-pages`, then preview with `python3 -m http.server 8080`.

### Releasing

Push a version tag and GitHub Actions builds both Mac downloads and opens a draft release:

```sh
npm version patch    # or minor or major. Updates package.json and creates a tag
git push --follow-tags
```

Then review the draft on the Releases page and publish it.

## Credits

- [Webamp](https://github.com/captbaritone/webamp) by Jordan Eldredge, MIT License.
- Skins belong to their original authors. Nostalgify doesn't include any skins. It downloads the starter skins from
  the [Winamp Skin Museum](https://skins.webamp.org/) and the [Internet Archive](https://archive.org/details/winampskins).
  See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The website's demo song, "Dial-Up Dreams", is an original chiptune generated by a script on the `gh-pages` branch.

Nostalgify is free. If it made you smile, please consider [donating to the Internet Archive](https://archive.org/donate).
They keep the Winamp Skin Collection, and millions of other pieces of internet history, online for everyone.

Nostalgify is an independent fan project. It isn't affiliated with or endorsed by Winamp, Spotify, or any skin author.

## License

[MIT](LICENSE)
