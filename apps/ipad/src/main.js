import { Capacitor, registerPlugin } from "@capacitor/core";
import { mountPlayer } from "@nostalgify/player-ui";
import { createNativeHost } from "./bridge.js";
import { attachSkinStore } from "./skins.js";
import { LOCAL_URI, commandCapability } from "../../../packages/contracts/src/player.js";
import { createMockPlugin } from "./mock.js";
import { safeWebError } from "./diagnostics.js";
import { installSkinAccessibility } from "./skin-accessibility.js";

const $ = id => document.getElementById(id);
const native = Capacitor.isNativePlatform();
// A production build always uses the real native plugin. Query parameters cannot enable mocks.
const demo = __IPAD_DEVELOPMENT__ && !native && new URLSearchParams(location.search).get("mock") === "1";
const plugin = demo ? createMockPlugin() : native ? registerPlugin("NostalgifyNative") : null;
$("demo-banner").hidden = !demo;
$("browser-banner").hidden = native || demo;
const host = attachSkinStore(createNativeHost(plugin, { debug: demo, onError: showError }));
window.nostalgify = host;
let mounted;
let library = [];
let savedShelf = [];
let localPlaylistExcluded = new Set();
let selectedSource = "spotify";
let playerWidth = 275;
let playerHeight = 377;
let lastTrack = null;
let lastGeometry = "";
let settingsOpener;
const pendingActions = new WeakSet();
const sliderEdits = new Map(["seek", "native-volume"].map(id => [id, { pointerId: null, pending: 0 }]));
const sliderIsEditing = id => sliderEdits.get(id).pointerId !== null || sliderEdits.get(id).pending > 0;

