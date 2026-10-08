// Self-tests for development. Run one with NOSTALGIFY_SELFTEST=<mode>, usually
// together with NOSTALGIFY_MOCK=1 (a fake Spotify) and NOSTALGIFY_USER_DATA
// (a throwaway settings folder). The modes are listed in the README.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

module.exports = function runSelfTest(ctx) {
  if (process.env.NOSTALGIFY_SELFTEST === "soundcloud-live" && !ctx.app.isPackaged && process.env.NOSTALGIFY_MOCK === "1") {
    return require("../../tests/helpers/soundcloud-live").runLiveSoundCloudSelftest(ctx);
  }
  if (process.env.NOSTALGIFY_SELFTEST === "soundcloud" && !ctx.app.isPackaged && process.env.NOSTALGIFY_MOCK === "1") {
    return require("../../tests/helpers/soundcloud-fixture").runSoundCloudSelftest(ctx);
  }
  const { win, app, screen, setZoom, cssSize, zoom, readPrefs, listSkins, applySkin, spotifyCommand, getSpotifyState } = ctx;
  const D = process.env.NOSTALGIFY_SHOTS || app.getPath("temp");
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(D, name + ".png"), img.toPNG());
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = (label) =>
    console.log(label, "content", win.getContentSize().join("x"), "css", `${cssSize().w}x${cssSize().h}`, "zoom", zoom());
  win.webContents.once("did-finish-load", async () => {
    await pause(4000);
    if (process.env.NOSTALGIFY_SELFTEST === "buttons") {
      for (const id of ["previous", "play", "pause", "stop", "next", "shuffle", "repeat", "eject"]) {
        await js(`document.getElementById(${JSON.stringify(id)}).click()`);
        await pause(400);
      }
    } else if (process.env.NOSTALGIFY_SELFTEST === "size") {
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      console.log("screen work area:", JSON.stringify(area), "| player css size:", cssSize().w + "x" + cssSize().h);
      for (const z of [4, 10, 1.5]) {
        setZoom(z, { save: false });
        await pause(600);
        const b = win.getBounds();
        const inside = b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;
        console.log(`asked for ${z}x -> got ${zoom()}x, window ${b.width}x${b.height} at ${b.x},${b.y}, fully on screen: ${inside}`);
      }
      win.setPosition(area.x + area.width - 100, area.y + area.height - 100);
      setZoom(2, { save: false });
      await pause(600);
      const b = win.getBounds();
      console.log(`after moving near the corner and resizing: at ${b.x},${b.y}, fully on screen: ${b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height}`);
    } else if (process.env.NOSTALGIFY_SELFTEST === "focus") {
      // Against the real Spotify, muted by the caller: play a shelf entry with Nostalgify in front.
      const front = () =>
        new Promise((r) =>
          execFile("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.spotify.client").firstObject; "spotify hidden=" + a.isHidden + " front=" + $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js'], (e, out) => r((out || "").trim()))
        );
      await js(`window.__shelf.addFromText("https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc")`);
      await pause(2000);
      win.show();
      app.focus({ steal: true });
      await pause(800);
      console.log("before double-click:", await front());
      await js(`[...document.querySelectorAll("#playlist-window .track-cell")].find((x) => x.textContent.includes("Discovery")).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
      for (const t of [700, 1500, 3000]) {
        await pause(t === 700 ? 700 : t - 700);
        console.log(`+${t}ms:`, await front());
      }
      await spotifyCommand("pause");
    } else if (process.env.NOSTALGIFY_SELFTEST === "real") {
      // Against the real Spotify. Run with Spotify muted; the caller restores it.
      const nowPlaying = () =>
        js(`(() => { const s = window.__webamp.store.getState(); const t = s.tracks[s.playlist.currentTrack]; return t ? t.artist + " - " + t.title + " | " + s.media.status : null; })()`);
      console.log("marquee before:", await nowPlaying());
      await js(`window.__shelf.addFromText("https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc")`);
      await pause(2000);
      console.log("cells:", await js(`JSON.stringify([...document.querySelectorAll("#playlist-window .track-cell")].map((x) => x.textContent))`));
      console.log("dblclick:", await js(`(() => { const cells = [...document.querySelectorAll("#playlist-window .track-cell")]; const c = cells.find((x) => x.textContent.includes("Discovery")); if (!c) return "no cell"; c.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return "sent"; })()`));
      await pause(4000);
      console.log("marquee after double-click:", await nowPlaying());
      console.log("quiet counter:", await js(`window.__bridge.quiet`));
      console.log("recent actions:", await js(`JSON.stringify(window.__actions.filter((a) => !a.startsWith("UPDATE_TIME") && !a.startsWith("STEP_MARQUEE")).slice(-12))`));
      const st = await getSpotifyState();
      console.log("spotify says:", st.state, "|", st.track && st.track.artist + " - " + st.track.name + " | " + st.track.album);
      await spotifyCommand("pause");
      await pause(1500);
      console.log("marquee after pause:", await nowPlaying());
      await js(`window.__webamp.store.dispatch({ type: "SET_VOLUME", volume: 37 })`);
      await pause(1500);
      console.log("volume set to 37 in Webamp, Spotify reads:", (await getSpotifyState()).volume);
      // Eject round trip: Spotify comes forward, a song gets picked, Spotify hides again.
      const front = () =>
        new Promise((r) =>
          execFile("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.spotify.client").firstObject; "spotify hidden=" + a.isHidden + " front=" + $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js'], (e, out) => r((out || "").trim()))
        );
      await js(`document.getElementById("eject").click()`);
      await pause(2500);
      console.log("after eject:", await front());
      await spotifyCommand("playUri", "spotify:track:4uLU6hMCjMI75M1A2tKUQC");
      await pause(4000);
      console.log("after picking a song:", await front());
      await spotifyCommand("pause");
    } else if (process.env.NOSTALGIFY_SELFTEST === "shelf") {
      const rows = () =>
        js(`JSON.stringify(window.__webamp.store.getState().playlist.trackOrder.map((id) => window.__webamp.store.getState().tracks[id].title))`);
      const nowPlaying = () =>
        js(`(() => { const s = window.__webamp.store.getState(); const t = s.tracks[s.playlist.currentTrack]; return t ? t.artist + " - " + t.title : null; })()`);
      console.log("start rows:", await rows());
      console.log("marquee track:", await nowPlaying());
      await js(`window.__shelf.addFromText("look https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc?si=abc and spotify:playlist:37i9dQZF1DXcBWIGoYBM5M")`);
      await pause(1500);
      console.log("after paste:", await rows());
      await js(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "https://open.spotify.com/intl-de/artist/4tZwfgrHOc3mvqYlEYSvVi"); document.querySelector("#main-window").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
      await pause(1500);
      console.log("after drop on main window:", await rows());
      await js(`window.__shelf.addFromText("not a link")`);
      await pause(300);
      console.log("marquee says:", await js(`window.__webamp.store.getState().userInput.userMessage`));
      await js(`document.querySelectorAll("#playlist-window .track-cell")[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
      await pause(800);
      await js(`document.querySelectorAll("#playlist-window .track-cell")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
      await pause(800);
      await js(`document.querySelector(".playlist-next-button").click()`);
      await pause(500);
      console.log("marquee track after shelf plays:", await nowPlaying());
      await shot("s1-shelf");
      await js(`window.__webamp.store.dispatch({ type: "REMOVE_TRACKS", ids: [window.__webamp.store.getState().playlist.trackOrder[2]] })`);
      await pause(500);
      console.log("after remove:", await rows());
      console.log("saved shelf:", JSON.stringify(readPrefs().shelf));
    } else if (process.env.NOSTALGIFY_SELFTEST === "eq") {
      const eqState = () =>
        js(`(() => { const s = window.__webamp.store.getState(); return JSON.stringify({ eqOpen: s.windows.genWindows.equalizer.open, bands: s.equalizer.sliders, on: s.equalizer.on }); })()`);
      console.log("no-eq skin:", await eqState());
      report("no-eq skin");
      await shot("e1-noeq");
      await js(`document.getElementById("equalizer-button").click()`);
      await pause(500);
      console.log("after EQ button:", await eqState());
      applySkin(listSkins().find((x) => /^Green/.test(x.name)));
      await pause(2500);
      console.log("green skin:", await eqState());
      report("green skin");
      await shot("e2-green");
      // Try dragging a band: pointer events should be ignored.
      const before = await eqState();
      await js(`(() => { const b = document.querySelector("#equalizer-window .band"); const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + 10); return el ? el.id || el.className : "none"; })()`).then((hit) => console.log("element under band:", hit));
      console.log("bands unchanged:", before === (await eqState()));
    } else {
      report("start");
      await shot("t1-start");
      await js(`document.getElementById("playlist-button").click()`); // PL toggle
      await pause(800);
      report("playlist open");
      await shot("t2-playlist");
      await js(`document.getElementById("equalizer-button").click()`); // EQ toggle
      await pause(800);
      report("eq closed");
      await shot("t3-eq-closed");
      setZoom(3);
      await pause(800);
      report("zoom 3");
      await shot("t4-zoom3");
      setZoom(1);
      await pause(800);
      report("zoom 1");
      await js(`document.getElementById("equalizer-button").click()`);
      await js(`document.getElementById("playlist-button").click()`);
      setZoom(2);
      await pause(800);
      report("back to start");
    }
    app.quit();
  });
};
