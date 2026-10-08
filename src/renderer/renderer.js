import Webamp from "webamp";
import { SpotifyMedia, bridge, quietly, sendCommand } from "./spotifyMedia.js";
import { manageLayout, addResizeGrips } from "./layout.js";
import { createEqPolicy } from "./eq.js";
import { createShelf } from "./shelf.js";
import { createSoundCloudAudio } from "./soundcloudAudio.js";

// Register before any asynchronous UI work so provider switches cannot send
// commands into an uninitialized audio engine.
const soundcloudAudio = createSoundCloudAudio();
window.addEventListener("beforeunload", () => soundcloudAudio.dispose(), { once: true });

const POLL_MS = 1000;
const TICK_MS = 200;

// Other modules listen to Webamp's actions through this list.
const actionListeners = [];

// Forward user actions to the active provider without echoing state updates.
const forwardToProvider = (store) => (next) => (action) => {
  const quiet = bridge.quiet > 0;
  const result = next(action);
  if (!quiet) {
    const s = store.getState();
    if (action.type === "TOGGLE_SHUFFLE") void sendCommand("shuffle", s.media.shuffle);
    if (action.type === "TOGGLE_REPEAT") void sendCommand("repeat", s.media.repeat);
  }
  actionListeners.forEach((cb) => cb(action, quiet, store.getState()));
  return result;
};

// Every skin load goes through fetch, from our menu or Webamp's own.
// Listeners use this to remember the choice and apply the equalizer rules.
const skinListeners = [];
export function onSkinLoad(cb) {
  skinListeners.push(cb);
}
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input && input.url;
  if (url && url.startsWith("skin://")) {
    window.nostalgify.skinChosen(url);
    skinListeners.forEach((cb) => cb(url));
  }
  return originalFetch(input, init);
};