function showError(error) {
  $("error-message").textContent = error?.message || "The player could not complete that action. Please try again.";
  $("error-message").hidden = false;
}
function clearError() {
  $("error-message").hidden = true;
  for (const id of ["spotify-client-id", "spotify-redirect"]) {
    $(id).removeAttribute("aria-invalid");
    $(id).removeAttribute("aria-errormessage");
  }
}
async function action(callback, button) {
  if (button && pendingActions.has(button)) return;
  if (button) { pendingActions.add(button); button.setAttribute("aria-busy", "true"); }
  clearError();
  try { return await callback(); }
  catch (error) { showError(error); }
  finally {
    if (button) { pendingActions.delete(button); button.removeAttribute("aria-busy"); }
    renderState(host.getCachedState());
  }
}
const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
const setText = (id, value) => {
  const element = $(id);
  // Polling unchanged state must not replace the text nodes VoiceOver is reading.
  if (element.textContent !== value) element.textContent = value;
};
const spokenTime = seconds => {
  const value = Math.floor(Math.max(0, Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  return [minutes && `${minutes} ${minutes === 1 ? "minute" : "minutes"}`, `${value % 60} ${value % 60 === 1 ? "second" : "seconds"}`].filter(Boolean).join(" ");
};
function updateSliderDescriptions() {
  $("seek").setAttribute("aria-valuetext", `${spokenTime($("seek").value)} of ${spokenTime($("seek").max)}`);
  $("native-volume").setAttribute("aria-valuetext", `${Math.round(Number($("native-volume").value))} percent`);
}
function updatePlayAvailability(state) {
  $("play-button").disabled = !state.running || (state.provider === "local" && !state.track && !library.length);
}
function renderState(state) {
  const caps = state.capabilities;
  setText("source-label", state.provider === "local" ? "LOCAL FILES" : "SPOTIFY");
  $("source-label").setAttribute("aria-label", `Playback source: ${state.provider === "local" ? "Local files" : "Spotify"}`);
  const title = state.track?.name || "Ready when you are.";
  const artist = state.track?.artist || (state.provider === "local" ? "Your imported music, on this iPad." : "Connect Spotify or bring your own music.");
  setText("track-title", title);
  const titleLabel = state.track ? `Now playing: ${title}` : `${title} No track selected`;
  if ($("track-title").getAttribute("aria-label") !== titleLabel) $("track-title").setAttribute("aria-label", titleLabel);
  setText("track-artist", artist);
  setText("elapsed", clock(state.position));
  setText("duration", clock(state.track?.duration || 0));
  $("seek").max = String(state.track?.duration || 0);
  if (!sliderIsEditing("seek")) $("seek").value = String(state.position);
  $("seek").disabled = !caps.canSeek || !state.track;
  $("native-volume").disabled = !caps.canSetVolume;
  if (!sliderIsEditing("native-volume")) $("native-volume").value = String(state.volume);
  updateSliderDescriptions();
  setText("volume-note", caps.canSetVolume ? "Volume applies to imported audio." : "Use the iPad volume buttons for Spotify.");
  $("previous-button").disabled = !caps.canSkipPrevious;
  $("next-button").disabled = !caps.canSkipNext;
  updatePlayAvailability(state);
  const playing = ["playing", "buffering"].includes(state.state);
  setText("play-button", playing ? "Ⅱ" : "▶︎");
  $("play-button").setAttribute("aria-label", playing ? "Pause" : "Play");
  for (const key of ["shuffle", "repeat"]) {
    $(`${key}-button`).disabled = !caps[key === "shuffle" ? "canShuffle" : "canRepeat"];
    $(`${key}-button`).setAttribute("aria-pressed", String(state[key]));
  }
  setText("connect-button", state.provider === "spotify" && state.running ? "Reconnect Spotify" : "Connect Spotify");
  const playbackStatus = ({ playing: "Playing", buffering: "Buffering", paused: "Paused" })[state.state] || (state.running ? "Ready to play" : "Connect Spotify or import music from Files");
  const status = demo ? `Development demo · ${playbackStatus.toLowerCase()}; no audio plays.` : state.message || playbackStatus;
  // Native progress events arrive frequently; unchanged live-region writes can interrupt VoiceOver.
  setText("player-status", status);
  renderClassicCapabilities();
  if (state.track?.id !== lastTrack) { lastTrack = state.track?.id; renderLists(); }
}
// Read cached state at activation time as well as rendering, so a newly opened
// compact window cannot send unavailable commands between native snapshots.
host.canUseClassicControl = command => {
  const state = host.getCachedState();
  const capability = commandCapability(command);
  if (capability) return state.capabilities[capability] && (command !== "seek" || Boolean(state.track));
  if (["play", "playOrFallback"].includes(command)) return state.running && (state.provider !== "local" || Boolean(state.track) || library.length > 0);
  if (["pause", "playpause", "stop"].includes(command)) return state.running && Boolean(state.track);
  return true;
};
function renderClassicCapabilities() {
  const controls = [
    ["#volume, #volume input, #equalizer-volume", "volume"], ["#position, #position input", "seek"],
    ["#next, .playlist-next-button", "next"], ["#previous, .playlist-previous-button", "previous"],
    ["#play, .playlist-play-button", "play"], ["#pause, .playlist-pause-button", "playpause"],
    ["#stop, .playlist-stop-button", "stop"], ["#shuffle", "shuffle"], ["#repeat", "repeat"],
  ];
  for (const [selector, command] of controls) {
    const enabled = host.canUseClassicControl(command);
    for (const element of $("app").querySelectorAll(selector)) {
      const disabled = String(!enabled);
      if (element.getAttribute("aria-disabled") !== disabled) element.setAttribute("aria-disabled", disabled);
      element.style.pointerEvents = enabled ? "" : "none";
      element.style.opacity = enabled ? "" : ".45";
      if ("disabled" in element && element.disabled !== !enabled) element.disabled = !enabled;
    }
  }
}
new MutationObserver(renderClassicCapabilities).observe($("app"), { childList: true, subtree: true });

function resizePlayer() {
  const available = Math.max(240, $("player-viewport").clientWidth - 38);
  const scale = Math.min(1.7, available / playerWidth);
  const geometry = `${playerWidth}:${playerHeight}:${scale}`;
  if (geometry === lastGeometry) return;
  lastGeometry = geometry;
  $("app").style.transform = `scale(${scale})`;
  $("player-size").style.width = `${Math.ceil(playerWidth * scale)}px`;
  $("player-size").style.height = `${Math.ceil(playerHeight * scale)}px`;
  $("app").style.width = `${playerWidth}px`;
}
host.layout = (width, height) => {
  if (width > 0 && height > 0) { playerWidth = width; playerHeight = height; resizePlayer(); }
};
let resizePending = false;
new ResizeObserver(() => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => { resizePending = false; resizePlayer(); });
}).observe($("player-viewport"));
window.addEventListener("resize", resizePlayer);

