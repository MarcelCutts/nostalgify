import Webamp from "webamp";
import { PlaybackMedia, bridge, quietly, sendCommand } from "./playbackMedia.js";
import { manageLayout, addResizeGrips } from "./layout.js";
import { createEqPolicy } from "./eq.js";
import { createShelf } from "./shelf.js";
import { installContextMenus } from "./contextMenu.js";

export async function mountPlayer(host, { target = document.getElementById("app") } = {}) {
  if (!host || !target) throw new Error("A player host and mount element are required");
  bridge.host = host;
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
  function onSkinLoad(cb) {
    skinListeners.push(cb);
  }
  const knownSkins = new Set();
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input && input.url;
    if (url && (knownSkins.has(url) || host.isSkinUrl?.(url) || url.startsWith("skin://"))) {
      host.skinChosen(url);
      skinListeners.forEach((cb) => cb(url));
    }
    return originalFetch(input, init);
  };

  const { skins, initial } = await host.initSkins();
  for (const skin of skins) knownSkins.add(skin.url);
  if (initial) knownSkins.add(initial);
  const ui = (await host.loadUiPrefs()) || {};

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
    __customMediaClass: PlaybackMedia,
    __customMiddlewares: [forwardToProvider],
  });
  const store = webamp.store;
  if (host.debug) window.__webamp = webamp;

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
    host,
    quietly,
    flash,
    // After playing a shelf entry, refresh straight away so the marquee catches up.
    onPlay: () => {
      currentTrackId = null;
      setTimeout(poll, 600);
    },
  });
  actionListeners.push((action, quiet) => shelf.onAction(action, quiet));
  if (host.debug) {
    window.__shelf = shelf;
    window.__bridge = bridge;
    window.__actions = [];
    actionListeners.push((action, quiet) => window.__actions.push(action.type + (quiet ? " (quiet)" : "")));
  }

  // Remember whether the playlist is open and how tall it is.
  actionListeners.push((action, quiet, state) => {
    const pl = state.windows.genWindows.playlist;
    if (["TOGGLE_WINDOW", "CLOSE_WINDOW", "WINDOW_SIZE_CHANGED"].includes(action.type)) {
      void runUI(() => host.saveUiPrefs({ playlistOpen: pl.open, playlistExtraHeight: pl.size[1] }));
    }
  });

  webamp.onClose(() => host.close());
  webamp.onMinimize(() => host.minimize());

  const eq = createEqPolicy(webamp, skins);
  onSkinLoad((url) => eq.applyForSkin(url));
  eq.applyForSkin(initial);
  if (host.showContextMenu && host.onMenuAction) installContextMenus({ webamp, shelf, eq, transport, host });
  host.onSetSkin((url) => {
    knownSkins.add(url);
    webamp.setSkinFromUrl(url);
  });
  host.onSkinsChanged((list) => {
    for (const skin of list) knownSkins.add(skin.url);
    eq.updateSkins(list);
    store.dispatch({ type: "SET_AVAILABLE_SKINS", skins: list });
  });

  // ---------- intercept buttons Webamp would handle itself ----------
  // Capture phase on window runs before React's handlers on the root. The
  // built-in menus use DOM labels (Webamp 2.x exposes no menu-action callback).
  const canUse = command => host.canUseClassicControl?.(command) !== false;
  async function runUI(callback) {
    try { await callback(); }
    catch (error) { flash(error?.message || "That action could not finish. Try again.", 6000); }
  }
  const TRANSPORT = {
    next: "next", previous: "previous", play: "play", pause: "playpause", stop: "stop", eject: "eject",
    "playlist-next-button": "next", "playlist-previous-button": "previous",
    "playlist-play-button": "play", "playlist-pause-button": "playpause",
    "playlist-stop-button": "stop", "playlist-eject-button": "eject",
  };
  const transportSelector = Object.keys(TRANSPORT).map(key => key.startsWith("playlist-") ? `.${key}` : `#${key}`).join(", ");
  const CONTROL_COMMANDS = { volume: "volume", "equalizer-volume": "volume", position: "seek", shuffle: "shuffle", repeat: "repeat", ...TRANSPORT };
  const controlSelector = `${transportSelector}, #volume, #equalizer-volume, #position, #shuffle, #repeat`;
  const commandForControl = element => CONTROL_COMMANDS[element.id] || [...element.classList].map(key => CONTROL_COMMANDS[key]).find(Boolean);
  const cancel = event => { event.preventDefault(); event.stopPropagation(); };

  // Disabled ranges must also ignore synthetic input and wheel events. Native
  // disabled attributes cover focus/default keyboard behavior; capture covers
  // sprite buttons and controls mounted since the last state render.
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "input", "change", "wheel"]) {
    window.addEventListener(type, event => {
      // Webamp treats wheel gestures anywhere on the main window as volume.
      if (type === "wheel" && event.target?.closest?.("#main-window") && !canUse("volume")) { cancel(event); return; }
      const element = event.target?.closest?.(controlSelector);
      if (element && !canUse(commandForControl(element))) cancel(event);
    }, { capture: true, passive: false });
  }

  function chooseSkinFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".wsz,.zip";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void runUI(() => host.importSkin(file));
    }, { once: true });
    input.addEventListener("cancel", () => input.remove(), { once: true });
    document.body.append(input);
    input.click();
  }

  const ownText = element => [...(element?.childNodes || [])].filter(node => node.nodeType === 3).map(node => node.textContent).join("").trim();
  const playbackMenu = {
    Previous: ["previous"], Play: ["play"], Pause: ["playpause"], Stop: ["stop"], Next: ["next"],
    "Back 5 seconds": ["seek", -5], "Fwd 5 seconds": ["seek", 5],
    "10 tracks back": ["previous", 10], "10 tracks fwd": ["next", 10],
  };
  function handleClassicMenu(target) {
    const entry = target.closest("#webamp-context-menu li:not(.parent):not(.hr)");
    if (!entry) return false;
    const label = ownText(entry);
    const parent = ownText(entry.parentElement?.closest("li.parent"));
    if (parent === "Play" && label === "File..." && host.importFiles) {
      void runUI(() => host.importFiles());
    } else if (parent === "Playback" && playbackMenu[label]) {
      const [command, amount] = playbackMenu[label];
      if (command === "seek") seek(amount);
      else transport(command === "play" ? "playOrFallback" : command, amount);
    } else if (parent === "Skins" && entry === entry.parentElement.children[2] && label === "<Base Skin>" && host.selectSkin) {
      void runUI(async () => { await host.selectSkin(null); eq.applyForSkin(null); });
    } else if (parent === "Skins" && entry === entry.parentElement.firstElementChild && label === "Load Skin..." && host.importSkin) {
      chooseSkinFile();
    } else if ((!parent || parent === "Options") && ["Shuffle", "Repeat"].includes(label) && !canUse(label.toLowerCase())) {
      // These options are also exposed in the standalone Options popup.
    } else return false;
    return true;
  }

  window.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    if (host.importFiles && event.target.closest("#playlist-add-menu .add-file, #playlist-add-menu .add-dir, #playlist-list-menu .load-list")) {
      cancel(event);
      void runUI(() => host.importFiles());
      // Let Webamp's click-away listener close its own menu.
      document.body.click();
      return;
    }
    if (handleClassicMenu(event.target)) {
      cancel(event);
      document.body.click();
      return;
    }
    if (event.target.closest("#equalizer-button") && !eq.canShowPanel()) { cancel(event); return; }
    const element = event.target.closest(controlSelector);
    if (!element) return;
    const command = commandForControl(element);
    if (!canUse(command)) { cancel(event); return; }
    if (!element.matches(transportSelector)) return;
    cancel(event);
    if (command === "eject" && host.importFiles) void runUI(() => host.importFiles());
    else transport(command === "play" && !currentTrackId ? "playOrFallback" : command);
  }, true);

  function transport(command, count = 1) {
    if (!canUse(command)) return;
    void (async () => {
      for (let index = 0; index < count && canUse(command); index++) {
        const result = await sendCommand(command);
        if (result?.error) break;
      }
      setTimeout(poll, 250);
    })();
  }
  function seek(seconds) {
    if (!canUse("seek")) return;
    if (seconds < 0) webamp.seekBackward(-seconds);
    else webamp.seekForward(seconds);
  }

  // Classic letters still work after a desktop sprite slider retains focus.
  // Arrow keys on any focused slider retain their native range semantics.
  window.addEventListener("keydown", event => {
    const target = event.composedPath?.()[0] || event.target;
    const range = target?.closest?.('input[type="range"], [role="slider"]');
    const classicRange = host.platform !== "ios" && range?.closest?.("#webamp");
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable) return;
    if (range && (!classicRange || event.key.startsWith("Arrow"))) return;
    if (!classicRange && target?.closest?.("input, textarea, select, button, a[href], [role=button], [role=menu], [role=menuitem], [contenteditable=true]")) return;
    const commands = { z: "previous", x: currentTrackId ? "play" : "playOrFallback", c: "playpause", v: "stop", b: "next" };
    const command = commands[event.key.toLowerCase()];
    if (command) { event.preventDefault(); transport(command); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); seek(event.key === "ArrowLeft" ? -5 : 5);
    }
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
        bridge.media.setVisualizerPlaying(false);
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
        sampleRate: provider === "local" ? track.sampleRate ?? null : provider === "soundcloud" ? null : 44100,
        bitrate: provider === "local" ? track.bitrate ?? null : provider === "soundcloud" ? null : 320000,
        numberOfChannels: 2,
      });
      store.dispatch({ type: "PLAY_TRACK", id });
    });
  }

  function apply(s) {
    const media = bridge.media;
    if (!media || !s) return;
    eq.setProvider(s.provider);
    updateAttribution(s);
    const soundcloud = s.provider === "soundcloud";

    if (host.platform === "ios" || s.provider === "local") {
      if (s.error || !s.track) return showMessage(s.message || (s.error ? "Playback is unavailable. Try again." : "Choose music to begin"));
    } else if (!soundcloud) {
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
    base = { elapsed: s.position, at: performance.now(), playing: playing && !soundcloud && s.provider !== "local" };
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
    media.setVisualizerPlaying(playing);

    const st = store.getState().media;
    quietly(() => {
      if (typeof s.shuffle === "boolean" && st.shuffle !== s.shuffle) store.dispatch({ type: "TOGGLE_SHUFFLE" });
      if (typeof s.repeat === "boolean" && st.repeat !== s.repeat) store.dispatch({ type: "TOGGLE_REPEAT" });
      // Follow the provider's volume unless the user just dragged the slider.
      const recentlyDragged = performance.now() - media.lastUserVolumeAt < 2500;
      if (Number.isFinite(s.volume) && !recentlyDragged && st.volume !== s.volume) {
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
      apply(await host.getState());
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
  if (host.platform === "ios") await webamp.renderInto(target);
  else await webamp.renderWhenReady(target);
  manageLayout(webamp, host);
  if (host.platform !== "ios") addResizeGrips(host);
  poll();
  setInterval(poll, POLL_MS);
  host.onStateChanged?.(apply);
  return { webamp, shelf, refresh: poll };
}