async function main() {
  const { skins, initial } = await window.nostalgify.initSkins();
  const ui = await window.nostalgify.loadUiPrefs();

  const webamp = new Webamp({
    initialSkin: initial ? { url: initial } : undefined,
    availableSkins: skins,
    windowLayout: {
      main: { position: { top: 0, left: 0 } },
      equalizer: { position: { top: 116, left: 0 } },
      playlist: {
        position: { top: 232, left: 0 },
        closed: ui.playlistOpen === false,
        size: { extraHeight: ui.playlistExtraHeight ?? 1, extraWidth: 0 },
      },
    },
    enableHotkeys: false,
    handleAddUrlEvent: () => shelf.handleAddUrl(),
    __customMediaClass: SpotifyMedia,
    __customMiddlewares: [forwardToProvider],
  });
  const store = webamp.store;
  if (window.nostalgify.debug) window.__webamp = webamp;

  // Temporary marquee messages, like "Added Discovery (album)".
  let flashTimer = null;
  let flashing = false;
  function flash(text, ms = 2500) {
    // Winamp's pixel font has no hearts or curly quotes.
    const plain = String(text)
      .replace(/♥\s*/g, "")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"');
    store.dispatch({ type: "SET_USER_MESSAGE", message: plain });
    flashing = true;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashing = false;
      if (shownMessage) store.dispatch({ type: "SET_USER_MESSAGE", message: shownMessage });
      else store.dispatch({ type: "UNSET_USER_MESSAGE" });
    }, ms);
  }
  bridge.onCommandError = (message) => flash(message, 6000);

  // Keep source attribution inside the decorative bitrate/status strip so it
  // remains visible without changing the dimensions of any Winamp window.
  const attribution = document.createElement("button");
  attribution.id = "soundcloud-attribution";
  attribution.type = "button";
  attribution.hidden = true;
  const sourceLogo = document.createElement("img");
  sourceLogo.src = "assets/soundcloud-logo-white.webp";
  sourceLogo.alt = "SoundCloud";
  sourceLogo.width = 64;
  sourceLogo.height = 16;
  const sourceAction = document.createElement("span");
  sourceAction.textContent = "OPEN TRACK";
  attribution.append(sourceLogo, sourceAction);
  attribution.addEventListener("click", (event) => { event.stopPropagation(); void sendCommand("activate"); });
  // A source-link double click must not shade the title bar in compact mode.
  attribution.addEventListener("dblclick", (event) => event.stopPropagation());

  function positionAttribution() {
    const mainWindow = document.getElementById("main-window");
    if (!mainWindow) return;
    const compact = mainWindow.classList.contains("shade");
    // Skins may cut holes through the shade-mode window with an SVG clip path.
    // Its positioning wrapper is unclipped and moves with the main window, so
    // only the compact attribution sits alongside that shaped window.
    const parent = compact ? mainWindow.parentElement : mainWindow;
    if (!parent) return;
    attribution.classList.toggle("soundcloud-attribution-compact", compact);
    if (attribution.parentElement !== parent) parent.appendChild(attribution);
    if (compact) {
      // Webamp's Double Size scales the main window itself, not its wrapper.
      // Match that CSS scale here; Electron's separate View zoom affects both.
      const scale = mainWindow.classList.contains("doubled") ? 2 : 1;
      attribution.style.left = `${mainWindow.offsetLeft + Math.max(0, Math.min(20, mainWindow.offsetWidth - 100)) * scale}px`;
      attribution.style.top = `${mainWindow.offsetTop + Math.max(0, Math.min(1, mainWindow.offsetHeight - 12)) * scale}px`;
      attribution.style.transform = `scale(${scale})`;
    } else {
      attribution.style.removeProperty("left");
      attribution.style.removeProperty("top");
      attribution.style.removeProperty("transform");
    }
  }
  let attributionLayoutPending = false;
  function scheduleAttributionLayout() {
    if (attributionLayoutPending) return;
    attributionLayoutPending = true;
    requestAnimationFrame(() => {
      attributionLayoutPending = false;
      positionAttribution();
    });
  }
  webamp.__onStateChange(scheduleAttributionLayout);
  window.addEventListener("resize", scheduleAttributionLayout);

  function updateAttribution(s) {
    positionAttribution();
    const visible = s.provider === "soundcloud" && Boolean(s.track);
    attribution.hidden = !visible;
    document.body.classList.toggle("has-soundcloud-track", visible);
    if (visible) {
      const uploader = s.track.uploader || s.track.artist;
      const label = `Open ${s.track.name} on SoundCloud. Uploaded by ${uploader}.`;
      attribution.title = label;
      attribution.setAttribute("aria-label", label);
    }
  }

  const shelf = createShelf(webamp, {
    quietly,
    flash,
    // After playing a shelf entry, refresh straight away so the marquee catches up.
    onPlay: () => {
      currentTrackId = null;
      setTimeout(poll, 600);
    },
  });
  actionListeners.push((action, quiet) => shelf.onAction(action, quiet));
  if (window.nostalgify.debug) {
    window.__shelf = shelf;
    window.__bridge = bridge;
    window.__actions = [];
    actionListeners.push((action, quiet) => window.__actions.push(action.type + (quiet ? " (quiet)" : "")));
  }

  // Remember whether the playlist is open and how tall it is.
  actionListeners.push((action, quiet, state) => {
    const pl = state.windows.genWindows.playlist;
    if (["TOGGLE_WINDOW", "CLOSE_WINDOW", "WINDOW_SIZE_CHANGED"].includes(action.type)) {
      window.nostalgify.saveUiPrefs({ playlistOpen: pl.open, playlistExtraHeight: pl.size[1] });
    }
  });

  webamp.onClose(() => window.nostalgify.close());
  webamp.onMinimize(() => window.nostalgify.minimize());

  const eq = createEqPolicy(webamp, skins);
  onSkinLoad((url) => eq.applyForSkin(url));
  eq.applyForSkin(initial);
  window.nostalgify.onSetSkin((url) => webamp.setSkinFromUrl(url));
  window.nostalgify.onSkinsChanged((list) => {
    eq.updateSkins(list);
    store.dispatch({ type: "SET_AVAILABLE_SKINS", skins: list });
  });

  // ---------- intercept buttons Webamp would handle itself ----------
  // Capture phase on window runs before React's handlers on the root.
  // The playlist window has its own small transport buttons. They map to the main ones.
  const TRANSPORT = {
    next: "next",
    previous: "previous",
    play: "play",
    eject: "eject",
    "playlist-next-button": "next",
    "playlist-previous-button": "previous",
    "playlist-play-button": "play",
    "playlist-eject-button": "eject",
  };
  window.addEventListener(
    "click",
    (e) => {
      if (!(e.target instanceof Element)) return;
      // ADD > File and ADD > Dir point to the supported streaming links.
      if (e.target.closest("#playlist-add-menu .add-file, #playlist-add-menu .add-dir")) {
        e.stopPropagation();
        e.preventDefault();
        flash("Copy a Spotify or SoundCloud link, then use ADD URL", 3500);
        return;
      }
      if (e.target.closest("#equalizer-button")) {
        if (eq.allowed()) return;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      const el = e.target.closest(
        "#next, #previous, #eject, #play, .playlist-next-button, .playlist-previous-button, .playlist-play-button, .playlist-eject-button"
      );
      if (!el) return;
      const key = el.id || [...el.classList].find((c) => TRANSPORT[c]);
      const action = TRANSPORT[key];
      // With a song loaded, Webamp's own Play works through the media bridge.
      if (action === "play" && currentTrackId) return;
      e.stopPropagation();
      e.preventDefault();
      if (action === "next") transport("next");
      else if (action === "previous") transport("previous");
      else if (action === "play") transport("playOrFallback");
      else if (action === "eject") void sendCommand("eject");
    },
    true
  );

  function transport(cmd) {
    void sendCommand(cmd).then(() => setTimeout(poll, 250));
  }

  // Classic Winamp keys: Z prev, X play, C pause, V stop, B next.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "z") transport("previous");
    else if (k === "x") transport(currentTrackId ? "play" : "playOrFallback");
    else if (k === "c") transport("playpause");
    else if (k === "v") webamp.stop();
    else if (k === "b") transport("next");
    else if (e.key === "ArrowLeft") webamp.seekBackward(5);
    else if (e.key === "ArrowRight") webamp.seekForward(5);
  });

  // ---------- provider -> Webamp sync ----------
  let currentTrackId = null;
  let shownMessage = null;
  let base = { elapsed: 0, at: performance.now(), playing: false };

  // Status lines (like "Spotify isn't running") go in the marquee without
  // pretending to be a track.
  function showMessage(text, preserveTrack = false) {
    if (shownMessage !== text) {
      shownMessage = text;
      if (!preserveTrack) {
        currentTrackId = null;
        base.playing = false;
        bridge.media.setTiming(0, 0);
        quietly(() => {
          store.dispatch({ type: "PLAY_TRACK", id: null });
          store.dispatch({ type: "STOP" });
        });
        bridge.media.setVisPlaying(false);
      }
    }
    // Webamp clears user messages after some interactions, so keep re-setting it.
    if (!flashing && store.getState().userInput.userMessage !== text) {
      store.dispatch({ type: "SET_USER_MESSAGE", message: text });
    }
  }
  function clearMessage() {
    if (shownMessage == null) return;
    shownMessage = null;
    if (!flashing) store.dispatch({ type: "UNSET_USER_MESSAGE" });
  }

  // The provider's song becomes Webamp's current track, so the marquee,
  // clock and seek bar show it. It's added and then taken straight back out of
  // the playlist order, so the playlist window keeps showing only the shelf.
  let nowPlayingId = 8_000_000;
  let currentWebampTrackId = null;
  function showNowPlaying(track, provider) {
    const id = nowPlayingId++;
    currentWebampTrackId = id;
    quietly(() => {
      store.dispatch({ type: "ADD_TRACK_FROM_URL", id, url: "nowplaying:" + track.id, duration: track.duration });
      store.dispatch({ type: "REMOVE_TRACKS", ids: [id] });
      store.dispatch({
        type: "SET_MEDIA_TAGS",
        id,
        title: provider === "soundcloud" && track.uploader && track.uploader !== track.artist
          ? `${track.name} (uploaded by ${track.uploader})`
          : track.name,
        artist: track.artist,
        album: track.album,
        albumArtUrl: track.artworkUrl,
        sampleRate: provider === "soundcloud" ? null : 44100,
        bitrate: provider === "soundcloud" ? null : 320000,
        numberOfChannels: 2,
      });
      store.dispatch({ type: "PLAY_TRACK", id });
    });
  }

  function apply(s) {
    const media = bridge.media;
    if (!media || !s) return;
    updateAttribution(s);
    const soundcloud = s.provider === "soundcloud";

    if (!soundcloud) {
      if (s.error === "permission") {
        return showMessage("Allow Nostalgify to control Spotify in System Settings > Privacy > Automation");
      }
      if (s.error === "waiting") return showMessage("Waiting for permission to control Spotify...");
      if (s.error) return showMessage(s.message || "Can't reach Spotify. See nostalgify.log");
      if (!s.running) return showMessage("Spotify is closed. Press Play to start it");
      if (!s.track) return showMessage("Nothing loaded. Press Play for Spotify Liked Songs");
    } else if (!s.track) {
      return showMessage(s.message || s.error || "Add a SoundCloud track or playlist link to the shelf");
    }

    const playing = s.state === "playing";
    // SoundCloud is local audio: use measured timing, including buffering and
    // seeks. Only the external Spotify player needs interpolation between polls.
    base = { elapsed: s.position, at: performance.now(), playing: playing && !soundcloud };
    media._duration = s.track.duration;

    const trackId = `${s.provider || "spotify"}:${s.track.id}`;
    if (trackId !== currentTrackId) {
      currentTrackId = trackId;
      showNowPlaying(s.track, s.provider);
    }
    // A preview's decoded duration can be shorter than its catalogue metadata.
    // Webamp's seek bar and remaining-time display use this Redux track value.
    if (store.getState().tracks[currentWebampTrackId]?.duration !== s.track.duration) {
      quietly(() => store.dispatch({ type: "SET_MEDIA_DURATION", id: currentWebampTrackId, duration: s.track.duration }));
    }

    const status = store.getState().media.status;
    quietly(() => {
      if (playing && status !== "PLAYING") store.dispatch({ type: "IS_PLAYING" });
      if (!playing && status === "PLAYING") store.dispatch({ type: "PAUSE" });
    });
    media.setVisPlaying(playing);

    const st = store.getState().media;
    quietly(() => {
      if (st.shuffle !== s.shuffle) store.dispatch({ type: "TOGGLE_SHUFFLE" });
      if (st.repeat !== s.repeat) store.dispatch({ type: "TOGGLE_REPEAT" });
      // Follow the provider's volume unless the user just dragged the slider.
      const recentlyDragged = performance.now() - media.lastUserVolumeAt < 2500;
      if (!recentlyDragged && st.volume !== s.volume) {
        store.dispatch({ type: "SET_VOLUME", volume: s.volume });
      }
    });
    media.markVolumeReady();
    media.setTiming(s.position, s.track.duration);
    const message = s.message || (soundcloud && s.error) ||
      (soundcloud && ["loading", "buffering"].includes(s.state) ? "SoundCloud is buffering..." : null);
    if (message) showMessage(message, true);
    else clearMessage();
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      apply(await window.nostalgify.getState());
    } catch (e) {
      console.error(e);
    } finally {
      polling = false;
    }
  }

  // Smooth the clock between polls.
  setInterval(() => {
    const media = bridge.media;
    if (!media || !base.playing || !currentTrackId) return;
    const elapsed = Math.min(media._duration, base.elapsed + (performance.now() - base.at) / 1000);
    media.setTiming(elapsed, media._duration);
  }, TICK_MS);

  await shelf.load();
  await webamp.renderWhenReady(document.getElementById("app"));
  manageLayout(webamp);
  addResizeGrips();
  poll();
  setInterval(poll, POLL_MS);
}

main().catch(() => {
  soundcloudAudio.dispose();
  document.getElementById("app").textContent = "Nostalgify could not start. Please relaunch the app.";
});