const nativeImport = host.importFiles;
host.importFiles = async () => {
  let result;
  try { result = await nativeImport(); }
  catch (error) {
    // A later storage failure can follow files already committed to the library.
    // Refresh those successes, preserving the actionable original failure.
    try { await refreshLibrary(); } catch {}
    showError(error);
    throw error;
  }
  const { items: imported, skipped } = result;
  await refreshLibrary();
  if (imported.length) await mounted?.shelf.addItems?.(imported.map(localShelfItem));
  if (skipped) showError(new Error(`Imported ${imported.length} ${imported.length === 1 ? "file" : "files"}. ${skipped} ${skipped === 1 ? "file could" : "files could"} not be imported. Choose unprotected audio downloaded in Files and try again.`));
  return imported;
};
host.saveShelf = async items => {
  // Playlist membership is separate from file ownership. Existing libraries
  // without exclusion metadata start with every local file on the playlist.
  savedShelf = items.filter(item => item.provider !== "local" && !item.uri?.startsWith("local:"));
  const included = new Set(items.filter(item => item.uri?.startsWith("local:")).map(item => item.uri));
  localPlaylistExcluded = new Set(library.map(item => item.uri || `local:${item.id}`).filter(uri => !included.has(uri)));
  // One acknowledged patch commits links and membership together.
  const result = await host.savePreferences({ shelf: savedShelf, localPlaylistExcluded: [...localPlaylistExcluded] });
  renderLists();
  return result;
};
host.loadShelf = async () => {
  const preferences = await host.getPreferences();
  localPlaylistExcluded = new Set((Array.isArray(preferences.localPlaylistExcluded) ? preferences.localPlaylistExcluded : []).filter(uri => typeof uri === "string" && LOCAL_URI.test(uri)));
  return [...savedShelf, ...visibleLocalItems()];
};
const visibleLocalItems = () => library.map(localShelfItem).filter(item => !localPlaylistExcluded.has(item.uri));
const parseLinks = host.resolveLinks;
host.resolveLinks = async text => {
  if (LOCAL_URI.test(text)) return library.filter(item => item.uri === text).map(localShelfItem);
  return parseLinks(text);
};
const localShelfItem = item => ({ provider: "local", kind: "track", uri: item.uri || `local:${item.id}`, title: item.name, artist: item.artist || "" });
async function refreshLibrary() {
  const previous = library;
  library = await host.listAudio();
  try {
    if (mounted) {
      // Add new library entries before persisting removals, so they cannot be
      // mistaken for user exclusions while reconciling a changed native library.
      const failures = [];
      try { await mounted.shelf.addItems(visibleLocalItems()); }
      catch (error) { failures.push(error); }
      const retained = new Set(library.map(item => item.uri || `local:${item.id}`));
      // Each operation updates the visible shelf before saving. Finish every
      // removal even if persistence fails: the cached library is already new,
      // so a later refresh cannot discover these vanished files again.
      for (const item of previous) {
        const uri = item.uri || `local:${item.id}`;
        if (!retained.has(uri)) {
          try { await mounted.shelf.removeUri(uri); }
          catch (error) { failures.push(error); }
        }
      }
      if (failures.length) throw failures[0];
    }
  } finally {
    // Native import can commit even when playlist preferences cannot be saved.
    // Files and playback eligibility must reflect the library we just read
    // while the save still rejects.
    renderLists();
    renderState(host.getCachedState());
  }
}
function renderLists() {
  renderList($("spotify-shelf"), savedShelf, "Save a Spotify link to start your collection.");
  renderList($("local-library"), library.map(localShelfItem), "Your imported audio will appear here.");
  const count = selectedSource === "local" ? library.length : savedShelf.length;
  $("collection-count").textContent = `${count} ${count === 1 ? "item" : "items"}`;
}
function renderList(container, items, emptyText) {
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const focusIndex = focused ? [...container.children].indexOf(focused.closest(".music-row")) : -1;
  const focusURI = focused?.dataset.uri;
  const focusAction = focused?.className;
  let nextFocus;
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p"); empty.className = "empty-library"; empty.textContent = emptyText; container.append(empty);
    if (focused) $(container.id === "local-library" ? "import-button" : "spotify-link").focus({ preventScroll: true });
    return;
  }
  for (const item of items) {
    const row = document.createElement("div"); row.className = "music-row";
    const play = document.createElement("button"); play.className = "music-play";
    const icon = document.createElement("span"); icon.className = "music-icon"; icon.textContent = "♪";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span"); text.className = "music-text";
    const title = document.createElement("span"); title.className = "music-title"; title.textContent = item.title;
    const subtitle = document.createElement("span"); subtitle.className = "music-subtitle"; subtitle.textContent = item.artist || (item.provider === "local" ? "Imported audio" : `Spotify ${item.kind}`);
    subtitle.id = `${container.id}-subtitle-${encodeURIComponent(item.uri)}`;
    text.append(title, subtitle); play.append(icon, text);
    play.setAttribute("aria-label", `Play ${item.title}`);
    play.setAttribute("aria-describedby", subtitle.id);
    play.addEventListener("click", () => action(() => host.command("playShelf", item.uri), play));
    const remove = document.createElement("button"); remove.className = "remove-item"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${item.title}`);
    play.dataset.uri = remove.dataset.uri = item.uri;
    const add = item.provider === "local" && localPlaylistExcluded.has(item.uri) ? document.createElement("button") : null;
    if (add) {
      add.className = "add-item"; add.textContent = "+"; add.dataset.uri = item.uri;
      add.setAttribute("aria-label", `Add ${item.title} to playlist`);
      add.addEventListener("click", () => action(() => mounted.shelf.addItems([item]), add));
    }
    if (item.uri === focusURI) nextFocus = focusAction === "remove-item" ? remove : focusAction === "add-item" && add ? add : play;
    remove.addEventListener("click", () => action(async () => {
      if (item.provider === "local") { await host.removeAudio(item.uri.slice(6)); await refreshLibrary(); }
      await mounted?.shelf.removeUri?.(item.uri);
      if (item.provider !== "local" && !mounted?.shelf.removeUri) await host.saveShelf(savedShelf.filter(saved => saved.uri !== item.uri));
    }, remove));
    row.append(play);
    if (add) row.append(add);
    row.append(remove); container.append(row);
  }
  if (focused) (nextFocus || container.children[Math.min(focusIndex, items.length - 1)]?.querySelector("button"))?.focus({ preventScroll: true });
}
function showSettings(open) {
  if (open && $("settings-panel").hidden) settingsOpener = document.activeElement;
  $("settings-panel").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) {
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    $("settings-panel").scrollIntoView({ behavior, block: "start" });
    $("spotify-client-id").focus({ preventScroll: true });
  } else (settingsOpener?.isConnected ? settingsOpener : $("settings-toggle")).focus();
}
$("settings-toggle").addEventListener("click", () => showSettings($("settings-panel").hidden));
$("settings-close").addEventListener("click", () => showSettings(false));
$("settings-panel").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); showSettings(false); }
});
$("spotify-settings").addEventListener("submit", event => {
  event.preventDefault();
  void action(async () => {
    const clientId = $("spotify-client-id").value.trim();
    const redirectURI = $("spotify-redirect").value.trim();
    const invalid = !/^[a-f0-9]{32}$/i.test(clientId) ? ["spotify-client-id", "Enter the 32-character client ID from your Spotify developer app."]
      : redirectURI !== "nostalgify://spotify-login-callback" ? ["spotify-redirect", "Register and use nostalgify://spotify-login-callback for this build."] : null;
    if (invalid) {
      $(invalid[0]).setAttribute("aria-invalid", "true");
      $(invalid[0]).setAttribute("aria-errormessage", "error-message");
      $(invalid[0]).focus();
      throw new Error(invalid[1]);
    }
    await host.configureSpotify({ clientId, redirectURI });
    $("diagnostics-status").textContent = "Connection settings saved. You can now connect Spotify.";
  }, event.submitter);
});
$("connect-button").addEventListener("click", () => action(async () => {
  const prefs = await host.getPreferences();
  if (!prefs.spotify?.clientId) { showSettings(true); throw new Error("Add your Spotify client ID in connection settings, then connect."); }
  await host.connectSpotify();
}, $("connect-button")));
$("reconnect-button").addEventListener("click", () => action(async () => { await host.getState(); $("diagnostics-status").textContent = "Player connection refreshed."; }, $("reconnect-button")));
$("logout-button").addEventListener("click", () => action(async () => { await host.command("logout"); await host.getState(); }, $("logout-button")));
$("disconnect-button").addEventListener("click", () => action(() => host.disconnectSpotify(), $("disconnect-button")));
for (const source of ["spotify", "local"]) {
  $(`${source}-source`).addEventListener("click", () => {
    selectedSource = source;
    for (const value of ["spotify", "local"]) {
      $(`${value}-source`).classList.toggle("active", value === source);
      $(`${value}-source`).setAttribute("aria-pressed", String(value === source));
      $(`${value}-panel`).hidden = value !== source;
    }
    renderLists();
    // Browsing the collection does not interrupt currently playing music.
  });
}
$("import-button").addEventListener("click", () => action(() => host.importFiles(), $("import-button")));
$("link-form").addEventListener("submit", event => {
  event.preventDefault();
  void action(async () => {
    const text = $("spotify-link").value.trim();
    const links = await host.resolveLinks(text);
    if (!links.length) throw new Error("Paste a link from open.spotify.com for a track, album, artist, playlist or episode.");
    if (mounted?.shelf.addItems) await mounted.shelf.addItems(links);
    else await mounted?.shelf.addFromText(text);
    $("spotify-link").value = "";
  }, event.submitter);
});
for (const [id, command] of [["play-button", "playpause"], ["previous-button", "previous"], ["next-button", "next"]]) $(id).addEventListener("click", () => action(() => host.command(command), $(id)));
for (const key of ["shuffle", "repeat"]) $(`${key}-button`).addEventListener("click", () => action(() => host.command(key, !host.getCachedState()[key]), $(`${key}-button`)));
for (const [id, command] of [["seek", "seek"], ["native-volume", "volume"]]) {
  const control = $(id), editing = sliderEdits.get(id);
  control.addEventListener("input", updateSliderDescriptions);
  control.addEventListener("pointerdown", event => { editing.pointerId = event.pointerId; });
  for (const eventName of ["pointerup", "pointercancel"]) window.addEventListener(eventName, event => {
    if (editing.pointerId !== event.pointerId) return;
    editing.pointerId = null;
    // Let the range's change event register its pending command before syncing.
    requestAnimationFrame(() => renderState(host.getCachedState()));
  });
  control.addEventListener("change", () => {
    const value = Number(control.value);
    editing.pending++;
    void action(async () => {
      try { await host.command(command, value); }
      finally { editing.pending--; }
    });
  });
}
// Classic menus and Settings share these operations. Refresh only after the
// store has committed or rolled back; picker failures must never affect that
// operation's result or become an import failure that triggers a rollback.
for (const method of ["importSkin", "selectSkin"]) {
  const changeSkin = host[method];
  host[method] = async (...args) => {
    try { return await changeSkin(...args); }
    finally {
      try { await renderSkins(); }
      catch { host.recordError("skin_load_failed"); }
    }
  };
}
$("skin-file").addEventListener("change", () => action(async () => {
  const file = $("skin-file").files?.[0]; if (!file) return;
  await host.importSkin(file); $("skin-file").value = "";
}));
$("skin-select").addEventListener("change", () => action(() => host.selectSkin($("skin-select").value)));
async function renderSkins() {
  const { skins } = await host.initSkins();
  const selected = (await host.getPreferences()).skinId || "";
  $("skin-select").replaceChildren(new Option("Classic Winamp", ""), ...skins.map(skin => new Option(skin.name, skin.id)));
  $("skin-select").value = selected;
}

$("diagnostics-button").addEventListener("click", () => action(async () => {
  const result = await host.exportDiagnostics();
  $("diagnostics-status").textContent = result?.shared ? "Diagnostics exported." : "Export closed.";
}, $("diagnostics-button")));
$("web-diagnostics-button").addEventListener("click", () => action(async () => {
  const report = await host.getDiagnostics();
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "nostalgify-diagnostics.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}, $("web-diagnostics-button")));
window.addEventListener("error", event => { const details = safeWebError(event); host.recordError(details.code, details); showError(new Error("The interface encountered an error. Refresh the connection or export diagnostics.")); });
window.addEventListener("unhandledrejection", event => { host.recordError("unhandled_promise", safeWebError({ error: event.reason })); showError(new Error("An action could not finish. Try again or export diagnostics.")); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void action(async () => { await host.getState(); if (native || demo) await refreshLibrary(); }); });
window.addEventListener("online", () => { void action(() => host.getState()); });
host.onStateChanged(renderState);

async function start() {
  await host.ready;
  const preferences = await host.getPreferences();
  savedShelf = Array.isArray(preferences.shelf) ? preferences.shelf : [];
  if (preferences.spotify) { $("spotify-client-id").value = preferences.spotify.clientId || ""; $("spotify-redirect").value = preferences.spotify.redirectURI || "nostalgify://spotify-login-callback"; }
  if (native || demo) await refreshLibrary();
  mounted = await mountPlayer(host);
  installSkinAccessibility($("app"));
  mounted.webamp.onWillClose(cancel => cancel());
  host.restoreDefaultSkin = () => mounted.webamp.store.dispatch({ type: "LOAD_DEFAULT_SKIN" });
  host.confirmSkinLoad = () => new Promise((resolve, reject) => {
    const store = mounted.webamp.store;
    const before = store.getState().display.skinImages;
    const timer = setTimeout(() => finish(false), 12000);
    const unsubscribe = store.subscribe(() => {
      if (!store.getState().display.loading) finish(store.getState().display.skinImages !== before);
    });
    function finish(success) {
      clearTimeout(timer); unsubscribe();
      if (success) resolve();
      else reject(new Error("That skin could not be read. Your previous skin is still selected."));
    }
  });
  try { await host.restoreSavedSkin(); } catch (error) { showError(error); }
  await renderSkins();
  renderLists(); renderState(host.getCachedState()); resizePlayer();
  document.documentElement.dataset.playerReady = "true";
  // Initial library rows are rebuilt after the player and saved skin load.
  // Let users browse only once those controls have their final initial identity.
  $("spotify-source").disabled = false;
  $("local-source").disabled = false;
  if (demo) window.__ipad = { host, mounted, plugin };
}
void start().catch(error => { host.recordError("startup_failed"); showError(error); $("player-status").textContent = "The player could not start. Export diagnostics from Settings."; });
