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
  const attributionClickable = () => js(`(() => {
    const a = document.getElementById('soundcloud-attribution');
    if (!a || a.hidden) return false;
    return [a, a.querySelector('img'), a.querySelector('span')].every(element => {
      if (!element) return false;
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && [0.1, 0.5, 0.9].every(fraction =>
        a.contains(document.elementFromPoint(r.x + r.width * fraction, r.y + r.height / 2)));
    });
  })()`);
  const attributionDiagnostic = () => js(`(() => {
    const a = document.getElementById('soundcloud-attribution');
    const main = document.getElementById('main-window');
    const rect = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => [key, Math.round(r[key] * 100) / 100]));
    };
    const describe = (element) => {
      if (!element) return null;
      const s = getComputedStyle(element);
      // Only shape references, geometry, and element identifiers: no DOM text,
      // image URLs, local file paths, or source/authorization values.
      const clipPath = s.clipPath.includes('url(') ? (s.clipPath.match(/#[^"')]+/)?.[0] || 'url-reference') : s.clipPath;
      return { tag: element.tagName, id: element.id, classes: [...element.classList], rect: rect(element),
        display: s.display, visibility: s.visibility, opacity: s.opacity, pointerEvents: s.pointerEvents,
        position: s.position, zIndex: s.zIndex, overflow: s.overflow, clipPath,
        appRegion: s.getPropertyValue('-webkit-app-region'), transform: s.transform };
    };
    const r = a?.getBoundingClientRect();
    const points = r ? [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 2, r.y + r.height / 2], [r.right - 2, r.y + r.height / 2]] : [];
    const ancestors = [];
    for (let p = a?.parentElement; p && ancestors.length < 5; p = p.parentElement) ancestors.push(describe(p));
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      reduxShade: window.__webamp?.store.getState().windows.genWindows.main.shade,
      main: describe(main), attribution: { ...describe(a), hidden: a?.hidden, connected: a?.isConnected, parent: a?.parentElement?.id },
      ancestors, titleBar: describe(document.getElementById('title-bar')),
      clipGeometry: [...document.querySelectorAll('clipPath')].filter(element => /mainwindow/i.test(element.id)).slice(0, 2).map(element => ({
        id: element.id, units: element.getAttribute('clipPathUnits'),
        shapeCount: element.children.length, shapes: [...element.children].slice(0, 2).map(shape => ({ tag: shape.tagName,
          pointsLength: shape.getAttribute('points')?.length, points: shape.getAttribute('points')?.slice(0, 100),
          pathLength: shape.getAttribute('d')?.length, d: shape.getAttribute('d')?.slice(0, 100) })) })),
      hits: points.map(([x, y]) => ({ x, y, attributionContainsHit: !!a?.contains(document.elementFromPoint(x, y)),
        elements: document.elementsFromPoint(x, y).slice(0, 6).map(describe) })) };
  })()`);
  const screenshot = async (name) => {
    const directory = process.env.NOSTALGIFY_SHOTS || app.getPath("temp");
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${name}.png`);
    await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
    console.log("SoundCloud offline screenshot:", file);
  };
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
      await until("normal source logo and uploader attribution", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const img=a?.querySelector('img'); return a && !a.hidden && a.getBoundingClientRect().width > 0 && img?.complete && img.naturalWidth > 0 && a.getAttribute('aria-label')?.toLowerCase().includes('uploaded by'); })()"));
      await js("window.__webamp.store.dispatch({type:'TOGGLE_WINDOW_SHADE_MODE',windowId:'main'})");
      await until("compact attribution moves outside the skin clip path", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const m=document.getElementById('main-window'); return m?.classList.contains('shade') && a?.classList.contains('soundcloud-attribution-compact') && a.parentElement === m.parentElement; })()"));
      await until("compact attribution logo and text remain clickable", attributionClickable);
      if (process.env.NOSTALGIFY_SHOTS) await screenshot("soundcloud-offline-compact");
      await js("window.__webamp.store.dispatch({type:'TOGGLE_DOUBLESIZE_MODE'})");
      await until("compact attribution matches Webamp Double Size", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const m=document.getElementById('main-window'); const r=a.getBoundingClientRect(); const b=m.getBoundingClientRect(); const img=a.querySelector('img').getBoundingClientRect(); return m.classList.contains('doubled') && m.classList.contains('shade') && Math.abs(r.width-200)<0.1 && Math.abs(r.height-24)<0.1 && Math.abs(r.left-b.left-40)<0.1 && Math.abs(r.top-b.top-2)<0.1 && Math.abs(img.width-80)<0.1; })()"));
      await until("double-size compact attribution logo and text remain clickable", attributionClickable);
      if (process.env.NOSTALGIFY_SHOTS) await screenshot("soundcloud-offline-compact-double");
      await js("window.__webamp.store.dispatch({type:'TOGGLE_WINDOW_SHADE_MODE',windowId:'main'})");
      await until("normal transport and attribution parent restored after compact mode", () => js("(() => { const a=document.getElementById('soundcloud-attribution'); const m=document.getElementById('main-window'); return !m.classList.contains('shade') && document.getElementById('pause').getBoundingClientRect().height > 0 && a.parentElement === m && !a.classList.contains('soundcloud-attribution-compact') && !a.style.left && !a.style.top && !a.style.transform; })()"));
      await until("normal double-size attribution logo and text remain clickable", attributionClickable);
      await js("window.__webamp.store.dispatch({type:'TOGGLE_DOUBLESIZE_MODE'})");
      await until("normal attribution returns to original size", () => js("!document.getElementById('main-window').classList.contains('doubled') && Math.abs(document.getElementById('soundcloud-attribution').getBoundingClientRect().width-154)<0.1"));
      await until("normal attribution logo and text remain clickable", attributionClickable);
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
      const stoppedTrack = (await playback.getState()).track.id;
      await js("document.getElementById('stop').click()");
      await until("Stop button pauses and rewinds the current track", async () => {
        const state = await playback.getState();
        return state.state === "paused" && state.position < 0.2 && state.track?.id === stoppedTrack;
      });
      await wait(500);
      assert.ok((await playback.getState()).position < 0.2, "stopped audio must remain at the beginning");
      await js("document.getElementById('play').click()");
      await until("Play button resumes the stopped track from the beginning", async () => {
        const state = await playback.getState();
        return state.state === "playing" && state.position > 0.2 && state.position < 3 && state.track?.id === stoppedTrack;
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
      console.error("Fixture attribution geometry:", JSON.stringify(await attributionDiagnostic().catch(() => ({ unavailable: true }))));
      await screenshot("soundcloud-offline-failure").catch(() => console.error("SoundCloud offline failure screenshot unavailable"));
      console.error("Fixture renderer:", await js("JSON.stringify({ready:!!window.__shelf,cells:document.querySelectorAll('#playlist-window .track-cell').length,body:document.body.innerText.slice(0,300),tracks:window.__webamp?.store.getState().playlist.trackOrder})").catch(() => "unavailable"));
      app.exit(1);
    }
  });
}

module.exports = { createFixtureFetch, runSoundCloudSelftest };
