// Explicit offline fixture for the soundcloud self-test; never used in packaged apps.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

const track = (id) => ({
  kind: "track", urn: `soundcloud:tracks:${id}`, title: `Fixture ${id}`,
  user: { username: "Nostalgify test" }, duration: 12000,
  access: "playable", sharing: "public", streamable: true,
  permalink_url: `https://soundcloud.com/nostalgify-test/${id}`,
});
const playlist = {
  kind: "playlist", urn: "soundcloud:playlists:900", title: "Fixture playlist",
  user: { username: "Nostalgify test" }, sharing: "public",
  permalink_url: "https://soundcloud.com/nostalgify-test/sets/fixture",
  tracks: [track("901"), track("902")], track_count: 2,
};

function createFixtureFetch() {
  return async (input) => {
    const url = new URL(input);
    if (url.hostname === "secure.soundcloud.com" && url.pathname === "/oauth/token") {
      return Response.json({ access_token: "offline-fixture-access-token", expires_in: 3600, token_type: "bearer" });
    }
    if (url.hostname === "api.soundcloud.com") {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === "/resolve") return Response.json(url.searchParams.get("url").includes("/sets/") ? playlist : track("901"));
      if (/^\/playlists\/soundcloud:playlists:900\/tracks$/.test(pathname)) return Response.json({ collection: playlist.tracks, next_href: null });
      if (pathname === "/playlists/soundcloud:playlists:900") return Response.json(playlist);
      if (/^\/tracks\/soundcloud:tracks:90[12]\/streams$/.test(pathname)) {
        return Response.json({ hls_aac_160_url: "https://playback.media-streaming.soundcloud.cloud/fixture/index.m3u8" });
      }
      const found = pathname.match(/^\/tracks\/soundcloud:tracks:(90[12])$/);
      if (found) return Response.json(track(found[1]));
    }
    if (url.hostname === "playback.media-streaming.soundcloud.cloud" && url.pathname.startsWith("/fixture/")) {
      const file = path.basename(url.pathname);
      if (!/^(index\.m3u8|segment-\d+\.ts)$/.test(file)) return new Response(null, { status: 404 });
      const content = await fs.readFile(path.join(__dirname, "../fixtures/soundcloud", file));
      return new Response(content, { headers: { "content-type": file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" } });
    }
    throw new Error("Unexpected network request in offline SoundCloud self-test");
  };
}

async function runSoundCloudSelftest({ win, app, playback, readPrefs }) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    for (let i = 0; i < 100; i++) {
      const value = await predicate();
      if (value) { console.log(`PASS SoundCloud ${label}`); return value; }
      await wait(100);
    }
    throw new Error(`SoundCloud self-test timed out: ${label}; state=${JSON.stringify(await playback.getState())}`);
  };
  win.webContents.once("did-finish-load", async () => {
    try {
      await until("UI ready", () => js("Boolean(window.__shelf && document.querySelector('#play'))"));
      await js("window.__shelf.addFromText('https://soundcloud.com/nostalgify-test/sets/fixture')");
      assert.equal(readPrefs().shelf[0].provider, "soundcloud");
      assert.equal(readPrefs().shelfVersion, 2);
      await js("[...document.querySelectorAll('#playlist-window .track-cell')].find(cell => cell.textContent.includes('Fixture playlist')).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
      await until("AAC HLS decodes and advances", async () => {
        const state = await playback.getState();
        return state.provider === "soundcloud" && state.state === "playing" && state.position > 0.5;
      });
      await until("decoded duration reaches the seek bar", () => js("(() => { const s=window.__webamp.store.getState(); const d=s.tracks[s.playlist.currentTrack]?.duration; return d > 12 && d < 12.1; })()"));
      await js("document.getElementById('pause').click()");
      await until("pause", async () => (await playback.getState()).state === "paused");
      const paused = (await playback.getState()).position;
      await wait(500);
      assert.ok(Math.abs((await playback.getState()).position - paused) < 0.2, "paused audio clock must stop");
      await playback.command("seek", 4);
      await playback.command("volume", 25);
      await playback.command("play");
      await until("seek, volume and resume", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.position > 4.2 && state.volume === 25;
      });
      await playback.command("next");
      await until("next within playlist", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.track.id === "soundcloud:tracks:902";
      });
      const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      win.webContents.reload();
      await reloaded;
      await until("shelf survives reload", () => js("Boolean(window.__shelf && window.__webamp.store.getState().playlist.trackOrder.length === 2 && [...document.querySelectorAll('#playlist-window .track-cell')].some(cell => cell.textContent.includes('Fixture playlist')))"));
      assert.equal((await playback.getState()).track, null, "reload stops the previous audio session");
      await js("[...document.querySelectorAll('#playlist-window .track-cell')].find(cell => cell.textContent.includes('Fixture playlist')).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
      await until("playback recovers after reload", async () => (await playback.getState()).state === "playing");
      await playback.command("selectProvider", "spotify");
      assert.equal((await playback.getState()).provider, "spotify");
      console.log("PASS SoundCloud switch back to Spotify");
      console.log("PASS SoundCloud offline integration (fixture audio; live service not exercised)");
      app.quit();
    } catch (error) {
      console.error("FAIL SoundCloud offline integration:", error.message);
      console.error("Fixture renderer:", await js("JSON.stringify({ready:!!window.__shelf,cells:document.querySelectorAll('#playlist-window .track-cell').length,body:document.body.innerText.slice(0,300),tracks:window.__webamp?.store.getState().playlist.trackOrder})").catch(() => "unavailable"));
      app.exit(1);
    }
  });
}

module.exports = { createFixtureFetch, runSoundCloudSelftest };
