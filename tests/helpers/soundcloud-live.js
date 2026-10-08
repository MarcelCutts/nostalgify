// Opt-in, read-only live service check. No fixture fetch or user-account writes.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { bounded, restoreSpotifyVolume } = require("../../src/main/spotify-selftest");

function runLiveSoundCloudSelftest({ win, app, playback, readPrefs, getSpotifyState, spotifyCommand }) {
  const realSpotify = process.env.NOSTALGIFY_SELFTEST === "soundcloud-live-real";
  if (realSpotify && (app.isPackaged || process.env.NOSTALGIFY_MOCK || process.platform !== "darwin")) {
    console.error("FAIL soundcloud-live-real requires a development macOS app and NOSTALGIFY_MOCK unset");
    app.exit(1);
    return;
  }
  const url = process.env.NOSTALGIFY_SOUNDCLOUD_TEST_URL || "https://soundcloud.com/forss/sets/soulhack";
  const spotifyUri = "spotify:album:2noRn2Aes5aoNVsU6iWThc";
  let overallDeadline;
  const call = (label, operation, timeout = 8000) => {
    assert.ok(Date.now() < overallDeadline, "Live SoundCloud self-test exceeded its four-minute deadline");
    return bounded(label, operation, Math.min(timeout, overallDeadline - Date.now()));
  };
  const js = (code) => call("renderer response", () => win.webContents.executeJavaScript(code), 30000);
  const readState = () => call("playback state", () => playback.getState());
  const command = (cmd, arg) => call("playback command", () => playback.command(cmd, arg), 30000);
  const spotifyState = () => call("real Spotify state", getSpotifyState);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Math.min(overallDeadline, Date.now() + 45000);
    while (Date.now() < deadline) {
      if (await predicate()) { console.log(`PASS live SoundCloud ${label}`); return; }
      const current = await readState();
      if (current.provider === "soundcloud" && current.error) throw new Error(`${label}: ${current.message}`);
      await wait(150);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const clickShelf = () => js("[...document.querySelectorAll('#playlist-window .track-cell')].find(cell => cell.textContent.includes('(SoundCloud,')).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  const clickSpotifyShelf = () => js(`(() => {
    const s = window.__webamp.store.getState();
    const id = s.playlist.trackOrder.find(id => s.tracks[id].url === ${JSON.stringify("shelf:" + spotifyUri)});
    const cell = [...document.querySelectorAll('#playlist-window .track-cell')].find(cell => id != null && cell.textContent.includes(s.tracks[id].title));
    if (!cell) throw new Error('Spotify handoff shelf row is missing');
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  // Retain native elements for observation only. SoundCloud still uses its real
  // renderer, HLS engine, protected media proxy, API and network requests.
  const installAudioProbe = () => js(`(() => {
    if (window.__soundcloudTestAudio) return;
    const NativeAudio = window.Audio;
    const audio = window.__soundcloudTestAudio = [];
    function ObservedAudio(...args) { const element = new NativeAudio(...args); audio.push(element); return element; }
    ObservedAudio.prototype = NativeAudio.prototype;
    Object.setPrototypeOf(ObservedAudio, NativeAudio);
    window.Audio = ObservedAudio;
  })()`);
  const loadTimeout = setTimeout(() => {
    console.error("FAIL live SoundCloud: UI did not load within 60 seconds");
    app.exit(1);
  }, 60000);
  win.webContents.once("did-finish-load", async () => {
    clearTimeout(loadTimeout);
    overallDeadline = Date.now() + 240000;
    let originalSpotifyVolume;
    let failure;
    try {
      assert.ok(process.env.SOUNDCLOUD_CLIENT_ID && process.env.SOUNDCLOUD_CLIENT_SECRET, "Live checks require application credentials");
      await until("UI ready", () => js("Boolean(window.__shelf && document.querySelector('#play'))"));
      if (realSpotify) {
        await until("real Spotify responds", async () => {
          const s = await spotifyState();
          assert.notEqual(s.error, "permission", "macOS Automation permission to control Spotify was denied");
          return s.running && !s.error && Number.isInteger(s.volume);
        });
        originalSpotifyVolume = (await spotifyState()).volume;
        assert.ok(originalSpotifyVolume >= 0 && originalSpotifyVolume <= 100, "Spotify returned an invalid original volume");
        await call("pause Spotify before muting", () => spotifyCommand("pause"));
        await until("Spotify paused before muting", async () => ["paused", "stopped"].includes((await spotifyState()).state));
        await call("mute Spotify", () => spotifyCommand("volume", 0));
        await until("Spotify muted", async () => (await spotifyState()).volume === 0);
        await command("selectProvider", "spotify");
        await js(`window.__shelf.addFromText(${JSON.stringify(spotifyUri)})`);
        await until("Spotify handoff shelf saved", () => readPrefs().shelf?.some((entry) => entry.uri === spotifyUri));
        await clickSpotifyShelf();
        await until("real Spotify playing before SoundCloud selection", async () => {
          const s = await spotifyState();
          return s.state === "playing" && s.track?.album === "Discovery" && s.position > 0.5 && s.volume === 0;
        });
        const playing = await spotifyState();
        await until("real Spotify clock advances before handoff", async () => {
          const s = await spotifyState();
          return s.state === "playing" && s.track?.id === playing.track.id && s.position > playing.position + 0.4;
        });
        await installAudioProbe();
      }
      await js(`window.__shelf.addFromText(${JSON.stringify(url)})`);
      await until("public playlist resolves and is saved", () => readPrefs().shelf?.some((entry) => entry.provider === "soundcloud" && entry.kind === "playlist"));
      await clickShelf();
      await until("AAC HLS decodes and clock advances", async () => {
        const current = await readState();
        return current.provider === "soundcloud" && current.state === "playing" && current.position > 1;
      });
      if (realSpotify) {
        await until("SoundCloud selection pauses real Spotify", async () => (await spotifyState()).state === "paused");
        await until("native SoundCloud audio element is playing", () => js("window.__soundcloudTestAudio.some(audio => !audio.paused && audio.currentTime > 1 && audio.readyState >= 2)"));
        const pausedSpotify = await spotifyState();
        const observedAt = Date.now();
        await until("Spotify clock remains stopped during live SoundCloud playback", async () => {
          const s = await spotifyState();
          assert.ok(s.state === "paused" && Math.abs(s.position - pausedSpotify.position) < 0.5, "Spotify continued playing after SoundCloud took over");
          return Date.now() - observedAt >= 1200;
        });
      }
      const first = (await readState()).track.id;
      await until("duration and title reach Webamp", () => js("(() => { const s=window.__webamp.store.getState(); const t=s.tracks[s.playlist.currentTrack]; return t?.duration > 10 && Boolean(t.title); })()"));
      await until("source logo and uploader attribution", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const img=a?.querySelector('img'); return a && !a.hidden && a.getBoundingClientRect().width > 0 && img?.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width >= 30 && a.getAttribute('aria-label').toLowerCase().includes('uploaded by'); })()"));
      if (process.env.NOSTALGIFY_SHOTS) {
        await call("capture normal player", async () => fs.writeFile(path.join(process.env.NOSTALGIFY_SHOTS, "soundcloud-live.png"), (await win.webContents.capturePage()).toPNG()));
      }
      await js("window.__webamp.store.dispatch({type:'TOGGLE_WINDOW_SHADE_MODE',windowId:'main'})");
      await until("attribution remains clickable in compact mode", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const r=a.getBoundingClientRect(); return document.getElementById('main-window').classList.contains('shade') && a.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()"));
      await wait(400);
      if (process.env.NOSTALGIFY_SHOTS) {
        await call("capture compact player", async () => fs.writeFile(path.join(process.env.NOSTALGIFY_SHOTS, "soundcloud-live-compact.png"), (await win.webContents.capturePage()).toPNG()));
      }
      await js("window.__webamp.store.dispatch({type:'TOGGLE_WINDOW_SHADE_MODE',windowId:'main'})");
      await until("normal transport restored", () => js("!document.getElementById('main-window').classList.contains('shade')"));
      await js("document.getElementById('pause').click()");
      await until("pause from Webamp", async () => (await readState()).state === "paused");
      const paused = (await readState()).position;
      await wait(700);
      assert.ok(Math.abs((await readState()).position - paused) < 0.2, "Paused audio clock must stop");
      await js("window.__webamp.store.dispatch({type:'SET_VOLUME',volume:25})");
      await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
      await js("document.getElementById('play').click()");
      await until("seek, volume and resume", async () => {
        const state = await readState();
        return state.state === "playing" && state.position > paused + 5.2 && state.volume === 25;
      });
      await js("document.getElementById('next').click()");
      await until("next plays another real track", async () => {
        const state = await readState();
        return state.state === "playing" && state.track.id !== first && state.position > 0.2;
      });
      // Previous returns to the prior item while close to the beginning.
      await command("seek", 0);
      await until("seek back before previous", async () => (await readState()).position < 1);
      await command("pause");
      await js("document.getElementById('previous').click()");
      await until("previous restores the first track", async () => {
        const state = await readState();
        return state.state === "playing" && state.track.id === first && state.position > 0.2;
      });
      const duration = (await readState()).track.duration;
      await command("seek", duration - 1);
      await until("natural ending advances the real playlist", async () => {
        const state = await readState();
        return state.state === "playing" && state.track.id !== first && state.position > 0.2;
      });
      const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      win.webContents.reload();
      await call("renderer reload", () => reloaded, 30000);
      await until("shelf survives renderer reload", () => js("Boolean(window.__shelf && [...document.querySelectorAll('#playlist-window .track-cell')].some(cell => cell.textContent.includes('(SoundCloud,')))"));
      assert.equal((await readState()).track, null, "Reload stops previous audio");
      if (realSpotify) await installAudioProbe();
      await clickShelf();
      await until("live playback recovers after reload", async () => {
        const state = await readState();
        return state.state === "playing" && state.position > 0.5;
      });
      if (realSpotify) {
        assert.equal((await spotifyState()).state, "paused", "Spotify must stay paused throughout live SoundCloud playback");
        await until("reloaded native SoundCloud audio is playing", () => js("window.__soundcloudTestAudio.some(audio => !audio.paused && audio.currentTime > 0.5 && audio.readyState >= 2)"));
        await clickSpotifyShelf();
        await until("Spotify shelf resumes real playback", async () => {
          const s = await spotifyState();
          return s.state === "playing" && s.track?.album === "Discovery" && s.volume === 0;
        });
        await until("Spotify selection stops and releases native SoundCloud audio", () => js("window.__soundcloudTestAudio.length > 0 && window.__soundcloudTestAudio.every(audio => audio.paused && !audio.hasAttribute('src'))"));
        const resumed = await spotifyState();
        await until("real Spotify clock advances with SoundCloud stopped", async () => {
          assert.ok(await js("window.__soundcloudTestAudio.every(audio => audio.paused && !audio.hasAttribute('src'))"), "SoundCloud audio resumed after Spotify took over");
          const s = await spotifyState();
          return s.state === "playing" && s.track?.id === resumed.track.id && s.position > resumed.position + 0.5;
        });
      } else {
        await command("selectProvider", "spotify");
      }
      assert.equal((await readState()).provider, "spotify");
      await until("SoundCloud attribution hides on source switch", () => js("document.getElementById('soundcloud-attribution')?.hidden"));
    } catch (error) {
      failure = error;
      if (process.env.NOSTALGIFY_SHOTS) {
        await bounded("capture failed player", async () => fs.writeFile(path.join(process.env.NOSTALGIFY_SHOTS, "soundcloud-live-failed.png"), (await win.webContents.capturePage()).toPNG())).catch(() => {});
      }
    } finally {
      if (realSpotify) {
        // Keep cleanup separate from the test deadline, and always attempt both
        // sources even when the renderer or a provider command has failed.
        let drained = false;
        try {
          await bounded("stop and drain playback during cleanup", () => playback.dispose(), 30000);
          drained = true;
        } catch {
          failure ||= new Error("Playback did not drain during cleanup; original Spotify volume cannot be safely restored");
        }
        try {
          if (!drained) await bounded("keep Spotify muted after cleanup timeout", () => spotifyCommand("volume", 0));
          await bounded("pause Spotify during cleanup", () => spotifyCommand("pause"));
          const paused = await bounded("verify Spotify paused during cleanup", getSpotifyState);
          assert.ok(paused.running && !paused.error && ["paused", "stopped"].includes(paused.state), "Could not verify Spotify is paused during cleanup");
          if (!drained) throw new Error("Playback cleanup did not finish");
          if (originalSpotifyVolume !== undefined) await restoreSpotifyVolume(originalSpotifyVolume, getSpotifyState);
          console.log(`PASS live SoundCloud cleanup: Spotify paused; original volume ${originalSpotifyVolume === undefined ? "unchanged" : "restored"}`);
        } catch {
          failure ||= new Error("Could not pause Spotify and restore its original volume");
          console.error("FAIL live SoundCloud cleanup: could not verify paused Spotify and restored volume");
        }
      }
    }
    if (failure) {
      // Only controlled assertions and app-sanitized messages; never response bodies or media URLs.
      console.error("FAIL live SoundCloud Electron integration:", failure.message);
      app.exit(1);
    } else {
      console.log(`PASS live SoundCloud switch back to ${realSpotify ? "real Spotify" : "Spotify mock"}`);
      console.log(`PASS live SoundCloud Electron integration (real API and media; ${realSpotify ? "real Spotify handoff verified" : "Spotify mocked"}; physical audio output unverified)`);
      app.quit();
    }
  });
}

module.exports = { runLiveSoundCloudSelftest };
