// Explicit real-Spotify checks, included in packaged apps as well as development.
// Playback stays muted except for a volume assertion while Spotify is paused.
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");

const ALBUM_URI = "spotify:album:2noRn2Aes5aoNVsU6iWThc";
const PICKED_TRACK_URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(label, operation, timeout = 8000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function osascript(args) {
  return new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout: 4000 }, (error, stdout) => {
      // Never echo arbitrary subprocess output or command arguments into logs.
      if (error) reject(new Error("macOS automation failed or timed out"));
      else resolve(stdout.trim());
    });
  });
}

function frontmost() {
  return osascript(["-l", "JavaScript", "-e", `
    ObjC.import("AppKit");
    const spotify = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.spotify.client").firstObject;
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    const bundle = ObjC.unwrap(front.bundleIdentifier);
    JSON.stringify({ pid: Number(front.processIdentifier), name: ObjC.unwrap(front.localizedName), bundle, spotifyFront: bundle === "com.spotify.client", hidden: !spotify.isNil() && Boolean(spotify.isHidden) });
  `]).then(JSON.parse);
}

// Restore the value actually observed before testing. The normal volume command
// compensates for Spotify's rounding; read back and correct the raw AppleScript
// value here so cleanup also works if a Spotify version rounds differently.
async function restoreVolume(target, getState) {
  let requested = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    await osascript(["-e", `tell application "Spotify" to set sound volume to ${requested}`]);
    const state = await bounded("read restored Spotify volume", getState);
    assert.ok(state.running && !state.error, "Cannot verify restored Spotify volume");
    if (state.volume === target) return;
    assert.ok(Number.isFinite(state.volume), "Spotify returned an invalid volume during cleanup");
    requested = Math.max(0, Math.min(100, requested + target - state.volume));
  }
  throw new Error("Spotify volume did not return to its original value");
}

