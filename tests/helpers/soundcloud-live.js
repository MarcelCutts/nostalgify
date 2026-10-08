// Opt-in, read-only live service check. No fixture fetch or user-account writes.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

function runLiveSoundCloudSelftest({ win, app, playback, readPrefs }) {
  const url = process.env.NOSTALGIFY_SOUNDCLOUD_TEST_URL || "https://soundcloud.com/forss/sets/soulhack";
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (await predicate()) { console.log(`PASS live SoundCloud ${label}`); return; }
      const state = await playback.getState();
      if (state.provider === "soundcloud" && state.error) throw new Error(`${label}: ${state.message}`);
      await wait(150);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const clickShelf = () => js("[...document.querySelectorAll('#playlist-window .track-cell')].find(cell => cell.textContent.includes('(SoundCloud,')).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  win.webContents.once("did-finish-load", async () => {
    const deadline = setTimeout(() => { console.error("FAIL live SoundCloud overall timeout"); app.exit(1); }, 240000);
    try {
      assert.ok(process.env.SOUNDCLOUD_CLIENT_ID && process.env.SOUNDCLOUD_CLIENT_SECRET, "Live checks require application credentials");
      await until("UI ready", () => js("Boolean(window.__shelf && document.querySelector('#play'))"));
      await js(`window.__shelf.addFromText(${JSON.stringify(url)})`);
      await until("public playlist resolves and is saved", () => readPrefs().shelf?.some((entry) => entry.provider === "soundcloud" && entry.kind === "playlist"));
      await clickShelf();
      await until("AAC HLS decodes and clock advances", async () => {
        const state = await playback.getState();
        return state.provider === "soundcloud" && state.state === "playing" && state.position > 1;
      });
      const first = (await playback.getState()).track.id;
      // The legacy Spotify mock reports a fixed playing state. Its command log
      // and coordinator unit tests verify pause routing; macOS verifies Spotify.
      await until("duration and title reach Webamp", () => js("(() => { const s=window.__webamp.store.getState(); const t=s.tracks[s.playlist.currentTrack]; return t?.duration > 10 && Boolean(t.title); })()"));
      await until("source logo and uploader attribution", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const img=a?.querySelector('img'); return a && !a.hidden && a.getBoundingClientRect().width > 0 && img?.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width >= 30 && a.getAttribute('aria-label').toLowerCase().includes('uploaded by'); })()"));
      if (process.env.NOSTALGIFY_SHOTS) {
        await fs.writeFile(path.join(process.env.NOSTALGIFY_SHOTS, "soundcloud-live.png"), (await win.webContents.capturePage()).toPNG());
      }
      await js("window.__webamp.store.dispatch({type:'TOGGLE_WINDOW_SHADE_MODE',windowId:'main'})");
      await until("attribution remains clickable in compact mode", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const r=a.getBoundingClientRect(); return document.getElementById('main-window').classList.contains('shade') && a.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()"));
      await wait(400);
      if (process.env.NOSTALGIFY_SHOTS) {
        await fs.writeFile(path.join(process.env.NOSTALGIFY_SHOTS, "soundcloud-live-compact.png"), (await win.webContents.capturePage()).toPNG());
      }
      await js("window.__webamp.store.dispatch({type:'TOGGLE_WINDOW_SHADE_MODE',windowId:'main'})");
      await until("normal transport restored", () => js("!document.getElementById('main-window').classList.contains('shade')"));
      await js("document.getElementById('pause').click()");
      await until("pause from Webamp", async () => (await playback.getState()).state === "paused");
      const paused = (await playback.getState()).position;
      await wait(700);
      assert.ok(Math.abs((await playback.getState()).position - paused) < 0.2, "Paused audio clock must stop");
      await js("window.__webamp.store.dispatch({type:'SET_VOLUME',volume:25})");
      await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
      await js("document.getElementById('play').click()");
      await until("seek, volume and resume", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.position > paused + 5.2 && state.volume === 25;
      });
      await js("document.getElementById('next').click()");
      await until("next plays another real track", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.track.id !== first && state.position > 0.2;
      });
      // Previous returns to the prior item while close to the beginning.
      await playback.command("seek", 0);
      await until("seek back before previous", async () => (await playback.getState()).position < 1);
      await playback.command("pause");
      await js("document.getElementById('previous').click()");
      await until("previous restores the first track", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.track.id === first && state.position > 0.2;
      });
      const duration = (await playback.getState()).track.duration;
      await playback.command("seek", duration - 1);
      await until("natural ending advances the real playlist", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.track.id !== first && state.position > 0.2;
      });
      const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      win.webContents.reload();
      await reloaded;
      await until("shelf survives renderer reload", () => js("Boolean(window.__shelf && [...document.querySelectorAll('#playlist-window .track-cell')].some(cell => cell.textContent.includes('(SoundCloud,')))"));
      assert.equal((await playback.getState()).track, null, "Reload stops previous audio");
      await clickShelf();
      await until("live playback recovers after reload", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.position > 0.5;
      });
      await playback.command("selectProvider", "spotify");
      assert.equal((await playback.getState()).provider, "spotify");
      await until("SoundCloud attribution hides on source switch", () => js("document.getElementById('soundcloud-attribution')?.hidden"));
      console.log("PASS live SoundCloud switch back to Spotify mock");
      console.log("PASS live SoundCloud Electron integration (real API and media; Spotify mocked; physical audio output unverified)");
      clearTimeout(deadline);
      app.quit();
    } catch (error) {
      clearTimeout(deadline);
      // Only controlled assertions and app-sanitized messages; never response bodies or media URLs.
      console.error("FAIL live SoundCloud Electron integration:", error.message);
      app.exit(1);
    }
  });
}

module.exports = { runLiveSoundCloudSelftest };