function runRealSpotifySelftest({ win, app, readPrefs, spotifyCommand, getSpotifyState, playback }) {
  const mode = process.env.NOSTALGIFY_SELFTEST;
  if (!["real", "focus"].includes(mode) || process.env.NOSTALGIFY_MOCK || process.platform !== "darwin") {
    console.error("FAIL real Spotify self-test requires explicit real/focus mode, macOS, and NOSTALGIFY_MOCK unset");
    app.exit(1);
    return;
  }

  let started = false;
  const loadTimeout = setTimeout(() => {
    if (!started) {
      console.error(`FAIL real Spotify ${mode}: UI did not load within 60 seconds`);
      app.exit(1);
    }
  }, 60000);

  win.webContents.once("did-finish-load", async () => {
    started = true;
    clearTimeout(loadTimeout);
    const deadline = Date.now() + 180000;
    const call = (label, operation, timeout = 8000) => {
      assert.ok(Date.now() < deadline, "Real Spotify self-test exceeded its three-minute deadline");
      return bounded(label, operation, Math.min(timeout, deadline - Date.now()));
    };
    const js = (code) => call("renderer response", () => win.webContents.executeJavaScript(code), 30000);
    let lastSpotifyState;
    const state = async () => {
      lastSpotifyState = await call("Spotify state", getSpotifyState);
      return lastSpotifyState;
    };
    let lastFocus;
    const focus = async () => {
      const front = await call("frontmost application", frontmost);
      lastFocus = { ...front, nostalgifyFocused: win.isFocused(), nostalgifyPid: process.pid };
      return lastFocus;
    };
    const until = async (label, predicate, timeout = 30000) => {
      const end = Math.min(deadline, Date.now() + timeout);
      while (Date.now() < end) {
        if (await predicate()) { console.log(`PASS real Spotify ${label}`); return; }
        await wait(150);
      }
      throw new Error(`Timed out: ${label}`);
    };
    const ui = () => js(`(() => {
      const s = window.__webamp.store.getState();
      const t = s.tracks[s.playlist.currentTrack];
      return { title: t?.title, artist: t?.artist, album: t?.album, duration: t?.duration, status: s.media.status, volume: s.media.volume, position: window.__bridge.media.timeElapsed() };
    })()`);
    const pauseFromUi = async () => {
      await js("document.getElementById('pause').click()");
      await until("Webamp pauses Spotify and reflects paused state", async () => (await state()).state === "paused" && (await ui()).status === "PAUSED");
    };
    let originalVolume;
    let failure;
    try {
      await until("UI ready", () => js("Boolean(window.__shelf && window.__webamp && window.__bridge?.media && document.getElementById('play'))"));
      await until("real Spotify responds", async () => {
        const s = await state();
        assert.notEqual(s.error, "permission", "macOS Automation permission to control Spotify was denied");
        return s.running && !s.error && Number.isFinite(s.volume);
      });
      originalVolume = (await state()).volume;
      assert.ok(Number.isInteger(originalVolume) && originalVolume >= 0 && originalVolume <= 100, "Spotify must report a valid original volume");
      await call("pause before testing", () => spotifyCommand("pause"));
      await until("paused before volume changes", async () => {
        const s = await state();
        return s.running && !s.error && ["paused", "stopped"].includes(s.state);
      });
      await call("mute Spotify", () => spotifyCommand("volume", 0));
      await until("muted before playback", async () => (await state()).volume === 0);
      await call("select Spotify", () => playback.command("selectProvider", "spotify"));
      await js(`window.__shelf.addFromText(${JSON.stringify(ALBUM_URI)})`);
      await until("Discovery album saved to shelf", () => readPrefs().shelf?.some((entry) => entry.uri === ALBUM_URI && entry.title.includes("Discovery")));
      win.show();
      app.focus({ steal: true });
      await until("Nostalgify focused before shelf playback", async () => {
        const front = await focus();
        return front.nostalgifyFocused && front.pid === process.pid;
      });
      await js(`(() => {
        const s = window.__webamp.store.getState();
        const id = s.playlist.trackOrder.find(id => s.tracks[id].url === ${JSON.stringify("shelf:" + ALBUM_URI)});
        const cell = [...document.querySelectorAll('#playlist-window .track-cell')].find(cell => id != null && cell.textContent.includes(s.tracks[id].title));
        if (!cell) throw new Error('Discovery shelf row is missing');
        cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      })()`);
      await until("shelf starts a real Discovery track", async () => {
        const s = await state();
        return s.state === "playing" && s.track?.album === "Discovery" && s.track.id.startsWith("spotify:track:") && s.volume === 0;
      });
      const initial = await state();
      await until("Spotify playback clock advances", async () => {
        const s = await state();
        return s.state === "playing" && s.track?.id === initial.track.id && s.position > initial.position + 0.4;
      });
      await until("Spotify metadata and playing state reach Webamp", async () => {
        const s = await state();
        const u = await ui();
        return u.status === "PLAYING" && u.title === s.track?.name && u.artist === s.track?.artist && u.album === s.track?.album && u.duration > 10 && Math.abs(u.duration - s.track.duration) < 1;
      });
      await until("shelf playback keeps Nostalgify in front and Spotify hidden", async () => {
        const front = await focus();
        return front.nostalgifyFocused && front.pid === process.pid && front.hidden;
      });
      // Observe a whole interval to catch delayed focus stealing after playUri.
      const focusStart = Date.now();
      await until("shelf focus remains stable", async () => {
        const front = await focus();
        assert.ok(front.nostalgifyFocused && front.pid === process.pid && front.hidden, "Shelf playback stole focus from Nostalgify");
        return Date.now() - focusStart >= 2500;
      }, 6000);

      if (mode === "real") {
        await pauseFromUi();
        const paused = await state();
        const pausedAt = Date.now();
        await until("paused playback clock remains stopped", async () => {
          const s = await state();
          assert.ok(s.state === "paused" && Math.abs(s.position - paused.position) < 0.5, "Spotify's clock advanced while paused");
          return Date.now() - pausedAt >= 1000;
        }, 5000);
        await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
        await until("Webamp keyboard seeks the real Spotify player", async () => {
          const s = await state();
          return s.state === "paused" && Math.abs(s.position - paused.position - 5) < 0.75 && Math.abs((await ui()).position - s.position) < 0.75;
        });
        const sought = (await state()).position;
        await js("window.__webamp.store.dispatch({ type: 'SET_VOLUME', volume: 37 })");
        await until("Webamp volume reaches Spotify", async () => (await state()).volume === 37 && (await ui()).volume === 37);
        await js("window.__webamp.store.dispatch({ type: 'SET_VOLUME', volume: 0 })");
        await until("muted again before resume", async () => (await state()).volume === 0);
        await js("document.getElementById('play').click()");
        await until("Webamp resumes Spotify after seeking", async () => {
          const s = await state();
          return s.state === "playing" && s.position > sought + 0.4 && (await ui()).status === "PLAYING";
        });
        await pauseFromUi();
        await js("document.getElementById('eject').click()");
        await until("Eject brings Spotify forward", async () => {
          const front = await focus();
          return front.spotifyFront && !front.hidden && !front.nostalgifyFocused;
        });
        // Bypass playUri's own hide/refocus behavior: this roundtrip must be
        // completed by the Eject watcher, as when picking a song in Spotify.
        await call("choose a track in Spotify", () => osascript(["-e", `tell application "Spotify" to play track "${PICKED_TRACK_URI}"`]));
        await until("chosen Spotify track starts", async () => {
          const s = await state();
          return s.state === "playing" && s.track?.id === PICKED_TRACK_URI && s.position > 0.2;
        });
        await until("Eject returns focus and hides Spotify after selection", async () => {
          const front = await focus();
          return front.nostalgifyFocused && front.pid === process.pid && front.hidden;
        });
        await until("chosen track metadata reaches Webamp", async () => (await ui()).title === (await state()).track?.name);
      }
    } catch (error) {
      failure = error;
      if (lastSpotifyState) {
        const { running, state, position, volume, error: stateError, track } = lastSpotifyState;
        console.error("Real Spotify last observed playback:", JSON.stringify({ running, state, position, volume, error: stateError, track: track && { id: track.id, name: track.name, album: track.album } }));
      }
      if (lastFocus) console.error("Real Spotify last observed focus:", JSON.stringify(lastFocus));
    } finally {
      // Cleanup has its own bounded budget, including after a test timeout.
      let drained = false;
      try {
        // Prevent late renderer work from submitting another play command, and
        // finish an already-running native command before the final pause.
        await bounded("drain playback during cleanup", () => playback.dispose(), 30000);
        drained = true;
      } catch {
        failure ||= new Error("Playback did not drain during cleanup; original Spotify volume cannot be safely restored");
      }
      try {
        if (!drained) await bounded("keep Spotify muted after cleanup timeout", () => spotifyCommand("volume", 0));
        await bounded("pause Spotify during cleanup", () => spotifyCommand("pause"));
        const cleanupDeadline = Date.now() + 8000;
        let paused = false;
        while (Date.now() < cleanupDeadline) {
          const s = await bounded("read Spotify cleanup state", getSpotifyState, Math.max(1, cleanupDeadline - Date.now()));
          if (s.running && !s.error && ["paused", "stopped"].includes(s.state)) { paused = true; break; }
          await wait(150);
        }
        assert.ok(paused, "Could not verify Spotify is paused during cleanup");
        if (!drained) throw new Error("Playback cleanup did not finish");
        if (originalVolume !== undefined) await restoreVolume(originalVolume, getSpotifyState);
        console.log(`PASS real Spotify cleanup: playback paused; original volume ${originalVolume === undefined ? "unchanged" : "restored"}`);
      } catch {
        failure ||= new Error("Could not pause Spotify and restore its original volume");
        console.error("FAIL real Spotify cleanup: could not verify paused playback and restored volume");
      }
    }
    if (failure) {
      console.error(`FAIL real Spotify ${mode}: ${failure.message}`);
      app.exit(1);
    } else {
      console.log(`PASS real Spotify ${mode} integration (physical audio output unverified)`);
      app.quit();
    }
  });
}

module.exports = { runRealSpotifySelftest, bounded, restoreSpotifyVolume: restoreVolume };
